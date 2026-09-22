import * as fs from "@atech/fs";
import * as task from "@atech/task";

import {
    cleanupConnector,
    ensureVcareaProcessRunning,
    launchVcarea,
    readConnectorMqttConfiguration,
} from "./vcarea/connector.js";
import {
    TOPICS,
    cleanupTimeout,
    configureBroker,
    disconnect,
    executionTimeout,
    initializeProtocol,
    isConnected,
    receiveMessage,
    registerAccess,
    reportEventCount,
    reportEventsSince,
    request,
    resetProtocol,
    routeProtocolMessage,
    waitForEaReady,
} from "./vcarea/protocol.js";
import { downloadReport } from "./vcarea/report.js";

// 导出名称与阶段切分保持和 CANoe 测试适配器一致：prepare、launch、
// readMqttConfig、connect、configure、startMeasurement、execute、
// collectArtifacts、cleanup。

const PROJECT_ROOT_URI = "workspace://vcarea-test/project";
const RESULT_ARTIFACT_URI = "artifact://vcarea-test/execution-result.json";
const SUPPORTED_REPORT_TYPES = ["html", "pdf", "xlsx", "zip"];

// TODO: 接口文档没有规定启动实验环境后的稳定时间和报告事件收尾时间，
// 暂分别等待 1000 ms 和 500 ms，可通过节点选项覆盖。
const DEFAULT_ENVIRONMENT_SETTLE_MS = 1000;
const DEFAULT_REPORT_EVENT_SETTLE_MS = 500;

let sourceProjectUri = "";
let projectRootUri = "";
let projectFileUri = "";
let projectPath = "";
let configuredWorkDirectory = "";
let deviceConfigurationPath = "";
let projectOpened = false;
let environmentStarted = false;
let activeCasePath = "";
let activeCaseMayBeOpen = false;
let testConfigurationPath = "";
let testbenchConfigurationPath = "";
let requestedCases = [];
let selectedCases = [];
let reportTypes = [];
let executionResults = [];
let reportDownloads = [];
let collectionErrors = [];

