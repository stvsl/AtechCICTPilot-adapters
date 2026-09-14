import * as fs from "@atech/fs";
import * as task from "@atech/task";

import {
    CanoeSession,
    errorMessage,
    isAutomationDisconnectFailure
} from "./canoe_flash/session.js";

/*
 * CANoe Automation 模型保留在适配器中；宿主只提供通用 COM 桥，
 * 诊断和 CAPL 逻辑由 CANoe 工程中的 FlashDownLoad 测试模块负责。
 */
const CONTRACT_VERSION = "1.0";
const DEFAULT_FLASH_MODULE = "FlashDownLoad";
const DEFAULT_INPUT_DIRECTORY = "Input";
const DEFAULT_CONFIGURATION_TIMEOUT_MS = 120000;
const DEFAULT_FLASH_TIMEOUT_MS = 1800000;
const CANOE_AUTOMATION_READY_TIMEOUT_MS = 120000;
const CANOE_MEASUREMENT_STOP_TIMEOUT_MS = 120000;
const CANOE_CONFIGURATION_READY_TIMEOUT_MS = 120000;
const CANOE_TEST_SETUP_READY_TIMEOUT_MS = 120000;
const CANOE_POLL_INTERVAL_MS = 250;

let userFiles = null;
let flashModule = null;
let flashReport = null;
let projectDescriptor = null;
let projectRootUri = "";
let configurationUri = "";
let firmwareUri = "";
let reportUri = "";
let inputDirectoryUri = "";
let flashParameters = {};
let flashStarted = false;

function debug(message) {
    task.info(`[CANoe debug] ${message}`);
}

const canoe = new CanoeSession({
    version: task.device("CANOE_VERSION"),
    intervalMs: CANOE_POLL_INTERVAL_MS,
    debug
});
const wait = canoe.waiter;

function requireSafeRelativePath(value, field) {
    if (typeof value !== "string" || value.length === 0
            || value.includes("\\") || value.startsWith("/")
            || value.includes(":")
            || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
        throw new Error(`${field} must be a safe relative path`);
    }
    return value;
}

function baseName(uri) {
    const parts = String(uri).split("/");
    const name = parts[parts.length - 1];
    if (!name || name === "." || name === "..") {
        throw new Error(`Unable to determine a file name from ${uri}`);
    }
    return name;
}

function clamp(value, lower, upper) {
    return Math.max(lower, Math.min(upper, Number(value)));
}

function optionalRequirement(key) {
    try {
        return task.requirement(key);
    } catch (_) {
        return "";
    }
}

function canoeStartMode() {
    let value;
    try {
        value = task.device("NEW_CANOE_WHEN_START");
    } catch (_) {
        const attachExisting = Boolean(task.option("AttachExisting", false));
        return {attachExisting, clearExisting: !attachExisting};
    }
    if (value === undefined || value === null || String(value).trim() === "") {
        const attachExisting = Boolean(task.option("AttachExisting", false));
        return {attachExisting, clearExisting: !attachExisting};
    }
    if (typeof value === "boolean") {
        return { attachExisting: !value, clearExisting: value };
    }
    const normalized = String(value).trim().toLowerCase();
    if (normalized === "true") {
        return { attachExisting: false, clearExisting: true };
    }
    if (normalized === "false") {
        return { attachExisting: true, clearExisting: false };
    }
    throw new Error("NEW_CANOE_WHEN_START must be true or false");
}

