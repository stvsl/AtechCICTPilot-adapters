import * as com from "@atech/com";
import * as fs from "@atech/fs";
import * as cli from "@atech/cli";
import * as task from "@atech/task";

const CONTRACT_VERSION = "1.0";
const DEFAULT_TEST_CONFIGURATION = "CICT Test Configuration";
const DEFAULT_TEST_TIMEOUT_MS = 1800000;
const CANOE_AUTOMATION_READY_TIMEOUT_MS = 120000;
const CANOE_MEASUREMENT_STOP_TIMEOUT_MS = 120000;
const CANOE_CONFIGURATION_READY_TIMEOUT_MS = 120000;
const CANOE_TEST_SETUP_READY_TIMEOUT_MS = 120000;
const CANOE_MEASUREMENT_START_TIMEOUT_MS = 120000;
const CANOE_POLL_INTERVAL_MS = 250;
const CANOE_ACTIVE_OBJECT_GRACE_TIMEOUT_MS = 3000;

let application = null;
let measurement = null;
let configuration = null;
let testConfiguration = null;
let testConfigurationReport = null;
let testUnits = null;
let canoeProcess = null;
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
let launchedByTask = false;
let attachExisting = false;
let measurementRunning = false;
let testStarted = false;
let expectedResultCount = 0;
let useProjectTestSetup = false;
let selectedTestCases = [];

function debug(message) {
    task.info(`[CANoe debug] ${message}`);
}

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
    }, canoeTimeout("AutomationReadyTimeoutMs",
                    CANOE_AUTOMATION_READY_TIMEOUT_MS),
    "the existing CANoe Automation server to stop");
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
    if (object === null) {
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
    const candidate = String(nativePath).replace(/\\/g, "/");
    const lowerRoot = root.toLowerCase();
    const lowerCandidate = candidate.toLowerCase();
    if (lowerCandidate !== lowerRoot && !lowerCandidate.startsWith(`${lowerRoot}/`)) {
        return "";
    }
    return `${projectRootUri}/${candidate.substring(root.length).replace(/^\/+/, "")}`;
}