function optionInteger(name, fallback, minimum, maximum) {
    const value = Number(task.option(name, fallback));
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(
            `${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
    }
    return value;
}

function optionBoolean(name, fallback) {
    const value = task.option(name, fallback);
    if (typeof value === "boolean") {
        return value;
    }
    const normalized = String(value).trim().toLowerCase();
    if (normalized === "true") {
        return true;
    }
    if (normalized === "false") {
        return false;
    }
    throw new Error(`${name} 必须是 true 或 false`);
}

function optionalDevice(key) {
    try {
        const value = task.device(key);
        return value === undefined || value === null ? "" : String(value).trim();
    } catch (_) {
        return "";
    }
}

function optionalRequirement(key) {
    try {
        return task.requirement(key);
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
        // 插件调试时允许直接传入字面量，正式任务输入仍由清单快照为文件。
    }
    return String(value);
}

function baseName(path) {
    const parts = String(path).replace(/\\/g, "/").split("/");
    return parts[parts.length - 1];
}

function fileStem(path) {
    return baseName(path).replace(/\.[^.]+$/, "");
}

function normalizedMatchPath(value) {
    return String(value === undefined || value === null ? "" : value)
        .trim().replace(/^file:\/\//i, "").replace(/\\/g, "/")
        .replace(/^\.\//, "").replace(/\/+$/g, "").toLowerCase();
}

function isAbsoluteNativePath(value) {
    const path = String(value || "");
    return path.startsWith("/") || path.startsWith("\\\\")
        || /^[A-Za-z]:[\\/]/.test(path);
}

function uniqueStrings(values) {
    const result = [];
    for (const value of values) {
        if (!result.includes(value)) {
            result.push(value);
        }
    }
    return result;
}

function parseRequestedCases() {
    const text = optionalRequirementText("TEST_CASE_IDS").trim();
    if (text === "") {
        return [];
    }
    if (text.startsWith("[") || text.startsWith("{")) {
        let value;
        try {
            value = JSON.parse(text);
        } catch (error) {
            throw new Error(`TEST_CASE_IDS 不是有效 JSON：${error.message}`);
        }
        if (Array.isArray(value)) {
            return uniqueStrings(value.map((item) => String(item).trim())
                .filter((item) => item !== ""));
        }
        if (value !== null && typeof value === "object") {
            for (const key of ["ids", "testCaseIds", "TestCaseIds", "cases"]) {
                if (Array.isArray(value[key])) {
                    return uniqueStrings(value[key]
                        .map((item) => String(item).trim())
                        .filter((item) => item !== ""));
                }
            }
        }
        throw new Error("TEST_CASE_IDS JSON 必须是数组或包含用例数组的对象");
    }
    return uniqueStrings(text.split(/[\r\n,;]+/)
        .map((item) => item.trim()).filter((item) => item !== ""));
}

function parseReportTypes() {
    const text = optionalRequirementText("VCAR_EA_REPORT_TYPE");
    const selected = uniqueStrings(String(text).split(",")
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item !== ""));
    if (selected.length === 0) {
        throw new Error("VCAR_EA_REPORT_TYPE 必须选择至少一种报告格式");
    }
    for (const type of selected) {
        if (!SUPPORTED_REPORT_TYPES.includes(type)) {
            throw new Error(
                `不支持的 VCarEA 报告格式 [${type}]，可选值：`
                + SUPPORTED_REPORT_TYPES.join("、"));
        }
    }
    const legacyFormats = selected.filter((type) => type !== "zip");
    if (legacyFormats.length > 0) {
        task.warning(
            `已保留旧版报告选项 ${legacyFormats.join("、")}，`
            + "但 EA 外部调用接口当前仅能下载 ZIP；本次将发布原生 ZIP 报告");
    }
    return selected;
}

function projectFiles(extension) {
    const suffix = extension.toLowerCase();
    return fs.list(projectRootUri, true).filter((entry) =>
        entry.type === "file" && entry.name.toLowerCase().endsWith(suffix));
}

function requireSingleProjectFile() {
    const projects = projectFiles(".hlt");
    if (projects.length === 0) {
        throw new Error("VCarEA 工程目录中未找到 .hlt 工程文件");
    }
    if (projects.length > 1) {
        throw new Error(
            `VCarEA 工程目录中存在 ${projects.length} 个 .hlt 文件，无法确定要执行的工程`);
    }
    return projects[0].uri;
}

function resetExecutionState() {
    sourceProjectUri = "";
    projectRootUri = "";
    projectFileUri = "";
    projectPath = "";
    configuredWorkDirectory = "";
    deviceConfigurationPath = "";
    projectOpened = false;
    environmentStarted = false;
    activeCasePath = "";
    activeCaseMayBeOpen = false;
    testConfigurationPath = "";
    testbenchConfigurationPath = "";
    requestedCases = [];
    selectedCases = [];
    reportTypes = [];
    executionResults = [];
    reportDownloads = [];
    collectionErrors = [];
}

function requirePrepared() {
    if (projectPath === "" || projectRootUri === "") {
        throw new Error("VCarEA 测试工程尚未准备");
    }
}

function projectRelativePath(uri) {
    const prefix = `${projectRootUri.replace(/\/$/, "")}/`;
    return String(uri).startsWith(prefix)
        ? String(uri).substring(prefix.length) : "";
}

function uriForAbsoluteInventoryPath(path) {
    const root = normalizedMatchPath(fs.nativePath(projectRootUri));
    const candidate = normalizedMatchPath(path);
    if (candidate === root) {
        return projectRootUri;
    }
    if (!candidate.startsWith(`${root}/`)) {
        return "";
    }
    return `${projectRootUri}/${candidate.substring(root.length + 1)}`;
}

/** 将项目清单返回的相对或绝对路径解析到本次任务复制的工程目录。 */
function resolveInventoryUri(path, extension) {
    const raw = String(path || "").trim();
    if (raw === "") {
        throw new Error(`VCarEA 返回了空的 ${extension} 路径`);
    }
    if (isAbsoluteNativePath(raw)) {
        const mapped = uriForAbsoluteInventoryPath(raw);
        if (mapped !== "" && fs.exists(mapped)) {
            return mapped;
        }
    } else {
        const relative = raw.replace(/\\/g, "/").replace(/^\.\//, "")
            .replace(/^\/+/, "");
        const direct = `${projectRootUri}/${relative}`;
        if (fs.exists(direct)) {
            return direct;
        }
    }

    const target = normalizedMatchPath(raw);
    const targetName = baseName(target);
    const matches = projectFiles(extension).filter((entry) => {
        const relative = normalizedMatchPath(projectRelativePath(entry.uri));
        return relative === target || relative.endsWith(`/${target}`)
            || target.endsWith(`/${relative}`) || baseName(relative) === targetName;
    });
    if (matches.length === 1) {
        return matches[0].uri;
    }
    if (matches.length > 1) {
        throw new Error(`项目路径 [${raw}] 匹配到多个本地文件`);
    }
    throw new Error(`无法在任务工程目录中解析 VCarEA 路径 [${raw}]`);
}

function inventoryPaths(entries, extension) {
    const paths = [];
    for (const entry of entries) {
        if (!entry || typeof entry !== "object") {
            continue;
        }
        const path = String(entry.Path || "").trim();
        if (path === "" || !path.toLowerCase().endsWith(extension)) {
            continue;
        }
        const uri = resolveInventoryUri(path, extension);
        const nativePath = fs.nativePath(uri);
        if (!paths.some((item) =>
            normalizedMatchPath(item.NativePath) === normalizedMatchPath(nativePath))) {
            paths.push({
                Path: path,
                Uri: uri,
                NativePath: nativePath,
                Name: baseName(path),
            });
        }
    }
    return paths;
}

function localProjectPaths(extension) {
    return projectFiles(extension).map((entry) => ({
        Path: projectRelativePath(entry.uri),
        Uri: entry.uri,
        NativePath: fs.nativePath(entry.uri),
        Name: entry.name,
    }));
}

function responseArray(response, field) {
    const value = field === ""
        ? response.Data : response.Data && response.Data[field];
    return Array.isArray(value) ? value : [];
}

function chooseConfiguration(entries, extension, description) {
    const paths = inventoryPaths(entries, extension);
    const available = paths.length > 0 ? paths : localProjectPaths(extension);
    if (available.length === 0) {
        throw new Error(`VCarEA 工程缺少${description}（${extension}）`);
    }
    if (available.length > 1) {
        // TODO: 接口文档未定义多份同类配置的选择规则，暂选择接口返回顺序中的第一份。
        task.warning(
            `发现 ${available.length} 份${description}，暂选择第一份：${available[0].Path}`);
    }
    return available[0];
}

function matchesCaseSelector(candidate, selector) {
    // TODO: 文档的 Case 执行接口只接受路径，没有定义可用于筛选的 Case ID；
    // 暂按相对路径、绝对路径、文件名或无扩展名文件名匹配任务输入。
    const normalizedSelector = normalizedMatchPath(selector);
    const relative = normalizedMatchPath(candidate.Path);
    const native = normalizedMatchPath(candidate.NativePath);
    const name = normalizedMatchPath(candidate.Name);
    const stem = normalizedMatchPath(fileStem(candidate.Name));
    return normalizedSelector === relative || normalizedSelector === native
        || normalizedSelector === name || normalizedSelector === stem;
}

function selectCases(entries) {
    const inventory = inventoryPaths(entries, ".case");
    const available = inventory.length > 0
        ? inventory : localProjectPaths(".case");
    if (available.length === 0) {
        throw new Error("VCarEA 工程中没有可执行的 Case");
    }
    if (requestedCases.length === 0) {
        return available;
    }
    const selected = [];
    for (const selector of requestedCases) {
        const matches = available.filter((candidate) =>
            matchesCaseSelector(candidate, selector));
        if (matches.length === 0) {
            throw new Error(`TEST_CASE_IDS 中的用例 [${selector}] 不在工程 Case 列表中`);
        }
        if (matches.length > 1) {
            throw new Error(
                `TEST_CASE_IDS 中的用例 [${selector}] 匹配多个 Case，请提供相对路径`);
        }
        if (!selected.some((candidate) =>
            normalizedMatchPath(candidate.NativePath)
                === normalizedMatchPath(matches[0].NativePath))) {
            selected.push(matches[0]);
        }
    }
    return selected;
}

function updateVariables() {
    const value = task.option("UpdateVariables", null);
    if (value === null || value === undefined || value === "") {
        return null;
    }
    if (!Array.isArray(value)) {
        throw new Error("UpdateVariables 必须是数组");
    }
    return value.map((entry, index) => {
        if (entry === null || typeof entry !== "object"
                || String(entry.VariableName || "").trim() === "") {
            throw new Error(`UpdateVariables[${index}] 缺少 VariableName`);
        }
        const valueMode = Number(entry.ValueMode === undefined
            ? 0 : entry.ValueMode);
        if (valueMode !== 0 && valueMode !== 1) {
            throw new Error(`UpdateVariables[${index}].ValueMode 只能是 0 或 1`);
        }
        return {
            VariableName: String(entry.VariableName),
            Value: entry.Value === undefined ? "" : entry.Value,
            ValueMode: valueMode,
        };
    });
}

function drainReportEvents() {
    const settleMs = optionInteger(
        "ReportEventSettleMs", DEFAULT_REPORT_EVENT_SETTLE_MS, 0, 60000);
    const deadline = Date.now() + settleMs;
    while (Date.now() < deadline) {
        task.checkCancelled();
        const message = receiveMessage(Math.max(1, Math.min(50, deadline - Date.now())));
        if (message !== null && message !== undefined) {
            routeProtocolMessage(message);
        }
    }
}

function numericFailureCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function evaluateCaseStatus(events) {
    let observedVerdict = false;
    let failed = false;
    for (const event of events) {
        const data = event && event.Data && typeof event.Data === "object"
            ? event.Data : {};
        if (event.Topic === "VCar/EA/TestReport/Step/Stop"
                && typeof data.IsPass === "boolean") {
            observedVerdict = true;
            failed = failed || !data.IsPass;
        }
        if (event.Topic.endsWith("/Stop")) {
            const counts = [
                data.PlanFailCount,
                data.CaseFailCount,
                data.StepFailCount,
            ];
            if (counts.some((value) => numericFailureCount(value) > 0)) {
                observedVerdict = true;
                failed = true;
            } else if (counts.some((value) => Number.isFinite(Number(value)))) {
                observedVerdict = true;
            }
        }
    }
    if (failed) {
        return "failed";
    }
    return observedVerdict ? "passed" : "completed";
}

function executionRequestData(casePath) {
    // 文档明确 ProjectPath、TCF、TBF 三个路径仅 Linux 版本需要；当前清单
    // 启动 Windows VCarEA，因此不向 Windows 服务发送这些可选字段。
    return {
        OperationType: 0,
        CasePath: casePath,
        UpdateVariables: updateVariables(),
    };
}

function stopActiveCase(timeoutMs) {
    if (activeCasePath === "" || !isConnected()) {
        return;
    }
    request(
        TOPICS.caseExecuteRequest,
        TOPICS.caseExecuteResponse,
        {OperationType: 1, CasePath: activeCasePath},
        timeoutMs);
}

function closeActiveCase(timeoutMs) {
    if (!activeCaseMayBeOpen || activeCasePath === "" || !isConnected()) {
        return;
    }
    request(
        TOPICS.caseOperationRequest,
        TOPICS.caseOperationResponse,
        {OperationType: 1, CasePath: activeCasePath},
        timeoutMs);
    activeCaseMayBeOpen = false;
    activeCasePath = "";
}

function addCollectionError(message) {
    const text = String(message || "").trim();
    if (text !== "" && !collectionErrors.includes(text)) {
        collectionErrors.push(text);
    }
}

function overallStatus() {
    if (executionResults.some((result) => result.Status === "failed")) {
        return "failed";
    }
    if (executionResults.length > 0
            && executionResults.every((result) => result.Status === "passed")) {
        return "passed";
    }
    return "completed";
}

function publishExecutionSummary() {
    const summary = {
        TaskId: task.id(),
        ProjectPath: projectPath,
        Configurations: {
            TestConfigurationPath: testConfigurationPath,
            TestbenchConfigurationPath: testbenchConfigurationPath,
        },
        LegacyDeviceProperties: {
            WorkDirectory: configuredWorkDirectory,
            DeviceConfigurationPath: deviceConfigurationPath,
        },
        RequestedCases: requestedCases,
        ReportTypes: reportTypes,
        NativeReportType: "zip",
        Status: overallStatus(),
        Cases: executionResults,
        Reports: reportDownloads,
        CollectionErrors: collectionErrors,
    };
    fs.writeText(RESULT_ARTIFACT_URI, `${JSON.stringify(summary, null, 2)}\n`);
    task.publish(
        "VCAREA_EXECUTION_RESULT",
        RESULT_ARTIFACT_URI,
        "VCarEA 执行结果",
        "application/json");
}

/** 阶段 1：校验并解压工程包，解析用例选择及报告格式。 */
export function prepare(projectPackage) {
    resetExecutionState();
    resetProtocol();
    if (typeof projectPackage !== "string" || projectPackage.trim() === "") {
        throw new Error("VCAR_EA_PROJECT 必须传入 VCarEA 工程 ZIP");
    }
    const source = projectPackage.trim();
    if (!fs.exists(source)) {
        throw new Error("VCAR_EA_PROJECT 指向的工程不存在");
    }
    sourceProjectUri = source;
    projectRootUri = PROJECT_ROOT_URI;
    if (fs.exists(projectRootUri)) {
        fs.remove(projectRootUri, true);
    }
    const sourceType = fs.stat(sourceProjectUri).type;
    if (sourceType === "file") {
        fs.extractZip(sourceProjectUri, projectRootUri);
    } else if (sourceType === "directory") {
        // 正式清单输入为 ZIP；保留目录输入仅用于本地插件调试。
        fs.copy(sourceProjectUri, projectRootUri);
    } else {
        throw new Error("VCAR_EA_PROJECT 必须指向 ZIP 文件或工程目录");
    }
    projectFileUri = requireSingleProjectFile();
    projectPath = fs.nativePath(projectFileUri);
    requestedCases = parseRequestedCases();
    reportTypes = parseReportTypes();
    configuredWorkDirectory = optionalDevice("VCAR_EA_WORK_DIR");
    deviceConfigurationPath = optionalDevice("VCAR_EA_DEVICE_CONFIG_PATH");
    if (configuredWorkDirectory !== "" || deviceConfigurationPath !== "") {
        // EA 文档没有加载这两个旧版字段的接口，只记录而不改变测试配置。
        task.info(
            `已记录旧版工位属性：工作目录=${configuredWorkDirectory || "未配置"}；`
            + `设备配置=${deviceConfigurationPath || "未配置"}`);
    }
    initializeProtocol();
    task.info(
        `VCarEA 工程已准备：${projectPath}；用例筛选 ${requestedCases.length} 项；`
        + `报告格式 ${reportTypes.join("、")}`);
    task.progress(5);
}

/** 阶段 2：按旧版流程探测 Connector 服务，必要时启动 VCarEA。 */
export function launch() {
    requirePrepared();
    const result = launchVcarea(optionBoolean("AttachExisting", false));
    task.progress(15);
    return result;
}

/** 阶段 3：查询旧版 Connector 配置并交给新的 MQTT 执行流程。 */
export function readMqttConfig() {
    requirePrepared();
    const configuration = readConnectorMqttConfiguration();
    configureBroker(configuration);
    task.progress(20);
    return configuration;
}

/** 阶段 4：按文档连接 MQTT、Ping 等待 EA 就绪并登记 API 客户端。 */
export function connect() {
    requirePrepared();
    waitForEaReady(ensureVcareaProcessRunning);
    registerAccess();
    task.progress(25);
}

/** 阶段 5：打开工程，查询并配置 TCF/TBF，然后确定待执行 Case。 */
export function configure() {
    requirePrepared();
    if (!isConnected()) {
        throw new Error("配置工程前必须先连接 VCarEA MQTT 服务");
    }
    // 请求超时时无法确认 EA 是否已经打开工程，因此发送前就进入待清理状态。
    projectOpened = true;
    const opened = request(
        TOPICS.projectRequest,
        TOPICS.projectResponse,
        {
            OperationType: 0,
            ProjectPath: projectPath,
            ConstaraintUpdate: optionBoolean("ConstraintUpdate", true),
        });
    const configurationsResponse = request(
        TOPICS.configurationsRequest,
        TOPICS.configurationsResponse,
        undefined);
    const casesResponse = request(
        TOPICS.casesRequest,
        TOPICS.casesResponse,
        undefined);
    const openedConfigurations = responseArray(opened, "Configurations");
    const queriedConfigurations = responseArray(configurationsResponse, "");
    const openedCases = responseArray(opened, "Cases");
    const queriedCases = responseArray(casesResponse, "");
    const configurations = queriedConfigurations.length > 0
        ? queriedConfigurations : openedConfigurations;
    const cases = queriedCases.length > 0 ? queriedCases : openedCases;

    const tcf = chooseConfiguration(configurations, ".tcf", "测试配置");
    const tbf = chooseConfiguration(configurations, ".tbf", "测试台配置");
    request(TOPICS.settingRequest, TOPICS.settingResponse, {
        OperationType: 0,
        ConstaraintUpdate: optionBoolean("ConstraintUpdate", true),
        ConfigPath: tcf.NativePath,
    });
    request(TOPICS.settingRequest, TOPICS.settingResponse, {
        OperationType: 1,
        ConstaraintUpdate: optionBoolean("ConstraintUpdate", true),
        ConfigPath: tbf.NativePath,
    });
    testConfigurationPath = tcf.NativePath;
    testbenchConfigurationPath = tbf.NativePath;
    selectedCases = selectCases(cases);
    task.info(
        `VCarEA 工程已打开并配置：TCF=${tcf.Path}；TBF=${tbf.Path}；`
        + `待执行 Case=${selectedCases.length}`);
    task.progress(45);
}

/** 阶段 6：启动实验环境，并使用文档中的执行端口查询确认 API 可响应。 */
export function startMeasurement() {
    if (!projectOpened) {
        throw new Error("启动实验环境前必须先打开 VCarEA 工程");
    }
    // 请求超时时无法确认环境是否已经启动，因此发送前就进入待清理状态。
    environmentStarted = true;
    request(
        TOPICS.environmentRequest,
        TOPICS.environmentResponse,
        {OperationType: 0});

    const settleMs = optionInteger(
        "EnvironmentSettleMs", DEFAULT_ENVIRONMENT_SETTLE_MS, 0, 60000);
    if (settleMs > 0) {
        task.delay(settleMs);
    }
    // 文档没有“实验环境状态”接口；这里只能以启动应答成功且业务 API
    // 仍可查询为就绪依据，ExecutionMqttPort=0 在尚未执行时是合法值。
    const status = request(
        TOPICS.executionPortRequest,
        TOPICS.executionPortResponse,
        undefined);
    const port = Number(status.Data && status.Data.ExecutionMqttPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error("VCarEA 执行端口查询返回无效数据");
    }
    task.info(`VCarEA 实验环境已启动，当前执行 MQTT 端口：${port}`);
    task.progress(55);
}

/** 阶段 7：依次打开并执行选中的 Case，保留接口应答及报告事件状态。 */
export function execute() {
    if (!environmentStarted) {
        throw new Error("执行测试前必须先启动 VCarEA 实验环境");
    }
    if (selectedCases.length === 0) {
        throw new Error("没有可执行的 VCarEA Case");
    }
    for (let index = 0; index < selectedCases.length; ++index) {
        task.checkCancelled();
        const selected = selectedCases[index];
        activeCasePath = selected.NativePath;
        const eventStart = reportEventCount();
        let response = null;
        let executionFailed = false;
        try {
            // 请求超时时无法判断 EA 是否已经打开 Case，因此在发送前进入待清理状态。
            activeCaseMayBeOpen = true;
            request(
                TOPICS.caseOperationRequest,
                TOPICS.caseOperationResponse,
                {OperationType: 0, CasePath: activeCasePath});
            task.info(
                `执行 VCarEA Case ${index + 1}/${selectedCases.length}：${selected.Path}`);
            response = request(
                TOPICS.caseExecuteRequest,
                TOPICS.caseExecuteResponse,
                executionRequestData(activeCasePath),
                executionTimeout());
            drainReportEvents();
        } catch (error) {
            executionFailed = true;
            throw error;
        } finally {
            if (activeCaseMayBeOpen && isConnected()) {
                const timeoutMs = cleanupTimeout();
                if (executionFailed) {
                    cleanupCall(
                        "停止执行失败的 VCarEA Case",
                        () => stopActiveCase(timeoutMs));
                    cleanupCall(
                        "关闭执行失败的 VCarEA Case",
                        () => closeActiveCase(timeoutMs));
                } else {
                    closeActiveCase(timeoutMs);
                }
            }
        }

        const eventSnapshot = reportEventsSince(eventStart);
        const reportPath = String(
            response && response.Data && response.Data.ReportPath || "").trim();
        executionResults.push({
            Case: selected.Path,
            Status: evaluateCaseStatus(eventSnapshot.Events),
            ReportPath: reportPath,
            Response: response,
            ReportEvents: eventSnapshot.Events,
            DroppedReportEventCount: eventSnapshot.DroppedEventCount,
        });
        task.progress(55 + Math.round((index + 1) / selectedCases.length * 35));
    }
}

/** 阶段 8：下载文档规定的 ZIP 报告，发布结构化执行结果。 */
export function collectArtifacts() {
    let reportIndex = 0;
    for (const result of executionResults) {
        if (result.ReportPath === "") {
            addCollectionError(`Case [${result.Case}] 的执行应答未返回 ReportPath`);
            continue;
        }
        reportIndex += 1;
        try {
            const downloaded = downloadReport(result.ReportPath, reportIndex);
            reportDownloads.push({
                Case: result.Case,
                ReportPath: result.ReportPath,
                ...downloaded,
            });
        } catch (error) {
            addCollectionError(
                `下载 Case [${result.Case}] 报告失败：${error.message}`);
        }
    }
    publishExecutionSummary();
    const failedCases = executionResults
        .filter((result) => result.Status === "failed")
        .map((result) => result.Case);
    task.progress(100);
    if (failedCases.length > 0 || collectionErrors.length > 0) {
        const failures = [];
        if (failedCases.length > 0) {
            failures.push(`VCarEA 测试失败：${failedCases.join("、")}`);
        }
        failures.push(...collectionErrors);
        throw new Error(failures.join("；"));
    }
}

function cleanupCall(description, callback) {
    try {
        callback();
    } catch (error) {
        task.warning(`${description}失败：${error.message}`);
    }
}

/** 清理阶段：关闭测试资源、MQTT、Connector SDK 和本次启动的宿主。 */
export function cleanup() {
    const timeoutMs = cleanupTimeout();
    if (isConnected()) {
        if (activeCasePath !== "") {
            cleanupCall("停止活动 VCarEA Case", () => stopActiveCase(timeoutMs));
        }
        if (activeCaseMayBeOpen) {
            cleanupCall("关闭活动 VCarEA Case", () => closeActiveCase(timeoutMs));
        }
        if (environmentStarted) {
            cleanupCall("停止 VCarEA 实验环境", () => request(
                TOPICS.environmentRequest,
                TOPICS.environmentResponse,
                {OperationType: 1},
                timeoutMs));
            environmentStarted = false;
        }
        if (projectOpened) {
            cleanupCall("关闭 VCarEA 工程", () => request(
                TOPICS.projectRequest,
                TOPICS.projectResponse,
                {
                    OperationType: 1,
                    ProjectPath: projectPath,
                    ConstaraintUpdate: optionBoolean("ConstraintUpdate", true),
                },
                timeoutMs));
            projectOpened = false;
        }
        cleanupCall("断开 VCarEA MQTT", disconnect);
    }
    cleanupCall("清理 VCarEA Connector", cleanupConnector);
    resetProtocol();
    resetExecutionState();
    task.info("VCarEA 测试适配器清理完成");
    task.progress(100);
}
