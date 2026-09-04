import * as fs from "@atech/fs";
import * as cli from "@atech/cli";
import * as task from "@atech/task";

import {CanoeSession} from "./canoe_test/session.js";

const CONTRACT_VERSION = "1.0";
const DEFAULT_TEST_CONFIGURATION = "CICT Test Configuration";
const DEFAULT_TEST_TIMEOUT_MS = 1800000;
const CANOE_AUTOMATION_READY_TIMEOUT_MS = 120000;
const CANOE_MEASUREMENT_STOP_TIMEOUT_MS = 120000;
const CANOE_CONFIGURATION_READY_TIMEOUT_MS = 120000;
const CANOE_TEST_SETUP_READY_TIMEOUT_MS = 120000;
const CANOE_MEASUREMENT_START_TIMEOUT_MS = 120000;
const CANOE_POLL_INTERVAL_MS = 250;
const CANOE_REPORT_GENERATION_TIMEOUT_MS = 120000;
const CANOE_REPORT_CONVERSION_TIMEOUT_MS = 120000;
const CANOE_REPORT_FORMAT_VTESTREPORT = 1;
const CANOE_REPORT_FORMAT_XML = 2;

const REPORT_TYPE_XML = "XML";
const REPORT_TYPE_PDF = "PDF";
const REPORT_TYPE_XUNIT = "XUnit";
const REPORT_TYPE_VTESTREPORT = "vtestreport";
const SUPPORTED_REPORT_TYPES = [
    REPORT_TYPE_XML,
    REPORT_TYPE_PDF,
    REPORT_TYPE_XUNIT,
    REPORT_TYPE_VTESTREPORT
];

let testConfiguration = null;
let testConfigurationReport = null;
let testUnits = null;
let projectDescriptor = null;
let projectRootUri = "";
let configurationUri = "";
let reportUri = "";
let scriptUris = [];
let requestedIds = [];
let results = [];
let testMode = "";
let communicationModules = [];
let activeCommunicationModules = [];
let communicationScriptUris = [];
let communicationModuleNames = [];
let reportObjects = [];
let reportTypes = [];
let nativeReportOutputs = [];
let generatedReports = [];
let executionFailureMessage = "";
let reportErrors = [];
let reportFileBaseline = [];
let publishedArtifactUris = [];
let testStarted = false;
let expectedResultCount = 0;
let useProjectTestSetup = false;
let projectTestSetupReady = false;
let selectedTestCases = [];

function debug(message) {
    task.info(`[CANoe debug] ${message}`);
}

