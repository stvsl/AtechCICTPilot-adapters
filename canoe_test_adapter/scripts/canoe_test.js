import * as com from "@atech/com";
import * as fs from "@atech/fs";
import * as cli from "@atech/cli";
import * as task from "@atech/task";

const CONTRACT_VERSION = "1.0";
const DEFAULT_TEST_CONFIGURATION = "CICT Test Configuration";
const DEFAULT_TEST_TIMEOUT_MS = 1800000;

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
let mockMode = false;
let measurementRunning = false;
let testStarted = false;
let expectedResultCount = 0;

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

function descriptorValue(name, fallback) {
    const value = projectDescriptor && projectDescriptor[name];
    return value === undefined || value === null || value === "" ? fallback : value;
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

function stateIsTerminal(state) {
    const value = normalize(state);
    return value === "0" || value === "stopped" || value === "finished"
        || value === "completed" || value === "passed" || value === "failed"
        || value === "cstopped" || value === "cfinished"
        || value === "ccompleted" || value === "cpassed" || value === "cfailed"
        || value === "cverdictpassed" || value === "cverdictfailed";
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

function reportPathUri() {
    const paths = reportPathUris();
    return paths.length > 0 ? paths[0] : "";
}

function reportPathUris() {
    if (reportUri && fs.exists(reportUri)) {
        return [reportUri];
    }
    const reports = testConfigurationReport === null
        ? reportObjects : [testConfigurationReport].concat(reportObjects);
    const paths = [];
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
    if (uri.toLowerCase().endsWith(".json")) {
        const value = readJson(uri, "TEST_CASE_IDS");
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

function isArchive(uri) {
    return uri.toLowerCase().endsWith(".zip");
}

function addExternalScripts(uri) {
    if (!uri) {
        return;
    }
    const resourceRoot = "workspace://canoe-test/resources";
    if (isArchive(uri)) {
        fs.extractZip(uri, resourceRoot);
        const entries = fs.list(resourceRoot, true);
        for (const entry of entries) {
            if (entry.type === "file" && (entry.name.toLowerCase().endsWith(".vtuexe")
                    || entry.name.toLowerCase().endsWith(".tse")
                    || entry.name.toLowerCase().endsWith(".xml"))) {
                const kind = scriptKind(entry.name);
                if (!testMode) {
                    testMode = kind;
                } else if (testMode !== kind) {
                    throw new Error("VTESTStudio and communication scripts cannot be mixed in one task");
                }
                registerScript({ uri: entry.uri, kind, name: entry.name });
            }
        }
        return;
    }
    const target = `${resourceRoot}/${baseName(uri)}`;
    fs.mkdir(resourceRoot);
    fs.copy(uri, target, true);
    const kind = scriptKind(baseName(uri));
    if (!testMode) {
        testMode = kind;
    } else if (testMode !== kind) {
        throw new Error("VTESTStudio and communication scripts cannot be mixed in one task");
    }
    registerScript({ uri: target, kind, name: baseName(uri) });
}

function objectRunning(object, started = true) {
    if (!started || object === null || object === undefined) {
        return false;
    }
    const running = optionalProperty(object, "Running");
    if (running !== undefined) {
        return running === true;
    }
    const state = normalize(optionalProperty(object, "State"));
    return state !== "" && !stateIsTerminal(state);
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

function walkElements(elements, unitName, selectedOnly) {
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
            const selected = requestedIds.length === 0 || requestedIds.includes(id);
            try {
                element.set("Enabled", selected);
            } catch (_) {
                // Some CANoe versions expose Enabled as read-only after start.
            }
            if (selected && (!selectedOnly || selected)) {
                local.push({ testUnit: unitName, id, name: id, object: element });
            }
        }
        if (children !== undefined && children !== null) {
            const nested = walkElements(children, unitName, selectedOnly);
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
        for (const candidate of walkElements(elements, unitName, true)) {
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
    if (collectionCount(configurations) === 0) {
        configurations.call("Add");
    }
    testConfiguration = collectionItems(configurations)[0];
    if (testConfiguration === undefined) {
        throw new Error("CANoe configuration could not create a TestConfiguration");
    }
    const configurationName = descriptorValue("TestConfiguration", DEFAULT_TEST_CONFIGURATION);
    testConfiguration.set("Name", configurationName);
    testConfiguration.set("Enabled", true);
    const settings = optionalProperty(testConfiguration, "Settings");
    if (settings !== undefined) {
        try {
            settings.set("ExecutionMode", 0);
        } catch (_) {
            // Older CANoe versions use the default single-execution mode.
        }
    }
    testUnits = testConfiguration.get("TestUnits");
    removeAll(testUnits, "Remove");
    for (const script of scriptUris) {
        testUnits.call("Add", fs.nativePath(script.uri));
    }
    const units = collectionItems(testUnits);
    const selected = [];
    for (const unit of units) {
        const elements = elementsFor(unit);
        if (elements === null || elements === undefined) {
            continue;
        }
        const candidates = walkElements(elements,
                                        String(optionalProperty(unit, "Name") || ""),
                                        false);
        if (candidates.length > 0) {
            try {
                unit.set("Enabled", true);
            } catch (_) {
                // Some CANoe versions enable a TestUnit implicitly.
            }
        }
        for (const candidate of candidates) {
            selected.push(candidate.id);
        }
    }
    if (selected.length === 0) {
        throw new Error("No enabled CANoe test case matches TEST_CASE_IDS");
    }
    expectedResultCount = selected.length;
    testConfigurationReport = optionalProperty(testConfiguration, "Report");
    if (testConfigurationReport !== undefined && testConfigurationReport !== null) {
        reportObjects.push(testConfigurationReport);
    }
    task.output("SELECTED_TEST_CASES", selected);
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
        const candidates = walkElements(elements,
                                        moduleName,
                                        false);
        if (candidates.length > 0) {
            activeCommunicationModules.push(module);
            try {
                module.set("Enabled", true);
            } catch (_) {
                // A module can be enabled by its parent environment.
            }
            for (const candidate of candidates) {
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
    expectedResultCount = selected.length;
    task.output("SELECTED_TEST_CASES", selected);
}

async function waitUntil(predicate, timeoutMs, description) {
    const started = Date.now();
    while (!predicate()) {
        task.checkCancelled();
        if (Date.now() - started >= timeoutMs) {
            throw new Error(`Timed out waiting for ${description}`);
        }
        await task.delay(250);
    }
}

function openConfiguration() {
    if (application === null) {
        throw new Error("CANoe Automation is not connected");
    }
    if (configuration !== null) {
        return;
    }
    try {
        application.call("Open", fs.nativePath(configurationUri), true, true);
    } catch (_) {
        application.call("Open", fs.nativePath(configurationUri));
    }
    configuration = application.get("Configuration");
    const openResult = optionalProperty(configuration, "OpenConfigurationResult")
        || optionalProperty(application, "OpenConfigurationResult");
    if (openResult !== undefined && openResult !== null) {
        const resultCode = optionalProperty(openResult, "result");
        if (resultCode !== undefined && Number(resultCode) !== 0) {
            release(openResult);
            throw new Error(`CANoe configuration open failed with result ${resultCode}`);
        }
        release(openResult);
    }
}

export async function prepare(projectPackage) {
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
    mockMode = Boolean(task.option("MockAutomation", false));

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
    addExternalScripts(optionalRequirement("TEST_SCRIPTS"));
    if (scriptUris.length === 0) {
        throw new Error("No CANoe test script (.vtuexe/.tse/.xml) was supplied");
    }
    requestedIds = parseIds(optionalRequirement("TEST_CASE_IDS"));
    if (requestedIds.length === 0 && Array.isArray(projectDescriptor.TestCaseIds)) {
        requestedIds = projectDescriptor.TestCaseIds.map((id) => String(id));
    }
    task.output("TEST_MODE", testMode);
    task.output("TEST_SCRIPT_COUNT", scriptUris.length);
    task.output("TEST_CASE_IDS", requestedIds);
    task.output("CANOE_CONFIGURATION", configurationUri);
    task.progress(5, "CANoe test project prepared");
}

export async function launch() {
    if (mockMode) {
        task.progress(8, "CANoe simulator ready");
        return;
    }
    if (Boolean(task.option("AttachExisting", false))) {
        launchedByTask = false;
        task.log("info", "Attaching to an existing CANoe process");
        return;
    }
    const executable = task.device("CANOE_SOFTWARE_POSITION");
    canoeProcess = cli.start({
        executable,
        arguments: []
    });
    launchedByTask = true;
    task.output("CANOE_PROCESS", canoeProcess);
    await task.delay(1500);
}

export async function connect() {
    if (mockMode) {
        return;
    }
    const attachExisting = Boolean(task.option("AttachExisting", false));
    application = attachExisting
        ? com.getActive("CANoe.Application")
        : com.create("CANoe.Application");
}

export async function startMeasurement() {
    if (mockMode) {
        measurementRunning = true;
        task.progress(10, "CANoe Measurement is running");
        return;
    }
    openConfiguration();
    measurement = application.get("Measurement");
    if (measurement.get("Running") !== true) {
        measurement.call("Start");
    }
    await waitUntil(() => measurement.get("Running") === true,
                    120000, "CANoe Measurement to start");
    measurementRunning = true;
    task.progress(10, "CANoe Measurement is running");
}

export async function configure() {
    if (mockMode) {
        task.progress(15, "CANoe test units configured");
        return;
    }
    openConfiguration();
    if (testMode === "communication") {
        configureCommunication();
    } else {
        configureVtest();
    }
    task.progress(15, "CANoe test units configured");
}

export async function execute() {
    const timeout = Number(projectDescriptor && projectDescriptor.TestTimeoutMs)
        || DEFAULT_TEST_TIMEOUT_MS;
    if (mockMode) {
        const ids = requestedIds.length > 0 ? requestedIds : ["mock.testcase"];
        results = ids.map((id) => ({
            testUnit: "mock",
            id,
            name: id,
            verdict: "cVerdictPassed",
            passed: true
        }));
        fs.writeText(`${projectRootUri}/mock-report.json`, JSON.stringify({
            status: "passed",
            results
        }, null, 2));
        reportUri = `${projectRootUri}/mock-report.json`;
        task.output("TEST_RESULTS", results);
        task.output("VERDICT", "passed");
        task.progress(95, "CANoe test execution passed");
        return;
    }
    const started = Date.now();
    if (testMode === "communication") {
        if (activeCommunicationModules.length === 0) {
            throw new Error("No CANoe communication test modules have been configured");
        }
        for (const module of activeCommunicationModules) {
            module.set("ExecuteRepeatedly", false);
            module.call("Start");
            testStarted = true;
        }
        while (activeCommunicationModules.some((module) => objectRunning(module, true))
                || results.length < expectedResultCount) {
            task.checkCancelled();
            results = collectVerdicts();
            task.progress(Math.min(90, 20 + results.length * 5),
                          `CANoe test cases observed: ${results.length}`,
                          { count: results.length });
            if (Date.now() - started >= timeout) {
                throw new Error("Timed out waiting for CANoe communication test modules");
            }
            await task.delay(250);
        }
    } else {
        if (testConfiguration === null) {
            throw new Error("CANoe TestConfiguration has not been configured");
        }
        testConfiguration.call("Start");
        testStarted = true;
        while (moduleRunning() || results.length < expectedResultCount) {
            task.checkCancelled();
            results = collectVerdicts();
            const progress = results.length === 0 ? 20 : Math.min(90, 20 + results.length * 5);
            task.progress(progress, `CANoe test cases observed: ${results.length}`, {
                count: results.length
            });
            if (!moduleRunning() && results.length >= expectedResultCount) {
                break;
            }
            if (Date.now() - started >= timeout) {
                throw new Error("Timed out waiting for CANoe TestConfiguration");
            }
            await task.delay(250);
        }
    }
    results = collectVerdicts();
    reportUri = reportPathUri();
    const passed = results.length > 0 && results.every((item) => item.passed);
    task.output("TEST_RESULTS", results);
    task.output("REPORT_URI", reportUri);
    task.output("VERDICT", passed ? "passed" : "failed");
    if (!passed) {
        throw new Error("One or more CANoe test cases failed");
    }
    task.progress(95, "CANoe test execution passed");
}

export async function collectArtifacts() {
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
    const collected = [];
    for (const path of paths) {
        const relative = requireSafeRelativePath(path, "Artifacts entry");
        const source = `${projectRootUri}/${relative}`;
        if (!fs.exists(source)) {
            task.log("warning", `CANoe test artifact is missing: ${relative}`);
            continue;
        }
        const destination = `artifact://canoe-test/${relative}`;
        fs.copy(source, destination, true);
        task.artifact(destination, { name: baseName(relative) });
        collected.push(destination);
    }
    task.output("ARTIFACTS", collected);
    task.progress(100, "CANoe test artifacts collected");
}

export async function cleanup() {
    if (mockMode) {
        task.output("CLEANUP_COMPLETED", true);
        return;
    }
    try {
        if (testConfiguration !== null && testStarted) {
            testConfiguration.call("Stop");
        }
        for (const module of activeCommunicationModules) {
            if (testStarted) {
                module.call("Stop");
            }
        }
    } catch (error) {
        task.log("warning", `Unable to stop CANoe TestConfiguration: ${error.message}`);
    }
    try {
        if (measurement !== null && measurementRunning && measurement.get("Running") === true) {
            measurement.call("Stop");
        }
    } catch (error) {
        task.log("warning", `Unable to stop CANoe Measurement: ${error.message}`);
    }
    try {
        if (application !== null
                && (launchedByTask || Boolean(task.option("QuitAttachedInstance", false)))) {
            application.call("Quit");
        }
    } catch (error) {
        task.log("warning", `Unable to quit CANoe: ${error.message}`);
    }
    if (canoeProcess !== null) {
        try {
            if (cli.isRunning(canoeProcess)) {
                cli.terminate(canoeProcess, 3000);
            }
        } catch (error) {
            task.log("warning", `Unable to terminate CANoe process: ${error.message}`);
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
    task.output("CLEANUP_COMPLETED", true);
}
