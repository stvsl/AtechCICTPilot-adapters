import * as fs from "@atech/fs";
import * as cli from "@atech/cli";
import * as task from "@atech/task";

import {
    configureNativeReport,
    isTransientReportViewerFailure,
    nativeReportFormat,
    waitForNativeReportOutputs
} from "./canoe_test/report_automation.js";
import {
    cliResultText,
    isNativeReportUri,
    ReportFileTracker
} from "./canoe_test/report_files.js";
import {
    CanoeSession,
    isAutomationDisconnectFailure
} from "./canoe_test/session.js";
import {
    parseTestCaseConfiguration,
    selectCompatibleConfigurations,
    sortConfigurationPaths,
    validateConfigurationPaths
} from "./canoe_test/project_plan.js";

const DEFAULT_TEST_TIMEOUT_MS = 1800000;
const CANOE_AUTOMATION_READY_TIMEOUT_MS = 120000;
const CANOE_MEASUREMENT_STOP_TIMEOUT_MS = 120000;
const CANOE_SABCMD_ID = "CANOE_SABCMD";
const CANOE_REPORT_VIEWER_ID = "CANOE_REPORT_VIEWER";
const CANOE_CONFIGURATION_READY_TIMEOUT_MS = 120000;
const CANOE_TEST_SETUP_READY_TIMEOUT_MS = 120000;
const CANOE_MEASUREMENT_START_TIMEOUT_MS = 120000;
const CANOE_POLL_INTERVAL_MS = 250;
const CANOE_REPORT_GENERATION_TIMEOUT_MS = 120000;
const CANOE_REPORT_CONVERSION_TIMEOUT_MS = 120000;
const CANOE_REPORT_CONVERSION_RETRY_INTERVAL_MS = 1000;
const CANOE_REPORT_STABLE_OBSERVATIONS = 3;
const REPORT_TYPE_VTESTREPORT = "vtestreport";
const REPORT_TYPE_XML = "XML";
const REPORT_TYPE_HTML = "HTML";
const REPORT_TYPE_PDF = "PDF";
// 必须与 PackageInfo.json 中 CANOE_REPORT_TYPE.values 的 ID 及顺序一致。
const SUPPORTED_REPORT_TYPES = [
    REPORT_TYPE_VTESTREPORT,
    REPORT_TYPE_XML,
    REPORT_TYPE_HTML,
    REPORT_TYPE_PDF
];
// 宿主单个任务最多保留 5000 条与用例明细；统计仍覆盖全部执行结果。
const REPORTED_TEST_CASE_LIMIT = 5000;

let testConfiguration = null;
let testConfigurationReport = null;
let testUnits = null;
let projectRootUri = "";
let configurationUri = "";
let configurationPlans = [];
let activeProject = null;
let projectOutcomes = [];
let summaryPublished = false;
let structuredResultsReported = false;
let currentReportPrefix = "";
let publicationTypeCounts = {};
let requestedTestCaseNames = [];
let results = [];
let testMode = "";
let communicationModules = [];
let activeCommunicationModules = [];
let reportTypes = [];
let generatedReports = [];
let executionFailureMessage = "";
let reportErrors = [];
let reportFileTracker = new ReportFileTracker();
let publishedArtifactUris = [];
let testStarted = false;
let expectedResultCount = 0;
let projectTestSetupReady = false;
let selectedTestCases = [];
let resolvedReportViewerExecutable = "";
let activeTestTarget = null;
let executionCompleted = false;

function debug(message) {
    task.info(`[CANoe debug] ${message}`);
}

const canoe = new CanoeSession({
    version: task.device("CANOE_VERSION"),
    intervalMs: CANOE_POLL_INTERVAL_MS,
    debug
});
const wait = canoe.waiter;

// py-canoe 的 TestConfiguration/TestModule 同样调用 Automation 的 Pause/Resume。
task.setPauseHandlers(
    () => {
        if (activeTestTarget !== null) {
            activeTestTarget.call("Pause");
        }
    },
    () => {
        if (activeTestTarget !== null) {
            activeTestTarget.call("Resume");
        }
    });

function baseName(uri) {
    const parts = String(uri).split("/");
    const name = parts[parts.length - 1];
    if (!name || name === "." || name === "..") {
        throw new Error(`Unable to determine a file name from ${uri}`);
    }
    return name;
}

function normalize(value) {
    return String(value === undefined || value === null ? "" : value)
        .trim().toLowerCase();
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
        return {attachExisting};
    }
    if (value === undefined || value === null || String(value).trim() === "") {
        const attachExisting = Boolean(task.option("AttachExisting", false));
        return {attachExisting};
    }
    if (typeof value === "boolean") {
        return {attachExisting: !value};
    }
    const normalized = String(value).trim().toLowerCase();
    if (normalized === "true") {
        return {attachExisting: false};
    }
    if (normalized === "false") {
        return {attachExisting: true};
    }
    throw new Error("NEW_CANOE_WHEN_START must be true or false");
}

function readJson(uri, field) {
    let value;
    try {
        value = JSON.parse(fs.readText(uri));
    } catch (error) {
        throw new Error(`${field} is not valid JSON: ${error.message}`);
    }
    if (value === null || typeof value !== "object") {
        throw new Error(`${field} must contain a JSON object or array`);
    }
    return value;
}

function parentUri(uri) {
    const index = String(uri).lastIndexOf("/");
    if (index <= "workspace://".length) {
        throw new Error(`Unable to determine a project directory from ${uri}`);
    }
    return String(uri).substring(0, index);
}

function relativePath(rootUri, uri) {
    const root = String(rootUri).replace(/\/$/, "");
    const prefix = `${root}/`;
    if (!String(uri).startsWith(prefix)) {
        throw new Error(`Project file is outside the extracted archive: ${uri}`);
    }
    return String(uri).substring(prefix.length);
}

function archiveFiles(rootUri) {
    return fs.list(rootUri, true).filter((entry) => entry.type === "file");
}

function relativeFiles(rootUri, entries) {
    return entries.map((entry) => relativePath(rootUri, entry.uri));
}

function findCanoeManifest(entries) {
    const manifests = entries.filter((entry) =>
        entry.name.toLowerCase() === "canoe.json");
    if (manifests.length > 1) {
        throw new Error("CANOE_PROJECT contains multiple canoe.json files");
    }
    return manifests.length === 1 ? manifests[0] : null;
}

function assignReportPrefixes(plans) {
    // 保留配置原名；Windows 目录不接受末尾的点或空格，空名使用固定回退。
    const stems = plans.map((plan) => baseName(plan.configuration)
        .replace(/\.cfg$/i, "").replace(/[. ]+$/g, "") || "canoe");
    const reserved = new Set(stems.map((stem) => stem.toLowerCase()));
    const occupied = new Set();
    return plans.map((plan, index) => {
        const stem = stems[index];
        let prefix = stem;
        if (occupied.has(prefix.toLowerCase())) {
            let sequence = 2;
            // 重名时追加编号，并跳过其他配置原本使用的名称。
            do {
                prefix = `${stem}-${sequence++}`;
            } while (occupied.has(prefix.toLowerCase())
                || reserved.has(prefix.toLowerCase()));
        }
        occupied.add(prefix.toLowerCase());
        return {...plan, reportPrefix: prefix};
    });
}