function reportPathUris() {
    const paths = [];
    if (reportUri && fs.exists(reportUri)) {
        paths.push(reportUri);
    }
    const reports = testConfigurationReport === null
        ? reportObjects : [testConfigurationReport].concat(reportObjects);
    for (const report of reports) {
        if (report === null || report === undefined) {
            continue;
        }
        const native = optionalProperty(report, "LastWrittenFullPath")
            || optionalProperty(report, "LastWrittenFullName");
        const uri = nativePathToWorkspaceUri(native);
        if (uri && fs.exists(uri) && !paths.includes(uri)) {
            paths.push(uri);
        }
    }
    return paths;
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

function writeResultsReport() {
    const source = `${projectRootUri}/test-results.json`;
    const passed = results.length > 0 && results.every((item) => item.passed);
    fs.writeText(source, JSON.stringify({
        taskId: task.id(),
        status: passed ? "passed" : "failed",
        results
    }, null, 2));
    reportUri = source;
    const destination = "artifact://canoe-test/test-results.json";
    fs.copy(source, destination, true);
    task.publish("REPORT_URI",
                 destination,
                 "CANoe test results",
                 "application/json");
}

function elementsFor(object) {
    return propertyOr(object, ["Elements", "Sequence"], null);
}

function collectCommunicationModules(environment, output) {
    const modules = optionalProperty(environment, "TestModules");
    for (const module of collectionItems(modules)) {
        output.push(module);
    }
    const items = optionalProperty(environment, "Items");
    for (const item of collectionItems(items)) {
        const nestedItems = optionalProperty(item, "Items");
        const sequence = propertyOr(item, ["Sequence", "Elements"], null);
        if (sequence !== null && sequence !== undefined) {
            output.push(item);
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
    const configurations = configuration.get("TestConfigurations");
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
        reportObjects.push(testConfigurationReport);
    }
}

function configureCommunication() {
    const setup = configuration.get("TestSetup");
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
        if (report !== null && report !== undefined) {
            reportObjects.push(report);
        }
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
    const setup = optionalProperty(configuration, "TestSetup");
    const environments = setup === undefined || setup === null
        ? null : optionalProperty(setup, "TestEnvironments");
    if (environments !== null && environments !== undefined
            && collectionCount(environments) > 0) {
        testMode = "communication";
        configureCommunication();
        return;
    }

    const configurations = optionalProperty(configuration, "TestConfigurations");
    if (configurations !== null && configurations !== undefined
            && collectionCount(configurations) > 0) {
        testMode = "vtest";
        configureVtest();
        return;
    }

    throw new Error("CANoe project does not contain a TestEnvironment or TestConfiguration");
}

function hasProjectTestSetup() {
    const setup = optionalProperty(configuration, "TestSetup");
    const environments = setup === undefined || setup === null
        ? null : optionalProperty(setup, "TestEnvironments");
    if (environments !== null && environments !== undefined
            && collectionCount(environments) > 0) {
        const environment = collectionItems(environments)[0];
        return environment !== undefined
            && optionalProperty(environment, "TestModules") !== undefined;
    }

    const configurations = optionalProperty(configuration, "TestConfigurations");
    if (configurations === null || configurations === undefined
            || collectionCount(configurations) === 0) {
        return false;
    }
    const testConfiguration = collectionItems(configurations)[0];
    return testConfiguration !== undefined
        && optionalProperty(testConfiguration, "TestUnits") !== undefined;
}

async function waitUntil(predicate, timeoutMs, description) {
    const started = Date.now();
    let lastError = "";
    debug(`waiting for ${description}`);
    while (true) {
        task.checkCancelled();
        try {
            if (predicate()) {
                debug(`${description} is ready after ${Date.now() - started} ms`);
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
        await task.delay(CANOE_POLL_INTERVAL_MS);
    }
}

async function waitForProjectTestSetup() {
    if (!useProjectTestSetup) {
        return;
    }
    debug("openConfiguration: waiting for project test setup");
    await waitUntil(hasProjectTestSetup,
                    canoeTimeout("TestSetupReadyTimeoutMs",
                                 CANOE_TEST_SETUP_READY_TIMEOUT_MS),
                    "CANoe project test setup to finish loading");
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
        // Configuration object itself is the only portable readiness signal.
        return true;
    }

    const resultCode = typeof openResult === "number"
        ? openResult : propertyOr(openResult, ["result", "Result"]);
    const openError = optionalProperty(openResult, "ErrorMessage");
    release(openResult);
    if (resultCode === undefined || resultCode === null) {
        return true;
    }
    if (Number(resultCode) === 0) {
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

async function waitForConfigurationReady() {
    await waitUntil(() => {
        if (configuration === null) {
            const opened = application.get("Configuration");
            if (opened === null || opened === undefined) {
                return false;
            }
            configuration = opened;
        }
        return checkOpenResult();
    }, canoeTimeout("ConfigurationReadyTimeoutMs",
                    CANOE_CONFIGURATION_READY_TIMEOUT_MS),
    "CANoe configuration to finish loading");
}

async function stopMeasurementBeforeOpening() {
    if (measurement === null) {
        measurement = application.get("Measurement");
    }
    if (measurement.get("Running") !== true) {
        return;
    }
    debug("openConfiguration: stopping existing measurement");
    measurement.call("Stop");
    await waitUntil(() => measurement.get("Running") !== true,
                    canoeTimeout("MeasurementStopTimeoutMs",
                                 CANOE_MEASUREMENT_STOP_TIMEOUT_MS),
                    "CANoe Measurement to stop before opening the configuration");
}

async function waitForAutomationServer() {
    let candidate = null;
    await waitUntil(() => {
        try {
            // CANoe started with -embedding may publish itself in the ROT
            // slightly later. Activating the ProgID here would create a
            // second CANoe process while the launched one is still starting.
            candidate = com.getActive("CANoe.Application");
            const candidateMeasurement = candidate.get("Measurement");
            candidateMeasurement.get("Running");
            release(measurement);
            measurement = candidateMeasurement;
            release(application);
            application = candidate;
            candidate = null;
            return true;
        } catch (_) {
            release(candidate);
            candidate = null;
            return false;
        }
    }, canoeTimeout("AutomationReadyTimeoutMs",
                    CANOE_AUTOMATION_READY_TIMEOUT_MS),
    "CANoe Automation server to become available");
}

async function connectToStartedAutomationServer() {
    const started = Date.now();
    debug("connect: checking whether the started CANoe instance is active");
    while (Date.now() - started < CANOE_ACTIVE_OBJECT_GRACE_TIMEOUT_MS) {
        task.checkCancelled();
        let candidate = null;
        let candidateMeasurement = null;
        try {
            candidate = com.getActive("CANoe.Application");
            candidateMeasurement = candidate.get("Measurement");
            candidateMeasurement.get("Running");
            release(measurement);
            measurement = candidateMeasurement;
            candidateMeasurement = null;
            release(application);
            application = candidate;
            candidate = null;
            return;
        } catch (_) {
            release(candidateMeasurement);
            release(candidate);
            await task.delay(CANOE_POLL_INTERVAL_MS);
        }
    }

    // Some CANoe versions started with -embedding do not publish an Active
    // Object in the ROT. COM activation connects to their local server once
    // it has registered its class object.
    debug("connect: calling com.create(CANoe.Application)");
    application = com.create("CANoe.Application");
}

async function openConfiguration() {
    if (application === null) {
        throw new Error("CANoe Automation is not connected");
    }
    if (configuration !== null) {
        debug("openConfiguration: configuration is already open");
        await waitForConfigurationReady();
        await waitForProjectTestSetup();
        return;
    }
    // The task workspace is disposable, so CANoe may persist an upgraded
    // configuration there. Keep prompts disabled for unattended execution.
    await stopMeasurementBeforeOpening();
    try {
        debug(`openConfiguration: calling Application.Open (${configurationUri})`);
        const openResult = application.call(
            "Open", fs.nativePath(configurationUri), true, false);
        checkOpenResult(openResult);
    } catch (error) {
        if (isTransientOpenFailure(error)) {
            throw new Error("CANoe Application became unavailable after "
                + `initialization: ${errorMessage(error)}`);
        }
        throw error;
    }
    await waitForConfigurationReady();
    await waitForProjectTestSetup();
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
    testMode = "";
    requestedIds = [];
    results = [];
    testStarted = false;
    expectedResultCount = 0;
    selectedTestCases = [];
    useProjectTestSetup = false;
    attachExisting = false;

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
    debug(`prepare: completed (mode=${testMode}, requestedCases=${requestedIds.length})`);
    task.progress(5);
}

export async function launch() {
    debug("launch: starting");
    const startMode = canoeStartMode();
    attachExisting = startMode.attachExisting;
    if (attachExisting) {
        launchedByTask = false;
        debug("launch: using an existing CANoe process");
        task.info("Attaching to an existing CANoe process");
        return;
    }
    if (startMode.clearExisting) {
        await clearExistingCanoe();
    }
    const executable = task.device("CANOE_SOFTWARE_POSITION");
    debug(`launch: starting executable: ${executable}`);
    debug(`launch: project configuration will be opened during configure: ${configurationUri}`);
    canoeProcess = cli.start({
        executable,
        // CANoe's COM mode suppresses the disclaimer and other modal dialogs.
        arguments: ["-embedding"]
    });
    launchedByTask = true;
    debug(`launch: process started (pid=${canoeProcess.pid})`);
}

export async function connect() {
    debug("connect: starting");
    if (attachExisting) {
        debug("connect: waiting for the existing CANoe Automation server");
        await waitForAutomationServer();
    } else {
        await connectToStartedAutomationServer();
    }
    debug("connect: completed");
}

export async function startMeasurement() {
    debug("startMeasurement: starting");
    await openConfiguration();
    if (measurement === null) {
        measurement = application.get("Measurement");
    }
    if (measurement.get("Running") !== true) {
        debug("startMeasurement: calling Measurement.Start");
        measurement.call("Start");
    } else {
        debug("startMeasurement: measurement is already running");
    }
    await waitUntil(() => measurement.get("Running") === true,
                    canoeTimeout("MeasurementStartTimeoutMs",
                                 CANOE_MEASUREMENT_START_TIMEOUT_MS),
                    "CANoe Measurement to start");
    measurementRunning = true;
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
            module.set("ExecuteRepeatedly", false);
            module.call("Start");
            testStarted = true;
            while (objectRunning(module, true)
                    || completedCaseCount([module]) < expectedModuleResultCount) {
                task.checkCancelled();
                publishCompletedResults(collectVerdictsFrom([module]));
                task.progress(Math.min(90, 20 + results.length * 5));
                if (Date.now() - started >= timeout) {
                    throw new Error("Timed out waiting for CANoe communication test module");
                }
                await task.delay(CANOE_POLL_INTERVAL_MS);
            }
            publishCompletedResults(collectVerdictsFrom([module]));
        }
    } else {
        if (testConfiguration === null) {
            throw new Error("CANoe TestConfiguration has not been configured");
        }
        debug("execute: calling TestConfiguration.Start");
        testConfiguration.call("Start");
        testStarted = true;
        while (moduleRunning() || results.length < expectedResultCount) {
            task.checkCancelled();
            publishCompletedResults(collectVerdicts());
            const progress = results.length === 0
                ? 20 : Math.min(90, 20 + results.length * 5);
            task.progress(progress);
            if (!moduleRunning() && results.length >= expectedResultCount) {
                break;
            }
            if (Date.now() - started >= timeout) {
                throw new Error("Timed out waiting for CANoe TestConfiguration");
            }
            await task.delay(CANOE_POLL_INTERVAL_MS);
        }
    }
    publishCompletedResults(collectVerdicts());
    writeResultsReport();
    debug(`execute: completed (results=${results.length})`);
    const passed = results.length > 0 && results.every((item) => item.passed);
    if (!passed) {
        throw new Error("One or more CANoe test cases failed");
    }
    task.progress(95);
}

export async function collectArtifacts() {
    debug("collectArtifacts: starting");
    const paths = Array.isArray(projectDescriptor && projectDescriptor.Artifacts)
        ? projectDescriptor.Artifacts.slice() : [];
    const prefix = `${projectRootUri}/`;
    for (const finalReport of reportPathUris()) {
        if (finalReport && finalReport.startsWith(prefix)) {
            const relative = finalReport.substring(prefix.length);
            if (!paths.includes(relative)) {
                paths.push(relative);
            }
        }
    }
    for (const path of paths) {
        const relative = requireSafeRelativePath(path, "Artifacts entry");
        const source = `${projectRootUri}/${relative}`;
        if (!fs.exists(source)) {
            task.warning(`CANoe test artifact is missing: ${relative}`);
            continue;
        }
        const destination = `artifact://canoe-test/${relative}`;
        fs.copy(source, destination, true);
        task.publish(source === reportUri ? "REPORT_URI" : `ARTIFACT:${relative}`,
                     destination,
                     baseName(relative),
                     relative.toLowerCase().endsWith(".json")
                         ? "application/json" : "application/octet-stream");
    }
    debug(`collectArtifacts: completed (paths=${paths.length})`);
    task.progress(100);
}

export async function cleanup() {
    debug(`cleanup: starting (measurementRunning=${measurementRunning}, testStarted=${testStarted}, launchedByTask=${launchedByTask})`);
    try {
        if (testConfiguration !== null && testStarted) {
            debug("cleanup: calling TestConfiguration.Stop");
            testConfiguration.call("Stop");
        }
        for (const module of activeCommunicationModules) {
            if (testStarted) {
                debug("cleanup: stopping communication test module");
                module.call("Stop");
            }
        }
    } catch (error) {
        task.warning(`Unable to stop CANoe TestConfiguration: ${error.message}`);
    }
    try {
        if (measurement !== null && measurementRunning && measurement.get("Running") === true) {
            debug("cleanup: calling Measurement.Stop");
            measurement.call("Stop");
        }
    } catch (error) {
        task.warning(`Unable to stop CANoe Measurement: ${error.message}`);
    }
    try {
        if (application !== null
                && (launchedByTask || Boolean(task.option("QuitAttachedInstance", false)))) {
            debug("cleanup: calling Application.Quit");
            application.call("Quit");
        }
    } catch (error) {
        task.warning(`Unable to quit CANoe: ${error.message}`);
    }
    if (canoeProcess !== null) {
        try {
            if (cli.isRunning(canoeProcess)) {
                debug(`cleanup: terminating process (pid=${canoeProcess.pid})`);
                cli.terminate(canoeProcess, 3000);
            }
        } catch (error) {
            task.warning(`Unable to terminate CANoe process: ${error.message}`);
        }
        try {
            cli.release(canoeProcess);
        } catch (_) {
            // The host reclaims process handles when the worker exits.
        }
    }
    for (const report of reportObjects) {
        release(report);
    }
    release(testUnits);
    release(testConfiguration);
    release(configuration);
    release(measurement);
    release(application);
    application = null;
    measurement = null;
    configuration = null;
    testConfiguration = null;
    testConfigurationReport = null;
    testUnits = null;
    communicationModules = [];
    activeCommunicationModules = [];
    reportObjects = [];
    canoeProcess = null;
    measurementRunning = false;
    testStarted = false;
    launchedByTask = false;
    attachExisting = false;
    useProjectTestSetup = false;
    debug("cleanup: completed");
}