function readJson(uri, field) {
    if (!uri || !fs.exists(uri)) {
        throw new Error(`${field} does not exist`);
    }
    let value;
    try {
        value = JSON.parse(fs.readText(uri));
    } catch (error) {
        throw new Error(`${field} is not valid JSON: ${error.message}`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${field} must contain a JSON object`);
    }
    return value;
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function applySystemVariables(uri, values) {
    if (!uri || Object.keys(values).length === 0) {
        return;
    }
    let xml = fs.readText(uri);
    let changed = 0;
    xml = xml.replace(/<variable\b[^>]*>/gi, (tag) => {
        const nameMatch = tag.match(/\bname\s*=\s*([\"'])(.*?)\1/i);
        if (!nameMatch || !Object.prototype.hasOwnProperty.call(values, nameMatch[2])) {
            return tag;
        }
        const value = escapeXml(values[nameMatch[2]]);
        const startValue = new RegExp("\\bstartValue\\s*=\\s*([\\\"'])(.*?)\\1", "i");
        changed += 1;
        if (startValue.test(tag)) {
            return tag.replace(startValue, `startValue=\"${value}\"`);
        }
        return tag.replace(/\s*\/?>(\s*)$/, ` startValue=\"${value}\"$&`);
    });
    if (changed > 0) {
        fs.writeText(uri, xml);
        task.info(`Updated ${changed} CANoe system variable(s): ${uri}`);
    }
}

function findFile(rootUri, predicate) {
    if (!rootUri || !fs.exists(rootUri)) {
        return "";
    }
    const entries = fs.list(rootUri, true);
    for (const entry of entries) {
        if (entry.type === "file" && predicate(entry)) {
            return entry.uri;
        }
    }
    return "";
}

function descriptorPath(name, fallback) {
    const value = projectDescriptor && projectDescriptor[name];
    return value === undefined || value === null || value === "" ? fallback : value;
}

function normalizeName(value) {
    return String(value).trim().toLowerCase();
}

function collectionCount(collection) {
    try {
        const count = Number(collection.get("Count"));
        return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
    } catch (error) {
        throwIfAutomationDisconnected(error);
        return 0;
    }
}

function collectionItem(collection, index) {
    try {
        return collection.item(index + 1);
    } catch (error) {
        throwIfAutomationDisconnected(error);
        return collection.item(index);
    }
}

function collectionItems(collection) {
    const result = [];
    const count = collectionCount(collection);
    for (let index = 0; index < count; ++index) {
        try {
            result.push(collectionItem(collection, index));
        } catch (error) {
            throwIfAutomationDisconnected(error);
            break;
        }
    }
    return result;
}

function findNamed(collection, expectedName) {
    const wanted = normalizeName(expectedName);
    for (const item of collectionItems(collection)) {
        try {
            if (normalizeName(item.get("Name")) === wanted) {
                return item;
            }
        } catch (error) {
            throwIfAutomationDisconnected(error);
            // 后续缺少模块的错误会包含可操作的模块名称。
        }
    }
    return null;
}

function optionalProperty(object, name) {
    try {
        return object.get(name);
    } catch (error) {
        throwIfAutomationDisconnected(error);
        return undefined;
    }
}

function stateIsTerminal(state) {
    const value = normalizeName(state);
    return value === "0" || value === "stopped" || value === "finished"
        || value === "completed" || value === "passed" || value === "failed"
        || value === "cstopped" || value === "cfinished"
        || value === "ccompleted" || value === "cpassed" || value === "cfailed"
        || value === "cverdictpassed" || value === "cverdictfailed";
}

function moduleFinished() {
    if (!flashStarted) {
        return false;
    }
    const running = optionalProperty(flashModule, "Running");
    if (running !== undefined) {
        return running !== true;
    }
    const state = optionalProperty(flashModule, "State");
    if (state !== undefined) {
        return stateIsTerminal(state);
    }
    const report = reportPathUri();
    return Boolean(report && fs.exists(report));
}

function stopFlashModule() {
    if (flashModule !== null && !moduleFinished()) {
        flashModule.call("Stop");
    }
}

function moduleProgress() {
    const progress = optionalProperty(flashModule, "Progress");
    if (progress === undefined) {
        return 0;
    }
    const value = Number(progress);
    return Number.isFinite(value) ? clamp(value, 0, 100) : 0;
}

function moduleVerdict() {
    const verdict = optionalProperty(flashModule, "Verdict");
    return verdict === undefined ? "" : normalizeName(verdict);
}

function verdictPassed(verdict) {
    const value = normalizeName(verdict);
    return value === "passed" || value === "pass" || value === "cverdictpassed"
        || value === "0";
}