function buildConfigurationPlans(extractionRootUri, testCaseUri) {
    const extractedFiles = archiveFiles(extractionRootUri);
    const testCasePlans = testCaseUri
        ? parseTestCaseConfiguration(fs.readText(testCaseUri), testCaseUri) : null;
    const manifest = testCasePlans === null
        ? findCanoeManifest(extractedFiles) : null;
    let rootUri = extractionRootUri;
    let rootFiles = extractedFiles;

    if (testCasePlans === null && manifest !== null
            && manifest.uri !== `${extractionRootUri}/canoe.json`) {
        rootUri = parentUri(manifest.uri);
        rootFiles = archiveFiles(rootUri);
    }
    const availableConfigurations = relativeFiles(rootUri, rootFiles.filter((entry) =>
        entry.name.toLowerCase().endsWith(".cfg")));
    if (testCasePlans !== null) {
        const configurations = validateConfigurationPaths(
            testCasePlans.map((plan) => plan.configuration),
            availableConfigurations);
        const byPath = new Map(testCasePlans.map((plan) =>
            [plan.configuration.toLowerCase(), plan]));
        return {
            rootUri,
            source: "TEST_CASES",
            plans: configurations.map((configuration) => ({
                configuration,
                testCaseNames: byPath.get(configuration.toLowerCase()).testCaseNames
            }))
        };
    }

    let configurationPaths;
    let source;
    if (manifest !== null) {
        const manifestValue = readJson(manifest.uri, "canoe.json");
        configurationPaths = selectCompatibleConfigurations(
            manifestValue, canoe.version);
        source = `canoe.json (CANoe ${canoe.version} compatibility)`;
    } else {
        configurationPaths = sortConfigurationPaths(availableConfigurations);
        source = "archive .cfg files (relative path order)";
    }
    const resolvedConfigurations = validateConfigurationPaths(
        configurationPaths, availableConfigurations);
    if (resolvedConfigurations.length === 0) {
        throw new Error("CANOE_PROJECT does not contain a CANoe .cfg file");
    }
    return {
        rootUri,
        source,
        plans: resolvedConfigurations.map((configuration) => ({
            configuration,
            testCaseNames: []
        }))
    };
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
    if (Array.isArray(collection)) {
        return collection.slice();
    }
    const items = [];
    for (let index = 0; index < collectionCount(collection); ++index) {
        try {
            items.push(collectionItem(collection, index));
        } catch (error) {
            throwIfAutomationDisconnected(error);
            break;
        }
    }
    return items;
}

function optionalProperty(object, name) {
    try {
        return object.get(name);
    } catch (error) {
        throwIfAutomationDisconnected(error);
        return undefined;
    }
}

function propertyOr(object, names, fallback = undefined) {
    for (const name of names) {
        const value = optionalProperty(object, name);
        if (value !== undefined && value !== null) {
            return value;
        }
    }
    return fallback;
}