const canoe = new CanoeSession({
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

function findProjectDescriptor(rootUri) {
    const directDescriptor = `${rootUri}/canoe-project.json`;
    if (fs.exists(directDescriptor)) {
        return directDescriptor;
    }
    const descriptors = fs.list(rootUri, true).filter((entry) =>
        entry.type === "file" && entry.name.toLowerCase() === "canoe-project.json");
    if (descriptors.length > 1) {
        throw new Error("CANOE_PROJECT contains multiple canoe-project.json files");
    }
    return descriptors.length === 1 ? descriptors[0].uri : "";
}

function loadProject(extractionRootUri) {
    const descriptorUri = findProjectDescriptor(extractionRootUri);
    if (descriptorUri) {
        const rootUri = parentUri(descriptorUri);
        const descriptor = readJson(descriptorUri, "canoe-project.json");
        if (Array.isArray(descriptor)) {
            throw new Error("canoe-project.json must contain an object");
        }
        return { rootUri, descriptor, usesProjectTestSetup: false };
    }

    const configurations = fs.list(extractionRootUri, true).filter((entry) =>
        entry.type === "file" && entry.name.toLowerCase().endsWith(".cfg"));
    if (configurations.length === 0) {
        throw new Error(
            "CANOE_PROJECT must contain canoe-project.json or one CANoe .cfg file");
    }
    if (configurations.length > 1) {
        throw new Error(
            "CANOE_PROJECT contains multiple CANoe .cfg files; add canoe-project.json to select one");
    }

    const configurationPath = relativePath(extractionRootUri,
                                           configurations[0].uri);
    task.info(`Using native CANoe project configuration: ${configurationPath}`);
    return {
        rootUri: extractionRootUri,
        descriptor: {
            ContractVersion: CONTRACT_VERSION,
            Configuration: configurationPath
        },
        usesProjectTestSetup: true
    };
}

function descriptorValue(name, fallback) {
    const value = projectDescriptor && projectDescriptor[name];
    return value === undefined || value === null || value === "" ? fallback : value;
}

function canoeTimeout(name, fallback) {
    const configured = Number(descriptorValue(name, fallback));
    return Number.isFinite(configured) && configured > 0
        ? Math.floor(configured) : fallback;
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
    if (Array.isArray(collection)) {
        return collection.slice();
    }
    const items = [];
    for (let index = 0; index < collectionCount(collection); ++index) {
        try {
            items.push(collectionItem(collection, index));
        } catch (_) {
            break;
        }
    }
    return items;
}

function optionalProperty(object, name) {
    try {
        return object.get(name);
    } catch (_) {
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
        // The host releases any remaining handles when the worker exits.
    }
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

function appendReportObject(report) {
    if (report !== null && report !== undefined && !reportObjects.includes(report)) {
        reportObjects.push(report);
    }
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

function reportNeedsVtestReport() {
    return reportTypes.includes(REPORT_TYPE_VTESTREPORT)
        || reportTypes.includes(REPORT_TYPE_PDF)
        || reportTypes.includes(REPORT_TYPE_XUNIT)
        || (reportTypes.includes(REPORT_TYPE_XML) && reportTypes.length > 1);
}

function nativeReportRequested() {
    return reportTypes.length > 0;
}

function nativeReportFormat() {
    return reportNeedsVtestReport()
        ? CANOE_REPORT_FORMAT_VTESTREPORT : CANOE_REPORT_FORMAT_XML;
}

function isNativeReportUri(uri) {
    const lower = String(uri === undefined || uri === null ? "" : uri)
        .toLowerCase();
    return lower.endsWith(".vtestreport") || lower.endsWith(".xml");
}

function likelyNativeReportUri(uri) {
    const lower = String(uri === undefined || uri === null ? "" : uri)
        .toLowerCase();
    return lower.endsWith(".vtestreport")
        || (lower.endsWith(".xml")
            && (lower.includes("/report") || lower.includes("report.")));
}

function reportFileSnapshot() {
    try {
        return fs.list(projectRootUri, true)
            .filter((entry) => entry.type === "file" && isNativeReportUri(entry.uri))
            .map((entry) => ({
                uri: entry.uri,
                size: Number(entry.size) || 0,
                modifiedAt: String(entry.modifiedAt || "")
            }));
    } catch (error) {
        debug(`report discovery: unable to list project files: ${errorMessage(error)}`);
        return [];
    }
}

function reportFileChanged(entry) {
    const previous = reportFileBaseline.find((candidate) =>
        candidate.uri === entry.uri);
    return previous === undefined
        || previous.size !== entry.size
        || previous.modifiedAt !== entry.modifiedAt;
}

function uniqueReportObjects() {
    const unique = [];
    for (const report of reportObjects) {
        if (!unique.includes(report)) {
            unique.push(report);
        }
    }
    return unique;
}

function reportObjectWrittenUri(report) {
    // 只读取 CANoe 生成后的只读属性，绝不改写报告对象的输出路径。
    const nativePath = optionalProperty(report, "LastWrittenFullPath")
        || optionalProperty(report, "LastWrittenFullName");
    const uri = nativePathToWorkspaceUri(nativePath);
    return uri && isNativeReportUri(uri) && fs.exists(uri) ? uri : "";
}

function discoveredNativeReportUris() {
    const uris = [];
    for (const report of uniqueReportObjects()) {
        const uri = reportObjectWrittenUri(report);
        if (uri && !uris.includes(uri)) {
            uris.push(uri);
        }
    }
    for (const entry of reportFileSnapshot()) {
        if (!likelyNativeReportUri(entry.uri) || !reportFileChanged(entry)) {
            continue;
        }
        if (!uris.includes(entry.uri)) {
            uris.push(entry.uri);
        }
    }
    return uris;
}


function configureNativeReports() {
    nativeReportOutputs = [];
    reportFileBaseline = reportFileSnapshot();
    if (!nativeReportRequested()) {
        return;
    }
    const reports = uniqueReportObjects();
    if (reports.length === 0) {
        addReportError("CANoe did not expose a report object for the selected report type");
        return;
    }

    const format = nativeReportFormat();
    for (const report of reports) {
        try {
            report.set("Enabled", true);
        } catch (error) {
            debug(`configure report: unable to enable report: ${errorMessage(error)}`);
        }
        try {
            // eReportFormat：cReportFormatVTestReport=1，cReportFormatXml=2。
            report.set("ReportFormat", format);
        } catch (error) {
            // TestReport/TestUnitReport 在部分版本没有 ReportFormat，继续使用工程配置。
            debug(`configure report: ReportFormat is unavailable: ${errorMessage(error)}`);
        }
        nativeReportOutputs.push({report});
    }
}

async function generateNativeReports() {
    if (!nativeReportRequested() || nativeReportOutputs.length === 0) {
        return discoveredNativeReportUris();
    }
    for (const output of nativeReportOutputs) {
        try {
            output.report.call("GenerateReport");
        } catch (error) {
            // 测试配置报告通常会在测试结束时自动生成，调用失败不应中断测试结果收集。
            debug(`generate report: waiting for CANoe automatic output: ${errorMessage(error)}`);
        }
    }

    let reportUris = discoveredNativeReportUris();
    if (reportUris.length === 0) {
        try {
            reportUris = await wait.until(
                () => discoveredNativeReportUris(),
                {
                    timeoutMs: canoeTimeout("ReportGenerationTimeoutMs",
                                             CANOE_REPORT_GENERATION_TIMEOUT_MS),
                    description: "CANoe reports to be generated",
                    isReady: (value) => value.length > 0
                });
        } catch (error) {
            addReportError(errorMessage(error));
            return [];
        }
    }
    return reportUris;
}

function parseIds(uri) {
    if (!uri || !fs.exists(uri)) {
        return [];
    }
    const text = fs.readText(uri).trim();
    if (!text) {
        return [];
    }
    const isJson = uri.toLowerCase().endsWith(".json")
        || text.startsWith("[") || text.startsWith("{");
    if (isJson) {
        let value;
        try {
            value = JSON.parse(text);
        } catch (error) {
            throw new Error(`TEST_CASE_IDS is not valid JSON: ${error.message}`);
        }
        if (value === null || typeof value !== "object") {
            throw new Error("TEST_CASE_IDS must contain a JSON object or array");
        }
        if (Array.isArray(value)) {
            return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
        }
        for (const key of ["ids", "testCaseIds", "TestCaseIds", "cases"]) {
            if (Array.isArray(value[key])) {
                return value[key].map((item) => String(item).trim())
                    .filter((item) => item.length > 0);
            }
        }
        throw new Error("TEST_CASE_IDS JSON must contain an array of IDs");
    }
    return text.split(/[\r\n,;]+/).map((item) => item.trim())
        .filter((item) => item.length > 0);
}

function descriptorScripts() {
    const entries = descriptorValue("TestScripts", descriptorValue("Scripts", []));
    if (!Array.isArray(entries)) {
        throw new Error("canoe-project.json TestScripts must be an array");
    }
    return entries.map((entry) => {
        const path = typeof entry === "string" ? entry : entry && (entry.Path || entry.path);
        if (!path) {
            throw new Error("Each TestScripts entry must provide a relative Path");
        }
        const name = typeof entry === "object" && entry !== null
            ? (entry.Name || entry.name || "") : "";
        const kind = typeof entry === "object" && entry !== null
            ? (entry.Type || entry.type || "") : "";
        return {
            path: requireSafeRelativePath(path, "TestScripts entry"),
            name: String(name),
            kind: normalize(kind)
        };
    });
}

function scriptKind(name, declaredKind = "") {
    if (declaredKind) {
        return declaredKind.includes("communication") || declaredKind === "comm"
            ? "communication" : "vtest";
    }
    return name.toLowerCase().endsWith(".vtuexe") ? "vtest" : "communication";
}

function scriptExtension(uri) {
    const name = baseName(uri).toLowerCase();
    const index = name.lastIndexOf(".");
    return index >= 0 ? name.substring(index) : "";
}

function registerScript(script) {
    scriptUris.push(script);
    if (script.kind !== "communication") {
        return;
    }
    if (scriptExtension(script.uri) === ".tse") {
        communicationScriptUris.push(script.uri);
    } else if (scriptExtension(script.uri) === ".xml") {
        const name = script.name || baseName(script.uri);
        communicationModuleNames.push(name.replace(/\.xml$/i, ""));
    }
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

function walkElements(elements, unitName) {
    const local = [];
    for (const element of collectionItems(elements)) {
        const type = normalize(optionalProperty(element, "Type"));
        const id = testCaseId(element);
        const verdictValue = optionalProperty(element, "Verdict");
        const children = propertyOr(element, ["Elements", "Sequence"], null);
        const hasChildren = children !== undefined && children !== null
            && collectionCount(children) > 0;
        const isCase = type.includes("testcase") || type.includes("test_case")
            || (!hasChildren && verdictValue !== undefined && id !== "");
        if (isCase) {
            local.push({ testUnit: unitName, id, name: id, object: element });
        }
        if (children !== undefined && children !== null) {
            const nested = walkElements(children, unitName);
            for (const child of nested) {
                local.push(child);
            }
        }
    }
    return local;
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

function publishCompletedResults(candidates) {
    for (const candidate of candidates) {
        if (results.some((result) => sameTestCase(result, candidate))) {
            continue;
        }
        results.push(candidate);
        publishTestCaseResult(candidate, results.length, expectedResultCount);
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
        const unitName = String(optionalProperty(unit, "Name") || "");
        const elements = elementsFor(unit);
        if (elements === null || elements === undefined) {
            continue;
        }
        for (const candidate of walkElements(elements, unitName)) {
            if (requestedIds.length === 0 || requestedIds.includes(candidate.id)) {
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

function publishTestCaseResult(result, sequence, total) {
    const number = String(sequence).padStart(4, "0");
    const relative = `results/test-case-${number}.json`;
    const source = `${projectRootUri}/${relative}`;
    const destination = `artifact://canoe-test/${relative}`;
    fs.mkdir(`${projectRootUri}/results`);
    fs.writeText(source, JSON.stringify({
        taskId: task.id(),
        sequence,
        total,
        result
    }, null, 2));
    fs.copy(source, destination, true);
    task.publish(`TEST_RESULT:${number}`,
                 destination,
                 `Test case ${sequence}: ${result.id}`,
                 "application/json");
    task.info(`[CANoe result] ${sequence}/${total}: ${result.id} - ${result.verdict}`);
}

function writeResultsReport(publish = true) {
    const source = `${projectRootUri}/test-results.json`;
    const passed = testPassed();
    fs.writeText(source, JSON.stringify({
        taskId: task.id(),
        status: passed ? "passed" : "failed",
        reportErrors: reportErrors.slice(),
        results
    }, null, 2));
    reportUri = source;
    if (!publish) {
        return;
    }
    const destination = "artifact://canoe-test/test-results.json";
    fs.copy(source, destination, true);
    task.publish("REPORT_URI",
                 destination,
                 "CANoe test results",
                 "application/json");
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
    const executable = optionalDevice("CANOE_REPORT_VIEWER_CLI");
    if (executable === undefined || executable === null
            || String(executable).trim() === "") {
        throw new Error(
            "CANOE_REPORT_VIEWER_CLI must be configured for the selected CANoe report export");
    }
    return String(executable);
}


function reportViewerFailure(result, type) {
    const details = [result.standardError, result.standardOutput]
        .map((value) => String(value === undefined || value === null ? "" : value).trim())
        .filter((value) => value !== "")
        .join("; ");
    const suffix = details === "" ? "" : `: ${details}`;
    return `CANoe Report Viewer failed to create ${type} (exit code ${result.exitCode})${suffix}`;
}

function runReportViewer(nativeReportUri, option, outputUri, type, executable) {
    const result = cli.run({
        executable,
        arguments: [
            `-r=${fs.nativePath(nativeReportUri)}`,
            `${option}=${fs.nativePath(outputUri)}`
        ],
        workingDirectoryUri: projectRootUri,
        timeoutMs: canoeTimeout("ReportConversionTimeoutMs",
                                CANOE_REPORT_CONVERSION_TIMEOUT_MS)
    });
    if (result.crashed || result.exitCode !== 0) {
        throw new Error(reportViewerFailure(result, type));
    }
    if (!fs.exists(outputUri)) {
        throw new Error(`CANoe Report Viewer did not create the requested ${type} report`);
    }
}

function reportOutputUri(type, index, total) {
    const suffix = total === 1 ? "" : `-${index + 1}`;
    if (type === REPORT_TYPE_XUNIT) {
        return `${reportsDirectoryUri()}/canoe-test.xunit${suffix}.xml`;
    }
    return `${reportsDirectoryUri()}/canoe-test${suffix}.${type.toLowerCase()}`;
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

function convertNativeReports(nativeReportUris, type, option) {
    if (!reportTypes.includes(type) || nativeReportUris.length === 0) {
        return;
    }
    let executable;
    try {
        executable = reportViewerExecutable();
    } catch (error) {
        addReportError(errorMessage(error));
        return;
    }
    const inputs = viewerInputUris(nativeReportUris);
    fs.mkdir(reportsDirectoryUri());
    for (let index = 0; index < inputs.length; ++index) {
        task.checkCancelled();
        const outputUri = reportOutputUri(type, index, inputs.length);
        try {
            runReportViewer(inputs[index], option, outputUri, type, executable);
            addGeneratedReport(type, outputUri);
        } catch (error) {
            if (task.isCancelled()) {
                throw error;
            }
            addReportError(errorMessage(error));
            task.warning(errorMessage(error));
        }
    }
}

async function generateSelectedReports() {
    const nativeReportUris = await generateNativeReports();
    registerNativeReports(nativeReportUris);

    if (nativeReportUris.length === 0 && reportTypes.length > 0) {
        addReportError("CANoe did not generate a native test report");
    }
    if (reportTypes.includes(REPORT_TYPE_VTESTREPORT)
            && !nativeReportUris.some((uri) =>
                uri.toLowerCase().endsWith(".vtestreport"))) {
        addReportError("CANoe did not generate the requested vtestreport output");
    }
    if (reportTypes.includes(REPORT_TYPE_XML)
            && !nativeReportUris.some((uri) => uri.toLowerCase().endsWith(".xml"))) {
        convertNativeReports(nativeReportUris, REPORT_TYPE_XML, "-e");
    }
    convertNativeReports(nativeReportUris, REPORT_TYPE_XUNIT, "--xunit");
    convertNativeReports(nativeReportUris, REPORT_TYPE_PDF, "-p");
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

function removeAll(collection, methodName, secondArgument) {
    for (let index = collectionCount(collection); index >= 1; --index) {
        try {
            if (secondArgument === undefined) {
                collection.call(methodName, index);
            } else {
                collection.call(methodName, index, secondArgument);
            }
        } catch (_) {
            // A stale optional item should not prevent the next removal.
        }
    }
}

function configureVtest() {
    const configurations = canoe.configuration.get("TestConfigurations");
    const useExistingTestConfiguration = useProjectTestSetup
        && scriptUris.length === 0;
    if (collectionCount(configurations) === 0) {
        if (useExistingTestConfiguration) {
            throw new Error("CANoe project does not contain a TestConfiguration");
        }
        configurations.call("Add");
    }
    testConfiguration = collectionItems(configurations)[0];
    if (testConfiguration === undefined) {
        throw new Error("CANoe configuration could not create a TestConfiguration");
    }
    if (!useExistingTestConfiguration) {
        const configurationName = descriptorValue("TestConfiguration", DEFAULT_TEST_CONFIGURATION);
        testConfiguration.set("Name", configurationName);
    }
    testConfiguration.set("Enabled", true);
    if (!useExistingTestConfiguration) {
        const settings = optionalProperty(testConfiguration, "Settings");
        if (settings !== undefined) {
            try {
                settings.set("ExecutionMode", 0);
            } catch (_) {
                // Older CANoe versions use the default single-execution mode.
            }
        }
    }
    testUnits = testConfiguration.get("TestUnits");
    if (!useExistingTestConfiguration) {
        removeAll(testUnits, "Remove");
        for (const script of scriptUris) {
            testUnits.call("Add", fs.nativePath(script.uri));
        }
    }
    const units = collectionItems(testUnits);
    const selected = [];
    for (const unit of units) {
        const elements = elementsFor(unit);
        if (elements === null || elements === undefined) {
            continue;
        }
        const candidates = walkElements(
            elements, String(optionalProperty(unit, "Name") || ""));
        const selectedCandidates = candidates.filter((candidate) =>
            requestedIds.length === 0 || requestedIds.includes(candidate.id));
        for (const candidate of candidates) {
            try {
                candidate.object.set("Enabled", selectedCandidates.includes(candidate));
            } catch (_) {
            }
        }
        try {
            unit.set("Enabled", selectedCandidates.length > 0);
        } catch (_) {
            // 部分 CANoe 版本会隐式启用测试单元。
        }
        for (const candidate of selectedCandidates) {
            selected.push(candidate.id);
        }
    }
    if (selected.length === 0) {
        throw new Error("No enabled CANoe test case matches TEST_CASE_IDS");
    }
    selectedTestCases = configuredTestCases(testUnits);
    expectedResultCount = selectedTestCases.length;
    testConfigurationReport = optionalProperty(testConfiguration, "Report");
    if (testConfigurationReport !== undefined && testConfigurationReport !== null) {
        appendReportObject(testConfigurationReport);
    }
}

function configureCommunication() {
    const setup = canoe.configuration.get("TestSetup");
    const environments = setup.get("TestEnvironments");
    if (communicationScriptUris.length > 0) {
        removeAll(environments, "Remove", false);
        for (const uri of communicationScriptUris) {
            environments.call("Add", fs.nativePath(uri));
        }
    }
    const environmentList = collectionItems(environments);
    if (environmentList.length === 0) {
        throw new Error("CANoe configuration could not create a TestEnvironment");
    }
    communicationModules = [];
    activeCommunicationModules = [];
    for (const environment of environmentList) {
        try {
            environment.set("Enabled", true);
        } catch (_) {
            // TestEnvironment.Enabled is not writable in some CANoe releases.
        }
        appendReportObject(propertyOr(environment, ["Report"], null));
        collectCommunicationModules(environment, communicationModules);
    }
    const selected = [];
    for (const module of communicationModules) {
        const moduleName = String(optionalProperty(module, "Name") || "");
        const baseModuleName = moduleName.replace(/_\d+$/, "");
        if (communicationModuleNames.length > 0
                && !communicationModuleNames.some((name) => {
                    const normalizedName = String(name).replace(/_\d+$/, "");
                    return normalize(normalizedName) === normalize(baseModuleName);
                })) {
            try {
                module.set("Enabled", false);
            } catch (_) {
                // A parent environment may own the Enabled property.
            }
            continue;
        }
        const elements = elementsFor(module);
        const candidates = walkElements(elements, moduleName);
        const selectedCandidates = candidates.filter((candidate) =>
            requestedIds.length === 0 || requestedIds.includes(candidate.id));
        for (const candidate of candidates) {
            try {
                candidate.object.set("Enabled", selectedCandidates.includes(candidate));
            } catch (_) {
            }
        }
        try {
            module.set("Enabled", selectedCandidates.length > 0);
        } catch (_) {
            // 部分 CANoe 版本由父级测试环境控制模块启用状态。
        }
        if (selectedCandidates.length > 0) {
            activeCommunicationModules.push(module);
            for (const candidate of selectedCandidates) {
                selected.push(candidate.id);
            }
        }
        const report = propertyOr(module, ["Report"], null);
        appendReportObject(report);
    }
    if (selected.length === 0) {
        throw new Error("No enabled CANoe communication test case matches TEST_CASE_IDS");
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
    if (environments !== null && environments !== undefined
            && collectionCount(environments) > 0) {
        testMode = "communication";
        configureCommunication();
        return;
    }

    const configurations = optionalProperty(canoe.configuration, "TestConfigurations");
    if (configurations !== null && configurations !== undefined
            && collectionCount(configurations) > 0) {
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
        // 部分 CANoe 版本或通信测试模块不支持该属性，继续使用工程配置的执行模式。
        task.warning("CANoe test module does not support ExecuteRepeatedly; "
            + `using its configured execution mode: ${errorMessage(error)}`);
    }
}

function optionalDevice(key) {
    try {
        return task.device(key);
    } catch (_) {
        return "";
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
        const normalized = normalize(entry);
        if (normalized === "") {
            continue;
        }
        const reportType = SUPPORTED_REPORT_TYPES.find((candidate) =>
            normalize(candidate) === normalized);
        if (reportType === undefined) {
            throw new Error(`CANOE_REPORT_TYPE contains an unsupported value: ${entry.trim()}`);
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
        throw new Error("CANoe Automation is not connected");
    }
    await canoe.openConfiguration(configurationUri, {
        setupReady: useProjectTestSetup && !projectTestSetupReady
            ? hasProjectTestSetup : null,
        setupDescription: "CANoe project test setup to finish loading",
        configurationTimeoutMs: canoeTimeout("ConfigurationReadyTimeoutMs",
                                            CANOE_CONFIGURATION_READY_TIMEOUT_MS),
        setupTimeoutMs: canoeTimeout("TestSetupReadyTimeoutMs",
                                     CANOE_TEST_SETUP_READY_TIMEOUT_MS),
        measurementStopTimeoutMs: canoeTimeout("MeasurementStopTimeoutMs",
                                                CANOE_MEASUREMENT_STOP_TIMEOUT_MS)
    });
    if (useProjectTestSetup) {
        projectTestSetupReady = true;
    }
    debug("openConfiguration: completed");
}

export async function prepare(projectPackage) {
    debug("prepare: starting");
    projectRootUri = "workspace://canoe-test/project";
    configurationUri = "";
    reportUri = "";
    scriptUris = [];
    communicationModules = [];
    activeCommunicationModules = [];
    communicationScriptUris = [];
    communicationModuleNames = [];
    reportObjects = [];
    reportTypes = [];
    nativeReportOutputs = [];
    generatedReports = [];
    executionFailureMessage = "";
    reportErrors = [];
    reportFileBaseline = [];
    publishedArtifactUris = [];
    testMode = "";
    requestedIds = [];
    results = [];
    testStarted = false;
    expectedResultCount = 0;
    selectedTestCases = [];
    useProjectTestSetup = false;
    projectTestSetupReady = false;
    debug("prepare: extracting project package");
    fs.extractZip(projectPackage, projectRootUri);
    const project = loadProject(projectRootUri);
    projectRootUri = project.rootUri;
    projectDescriptor = project.descriptor;
    useProjectTestSetup = project.usesProjectTestSetup;
    if (String(projectDescriptor.ContractVersion) !== CONTRACT_VERSION) {
        throw new Error(`Unsupported canoe-project.json contract: ${projectDescriptor.ContractVersion}`);
    }
    const configurationPath = requireSafeRelativePath(
        descriptorValue("Configuration", ""), "Configuration");
    configurationUri = `${projectRootUri}/${configurationPath}`;
    if (!fs.exists(configurationUri)) {
        throw new Error(`CANoe configuration is missing: ${configurationPath}`);
    }

    for (const entry of descriptorScripts()) {
        const uri = `${projectRootUri}/${entry.path}`;
        if (!fs.exists(uri)) {
            throw new Error(`CANoe test script is missing: ${entry.path}`);
        }
        const kind = scriptKind(entry.path, entry.kind);
        if (!testMode) {
            testMode = kind;
        } else if (testMode !== kind) {
            throw new Error("VTESTStudio and communication scripts cannot be mixed in one task");
        }
        registerScript({ uri, kind, name: entry.name || baseName(uri) });
    }
    if (scriptUris.length === 0) {
        if (!useProjectTestSetup) {
            throw new Error("No CANoe test script (.vtuexe/.tse/.xml) was supplied");
        }
        testMode = "project";
    }
    requestedIds = parseIds(optionalRequirement("TEST_CASE_IDS"));
    if (requestedIds.length === 0 && Array.isArray(projectDescriptor.TestCaseIds)) {
        requestedIds = projectDescriptor.TestCaseIds.map((id) => String(id));
    }
    reportTypes = parseReportTypes(optionalRequirementText("CANOE_REPORT_TYPE"));
    debug(`prepare: completed (mode=${testMode}, requestedCases=${requestedIds.length}, reports=${reportTypes.join(",")})`);
    task.progress(5);
}

export async function launch() {
    debug("launch: starting");
    const startMode = canoeStartMode();
    if (startMode.attachExisting) {
        debug("launch: using an existing CANoe process");
        task.info("Attaching to an existing CANoe process");
        await canoe.launch({
            attachExisting: true,
            clearExisting: false
        });
        return;
    }
    debug("launch: creating CANoe Automation instance through COM");
    debug(`launch: project configuration will be opened during configure: ${configurationUri}`);
    await canoe.launch({
        attachExisting: false,
        clearExisting: startMode.clearExisting,
        clearTimeoutMs: canoeTimeout("AutomationReadyTimeoutMs",
                                    CANOE_AUTOMATION_READY_TIMEOUT_MS)
    });
    debug("launch: CANoe Automation instance created");
}

export async function connect() {
    debug("connect: starting");
    debug(canoe.attached
        ? "connect: waiting for the existing CANoe Automation server"
        : "connect: using the CANoe Automation instance created during launch");
    await canoe.connect({
        attached: canoe.attached,
        timeoutMs: canoeTimeout("AutomationReadyTimeoutMs",
                                CANOE_AUTOMATION_READY_TIMEOUT_MS)
    });
    debug("connect: completed");
}

export async function startMeasurement() {
    debug("startMeasurement: starting");
    await openConfiguration();
    const running = await canoe.ensureMeasurementStarted({
        readyTimeoutMs: canoeTimeout("AutomationReadyTimeoutMs",
                                     CANOE_AUTOMATION_READY_TIMEOUT_MS),
        startTimeoutMs: canoeTimeout("MeasurementStartTimeoutMs",
                                     CANOE_MEASUREMENT_START_TIMEOUT_MS)
    });
    if (running) {
        debug("startMeasurement: measurement is already running");
    }
    debug("startMeasurement: completed");
    task.progress(10);
}

export async function configure() {
    debug(`configure: starting (mode=${testMode})`);
    await openConfiguration();
    if (testMode === "project") {
        configureProjectTests();
    } else if (testMode === "communication") {
        configureCommunication();
    } else {
        configureVtest();
    }
    configureNativeReports();
    debug(`configure: completed (mode=${testMode})`);
    task.progress(15);
}

export async function execute() {
    debug(`execute: starting (mode=${testMode}, expectedResults=${expectedResultCount})`);
    const timeout = Number(projectDescriptor && projectDescriptor.TestTimeoutMs)
        || DEFAULT_TEST_TIMEOUT_MS;
    const started = Date.now();
    if (selectedTestCases.length === 0) {
        throw new Error("No CANoe test cases have been configured");
    }
    if (testMode === "communication") {
        if (activeCommunicationModules.length === 0) {
            throw new Error("No CANoe communication test modules have been configured");
        }
        for (const module of activeCommunicationModules) {
            const expectedModuleResultCount = selectedCaseCount([module]);
            debug("execute: starting communication test module");
            configureModuleExecution(module);
            module.call("Start");
            testStarted = true;
            await wait.until(() => {
                const pending = objectRunning(module, true)
                    || completedCaseCount([module]) < expectedModuleResultCount;
                publishCompletedResults(collectVerdictsFrom([module]));
                task.progress(Math.min(90, 20 + results.length * 5));
                return !pending;
            }, {
                timeoutMs: Math.max(0, timeout - (Date.now() - started)),
                description: "CANoe communication test module to finish",
                isReady: (value) => value === true
            });
            publishCompletedResults(collectVerdictsFrom([module]));
        }
    } else {
        if (testConfiguration === null) {
            throw new Error("CANoe TestConfiguration has not been configured");
        }
        debug("execute: calling TestConfiguration.Start");
        testConfiguration.call("Start");
        testStarted = true;
        await wait.until(() => {
            const pending = moduleRunning() || results.length < expectedResultCount;
            publishCompletedResults(collectVerdicts());
            const progress = results.length === 0
                ? 20 : Math.min(90, 20 + results.length * 5);
            task.progress(progress);
            return !pending;
        }, {
            timeoutMs: Math.max(0, timeout - (Date.now() - started)),
            description: "CANoe TestConfiguration to finish",
            isReady: (value) => value === true
        });
    }
    publishCompletedResults(collectVerdicts());
    writeResultsReport(false);
    try {
        await generateSelectedReports();
    } catch (error) {
        if (task.isCancelled()) {
            throw error;
        }
        addReportError(errorMessage(error));
        task.warning(`CANoe report generation failed: ${errorMessage(error)}`);
    }
    debug(`execute: completed (results=${results.length})`);
    const passed = testPassed();
    if (!passed) {
        executionFailureMessage = "One or more CANoe test cases failed";
        task.error(executionFailureMessage);
    }
    task.progress(95);
}

function reportMediaType(type) {
    if (type === REPORT_TYPE_XML) {
        return "application/xml";
    }
    if (type === REPORT_TYPE_XUNIT) {
        return "application/xml";
    }
    if (type === REPORT_TYPE_PDF) {
        return "application/pdf";
    }
    return "application/octet-stream";
}

function publishArtifact(source, relative, publicationId, mediaType) {
    const destination = `artifact://canoe-test/${relative}`;
    if (publishedArtifactUris.includes(destination)) {
        return;
    }
    fs.copy(source, destination, true);
    publishedArtifactUris.push(destination);
    task.publish(publicationId, destination, baseName(relative), mediaType);
}

function publishSelectedReports() {
    const typeCounts = {};
    for (const report of generatedReports) {
        if (!fs.exists(report.uri)) {
            addReportError(`Requested CANoe ${report.type} report is missing`);
            continue;
        }
        try {
            const relative = relativePath(projectRootUri, report.uri);
            const count = (typeCounts[report.type] || 0) + 1;
            typeCounts[report.type] = count;
            const publicationId = count === 1
                ? `CANOE_REPORT:${report.type}`
                : `CANOE_REPORT:${report.type}:${count}`;
            publishArtifact(report.uri, relative, publicationId,
                            reportMediaType(report.type));
        } catch (error) {
            addReportError(`Unable to publish CANoe ${report.type} report: ${errorMessage(error)}`);
        }
    }
}

export async function collectArtifacts() {
    debug("collectArtifacts: starting");
    if (!reportUri) {
        try {
            writeResultsReport(false);
        } catch (error) {
            addReportError(`Unable to write CANoe execution summary: ${errorMessage(error)}`);
        }
    }
    if (reportUri && fs.exists(reportUri)) {
        try {
            publishArtifact(reportUri,
                            relativePath(projectRootUri, reportUri),
                            "REPORT_URI",
                            "application/json");
        } catch (error) {
            addReportError(`Unable to publish CANoe execution summary: ${errorMessage(error)}`);
        }
    }
    publishSelectedReports();
    const paths = Array.isArray(projectDescriptor && projectDescriptor.Artifacts)
        ? projectDescriptor.Artifacts.slice() : [];
    for (const path of paths) {
        try {
            const relative = requireSafeRelativePath(path, "Artifacts entry");
            const source = `${projectRootUri}/${relative}`;
            if (source === reportUri) {
                continue;
            }
            if (!fs.exists(source)) {
                task.warning(`CANoe test artifact is missing: ${relative}`);
                continue;
            }
            publishArtifact(source,
                            relative,
                            `ARTIFACT:${relative}`,
                            relative.toLowerCase().endsWith(".json")
                                ? "application/json" : "application/octet-stream");
        } catch (error) {
            task.warning(`Unable to publish CANoe test artifact: ${errorMessage(error)}`);
        }
    }
    const failures = [];
    if (executionFailureMessage !== "") {
        failures.push(executionFailureMessage);
    }
    failures.push(...reportErrors);
    if (failures.length > 0) {
        task.progress(100);
        throw new Error(failures.join("; "));
    }
    debug(`collectArtifacts: completed (paths=${paths.length})`);
    task.progress(100);
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
        for (const report of reportObjects) {
            release(report);
        }
        release(testUnits);
        release(testConfiguration);
        testConfiguration = null;
        testConfigurationReport = null;
        testUnits = null;
        communicationModules = [];
        activeCommunicationModules = [];
        communicationScriptUris = [];
        communicationModuleNames = [];
        scriptUris = [];
        requestedIds = [];
        results = [];
        reportObjects = [];
        reportTypes = [];
        nativeReportOutputs = [];
        generatedReports = [];
        executionFailureMessage = "";
        reportErrors = [];
        reportFileBaseline = [];
        publishedArtifactUris = [];
        testMode = "";
        projectDescriptor = null;
        projectRootUri = "";
        configurationUri = "";
        reportUri = "";
        expectedResultCount = 0;
        selectedTestCases = [];
        testStarted = false;
        useProjectTestSetup = false;
        projectTestSetupReady = false;
        debug("cleanup: completed");
    }
}