function nativePathToWorkspaceUri(nativePath) {
    if (!nativePath || !projectRootUri) {
        return "";
    }
    const root = fs.nativePath(projectRootUri).replace(/\\/g, "/").replace(/\/$/, "");
    const candidate = String(nativePath).replace(/\\/g, "/");
    const lowerRoot = root.toLowerCase();
    const lowerCandidate = candidate.toLowerCase();
    if (lowerCandidate !== lowerRoot && !lowerCandidate.startsWith(`${lowerRoot}/`)) {
        return "";
    }
    const relative = candidate.substring(root.length).replace(/^\/+/, "");
    return relative ? `${projectRootUri}/${relative}` : projectRootUri;
}

function reportPathUri() {
    if (reportUri && fs.exists(reportUri)) {
        return reportUri;
    }
    if (flashReport === null) {
        return "";
    }
    const native = optionalProperty(flashReport, "LastWrittenFullName")
        || optionalProperty(flashReport, "LastWrittenFullPath");
    return nativePathToWorkspaceUri(native);
}

function expectedVersion() {
    if (projectDescriptor && projectDescriptor.ExpectedVersion) {
        return String(projectDescriptor.ExpectedVersion);
    }
    if (flashParameters.ExpectedVersion) {
        return String(flashParameters.ExpectedVersion);
    }
    const name = baseName(firmwareUri);
    const withoutExtension = name.replace(/\.[^.]+$/, "");
    const separator = withoutExtension.lastIndexOf("_");
    return separator >= 0 ? withoutExtension.substring(separator + 1) : withoutExtension;
}