function release(object) {
    if (object === null || object === undefined) {
        return;
    }
    try {
        object.release();
    } catch (_) {
        // 工作线程退出时，宿主会回收仍未释放的句柄。
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

function nativePathToWorkspaceUri(nativePath) {
    if (!nativePath || !projectRootUri) {
        return "";
    }
    const root = fs.nativePath(projectRootUri).replace(/\\/g, "/").replace(/\/$/, "");
    let candidate = String(nativePath).trim().replace(/\\/g, "/");
    if (candidate.toLowerCase().startsWith("file://")) {
        candidate = candidate.substring("file://".length).replace(/^\/+/, "");
    }
    const isAbsolute = candidate.startsWith("/")
        || candidate.startsWith("//") || /^[a-z]:\//i.test(candidate);
    if (!isAbsolute) {
        const relative = candidate.replace(/^\/+/, "");
        if (relative.split("/").some((part) => part === "..")) {
            return "";
        }
        return relative === "" ? projectRootUri : `${projectRootUri}/${relative}`;
    }
    const lowerRoot = root.toLowerCase();
    const lowerCandidate = candidate.toLowerCase();
    if (lowerCandidate !== lowerRoot && !lowerCandidate.startsWith(`${lowerRoot}/`)) {
        return "";
    }
    return `${projectRootUri}/${candidate.substring(root.length).replace(/^\/+/, "")}`;
}

function addReportError(message) {
    const text = String(message === undefined || message === null ? "" : message).trim();
    if (text !== "" && !reportErrors.includes(text)) {
        reportErrors.push(text);
    }
}

function reportsDirectoryUri() {
    return `${projectRootUri}/reports`;
}

function nativeReportRequested() {
    return reportTypes.length > 0;
}

function reportFileSnapshot(uris = null) {
    try {
        const entries = Array.isArray(uris)
            ? uris.filter((uri, index) => uris.indexOf(uri) === index)
                .filter((uri) => fs.exists(uri))
                .map((uri) => fs.stat(uri))
            : fs.list(projectRootUri, true);
        return entries
            .filter((entry) => entry.type === "file"
                && isNativeReportUri(entry.uri))
            .map((entry) => ({
                uri: entry.uri,
                size: Number(entry.size) || 0,
                modifiedAt: entry.modifiedAt
            }));
    } catch (error) {
        debug(`report discovery: unable to inspect project files: ${errorMessage(error)}`);
        return [];
    }
}

function reportObjectWrittenUri(report) {
    // 只读取 CANoe 生成后的只读属性，绝不改写报告对象的输出路径。
    const nativePath = optionalProperty(report, "LastWrittenFullPath");
    const uri = nativePathToWorkspaceUri(nativePath);
    return uri && isNativeReportUri(uri) ? uri : "";
}

function preferredNativeReportUris() {
    const uris = [];
    if (testConfigurationReport !== null
            && testConfigurationReport !== undefined) {
        const uri = reportObjectWrittenUri(testConfigurationReport);
        if (uri && !uris.includes(uri)) {
            uris.push(uri);
        }
    }
    return uris;
}

function stableNativeReportUris() {
    const preferredUris = preferredNativeReportUris();
    // VTEST 只检查 Report 对象确认的最终路径，避免目录扫描提前拾取
    // CANoe 随后还会删除并重建的临时报告。
    const entries = testConfigurationReport !== null
            && testConfigurationReport !== undefined
        ? reportFileSnapshot(preferredUris) : reportFileSnapshot();
    const stableEntries = reportFileTracker.observe(entries, preferredUris);
    return stableEntries.map((entry) => entry.uri);
}

function executionState(object, started = true) {
    if (!started || object === null || object === undefined) {
        return { known: false, running: false };
    }
    let known = false;
    for (const name of ["Running", "Executing", "IsRunning"]) {
        const value = optionalProperty(object, name);
        if (value !== undefined && value !== null) {
            known = true;
            if (value === true) {
                return { known: true, running: true };
            }
        }
    }
    const state = normalize(optionalProperty(object, "State"));
    if (state !== "") {
        known = true;
        return {
            known,
            running: state === "1" || state === "running"
                || state === "executing" || state === "started"
                || state === "active" || state === "cstarting"
        };
    }
    return { known, running: false };
}

function objectRunning(object, started = true) {
    return executionState(object, started).running;
}

function moduleRunning() {
    return objectRunning(testConfiguration, testStarted);
}

function verdictIsAvailable(verdict) {
    const value = normalize(verdict);
    return value !== "" && value !== "cverdictnotavailable"
        && value !== "notavailable" && value !== "not available";
}

function verdictPassed(verdict) {
    const value = normalize(verdict);
    return value === "passed" || value === "pass" || value === "cverdictpassed"
        || value === "0";
}

function testCaseId(testCase) {
    return String(optionalProperty(testCase, "Id")
        || optionalProperty(testCase, "Name")
        || optionalProperty(testCase, "Caption") || "");
}

function testCaseName(testCase) {
    return String(optionalProperty(testCase, "Name")
        || optionalProperty(testCase, "Caption")
        || optionalProperty(testCase, "Id") || "");
}

function matchesRequestedTestCase(candidate) {
    return requestedTestCaseNames.length === 0
        || requestedTestCaseNames.includes(candidate.name);
}

function validateRequestedTestCases(candidates) {
    if (requestedTestCaseNames.length === 0) {
        return;
    }
    const available = new Set(candidates.map((candidate) => candidate.name));
    const missing = requestedTestCaseNames.filter((name) => !available.has(name));
    if (missing.length > 0) {
        throw new Error("TEST_CASES names do not match CANoe test cases: "
            + missing.join(", "));
    }
}

function walkElements(elements, unitName, parentEnabled = true, parents = []) {
    const local = [];
    for (const element of collectionItems(elements)) {
        const type = normalize(optionalProperty(element, "Type"));
        const id = testCaseId(element);
        const name = testCaseName(element);
        const enabled = parentEnabled && optionalProperty(element, "Enabled") !== false;
        const verdictValue = optionalProperty(element, "Verdict");
        const children = propertyOr(element, ["Elements", "Sequence"], null);
        const hasChildren = children !== undefined && children !== null
            && collectionCount(children) > 0;
        const isCase = type.includes("testcase") || type.includes("test_case")
            || (!hasChildren && verdictValue !== undefined && id !== "");
        if (isCase) {
            local.push({ testUnit: unitName, id, name, enabled, parents, object: element });
        }
        if (children !== undefined && children !== null) {
            const nested = walkElements(children, unitName, enabled, [...parents, element]);
            for (const child of nested) {
                local.push(child);
            }
        }
    }
    return local;
}

function selectProjectTestCases(candidates) {
    const selected = candidates.filter((candidate) =>
        matchesRequestedTestCase(candidate)
        && (requestedTestCaseNames.length > 0 || candidate.enabled));
    if (requestedTestCaseNames.length === 0) {
        return selected;
    }
    const parents = new Set();
    for (const candidate of candidates) {
        const enabled = selected.includes(candidate);
        try {
            candidate.object.set("Enabled", enabled);
        } catch (error) {
            throwIfAutomationDisconnected(error);
        }
        if (enabled) {
            candidate.parents.forEach((parent) => parents.add(parent));
        }
    }
    // 指定的用例可能在已禁用的测试组中，必须同时启用其全部父组。
    for (const parent of parents) {
        try {
            parent.set("Enabled", true);
        } catch (error) {
            throwIfAutomationDisconnected(error);
        }
    }
    return selected;
}

function collectVerdictsFrom(units) {
    const output = [];
    for (const unit of collectionItems(units)) {
        const unitName = String(optionalProperty(unit, "Name") || "");
        const elements = elementsFor(unit);
        if (elements === undefined || elements === null) {
            continue;
        }
        for (const candidate of walkElements(elements, unitName)) {
            if (!selectedTestCases.some((selected) => selected.testUnit === candidate.testUnit
                    && selected.id === candidate.id)) {
                continue;
            }
            const verdict = optionalProperty(candidate.object, "Verdict");
            if (!verdictIsAvailable(verdict)) {
                continue;
            }
            output.push({
                testUnit: candidate.testUnit,
                id: candidate.id,
                name: candidate.name,
                verdict: String(verdict === undefined ? "" : verdict),
                passed: verdictPassed(verdict)
            });
        }
    }
    return output;
}

function collectVerdicts() {
    return testMode === "communication"
        ? collectVerdictsFrom(activeCommunicationModules)
        : collectVerdictsFrom(testUnits);
}

function sameTestCase(left, right) {
    return left.testUnit === right.testUnit && left.id === right.id;
}

function recordCompletedResults(candidates) {
    for (const candidate of candidates) {
        if (results.some((result) => sameTestCase(result, candidate))) {
            continue;
        }
        results.push(candidate);
        task.resetTimeout();
        task.info(`[CANoe result] ${results.length}/${expectedResultCount}: `
            + `${candidate.id} - ${candidate.verdict}`);
    }
}

function selectedCaseCount(units) {
    return configuredTestCases(units).length;
}

function completedCaseCount(units) {
    const configured = configuredTestCases(units);
    return results.filter((result) => configured.some((candidate) =>
        sameTestCase(result, candidate))).length;
}

function configuredTestCases(units) {
    const output = [];
    for (const unit of collectionItems(units)) {
        if (requestedTestCaseNames.length === 0
                && optionalProperty(unit, "Enabled") === false) {
            continue;
        }
        const unitName = String(optionalProperty(unit, "Name") || "");
        const elements = elementsFor(unit);
        if (elements === null || elements === undefined) {
            continue;
        }
        for (const candidate of walkElements(elements, unitName)) {
            if (matchesRequestedTestCase(candidate)
                    && (requestedTestCaseNames.length > 0 || candidate.enabled)) {
                output.push({
                    testUnit: candidate.testUnit,
                    id: candidate.id,
                    name: candidate.name
                });
            }
        }
    }
    return output;
}

function testPassed() {
    return results.length > 0 && results.every((item) => item.passed);
}


function addGeneratedReport(type, uri) {
    if (!generatedReports.some((report) => report.type === type && report.uri === uri)) {
        generatedReports.push({type, uri});
    }
}

function reportViewerExecutable() {
    if (resolvedReportViewerExecutable === "") {
        resolvedReportViewerExecutable = cli.resolveExecutable(
            CANOE_REPORT_VIEWER_ID);
        task.info(`Resolved CANoe ${canoe.version} Report Viewer executable: `
            + resolvedReportViewerExecutable);
    }
    return resolvedReportViewerExecutable;
}

function parentNativePath(path) {
    const normalized = String(path === undefined || path === null ? "" : path)
        .trim().replace(/\\/g, "/").replace(/\/+$/, "");
    const separator = normalized.lastIndexOf("/");
    return separator > 0 ? normalized.substring(0, separator) : "";
}

function canoeExecutableDirectory() {
    const executable = canoe.installedExecutable();
    const directory = parentNativePath(executable);
    if (directory === "") {
        throw new Error(
            `CANoe ${canoe.version} executable path is invalid: ${executable}`);
    }
    return directory;
}

function sabCommandExecutable() {
    return cli.resolveExecutable(CANOE_SABCMD_ID);
}

function onePageStylesheetPath() {
    return `${canoeExecutableDirectory()}/Report/onepage.xslt`;
}

function nativeFileUri(path) {
    const normalized = String(path).trim().replace(/\\/g, "/");
    if (/^[A-Za-z]:\//.test(normalized)) {
        return `file:///${normalized}`;
    }
    if (normalized.startsWith("//")) {
        return `file:${normalized}`;
    }
    return normalized.startsWith("/")
        ? `file://${normalized}` : `file:///${normalized}`;
}


function reportViewerFailure(result, type, nativeReportPath) {
    const details = cliResultText(result);
    const suffix = details === "" ? "" : `: ${details}`;
    return `CANoe Report Viewer failed to create ${type} from "${nativeReportPath}" `
        + `(exit code ${result.exitCode})${suffix}`;
}

async function runReportViewer(nativeReportUri, option, outputUri, type,
                               executable) {
    const nativeReportPath = fs.nativePath(nativeReportUri);
    if (!fs.exists(nativeReportUri)) {
        throw new Error(`CANoe Report Viewer source report is missing: ${nativeReportPath}`);
    }
    const timeoutMs = CANOE_REPORT_CONVERSION_TIMEOUT_MS;
    const startedAt = Date.now();
    let attempt = 0;
    let lastFailure = "";
    while (true) {
        task.checkCancelled();
        const elapsed = Math.max(0, Date.now() - startedAt);
        if (attempt > 0 && elapsed >= timeoutMs) {
            throw new Error(lastFailure);
        }
        if (fs.exists(outputUri)) {
            // 每次尝试都清理目标，避免把失败尝试留下的文件误判为成功结果。
            fs.remove(outputUri);
        }
        ++attempt;
        const remaining = timeoutMs - elapsed;
        const result = cli.run({
            executable,
            arguments: [
                `-r=${nativeReportPath}`,
                `${option}=${fs.nativePath(outputUri)}`
            ],
            workingDirectoryUri: projectRootUri,
            timeoutMs: remaining
        });
        if (!result.crashed && result.exitCode === 0) {
            if (!fs.exists(outputUri)) {
                throw new Error(
                    `CANoe Report Viewer did not create the requested ${type} report`);
            }
            if (attempt > 1) {
                task.info(`CANoe Report Viewer created ${type} after ${attempt} attempts`);
            }
            return;
        }

        const failure = reportViewerFailure(result, type, nativeReportPath);
        lastFailure = failure;
        if (fs.exists(outputUri)) {
            // 失败尝试可能留下不完整文件，立即清理，避免污染后续产物收集。
            fs.remove(outputUri);
        }
        const retryRemaining = timeoutMs - Math.max(0, Date.now() - startedAt);
        if (!isTransientReportViewerFailure(result) || retryRemaining <= 1) {
            throw new Error(failure);
        }
        debug(`Report Viewer attempt ${attempt} is not ready; retrying ${type}: `
            + failure);
        await wait.delay(Math.min(CANOE_REPORT_CONVERSION_RETRY_INTERVAL_MS,
                                  retryRemaining - 1));
    }
}

export function reportOutputUri(type, index, total) {
    const suffix = total === 1 ? "" : `-${index + 1}`;
    const prefix = currentReportPrefix || "canoe-test";
    return `${reportsDirectoryUri()}/${prefix}-report${suffix}.${type.toLowerCase()}`;
}

function registerNativeReports(nativeReportUris) {
    for (const uri of nativeReportUris) {
        const lower = uri.toLowerCase();
        if (reportTypes.includes(REPORT_TYPE_VTESTREPORT)
                && lower.endsWith(".vtestreport")) {
            addGeneratedReport(REPORT_TYPE_VTESTREPORT, uri);
        }
        if (reportTypes.includes(REPORT_TYPE_XML) && lower.endsWith(".xml")) {
            addGeneratedReport(REPORT_TYPE_XML, uri);
        }
    }
}

function viewerInputUris(nativeReportUris) {
    const vtestReports = nativeReportUris.filter((uri) =>
        uri.toLowerCase().endsWith(".vtestreport"));
    return vtestReports.length > 0 ? vtestReports : nativeReportUris;
}

async function convertNativeReports(nativeReportUris, type, option,
                                    registerOutputs = true) {
    const requested = reportTypes.includes(type)
        || (type === REPORT_TYPE_XML
            && reportTypes.includes(REPORT_TYPE_HTML));
    if (!requested || nativeReportUris.length === 0) {
        return [];
    }
    let executable;
    try {
        executable = reportViewerExecutable();
    } catch (error) {
        addReportError(errorMessage(error));
        return [];
    }
    const inputs = viewerInputUris(nativeReportUris);
    const outputs = [];
    fs.mkdir(reportsDirectoryUri());
    for (let index = 0; index < inputs.length; ++index) {
        task.checkCancelled();
        const outputUri = reportOutputUri(type, index, inputs.length);
        try {
            await runReportViewer(inputs[index], option, outputUri, type,
                                  executable);
            outputs.push(outputUri);
            if (registerOutputs) {
                addGeneratedReport(type, outputUri);
            }
        } catch (error) {
            if (task.isCancelled()) {
                throw error;
            }
            addReportError(errorMessage(error));
            task.warning(errorMessage(error));
        }
    }
    return outputs;
}

function sabCommandFailure(result, xmlPath) {
    const details = cliResultText(result);
    const suffix = details === "" ? "" : `: ${details}`;
    return `CANoe sabcmd failed to create HTML from "${xmlPath}" `
        + `(exit code ${result.exitCode})${suffix}`;
}

function runHtmlTransform(xmlUri, outputUri, executable, stylesheet) {
    const xmlPath = fs.nativePath(xmlUri);
    if (!fs.exists(xmlUri)) {
        throw new Error(`CANoe HTML source report is missing: ${xmlPath}`);
    }
    if (fs.exists(outputUri)) {
        // 输出文件由本次转换独占，避免发布上一次执行遗留的 HTML。
        fs.remove(outputUri);
    }
    const result = cli.run({
        executable,
        arguments: [
            nativeFileUri(stylesheet),
            nativeFileUri(xmlPath),
            nativeFileUri(fs.nativePath(outputUri))
        ],
        workingDirectoryUri: projectRootUri,
        timeoutMs: CANOE_REPORT_CONVERSION_TIMEOUT_MS
    });
    if (result.crashed || result.exitCode !== 0) {
        throw new Error(sabCommandFailure(result, xmlPath));
    }
    if (!fs.exists(outputUri)) {
        throw new Error("CANoe sabcmd did not create the requested HTML report");
    }
}

function convertXmlReportsToHtml(xmlReportUris) {
    if (!reportTypes.includes(REPORT_TYPE_HTML) || xmlReportUris.length === 0) {
        return;
    }
    let executable;
    let stylesheet;
    try {
        executable = sabCommandExecutable();
        stylesheet = onePageStylesheetPath();
    } catch (error) {
        addReportError(errorMessage(error));
        return;
    }
    fs.mkdir(reportsDirectoryUri());
    for (let index = 0; index < xmlReportUris.length; ++index) {
        task.checkCancelled();
        const outputUri = reportOutputUri(
            REPORT_TYPE_HTML, index, xmlReportUris.length);
        try {
            runHtmlTransform(xmlReportUris[index], outputUri,
                             executable, stylesheet);
            addGeneratedReport(REPORT_TYPE_HTML, outputUri);
        } catch (error) {
            if (task.isCancelled()) {
                throw error;
            }
            addReportError(errorMessage(error));
            task.warning(errorMessage(error));
        }
    }
}

async function generateSelectedReports({ignoreCancellation = false} = {}) {
    const nativeReportUris = await waitForNativeReportOutputs({
        requested: nativeReportRequested(),
        waitForDiscovery: () => wait.until(
            () => stableNativeReportUris(),
            {
                timeoutMs: CANOE_REPORT_GENERATION_TIMEOUT_MS,
                description: "CANoe reports to be generated",
                isReady: (value) => value.length > 0,
                ignoreCancellation
            }),
        abortOnError: throwIfAutomationDisconnected,
        recordError: addReportError
    });
    registerNativeReports(nativeReportUris);

    if (nativeReportUris.length === 0 && reportTypes.length > 0) {
        addReportError("CANoe did not generate a native test report");
    }
    if (reportTypes.includes(REPORT_TYPE_VTESTREPORT)
            && !nativeReportUris.some((uri) =>
                uri.toLowerCase().endsWith(".vtestreport"))) {
        addReportError("CANoe did not generate the requested vtestreport output");
    }
    if (ignoreCancellation) {
        const conversionTypes = reportTypes.filter((type) =>
            type === REPORT_TYPE_HTML || type === REPORT_TYPE_PDF
                || (type === REPORT_TYPE_XML
                    && !nativeReportUris.some((uri) =>
                        uri.toLowerCase().endsWith(".xml"))));
        if (conversionTypes.length > 0) {
            addReportError("Report conversion was skipped during cancellation cleanup: "
                + conversionTypes.join(", "));
        }
        publishSelectedReports();
        return;
    }
    let xmlReportUris = nativeReportUris.filter((uri) =>
        uri.toLowerCase().endsWith(".xml"));
    const xmlRequired = reportTypes.includes(REPORT_TYPE_XML)
        || reportTypes.includes(REPORT_TYPE_HTML);
    if (xmlRequired && xmlReportUris.length === 0) {
        xmlReportUris = await convertNativeReports(
            nativeReportUris,
            REPORT_TYPE_XML,
            "-e",
            reportTypes.includes(REPORT_TYPE_XML));
    }
    publishSelectedReports();
    convertXmlReportsToHtml(xmlReportUris);
    publishSelectedReports();
    await convertNativeReports(nativeReportUris, REPORT_TYPE_PDF, "-p");
    publishSelectedReports();
}

function elementsFor(object) {
    return propertyOr(object, ["Elements", "Sequence"], null);
}

function communicationModuleKey(module) {
    return normalize(optionalProperty(module, "Name") || "");
}

function appendCommunicationModule(modules, module) {
    const key = communicationModuleKey(module);
    if (modules.includes(module)) {
        return;
    }
    if (key !== "" && modules.some((candidate) =>
            communicationModuleKey(candidate) === key)) {
        // 同一测试模块可能同时暴露在 TestModules 与 Items 集合中。
        release(module);
        return;
    }
    modules.push(module);
}

function collectCommunicationModules(environment, output) {
    const modules = optionalProperty(environment, "TestModules");
    for (const module of collectionItems(modules)) {
        appendCommunicationModule(output, module);
    }
    const items = optionalProperty(environment, "Items");
    for (const item of collectionItems(items)) {
        const nestedItems = optionalProperty(item, "Items");
        const sequence = propertyOr(item, ["Sequence", "Elements"], null);
        if (sequence !== null && sequence !== undefined) {
            appendCommunicationModule(output, item);
        } else if (nestedItems !== null && nestedItems !== undefined) {
            collectCommunicationModules(item, output);
        }
    }
}

function configureVtest() {
    const configurations = collectionItems(
        canoe.configuration.get("TestConfigurations"));
    if (configurations.length === 0) {
        throw new Error("CANoe project does not contain a TestConfiguration");
    }
    testConfiguration = requestedTestCaseNames.length > 0
        ? configurations[0]
        : configurations.find((configuration) =>
            optionalProperty(configuration, "Enabled") !== false);
    if (testConfiguration === undefined) {
        throw new Error("CANoe project does not have an enabled TestConfiguration");
    }
    if (requestedTestCaseNames.length > 0) {
        testConfiguration.set("Enabled", true);
    }
    testUnits = testConfiguration.get("TestUnits");
    const units = collectionItems(testUnits);
    const selected = [];
    const availableCases = [];
    for (const unit of units) {
        const unitEnabled = optionalProperty(unit, "Enabled") !== false;
        if (!unitEnabled && requestedTestCaseNames.length === 0) {
            continue;
        }
        const elements = elementsFor(unit);
        if (elements === null || elements === undefined) {
            continue;
        }
        const candidates = walkElements(
            elements, String(optionalProperty(unit, "Name") || ""));
        availableCases.push(...candidates);
        const selectedCandidates = selectProjectTestCases(candidates);
        if (requestedTestCaseNames.length > 0) {
            try {
                unit.set("Enabled", selectedCandidates.length > 0);
            } catch (error) {
                throwIfAutomationDisconnected(error);
                // 部分 CANoe 版本会隐式启用测试单元。
            }
        }
        for (const candidate of selectedCandidates) {
            selected.push(candidate.name);
        }
    }
    validateRequestedTestCases(availableCases);
    if (selected.length === 0) {
        throw new Error("No enabled CANoe test case matches TEST_CASES");
    }
    selectedTestCases = configuredTestCases(testUnits);
    expectedResultCount = selectedTestCases.length;
    testConfigurationReport = optionalProperty(testConfiguration, "Report");
}

function configureCommunication() {
    const setup = canoe.configuration.get("TestSetup");
    const environments = setup.get("TestEnvironments");
    const environmentList = collectionItems(environments);
    if (environmentList.length === 0) {
        throw new Error("CANoe configuration could not create a TestEnvironment");
    }
    communicationModules = [];
    activeCommunicationModules = [];
    for (const environment of environmentList) {
        if (requestedTestCaseNames.length === 0
                && optionalProperty(environment, "Enabled") === false) {
            continue;
        }
        if (requestedTestCaseNames.length > 0) {
            try {
                environment.set("Enabled", true);
            } catch (error) {
                throwIfAutomationDisconnected(error);
                // 部分 CANoe 版本不允许写入 TestEnvironment.Enabled。
            }
        }
        collectCommunicationModules(environment, communicationModules);
    }
    const selected = [];
    const availableCases = [];
    for (const module of communicationModules) {
        if (requestedTestCaseNames.length === 0
                && optionalProperty(module, "Enabled") === false) {
            continue;
        }
        const moduleName = String(optionalProperty(module, "Name") || "");
        const elements = elementsFor(module);
        const candidates = walkElements(elements, moduleName);
        availableCases.push(...candidates);
        const selectedCandidates = selectProjectTestCases(candidates);
        if (requestedTestCaseNames.length > 0) {
            try {
                module.set("Enabled", selectedCandidates.length > 0);
            } catch (error) {
                throwIfAutomationDisconnected(error);
                // 部分 CANoe 版本由父级测试环境控制模块启用状态。
            }
        }
        if (selectedCandidates.length > 0) {
            activeCommunicationModules.push(module);
            for (const candidate of selectedCandidates) {
                selected.push(candidate.name);
            }
        }
    }
    validateRequestedTestCases(availableCases);
    if (selected.length === 0) {
        throw new Error("No enabled CANoe communication test case matches TEST_CASES");
    }
    selectedTestCases = [];
    for (const module of activeCommunicationModules) {
        selectedTestCases.push(...configuredTestCases([module]));
    }
    expectedResultCount = selectedTestCases.length;
}

function configureProjectTests() {
    const setup = optionalProperty(canoe.configuration, "TestSetup");
    const environments = setup === undefined || setup === null
        ? null : optionalProperty(setup, "TestEnvironments");
    const activeEnvironments = environments === null || environments === undefined
        ? [] : collectionItems(environments).filter((environment) =>
            requestedTestCaseNames.length > 0
                || optionalProperty(environment, "Enabled") !== false);
    if (activeEnvironments.length > 0) {
        testMode = "communication";
        configureCommunication();
        return;
    }

    const configurations = optionalProperty(canoe.configuration, "TestConfigurations");
    const activeConfigurations = configurations === null || configurations === undefined
        ? [] : collectionItems(configurations).filter((configuration) =>
            requestedTestCaseNames.length > 0
                || optionalProperty(configuration, "Enabled") !== false);
    if (activeConfigurations.length > 0) {
        testMode = "vtest";
        configureVtest();
        return;
    }

    throw new Error("CANoe project does not contain a TestEnvironment or TestConfiguration");
}

function hasProjectTestSetup() {
    // 会话在轮询期间可能刚替换了 Configuration 代理，优先读取会话的最新句柄。
    const currentConfiguration = canoe.configuration;
    const setup = optionalProperty(currentConfiguration, "TestSetup");
    const environments = setup === undefined || setup === null
        ? null : optionalProperty(setup, "TestEnvironments");
    if (environments !== null && environments !== undefined
            && collectionCount(environments) > 0) {
        const environment = collectionItems(environments)[0];
        if (environment === undefined) {
            return false;
        }
        // 不同 CANoe 版本会把通信测试模块暴露为 TestModules 或 Items。
        const modules = optionalProperty(environment, "TestModules");
        const items = optionalProperty(environment, "Items");
        return (modules !== undefined && modules !== null)
            || (items !== undefined && items !== null);
    }

    const configurations = optionalProperty(currentConfiguration, "TestConfigurations");
    if (configurations === null || configurations === undefined
            || collectionCount(configurations) === 0) {
        return false;
    }
    const testConfiguration = collectionItems(configurations)[0];
    return testConfiguration !== undefined
        && optionalProperty(testConfiguration, "TestUnits") !== undefined;
}

function errorMessage(error) {
    return error && error.message ? String(error.message) : String(error);
}

function configureModuleExecution(module) {
    try {
        module.set("ExecuteRepeatedly", false);
    } catch (error) {
        throwIfAutomationDisconnected(error);
        // 部分 CANoe 版本或通信测试模块不支持该属性，继续使用工程配置的执行模式。
        task.warning("CANoe test module does not support ExecuteRepeatedly; "
            + `using its configured execution mode: ${errorMessage(error)}`);
    }
}

function optionalRequirementText(key) {
    const value = optionalRequirement(key);
    if (value === undefined || value === null || String(value).trim() === "") {
        return "";
    }
    try {
        if (fs.exists(value)) {
            return fs.readText(value);
        }
    } catch (_) {
        // 调试运行时可以直接传入字面量。
    }
    return String(value);
}

function parseReportTypes(value) {
    const selected = [];
    for (const entry of String(value === undefined || value === null ? "" : value)
        .split(",")) {
        const reportType = entry.trim();
        if (reportType === "") {
            continue;
        }
        if (!SUPPORTED_REPORT_TYPES.includes(reportType)) {
            throw new Error(`CANOE_REPORT_TYPE contains an unsupported value: ${reportType}`);
        }
        if (!selected.includes(reportType)) {
            selected.push(reportType);
        }
    }
    if (selected.length === 0) {
        throw new Error("CANOE_REPORT_TYPE must select at least one report type");
    }
    return selected;
}


async function openConfiguration() {
    if (canoe.application === null) {
        const error = new Error("CANoe Automation is not connected");
        error.canoeFatal = true;
        throw error;
    }
    await canoe.openConfiguration(configurationUri, {
        setupReady: !projectTestSetupReady
            ? hasProjectTestSetup : null,
        setupDescription: "CANoe project test setup to finish loading",
        configurationTimeoutMs: CANOE_CONFIGURATION_READY_TIMEOUT_MS,
        setupTimeoutMs: CANOE_TEST_SETUP_READY_TIMEOUT_MS,
        measurementStopTimeoutMs: CANOE_MEASUREMENT_STOP_TIMEOUT_MS
    });
    projectTestSetupReady = true;
    debug("openConfiguration: completed");
}

export async function prepare(projectPackage) {
    debug("prepare: starting");
    projectRootUri = "workspace://canoe-test/project";
    configurationUri = "";
    configurationPlans = [];
    activeProject = null;
    projectOutcomes = [];
    summaryPublished = false;
    structuredResultsReported = false;
    currentReportPrefix = "";
    publicationTypeCounts = {};
    communicationModules = [];
    activeCommunicationModules = [];
    testConfiguration = null;
    testConfigurationReport = null;
    testUnits = null;
    reportTypes = [];
    generatedReports = [];
    executionFailureMessage = "";
    reportErrors = [];
    reportFileTracker = new ReportFileTracker();
    publishedArtifactUris = [];
    testMode = "";
    requestedTestCaseNames = [];
    results = [];
    testStarted = false;
    executionCompleted = false;
    activeTestTarget = null;
    expectedResultCount = 0;
    selectedTestCases = [];
    projectTestSetupReady = false;
    debug("prepare: extracting project package");
    fs.extractZip(projectPackage, projectRootUri);
    const plan = buildConfigurationPlans(
        projectRootUri, optionalRequirement("TEST_CASES"));
    projectRootUri = plan.rootUri;
    configurationPlans = assignReportPrefixes(plan.plans);
    testMode = "project";
    if (configurationPlans.length > 990) {
        throw new Error("CANOE_PROJECT contains too many .cfg files for dynamic stages");
    }
    // 首个工程提前核验，避免明知不兼容时仍启动 CANoe；后续工程到执行时再核验。
    canoe.validateProjectVersion(
        `${projectRootUri}/${configurationPlans[0].configuration}`);
    reportTypes = parseReportTypes(optionalRequirementText("CANOE_REPORT_TYPE"));
    task.info(`CANoe project plan source: ${plan.source}`);
    task.info(`CANoe project plan contains ${configurationPlans.length} configuration(s)`);
    configurationPlans.forEach((entry, index) => {
        task.info(`CANoe project ${index + 1}: ${entry.configuration}`
            + (entry.testCaseNames.length > 0
                ? ` (test cases: ${entry.testCaseNames.join(", ")})` : ""));
    });
    debug(`prepare: completed (projects=${configurationPlans.length}, reports=${reportTypes.join(",")})`);
    task.progress(5);
}

export async function launch() {
    debug("launch: starting");
    const startMode = canoeStartMode();
    if (startMode.attachExisting) {
        debug("launch: using an existing CANoe process");
        task.info("Attaching to an existing CANoe process");
        await canoe.launch({
            attachExisting: true
        });
        return;
    }
    const executable = canoe.installedExecutable();
    debug(`launch: starting discovered CANoe ${canoe.version} executable: ${executable}`);
    debug(`launch: ${configurationPlans.length} project configuration(s) will be opened in order`);
    await canoe.launch({
        attachExisting: false,
        executable,
        clearTimeoutMs: CANOE_AUTOMATION_READY_TIMEOUT_MS
    });
    debug(`launch: CANoe process started (pid=${canoe.process.pid})`);
}

export async function connect() {
    debug("connect: starting");
    debug(canoe.attached
        ? "connect: waiting for the existing CANoe Automation server"
        : "connect: activating the configured CANoe Automation server");
    await canoe.connect({
        attached: canoe.attached,
        timeoutMs: CANOE_AUTOMATION_READY_TIMEOUT_MS
    });
    debug("connect: completed");
}

function prepareProjectExecution(index) {
    const plan = configurationPlans[index];
    if (plan === undefined) {
        throw new Error("Dynamic CANoe project stage refers to an unknown configuration");
    }
    configurationUri = `${projectRootUri}/${plan.configuration}`;
    currentReportPrefix = plan.reportPrefix;
    requestedTestCaseNames = plan.testCaseNames.slice();
    communicationModules = [];
    activeCommunicationModules = [];
    testConfiguration = null;
    testConfigurationReport = null;
    testUnits = null;
    results = [];
    testMode = "project";
    generatedReports = [];
    executionFailureMessage = "";
    reportErrors = [];
    reportFileTracker = new ReportFileTracker();
    testStarted = false;
    executionCompleted = false;
    expectedResultCount = 0;
    selectedTestCases = [];
    projectTestSetupReady = false;
    activeTestTarget = null;
    activeProject = {
        Index: index + 1,
        Configuration: plan.configuration,
        TestCaseNames: plan.testCaseNames.slice(),
        Status: "running",
        Completed: false,
        ExpectedResultCount: 0,
        Results: [],
        ExecutionError: "",
        ReportErrors: [],
        Reports: [],
        Artifacts: [],
        ReportsCollected: false
    };
    projectOutcomes.push(activeProject);
}

function addProjectStage(index) {
    const plan = configurationPlans[index];
    if (plan === undefined) {
        throw new Error("Unable to add a dynamic stage for an unknown CANoe configuration");
    }
    const stageNumber = String(index + 1).padStart(3, "0");
    task.addStage({
        stageId: `canoe_project_${stageNumber}`,
        name: `执行 CANoe 工程 ${index + 1}/${configurationPlans.length}: ${plan.configuration}`,
        exportName: "executeProject",
        timeoutMs: 86400000,
        arguments: [index]
    });
}

function isFatalProjectError(error) {
    return Boolean(error && error.canoeFatal)
        || isAutomationDisconnectFailure(error);
}

function appendProjectExecutionError(message) {
    if (activeProject === null || !message) {
        return;
    }
    const current = activeProject.ExecutionError;
    if (!current.split("; ").includes(message)) {
        activeProject.ExecutionError = current === ""
            ? message : `${current}; ${message}`;
    }
}

function updateProjectOutcome() {
    if (activeProject === null) {
        return;
    }
    activeProject.Completed = executionCompleted;
    activeProject.ExpectedResultCount = expectedResultCount;
    activeProject.Results = results.map((result) => ({...result}));
    if (executionFailureMessage !== "") {
        appendProjectExecutionError(executionFailureMessage);
    }
    activeProject.ReportErrors = reportErrors.slice();
    activeProject.Reports = generatedReports.map((report) => ({
        Type: report.type,
        Uri: report.uri
    }));
    activeProject.Status = activeProject.ExecutionError === ""
            && activeProject.ReportErrors.length === 0
            && executionCompleted && testPassed()
            && results.length === expectedResultCount
        ? "passed" : "failed";
}

async function closeProjectResources() {
    let cleanupError = null;
    if (testStarted) {
        if (testConfiguration !== null) {
            try {
                testConfiguration.call("Stop");
            } catch (error) {
                try {
                    throwIfAutomationDisconnected(error);
                } catch (fatalError) {
                    cleanupError = fatalError;
                }
                if (cleanupError === null) {
                    cleanupError = error;
                    task.warning(`Unable to stop CANoe TestConfiguration: ${errorMessage(error)}`);
                }
            }
        }
        for (const module of activeCommunicationModules) {
            try {
                module.call("Stop");
            } catch (error) {
                try {
                    throwIfAutomationDisconnected(error);
                } catch (fatalError) {
                    cleanupError = fatalError;
                }
                if (cleanupError === null) {
                    cleanupError = error;
                    task.warning(`Unable to stop CANoe communication module: ${errorMessage(error)}`);
                }
            }
        }
    }
    activeTestTarget = null;
    try {
        const activeConfigurationUri = String(canoe.configurationUri || "");
        if (activeConfigurationUri.toLowerCase() === configurationUri.toLowerCase()) {
            try {
                await canoe.closeConfiguration({
                    timeoutMs: CANOE_MEASUREMENT_STOP_TIMEOUT_MS
                });
            } catch (error) {
                if (cleanupError === null || isFatalProjectError(error)) {
                    cleanupError = error;
                }
            }
        }
    } finally {
        release(testConfigurationReport);
        release(testUnits);
        release(testConfiguration);
        testConfiguration = null;
        testConfigurationReport = null;
        testUnits = null;
        communicationModules = [];
        activeCommunicationModules = [];
        testStarted = false;
        activeTestTarget = null;
    }
    if (cleanupError !== null) {
        throw cleanupError;
    }
}

export function beginExecution() {
    if (configurationPlans.length === 0) {
        throw new Error("No CANoe configurations are available to execute");
    }
    task.info(`Starting ${configurationPlans.length} CANoe configuration(s) in order`);
    addProjectStage(0);
    task.progress(10);
}

export async function executeProject(index) {
    if (!Number.isInteger(index) || index < 0 || index >= configurationPlans.length) {
        throw new Error("Dynamic CANoe project stage index is invalid");
    }
    prepareProjectExecution(index);
    const plan = configurationPlans[index];
    task.info(`Opening CANoe project ${index + 1}/${configurationPlans.length}: ${plan.configuration}`);
    let fatalError = null;
    try {
        canoe.validateProjectVersion(configurationUri);
        await configure();
        await startMeasurement();
        await execute();
        await collectCurrentProjectArtifacts();
    } catch (error) {
        appendProjectExecutionError(errorMessage(error));
        task.error(`CANoe project failed: ${plan.configuration}: ${errorMessage(error)}`);
        if (isFatalProjectError(error)) {
            fatalError = error;
        }
        try {
            await collectCurrentProjectArtifacts();
        } catch (reportError) {
            addReportError(`Unable to collect the current CANoe report: ${errorMessage(reportError)}`);
            if (isFatalProjectError(reportError)) {
                fatalError = fatalError || reportError;
            }
        }
    }

    try {
        await closeProjectResources();
    } catch (error) {
        appendProjectExecutionError(`Project cleanup failed: ${errorMessage(error)}`);
        if (isFatalProjectError(error)) {
            fatalError = fatalError || error;
        }
    }
    updateProjectOutcome();
    task.info(`CANoe project ${plan.configuration} finished with status ${activeProject.Status}`);
    if (fatalError !== null) {
        throw fatalError;
    }
    if (task.isCancelled()) {
        task.checkCancelled();
    }
    if (index + 1 < configurationPlans.length) {
        addProjectStage(index + 1);
    }
}

export function summarizeExecution() {
    updateProjectOutcome();
    publishExecutionSummary();
    const failures = projectOutcomes.filter((project) => project.Status !== "passed");
    task.progress(100);
    if (failures.length > 0) {
        const failedNames = failures.map((project) => project.Configuration).join(", ");
        throw new Error(`CANoe execution failed for ${failures.length} project(s): ${failedNames}`);
    }
}

async function startMeasurement() {
    debug("startMeasurement: starting");
    await openConfiguration();
    const running = await canoe.ensureMeasurementStarted({
        readyTimeoutMs: CANOE_AUTOMATION_READY_TIMEOUT_MS,
        startTimeoutMs: CANOE_MEASUREMENT_START_TIMEOUT_MS
    });
    if (running) {
        debug("startMeasurement: measurement is already running");
    }
    debug("startMeasurement: completed");
    task.progress(10);
}

async function configure() {
    debug(`configure: starting (mode=${testMode})`);
    await openConfiguration();
    configureProjectTests();
    configureNativeReport({
        mode: testMode,
        requested: nativeReportRequested(),
        testConfigurationReport,
        format: nativeReportFormat(reportTypes),
        abortOnError: throwIfAutomationDisconnected
    });
    const reportFileBaseline = reportFileSnapshot();
    reportFileTracker = new ReportFileTracker(
        reportFileBaseline, CANOE_REPORT_STABLE_OBSERVATIONS);
    debug(`configure: completed (mode=${testMode})`);
    task.progress(15);
}

async function execute() {
    debug(`execute: starting (mode=${testMode}, expectedResults=${expectedResultCount})`);
    const timeout = DEFAULT_TEST_TIMEOUT_MS;
    if (selectedTestCases.length === 0) {
        throw new Error("No CANoe test cases have been configured");
    }
    if (testMode === "communication") {
        if (activeCommunicationModules.length === 0) {
            throw new Error("No CANoe communication test modules have been configured");
        }
        for (const module of activeCommunicationModules) {
            task.checkpoint();
            const expectedModuleResultCount = selectedCaseCount([module]);
            debug("execute: starting communication test module");
            configureModuleExecution(module);
            module.call("Start");
            activeTestTarget = module;
            testStarted = true;
            await wait.until(() => {
                const pending = objectRunning(module, true)
                    || completedCaseCount([module]) < expectedModuleResultCount;
                recordCompletedResults(collectVerdictsFrom([module]));
                task.progress(Math.min(90, 20 + results.length * 5));
                return !pending;
            }, {
                timeoutMs: timeout,
                progress: () => results.length,
                description: "CANoe communication test module to finish",
                isReady: (value) => value === true
            });
            recordCompletedResults(collectVerdictsFrom([module]));
            activeTestTarget = null;
        }
    } else {
        if (testConfiguration === null) {
            throw new Error("CANoe TestConfiguration has not been configured");
        }
        debug("execute: calling TestConfiguration.Start");
        testConfiguration.call("Start");
        activeTestTarget = testConfiguration;
        testStarted = true;
        await wait.until(() => {
            const pending = moduleRunning() || results.length < expectedResultCount;
            recordCompletedResults(collectVerdicts());
            const progress = results.length === 0
                ? 20 : Math.min(90, 20 + results.length * 5);
            task.progress(progress);
            return !pending;
        }, {
            timeoutMs: timeout,
            progress: () => results.length,
            description: "CANoe TestConfiguration to finish",
            isReady: (value) => value === true
        });
    }
    activeTestTarget = null;
    executionCompleted = true;
    recordCompletedResults(collectVerdicts());
    debug(`execute: completed (results=${results.length})`);
    const passed = testPassed();
    if (!passed) {
        executionFailureMessage = "One or more CANoe test cases failed";
        task.error(executionFailureMessage);
    }
    task.progress(95);
}

export function reportMediaType(type) {
    if (type === REPORT_TYPE_XML) {
        return "application/xml";
    }
    if (type === REPORT_TYPE_HTML) {
        return "text/html";
    }
    if (type === REPORT_TYPE_PDF) {
        return "application/pdf";
    }
    return "application/octet-stream";
}

export function reportPublicationId(type, count) {
    return count === 1
        ? `CANOE_REPORT:${type}` : `CANOE_REPORT:${type}:${count}`;
}

function publishArtifact(source, relative, publicationId, mediaType, group) {
    const destination = `artifact://canoe-test/${relative}`;
    if (publishedArtifactUris.includes(destination)) {
        if (activeProject !== null
                && !activeProject.Artifacts.includes(destination)) {
            activeProject.Artifacts.push(destination);
        }
        return false;
    }
    fs.copy(source, destination, true);
    task.publish(publicationId, destination, baseName(relative), mediaType,
                 group);
    publishedArtifactUris.push(destination);
    if (activeProject !== null) {
        activeProject.Artifacts.push(destination);
    }
    return true;
}

function publishSelectedReports() {
    for (const report of generatedReports) {
        if (!fs.exists(report.uri)) {
            addReportError(`Requested CANoe ${report.type} report is missing`);
            continue;
        }
        try {
            const sourceRelative = relativePath(projectRootUri, report.uri);
            // 保留工程内相对目录，避免不同模块的同名报告互相覆盖。
            const relative = `reports/${currentReportPrefix}/${sourceRelative}`;
            const count = (publicationTypeCounts[report.type] || 0) + 1;
            const publicationId = reportPublicationId(report.type, count);
            // 分组路径固定为「工程/报告类型」，界面据此逐级归类产物。
            const group = `${currentReportPrefix}/${String(report.type).toLowerCase()}`;
            if (publishArtifact(report.uri, relative, publicationId,
                                reportMediaType(report.type), group)) {
                publicationTypeCounts[report.type] = count;
            }
        } catch (error) {
            addReportError(`Unable to publish CANoe ${report.type} report: ${errorMessage(error)}`);
        }
    }
}

// 组合工程内稳定的用例编号：带上工程序号，避免不同工程内同名用例互相覆盖。
function structuredCaseId(projectIndex, result) {
    const unit = String(result.testUnit === undefined
        || result.testUnit === null ? "" : result.testUnit);
    const id = String(result.id === undefined || result.id === null
        ? "" : result.id);
    const composed = `P${projectIndex + 1}/`
        + (unit === "" ? "" : `${unit}/`) + id;
    // caseId 契约上限为 256 字符，超长时保留仍可定位的前缀。
    return composed.length <= 256 ? composed : composed.substring(0, 256);
}

/*
 * 收尾阶段把逐用例 Verdict 与工程级统计通过 task.reportResult 上报宿主。
 * 宿主据此生成 TASK_RESULT 的 summary 与 TASK_RESULT_CASES 明细；没有执行任何
 * 用例时保持静默，绝不把“未执行”伪造成“全部通过”。
 */
function reportStructuredResults() {
    if (structuredResultsReported) {
        return;
    }
    structuredResultsReported = true;
    let total = 0;
    let passed = 0;
    let failed = 0;
    const cases = [];
    projectOutcomes.forEach((project, projectIndex) => {
        for (const result of project.Results) {
            ++total;
            if (result.passed) {
                ++passed;
            } else {
                ++failed;
            }
            const id = String(result.id === undefined || result.id === null
                ? "" : result.id);
            if (cases.length >= REPORTED_TEST_CASE_LIMIT || id === "") {
                continue;
            }
            cases.push({
                caseId: structuredCaseId(projectIndex, result),
                name: String(result.name === undefined
                    || result.name === null || result.name === ""
                    ? id : result.name),
                result: result.passed ? "passed" : "failed",
                durationMs: 0,
                message: String(result.verdict === undefined
                    || result.verdict === null ? "" : result.verdict)
            });
        }
    });
    if (total === 0) {
        return;
    }
    try {
        task.reportResult({total, passed, failed, cases});
    } catch (error) {
        task.warning(`Unable to report CANoe case results: ${errorMessage(error)}`);
    }
}

function publishExecutionSummary() {
    if (summaryPublished) {
        return;
    }
    const summaryUri = "artifact://canoe-test/execution-result.json";
    const completed = configurationPlans.length > 0
        && projectOutcomes.length === configurationPlans.length
        && projectOutcomes.every((project) => project.Completed);
    const passed = completed
        && projectOutcomes.every((project) => project.Status === "passed");
    const allResults = projectOutcomes.flatMap((project) => project.Results);
    const allReportErrors = projectOutcomes.flatMap((project) => project.ReportErrors);
    const executionErrors = projectOutcomes
        .map((project) => project.ExecutionError)
        .filter((message) => message !== "");
    fs.writeText(summaryUri, JSON.stringify({
        TaskId: task.id(),
        Completed: completed,
        Passed: passed,
        ProjectCount: configurationPlans.length,
        StartedProjectCount: projectOutcomes.length,
        CompletedProjectCount: projectOutcomes.filter((project) => project.Completed).length,
        Results: allResults,
        Projects: projectOutcomes,
        ExecutionErrors: executionErrors,
        ReportErrors: allReportErrors
    }, null, 2), true);
    task.publish("CANOE_EXECUTION_RESULT", summaryUri,
                 "CANoe execution result", "application/json", "");
    summaryPublished = true;
}

async function collectCurrentProjectArtifacts() {
    if (activeProject === null || activeProject.ReportsCollected) {
        return;
    }
    debug(`collectCurrentProjectArtifacts: starting (${activeProject.Configuration})`);
    if (testStarted && !executionCompleted) {
        if (executionFailureMessage === "") {
            executionFailureMessage =
                "CANoe execution was interrupted before all test cases completed";
        }
        try {
            if (activeTestTarget !== null) {
                activeTestTarget.call("Stop");
                activeTestTarget = null;
            }
            recordCompletedResults(collectVerdicts());
        } catch (error) {
            throwIfAutomationDisconnected(error);
            addReportError(`Unable to finalize interrupted CANoe execution: ${errorMessage(error)}`);
        }
    }
    if (testStarted) {
        try {
            await generateSelectedReports({ignoreCancellation: task.isCancelled()});
        } catch (error) {
            throwIfAutomationDisconnected(error);
            if (task.isCancelled()) {
                throw error;
            }
            addReportError(`CANoe report generation failed: ${errorMessage(error)}`);
        }
    } else {
        debug("collectCurrentProjectArtifacts: test did not start; no report is expected");
    }
    publishSelectedReports();
    activeProject.ReportsCollected = true;
    activeProject.ReportErrors = reportErrors.slice();
    activeProject.Reports = generatedReports.map((report) => ({
        Type: report.type,
        Uri: report.uri
    }));
    updateProjectOutcome();
    debug(`collectCurrentProjectArtifacts: completed (reports=${generatedReports.length})`);
}

export async function collectArtifacts() {
    debug("collectArtifacts: starting");
    if (activeProject !== null && !activeProject.ReportsCollected) {
        try {
            await collectCurrentProjectArtifacts();
        } catch (error) {
            appendProjectExecutionError(`Final report collection failed: ${errorMessage(error)}`);
            addReportError(errorMessage(error));
            updateProjectOutcome();
            task.warning(`Unable to collect final CANoe report: ${errorMessage(error)}`);
        }
    }
    updateProjectOutcome();
    try {
        publishExecutionSummary();
    } catch (error) {
        task.warning(`Unable to publish CANoe execution summary: ${errorMessage(error)}`);
    }
    reportStructuredResults();
    task.progress(100);
    debug(`collectArtifacts: completed (projects=${projectOutcomes.length})`);
}

export async function cleanup() {
    debug(`cleanup: starting (measurementRunning=${canoe.measurementRunning}, testStarted=${testStarted}, launchedByTask=${canoe.ownsProcess})`);
    try {
        if (testStarted) {
            if (testConfiguration !== null) {
                try {
                    debug("cleanup: calling TestConfiguration.Stop");
                    testConfiguration.call("Stop");
                } catch (error) {
                    task.warning(`Unable to stop CANoe TestConfiguration: ${errorMessage(error)}`);
                }
            }
            for (const module of activeCommunicationModules) {
                try {
                    debug("cleanup: stopping communication test module");
                    module.call("Stop");
                } catch (error) {
                    task.warning(`Unable to stop CANoe communication module: ${errorMessage(error)}`);
                }
            }
        }
    } catch (error) {
        task.warning(`Unable to stop CANoe test execution: ${errorMessage(error)}`);
    }
    try {
        await canoe.close({
            quit: canoe.ownsProcess || Boolean(task.option("QuitAttachedInstance", false))
        });
    } finally {
        release(testConfigurationReport);
        release(testUnits);
        release(testConfiguration);
        testConfiguration = null;
        testConfigurationReport = null;
        testUnits = null;
        communicationModules = [];
        activeCommunicationModules = [];
        requestedTestCaseNames = [];
        results = [];
        reportTypes = [];
        generatedReports = [];
        executionFailureMessage = "";
        reportErrors = [];
        reportFileTracker = new ReportFileTracker();
        publishedArtifactUris = [];
        testMode = "";
        projectRootUri = "";
        configurationUri = "";
        configurationPlans = [];
        activeProject = null;
        projectOutcomes = [];
        summaryPublished = false;
        structuredResultsReported = false;
        currentReportPrefix = "";
        publicationTypeCounts = {};
        expectedResultCount = 0;
        selectedTestCases = [];
        testStarted = false;
        projectTestSetupReady = false;
        debug("cleanup: completed");
    }
}
