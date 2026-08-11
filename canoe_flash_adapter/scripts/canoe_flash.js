import * as com from "@atech/com";
import * as fs from "@atech/fs";
import * as cli from "@atech/cli";
import * as task from "@atech/task";

const CONTRACT_VERSION = "1.0";
const COMMAND = Object.freeze({ none: 0, start: 1, cancel: 2, reset: 3 });
const STATE = Object.freeze({
    idle: 0,
    ready: 10,
    running: 20,
    verifying: 30,
    succeeded: 40,
    failed: 50,
    cancelled: 60
});

let application = null;
let measurement = null;
let flashVariables = null;
let projectDescriptor = null;
let configurationUri = "";
let firmwareUri = "";
let launchedByTask = false;

function requireRelativePath(path, field) {
    if (typeof path !== "string" || path.length === 0 || path.includes("\\") || path.startsWith("/") || path.split("/").includes("..")) {
        throw new Error(`${field} must be a safe relative path`);
    }
    return path;
}

function fileName(uri) {
    const parts = uri.split("/");
    return parts[parts.length - 1];
}

function variable(name) {
    if (flashVariables === null) {
        const system = application.get("System");
        const namespaces = system.get("Namespaces");
        const cict = namespaces.item("CICT");
        const flash = cict.get("Namespaces").item("Flash");
        flashVariables = flash.get("Variables");
    }
    return flashVariables.item(name);
}

function getVariable(name) {
    return variable(name).get("Value");
}

function setVariable(name, value) {
    variable(name).set("Value", value);
}

async function waitUntil(predicate, timeoutMs, description, ignoreCancellation = false) {
    const started = Date.now();
    while (!predicate()) {
        if (!ignoreCancellation)
            task.checkCancelled();
        if (Date.now() - started >= timeoutMs) {
            throw new Error(`Timed out waiting for ${description}`);
        }
        await task.delay(250, ignoreCancellation);
    }
}

export async function prepare(projectPackage, softwarePackage) {
    task.log("info", "Validating and extracting the CANoe project package");
    fs.extractZip(projectPackage, "workspace://canoe-project");
    const descriptorUri = "workspace://canoe-project/canoe-project.json";
    if (!fs.exists(descriptorUri)) {
        throw new Error("CANOE_PROJECT must contain canoe-project.json");
    }
    projectDescriptor = JSON.parse(fs.readText(descriptorUri));
    if (projectDescriptor.ContractVersion !== CONTRACT_VERSION) {
        throw new Error(`Unsupported canoe-project.json contract: ${projectDescriptor.ContractVersion}`);
    }
    const configPath = requireRelativePath(projectDescriptor.Configuration, "Configuration");
    configurationUri = `workspace://canoe-project/${configPath}`;
    if (!fs.exists(configurationUri)) {
        throw new Error(`CANoe configuration is missing: ${configPath}`);
    }
    firmwareUri = `workspace://firmware/${fileName(softwarePackage)}`;
    fs.copy(softwarePackage, firmwareUri);
    task.progress(5, "Inputs prepared");
}

export async function launch() {
    if (task.option("MockAutomation", false)) {
        task.log("info", "Using the in-process CANoe Automation simulator");
        return;
    }
    const executable = task.device("CANOE_SOFTWARE_POSITION");
    const process = cli.start({ executable, arguments: [] });
    launchedByTask = true;
    task.output("CANOE_PROCESS", process);
    task.log("info", `CANoe started with PID ${process.pid}`);
    await task.delay(1500);
}

export async function connect() {
    const attachExisting = task.option("AttachExisting", false);
    application = attachExisting ? com.getActive("CANoe.Application") : com.create("CANoe.Application");
    task.log("info", attachExisting ? "Attached to an existing CANoe instance" : "Connected to CANoe Automation");
}