function extractReportedVersion(uri) {
    if (!uri || !fs.exists(uri)) {
        return "";
    }
    const text = fs.readText(uri);
    const patterns = [
        /softwareVer\s*[:=]\s*[\"']?([^\"'\s<]+)/i,
        /ECUSoftwareVersionNumber\s*[=:>]\s*[\"']?([^\"'\s<]+)/i,
        /F189\s*[:=]\s*[\"']?([^\"'\s<]+)/i,
        /software[_ ]?version\s*[:=]\s*[\"']?([^\"'\s<]+)/i
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            return match[1].trim();
        }
    }
    return "";
}

function release(object) {
    if (object === null || object === undefined) {
        return;
    }
    try {
        object.release();
    } catch (_) {
        // 阶段结束后，宿主也会回收所有剩余句柄。
    }
}

function throwIfAutomationDisconnected(error) {
    if (!isAutomationDisconnectFailure(error)) {
        return;
    }
    if (error && typeof error === "object") {
        error.canoeFatal = true;
        throw error;
    }
    const disconnected = new Error(`CANoe Automation disconnected: ${error}`);
    disconnected.canoeFatal = true;
    throw disconnected;
}

function hasFlashTestSetup() {
    const currentConfiguration = canoe.configuration;
    const setup = optionalProperty(currentConfiguration, "TestSetup");
    const environments = setup === undefined || setup === null
        ? null : optionalProperty(setup, "TestEnvironments");
    return environments !== null && environments !== undefined
        && collectionCount(environments) > 0;
}

async function openConfiguration() {
    if (canoe.application === null) {
        throw new Error("CANoe Automation is not connected");
    }
    await canoe.openConfiguration(configurationUri, {
        setupReady: hasFlashTestSetup,
        setupDescription: "CANoe TestEnvironment to finish loading",
        configurationTimeoutMs: CANOE_CONFIGURATION_READY_TIMEOUT_MS,
        setupTimeoutMs: CANOE_TEST_SETUP_READY_TIMEOUT_MS,
        measurementStopTimeoutMs: CANOE_MEASUREMENT_STOP_TIMEOUT_MS
    });
}

export async function prepare(projectPackage, softwarePackage) {
    projectRootUri = "workspace://canoe-project";
    configurationUri = "";
    firmwareUri = "";
    reportUri = "";
    projectDescriptor = null;
    flashParameters = {};
    inputDirectoryUri = "";
    flashStarted = false;
    fs.extractZip(projectPackage, projectRootUri);
    const descriptorUri = `${projectRootUri}/canoe-project.json`;
    if (!fs.exists(descriptorUri)) {
        throw new Error("CANOE_PROJECT must contain canoe-project.json");
    }
    projectDescriptor = readJson(descriptorUri, "canoe-project.json");
    if (Array.isArray(projectDescriptor)) {
        throw new Error("canoe-project.json must contain an object");
    }
    if (String(projectDescriptor.ContractVersion) !== CONTRACT_VERSION) {
        throw new Error(`Unsupported canoe-project.json contract: ${projectDescriptor.ContractVersion}`);
    }

    const configurationPath = requireSafeRelativePath(
        descriptorPath("Configuration", ""), "Configuration");
    configurationUri = `${projectRootUri}/${configurationPath}`;
    if (!fs.exists(configurationUri)) {
        throw new Error(`CANoe configuration is missing: ${configurationPath}`);
    }

    const inputPath = requireSafeRelativePath(
        descriptorPath("InputDirectory", DEFAULT_INPUT_DIRECTORY), "InputDirectory");
    inputDirectoryUri = `${projectRootUri}/${inputPath}`;
    if (!fs.exists(inputDirectoryUri)) {
        fs.mkdir(inputDirectoryUri);
    }
    const firmwareName = baseName(softwarePackage);
    firmwareUri = `${inputDirectoryUri}/${firmwareName}`;
    fs.copy(softwarePackage, firmwareUri, true);

    const parametersUri = optionalRequirement("FLASH_PARAMETERS");
    if (parametersUri) {
        const parameters = readJson(parametersUri, "FLASH_PARAMETERS");
        const variables = parameters.sysVariables || parameters.SysVariables
            || parameters.variables || parameters.Variables;
        flashParameters = variables && typeof variables === "object"
            ? Object.assign({}, parameters, variables) : parameters;
    }
    const variablePath = descriptorPath("SystemVariableFile", "");
    const variableUri = variablePath
        ? `${projectRootUri}/${requireSafeRelativePath(variablePath, "SystemVariableFile")}`
        : (() => {
            const variableDirectory = descriptorPath("SystemVariableDirectory", "");
            const directoryUri = variableDirectory
                ? `${projectRootUri}/${requireSafeRelativePath(variableDirectory, "SystemVariableDirectory")}`
                : projectRootUri;
            return findFile(directoryUri,
                            (entry) => entry.name.toLowerCase().endsWith(".vsysvar"));
        })();
    if (variableUri && !fs.exists(variableUri)) {
        throw new Error(`CANoe system variable file is missing: ${variablePath}`);
    }
    if (variableUri && !Object.prototype.hasOwnProperty.call(flashParameters, "fileName")) {
        flashParameters.fileName = firmwareName;
    }
    applySystemVariables(variableUri, flashParameters);
    task.info(`CANoe project prepared: ${configurationUri}`);
    task.progress(5);
}

export async function launch() {
    const startMode = canoeStartMode();
    if (startMode.attachExisting) {
        task.info("Attaching to an existing CANoe process");
        await canoe.launch({
            attachExisting: true,
            clearExisting: false
        });
        return;
    }
    const executable = task.device("CANOE_SOFTWARE_POSITION");
    await canoe.launch({
        attachExisting: false,
        clearExisting: startMode.clearExisting,
        executable,
        clearTimeoutMs: CANOE_AUTOMATION_READY_TIMEOUT_MS,
    });
    task.info(`CANoe process started from configured executable (pid=${canoe.process.pid})`);
}

export async function connect() {
    await canoe.connect({
        attached: canoe.attached,
        timeoutMs: CANOE_AUTOMATION_READY_TIMEOUT_MS
    });
    task.info(canoe.attached
        ? "Attached to an existing CANoe instance"
        : "Connected to CANoe Automation");
}

export async function startMeasurement() {
    await openConfiguration();
    await canoe.ensureMeasurementStarted({
        readyTimeoutMs: CANOE_AUTOMATION_READY_TIMEOUT_MS,
        startTimeoutMs: DEFAULT_CONFIGURATION_TIMEOUT_MS
    });
    task.progress(10);
}

export async function validateContract() {
    await openConfiguration();
    userFiles = canoe.configuration.get("UserFiles");
    const setup = canoe.configuration.get("TestSetup");
    const environments = setup.get("TestEnvironments");
    const environment = collectionItems(environments)[0];
    if (environment === undefined) {
        throw new Error("CANoe configuration does not contain a TestEnvironment");
    }
    const modules = environment.get("TestModules");
    const moduleName = descriptorPath("FlashModule", DEFAULT_FLASH_MODULE);
    flashModule = findNamed(modules, moduleName);
    if (flashModule === null) {
        throw new Error(`CANoe TestModule not found: ${moduleName}`);
    }
    flashModule.set("Enabled", true);
    flashStarted = false;
    flashReport = optionalProperty(flashModule, "Report");
    userFiles.call("Add", fs.nativePath(firmwareUri));
    task.info(`CANoe ${moduleName} module loaded`);
    task.progress(15);
}

export async function flash() {
    const timeout = Number(projectDescriptor && projectDescriptor.FlashTimeoutMs)
        || DEFAULT_FLASH_TIMEOUT_MS;
    if (flashModule === null) {
        throw new Error("FlashDownLoad module has not been loaded");
    }
    flashModule.set("ExecuteRepeatedly", false);
    flashModule.call("Start");
    flashStarted = true;
    await wait.delay(100, {onCancel: stopFlashModule});
    await wait.until(() => {
        const finished = moduleFinished();
        if (!finished) {
            const progress = moduleProgress();
            task.progress(15 + Math.round(progress * 0.8));
        }
        return finished;
    }, {
        timeoutMs: timeout,
        intervalMs: 500,
        description: "FlashDownLoad to finish",
        isReady: (value) => value === true,
        onCancel: stopFlashModule
    });
    reportUri = reportPathUri();
    const reportedVersion = extractReportedVersion(reportUri);
    const expected = expectedVersion();
    const verdict = moduleVerdict();
    if (!reportedVersion || reportedVersion !== expected
            || (verdict && !verdictPassed(verdict))) {
        throw new Error(`Flash verification failed: expected ${expected}, got ${reportedVersion || "<empty>"}`);
    }
    task.progress(96);
}

export async function collectArtifacts() {
    const artifactPaths = Array.isArray(projectDescriptor && projectDescriptor.Artifacts)
        ? projectDescriptor.Artifacts.slice() : [];
    const finalReportUri = reportPathUri();
    const projectPrefix = `${projectRootUri}/`;
    if (finalReportUri && finalReportUri.startsWith(projectPrefix)) {
        const relativeReport = finalReportUri.substring(projectPrefix.length);
        if (!artifactPaths.includes(relativeReport)) {
            artifactPaths.push(relativeReport);
        }
    }
    for (const path of artifactPaths) {
        const relativePath = requireSafeRelativePath(path, "Artifacts entry");
        const source = `${projectRootUri}/${relativePath}`;
        if (!fs.exists(source)) {
            task.warning(`CANoe artifact is missing: ${relativePath}`);
            continue;
        }
        const destination = `artifact://canoe/${relativePath}`;
        fs.copy(source, destination, true);
        task.publish(source === finalReportUri ? "REPORT_URI" : `ARTIFACT:${relativePath}`,
                     destination,
                     baseName(relativePath),
                     relativePath.toLowerCase().endsWith(".json")
                         ? "application/json" : "application/octet-stream");
    }
    task.progress(100);
}

export async function cleanup() {
    try {
        try {
            stopFlashModule();
        } catch (error) {
            task.warning(`Unable to stop FlashDownLoad: ${errorMessage(error)}`);
        }
        await canoe.close({
            quit: canoe.ownsProcess || Boolean(task.option("QuitAttachedInstance", false))
        });
    } finally {
        release(flashReport);
        release(flashModule);
        release(userFiles);
        userFiles = null;
        flashModule = null;
        flashReport = null;
        projectDescriptor = null;
        projectRootUri = "";
        configurationUri = "";
        firmwareUri = "";
        reportUri = "";
        inputDirectoryUri = "";
        flashParameters = {};
        flashStarted = false;
    }
}
