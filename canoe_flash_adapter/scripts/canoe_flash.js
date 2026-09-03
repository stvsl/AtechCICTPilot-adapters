import * as com from "@atech/com";
import * as fs from "@atech/fs";
import * as cli from "@atech/cli";
import * as task from "@atech/task";

/*
 * CANoe's Automation model is intentionally kept in this adapter. The host
 * only provides the generic COM/CLI bridge, while the CANoe project owns the
 * diagnostic and CAPL implementation of the FlashDownLoad test module.
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
const CANOE_ACTIVE_OBJECT_GRACE_TIMEOUT_MS = 3000;

let application = null;
let measurement = null;
let configuration = null;
let userFiles = null;
let flashModule = null;
let flashReport = null;
let canoeProcess = null;
let projectDescriptor = null;
let projectRootUri = "";
let configurationUri = "";
let firmwareUri = "";
let reportUri = "";
let inputDirectoryUri = "";
let flashParameters = {};
let launchedByTask = false;
let attachExisting = false;
let measurementRunning = false;
let flashStarted = false;

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

async function clearExistingCanoe() {
    let existingApplication = null;
    try {
        existingApplication = com.getActive("CANoe.Application");
    } catch (_) {
        return;
    }
    try {
        existingApplication.call("Quit");
        task.info("Closed existing CANoe instance before starting a new one");
    } catch (error) {
        throw new Error(`Unable to close existing CANoe instance: ${error.message}`);
    } finally {
        release(existingApplication);
    }
    await waitUntil(() => {
        let activeApplication = null;
        try {
            activeApplication = com.getActive("CANoe.Application");
            return false;
        } catch (_) {
            return true;
        } finally {
            release(activeApplication);
        }
    }, CANOE_AUTOMATION_READY_TIMEOUT_MS,
    "the existing CANoe Automation server to stop");
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
    } catch (_) {
        return 0;
    }
}

function collectionItem(collection, index) {
    try {
        return collection.item(index + 1);
    } catch (_) {
        return collection.item(index);
    }
}

function collectionItems(collection) {
    const result = [];
    const count = collectionCount(collection);
    for (let index = 0; index < count; ++index) {
        try {
            result.push(collectionItem(collection, index));
        } catch (_) {
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
        } catch (_) {
            // The missing-module error below contains the actionable name.
        }
    }
    return null;
}

function optionalProperty(object, name) {
    try {
        return object.get(name);
    } catch (_) {
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

async function waitUntil(predicate, timeoutMs, description, ignoreCancellation = false) {
    const started = Date.now();
    let lastError = "";
    while (true) {
        if (!ignoreCancellation) {
            task.checkCancelled();
        }
        try {
            if (predicate()) {
                return;
            }
        } catch (error) {
            if (error && error.canoeFatal === true) {
                throw error;
            }
            lastError = errorMessage(error);
        }
        if (Date.now() - started >= timeoutMs) {
            const detail = lastError ? `; last COM error: ${lastError}` : "";
            throw new Error(`Timed out waiting for ${description} after ${timeoutMs} ms${detail}`);
        }
        await task.delay(CANOE_POLL_INTERVAL_MS, ignoreCancellation);
    }
}

function release(object) {
    if (object === null || object === undefined) {
        return;
    }
    try {
        object.release();
    } catch (_) {
        // The host also releases all remaining handles after the stage.
    }
}

function adoptAutomationHandles(applicationCandidate, measurementCandidate) {
    release(measurement);
    release(application);
    application = applicationCandidate;
    measurement = measurementCandidate;
}

function refreshMeasurement() {
    if (application === null || application === undefined) {
        throw new Error("CANoe Automation is not connected");
    }
    let candidate = null;
    try {
        // 打开配置后 CANoe 可能重建 Measurement 对象，不能继续复用旧代理。
        candidate = application.get("Measurement");
        candidate.get("Running");
        release(measurement);
        measurement = candidate;
        candidate = null;
    } finally {
        release(candidate);
    }
}

function isTransientComFailure(error) {
    const message = errorMessage(error);
    return /0x800706ba|rpc|server unavailable|服务器不可用|call was rejected|调用被拒绝|server busy|服务器忙/i
        .test(message);
}

function tryConnectToActiveAutomationServer() {
    let candidate = null;
    let candidateMeasurement = null;
    try {
        candidate = com.getActive("CANoe.Application");
        candidateMeasurement = candidate.get("Measurement");
        candidateMeasurement.get("Running");
        adoptAutomationHandles(candidate, candidateMeasurement);
        candidate = null;
        candidateMeasurement = null;
        return true;
    } catch (_) {
        release(candidateMeasurement);
        release(candidate);
        return false;
    }
}

function connectWithComActivation() {
    let createdApplication = null;
    let createdMeasurement = null;
    try {
        createdApplication = com.create("CANoe.Application");
        createdMeasurement = createdApplication.get("Measurement");
        createdMeasurement.get("Running");
        adoptAutomationHandles(createdApplication, createdMeasurement);
        createdApplication = null;
        createdMeasurement = null;
    } catch (error) {
        release(createdMeasurement);
        release(createdApplication);
        throw new Error(`Unable to connect to CANoe Automation: ${errorMessage(error)}`);
    }
}

async function readMeasurementRunning(description) {
    let running = false;
    await waitUntil(() => {
        try {
            if (measurement === null || measurement === undefined) {
                refreshMeasurement();
            }
            running = measurement.get("Running") === true;
            return true;
        } catch (error) {
            if (!isTransientComFailure(error)) {
                error.canoeFatal = true;
                throw error;
            }
            // CANoe 在切换配置时会短暂撤销旧的 Automation 代理，重新绑定活动对象。
            tryConnectToActiveAutomationServer();
            return false;
        }
    }, CANOE_AUTOMATION_READY_TIMEOUT_MS, description);
    return running;
}

async function callMeasurementCommand(command, expectedRunning) {
    try {
        measurement.call(command);
        return;
    } catch (error) {
        if (!isTransientComFailure(error)) {
            throw error;
        }
        // COM 调用可能已经在 CANoe 端生效，只是返回路径在代理切换时中断。
        const running = await readMeasurementRunning(
            "CANoe Measurement Automation object to recover");
        if (running === expectedRunning) {
            return;
        }
        measurement.call(command);
    }
}

async function waitForMeasurementState(expected, timeoutMs, description) {
    await waitUntil(() => {
        try {
            if (measurement === null || measurement === undefined) {
                refreshMeasurement();
            }
            return measurement.get("Running") === expected;
        } catch (error) {
            if (!isTransientComFailure(error)) {
                error.canoeFatal = true;
                throw error;
            }
            // 轮询期间同样允许 CANoe 重建 Measurement 对象。
            tryConnectToActiveAutomationServer();
            return false;
        }
    }, timeoutMs, description);
}

function errorMessage(error) {
    return error && error.message ? String(error.message) : String(error);
}

function isTransientOpenFailure(error) {
    return /COM invocation failed/i.test(errorMessage(error));
}

function checkOpenResult(resultOverride) {
    const openResult = resultOverride === undefined || resultOverride === null
        ? optionalProperty(configuration, "OpenConfigurationResult")
            || optionalProperty(application, "OpenConfigurationResult")
        : resultOverride;
    if (openResult === undefined || openResult === null) {
        // OpenConfigurationResult is not exposed by every CANoe release. The
        // Configuration object itself is the portable readiness signal.
        return true;
    }

    const resultCode = typeof openResult === "number"
        ? openResult : optionalProperty(openResult, "result")
            || optionalProperty(openResult, "Result");
    const openError = optionalProperty(openResult, "ErrorMessage");
    release(openResult);
    if (resultCode === undefined || resultCode === null
            || Number(resultCode) === 0) {
        return true;
    }
    if (Number(resultCode) === 2) {
        task.warning(`CANoe opened the configuration with a warning${
            openError ? `: ${openError}` : ""}`);
        return true;
    }
    const detail = openError ? `: ${openError}`
        : ` with result ${resultCode}`;
    const error = new Error(`CANoe configuration open failed${detail}`);
    error.canoeFatal = true;
    throw error;
}

function hasFlashTestSetup() {
    const setup = optionalProperty(configuration, "TestSetup");
    const environments = setup === undefined || setup === null
        ? null : optionalProperty(setup, "TestEnvironments");
    return environments !== null && environments !== undefined
        && collectionCount(environments) > 0;
}

async function waitForFlashTestSetup() {
    await waitUntil(hasFlashTestSetup, CANOE_TEST_SETUP_READY_TIMEOUT_MS,
                    "CANoe TestEnvironment to finish loading");
}

async function waitForConfigurationReady() {
    await waitUntil(() => {
        try {
            if (configuration === null) {
            const opened = application.get("Configuration");
            if (opened === null || opened === undefined) {
                return false;
            }
                configuration = opened;
            }
            return checkOpenResult();
        } catch (error) {
            if (!isTransientComFailure(error)) {
                error.canoeFatal = true;
                throw error;
            }
            // Open 期间 Application 也可能被 CANoe 重建；下一轮从 ROT 获取新代理。
            if (tryConnectToActiveAutomationServer()) {
                release(configuration);
                configuration = null;
            }
            return false;
        }
    }, CANOE_CONFIGURATION_READY_TIMEOUT_MS,
    "CANoe configuration to finish loading");
}

async function stopMeasurementBeforeOpening() {
    const running = await readMeasurementRunning(
        "CANoe Measurement Automation object to become available");
    if (!running) {
        return;
    }
    await callMeasurementCommand("Stop", false);
    await waitForMeasurementState(
        false,
        CANOE_MEASUREMENT_STOP_TIMEOUT_MS,
        "CANoe Measurement to stop before opening the configuration");
}

async function waitForAutomationServer() {
    await waitUntil(tryConnectToActiveAutomationServer,
                    CANOE_AUTOMATION_READY_TIMEOUT_MS,
    "CANoe Automation server to become available");
}

async function connectToStartedAutomationServer() {
    const started = Date.now();
    debug("connect: checking whether the started CANoe instance is active");
    while (Date.now() - started < CANOE_ACTIVE_OBJECT_GRACE_TIMEOUT_MS) {
        task.checkCancelled();
        if (tryConnectToActiveAutomationServer()) {
            return;
        }
        await task.delay(CANOE_POLL_INTERVAL_MS);
    }

    // 部分 CANoe 版本不会把 -embedding 实例及时注册到 ROT，只能通过 ProgID 激活。
    debug("connect: calling com.create(CANoe.Application)");
    connectWithComActivation();
}

async function openConfiguration() {
    if (application === null) {
        throw new Error("CANoe Automation is not connected");
    }
    if (configuration !== null) {
        await waitForConfigurationReady();
        await waitForFlashTestSetup();
        return;
    }
    // The task workspace is disposable, so CANoe may persist an upgraded
    // configuration there. Keep prompts disabled for unattended execution.
    await stopMeasurementBeforeOpening();
    // Application.Open 会替换 Measurement 子对象，主动释放旧代理，避免后续访问失效句柄。
    release(measurement);
    measurement = null;
    try {
        application.call("Open", fs.nativePath(configurationUri), true, false);
    } catch (error) {
        if (isTransientOpenFailure(error)) {
            throw new Error("CANoe Application became unavailable after "
                + `initialization: ${errorMessage(error)}`);
        }
        throw error;
    }
    await waitForConfigurationReady();
    await waitForFlashTestSetup();
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
    attachExisting = false;

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
    attachExisting = startMode.attachExisting;
    if (attachExisting) {
        launchedByTask = false;
        task.info("Attaching to an existing CANoe process");
        return;
    }
    if (startMode.clearExisting) {
        await clearExistingCanoe();
    }
    const executable = task.device("CANOE_SOFTWARE_POSITION");
    canoeProcess = cli.start({
        executable,
        // CANoe's COM mode suppresses the disclaimer and other modal dialogs.
        arguments: ["-embedding"]
    });
    launchedByTask = true;
    task.info(`CANoe started with PID ${canoeProcess.pid}`);
}

export async function connect() {
    if (attachExisting) {
        await waitForAutomationServer();
    } else {
        await connectToStartedAutomationServer();
    }
    task.info(attachExisting
        ? "Attached to an existing CANoe instance"
        : "Connected to CANoe Automation");
}

export async function startMeasurement() {
    await openConfiguration();
    let running = await readMeasurementRunning(
        "CANoe Measurement Automation object to become available");
    if (!running) {
        await callMeasurementCommand("Start", true);
    }
    await waitForMeasurementState(
        true,
        DEFAULT_CONFIGURATION_TIMEOUT_MS,
        "CANoe Measurement to start");
    measurementRunning = true;
    task.progress(10);
}

export async function validateContract() {
    await openConfiguration();
    userFiles = configuration.get("UserFiles");
    const setup = configuration.get("TestSetup");
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
    const requestStarted = Date.now();
    const timeout = Number(projectDescriptor && projectDescriptor.FlashTimeoutMs)
        || DEFAULT_FLASH_TIMEOUT_MS;
    if (flashModule === null) {
        throw new Error("FlashDownLoad module has not been loaded");
    }
    flashModule.set("ExecuteRepeatedly", false);
    flashModule.call("Start");
    flashStarted = true;
    await task.delay(100);
    while (!moduleFinished()) {
        if (task.isCancelled()) {
            try {
                flashModule.call("Stop");
            } finally {
                task.checkCancelled();
            }
        }
        if (Date.now() - requestStarted >= timeout) {
            throw new Error("Timed out waiting for FlashDownLoad to finish");
        }
        const progress = moduleProgress();
        task.progress(15 + Math.round(progress * 0.8));
        await task.delay(500);
    }
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
        if (flashModule !== null && !moduleFinished()) {
            flashModule.call("Stop");
        }
    } catch (error) {
        task.warning(`Unable to stop FlashDownLoad: ${error.message}`);
    }
    try {
        if (measurement !== null && measurementRunning && measurement.get("Running") === true) {
            measurement.call("Stop");
        }
    } catch (error) {
        task.warning(`Unable to stop CANoe Measurement: ${error.message}`);
    }
    try {
        if (application !== null
                && (launchedByTask || Boolean(task.option("QuitAttachedInstance", false)))) {
            application.call("Quit");
        }
    } catch (error) {
        task.warning(`Unable to quit CANoe: ${error.message}`);
    }
    if (canoeProcess !== null) {
        try {
            if (cli.isRunning(canoeProcess)) {
                cli.terminate(canoeProcess, 3000);
            }
        } catch (error) {
            task.warning(`Unable to terminate CANoe process: ${error.message}`);
        }
        try {
            cli.release(canoeProcess);
        } catch (_) {
            // The host will reclaim an unreleased process handle.
        }
    }
    release(flashReport);
    release(flashModule);
    release(userFiles);
    release(configuration);
    release(measurement);
    release(application);
    application = null;
    measurement = null;
    configuration = null;
    userFiles = null;
    flashModule = null;
    flashReport = null;
    canoeProcess = null;
    measurementRunning = false;
    launchedByTask = false;
    attachExisting = false;
    flashStarted = false;
}