export async function startMeasurement() {
    application.call("Open", fs.nativePath(configurationUri));
    measurement = application.get("Measurement");
    if (!measurement.get("Running")) {
        measurement.call("Start");
    }
    await waitUntil(() => measurement.get("Running") === true, 30000, "CANoe Measurement to start");
    task.progress(10, "CANoe Measurement is running");
}

export async function validateContract() {
    const actualVersion = String(getVariable("ContractVersion"));
    if (actualVersion !== CONTRACT_VERSION) {
        throw new Error(`CICT::Flash contract mismatch: expected ${CONTRACT_VERSION}, got ${actualVersion}`);
    }
    const state = Number(getVariable("State"));
    if (state !== STATE.idle && state !== STATE.ready) {
        throw new Error(`CICT::Flash is busy (state ${state})`);
    }
    task.progress(15, "CICT::Flash contract is ready");
}

export async function flash() {
    const requestId = task.id();
    setVariable("Command", COMMAND.reset);
    await waitUntil(() => Number(getVariable("State")) === STATE.ready, 10000, "CICT::Flash reset");
    setVariable("RequestId", requestId);
    setVariable("FirmwarePath", fs.nativePath(firmwareUri));
    setVariable("Command", COMMAND.start);

    while (true) {
        if (task.isCancelled()) {
            setVariable("Command", COMMAND.cancel);
            await waitUntil(() => Number(getVariable("State")) === STATE.cancelled,
                            10000,
                            "CICT::Flash cancellation",
                            true);
            task.checkCancelled();
        }
        const state = Number(getVariable("State"));
        const progress = Math.max(0, Math.min(100, Number(getVariable("Progress"))));
        const activeRequestId = String(getVariable("ActiveRequestId"));
        task.progress(15 + Math.round(progress * 0.8), `CANoe flash state ${state}`, { state, progress, activeRequestId });
        if (state === STATE.succeeded || state === STATE.failed || state === STATE.cancelled) {
            const resultCode = Number(getVariable("ResultCode"));
            const resultMessage = String(getVariable("ResultMessage"));
            const reportedVersion = String(getVariable("ReportedVersion"));
            task.output("REQUEST_ID", requestId);
            task.output("RESULT_CODE", resultCode);
            task.output("RESULT_MESSAGE", resultMessage);
            task.output("REPORTED_VERSION", reportedVersion);
            if (activeRequestId !== requestId || state !== STATE.succeeded || resultCode !== 0) {
                throw new Error(`Flash failed: state=${state}, code=${resultCode}, message=${resultMessage}`);
            }
            task.progress(96, "ECU flash and verification succeeded");
            return;
        }
        await task.delay(500);
    }
}

export async function collectArtifacts() {
    const collected = [];
    const artifacts = Array.isArray(projectDescriptor.Artifacts) ? projectDescriptor.Artifacts : [];
    for (const entry of artifacts) {
        const relativePath = requireRelativePath(entry, "Artifacts entry");
        const source = `workspace://canoe-project/${relativePath}`;
        if (fs.exists(source)) {
            const destination = `artifact://${fileName(relativePath)}`;
            fs.copy(source, destination);
            collected.push(destination);
            task.artifact(destination);
        }
    }
    task.output("ARTIFACTS", collected);
    task.progress(100, "Flash artifacts collected");
}

export async function cleanup() {
    if (application === null) {
        return;
    }
    try {
        const state = Number(getVariable("State"));
        if (state === STATE.running || state === STATE.verifying) {
            setVariable("Command", COMMAND.cancel);
            await task.delay(500, true);
        }
    } catch (error) {
        task.log("warning", `Unable to cancel active flash during cleanup: ${error.message}`);
    }
    try {
        if (measurement !== null && measurement.get("Running")) {
            measurement.call("Stop");
        }
    } catch (error) {
        task.log("warning", `Unable to stop CANoe Measurement: ${error.message}`);
    }
    try {
        if (launchedByTask || task.option("QuitAttachedInstance", false)) {
            application.call("Quit");
        }
    } finally {
        application.release();
        application = null;
        measurement = null;
        flashVariables = null;
    }
}
