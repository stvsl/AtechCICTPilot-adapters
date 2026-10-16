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
    configureResponseTimeout,
    connectEaApi,
    configureProjectConfiguration,
    configureBroker,
    disconnect,
    executionTimeout,
    initializeProtocol,
    isConnected,
    isEnvironmentNotRunningError,
    probeExecutionPort,
    reportEventCount,
    reportEventsSince,
    request,
    resetProtocol,
    waitForProjectConfigurations,
    waitForProjectPlans,
    waitForPlanStop,
} from "./vcarea/protocol.js";
import { downloadReport } from "./vcarea/report.js";

// 导出名称与阶段切分保持和 CANoe 测试适配器一致：prepare、launch、
// readMqttConfig、connect、configure、startMeasurement、execute、
// collectArtifacts、cleanup。

const PROJECT_ROOT_URI = "workspace://vcarea-test/project";
const RESULT_ARTIFACT_URI = "artifact://vcarea-test/execution-result.json";
const SUPPORTED_REPORT_TYPES = ["html", "pdf", "xlsx", "zip"];

// TODO: 接口文档没有规定工程后台初始化、启动实验环境后的稳定时间、报告渲染
// 时间和报告事件收尾时间，以下均为适配器实测值，可通过节点选项覆盖。
const DEFAULT_PROJECT_READY_TIMEOUT_MS = 120000;
const DEFAULT_PROJECT_READY_PROBE_INTERVAL_MS = 500;
const DEFAULT_ENVIRONMENT_SETTLE_MS = 1000;
const DEFAULT_REPORT_RENDER_TIMEOUT_MS = 30000;

/**
 * 报告渲染完成后出现在报告目录中的旧版格式后缀。
 *
 * 实测 VCarEA 在执行停止后异步渲染报告目录：`data/vcar_ea_data_report.db`
 * 先落盘，约 2~3 秒后 `<报告名>.html`、`<报告名>.pdf`、`<报告名>.xlsx`
 * 才写入；渲染完成前调用报告下载接口只能得到仅含数据库的 ZIP。
 */
const NATIVE_REPORT_FORMATS = ["html", "pdf", "xlsx"];
const REPORT_RENDER_PROBE_INTERVAL_MS = 500;

let sourceProjectUri = "";
let projectRootUri = "";
let projectFileUri = "";
let projectPath = "";
let configuredWorkDirectory = "";
let deviceConfigurationPath = "";
let projectOpened = false;
let projectReady = false;
let environmentStarted = false;
let activePlanPath = "";
let activePlanMayBeOpen = false;
let testConfigurationPath = "";
let testbenchConfigurationPath = "";
let requestedPlans = [];
let selectedPlans = [];
let reportTypes = [];
let executionResults = [];
let reportDownloads = [];
let collectionErrors = [];
/**
 * 工程文件清单与扩展名索引缓存。
 *
 * VCarEA 工程可能包含大量执行文件与报告产物，而 `fs.list` 每次都会递归遍历
 * 整个工程目录并为每个条目做一次文件系统查询；逐条路径解析再枚举一次会把
 * 配置阶段拖到分钟级，因此全工程只枚举一次，再按扩展名缓存归一化索引。
 * 工程目录在任务内只读，缓存不需要失效。
 */
const projectFileCache = new Map();
let projectEntryCache = null;

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

function parseRequestedPlans() {
    const text = optionalRequirementText("TEST_PLAN_IDS").trim();
    if (text === "") {
        return [];
    }
    if (text.startsWith("[") || text.startsWith("{")) {
        let value;
        try {
            value = JSON.parse(text);
        } catch (error) {
            throw new Error(`TEST_PLAN_IDS 不是有效 JSON：${error.message}`);
        }
        if (Array.isArray(value)) {
            return uniqueStrings(value.map((item) => String(item).trim())
                .filter((item) => item !== ""));
        }
        if (value !== null && typeof value === "object") {
            for (const key of ["ids", "testPlanIds", "TestPlanIds", "plans"]) {
                if (Array.isArray(value[key])) {
                    return uniqueStrings(value[key]
                        .map((item) => String(item).trim())
                        .filter((item) => item !== ""));
                }
            }
        }
        throw new Error("TEST_PLAN_IDS JSON 必须是数组或包含计划数组的对象");
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
        // 接口固定推送 ZIP（实测内含 html/pdf/xlsx），旧版格式将从 ZIP 中提取。
        task.info(
            `报告格式 ${legacyFormats.join("、")} 将从 VCarEA ZIP 报告中提取，`
            + "ZIP 本体一并保留为产物");
    }
    return selected;
}

/**
 * 工程文件清单（按扩展名缓存）。
 *
 * 返回候选数组与两张归一化路径索引：候选数组用于名称回退匹配，索引表用于
 * 路径精确匹配，避免逐条路径扫描整个清单。
 *
 * VCarEA 工程可能包含大量执行文件与报告产物，而 `fs.list` 每次都会递归遍历
 * 整个工程目录并为每个条目做一次文件系统查询；这里复用全工程枚举结果，
 * 再缓存当前扩展名的索引。工程目录在任务内只读，缓存不需要失效。
 */
function projectInventory(extension) {
    const suffix = extension.toLowerCase();
    let inventory = projectFileCache.get(suffix);
    if (inventory === undefined) {
        const candidates = [];
        const byNativePath = new Map();
        const byRelativePath = new Map();
        if (projectEntryCache === null) {
            projectEntryCache = fs.list(projectRootUri, true);
        }
        for (const entry of projectEntryCache) {
            if (entry.type !== "file"
                    || !entry.name.toLowerCase().endsWith(suffix)) {
                continue;
            }
            const nativePath = fs.nativePath(entry.uri);
            const candidate = {
                entry,
                nativePath,
                native: normalizedMatchPath(nativePath),
                relative: normalizedMatchPath(
                    projectRelativePath(entry.uri)),
            };
            candidates.push(candidate);
            appendInventoryIndex(byNativePath, candidate.native, candidate);
            appendInventoryIndex(byRelativePath, candidate.relative, candidate);
        }
        inventory = {candidates, byNativePath, byRelativePath};
        projectFileCache.set(suffix, inventory);
    }
    return inventory;
}

function appendInventoryIndex(index, key, candidate) {
    const bucket = index.get(key);
    if (bucket === undefined) {
        index.set(key, [candidate]);
        return;
    }
    bucket.push(candidate);
}

function projectFiles(extension) {
    return projectInventory(extension).candidates
        .map((candidate) => candidate.entry);
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
    projectReady = false;
    environmentStarted = false;
    activePlanPath = "";
    activePlanMayBeOpen = false;
    testConfigurationPath = "";
    testbenchConfigurationPath = "";
    requestedPlans = [];
    selectedPlans = [];
    reportTypes = [];
    executionResults = [];
    reportDownloads = [];
    collectionErrors = [];
    projectFileCache.clear();
    projectEntryCache = null;
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

/**
 * 把工程副本内的原生绝对路径映射为对应的虚拟 URI。
 *
 * 报告由 VCarEA 写入工程目录（形如 `Reports/<报告名>`），虚拟文件接口
 * 只接受 `scheme://` URI，因此需要按工程根前缀把原生路径转回 URI。
 * 前缀比较使用归一化小写形式，截取时保留原始大小写；路径不在工程
 * 目录内时返回空串。
 */
function projectUriForNativePath(nativePath) {
    const raw = String(nativePath || "").trim();
    if (raw === "" || projectRootUri === "") {
        return "";
    }
    const root = String(fs.nativePath(projectRootUri) || "").trim();
    if (root === "") {
        return "";
    }
    const slashed = (value) => value.replace(/^file:\/\//i, "")
        .replace(/\\/g, "/").replace(/\/+$/g, "");
    const target = slashed(raw);
    const base = slashed(root);
    if (target.toLowerCase() === base.toLowerCase()) {
        return projectRootUri;
    }
    if (!target.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
        return "";
    }
    return `${projectRootUri}/${target.substring(base.length + 1)}`;
}

/**
 * 将项目清单返回的相对或绝对路径解析为工程清单中的候选条目。
 *
 * 路径归一化仅用于比较；返回的条目来自文件系统枚举，保留 VCarEA 工程树
 * 登记的真实大小写。VCarEA 在 Windows 上也会按路径字符串区分大小写。
 */
function resolveInventoryCandidate(path, extension) {
    const raw = String(path || "").trim();
    if (raw === "") {
        throw new Error(`VCarEA 返回了空的 ${extension} 路径`);
    }

    const target = normalizedMatchPath(raw);
    const root = normalizedMatchPath(fs.nativePath(projectRootUri));
    let relativeTarget = target;
    if (isAbsoluteNativePath(raw) && target.startsWith(`${root}/`)) {
        relativeTarget = target.substring(root.length + 1);
    }

    const inventory = projectInventory(extension);
    const exactMatches = [];
    for (const candidate of inventory.byNativePath.get(target) || []) {
        exactMatches.push(candidate);
    }
    for (const candidate of inventory.byRelativePath.get(relativeTarget) || []) {
        if (!exactMatches.includes(candidate)) {
            exactMatches.push(candidate);
        }
    }
    if (exactMatches.length === 1) {
        return exactMatches[0];
    }
    if (exactMatches.length > 1) {
        throw new Error(`项目路径 [${raw}] 匹配到多个本地文件`);
    }

    const targetName = baseName(relativeTarget);
    const matches = inventory.candidates.filter((candidate) =>
        candidate.relative.endsWith(`/${relativeTarget}`)
        || relativeTarget.endsWith(`/${candidate.relative}`)
        || baseName(candidate.relative) === targetName);
    if (matches.length === 1) {
        return matches[0];
    }
    if (matches.length > 1) {
        throw new Error(`项目路径 [${raw}] 匹配到多个本地文件`);
    }
    throw new Error(`无法在任务工程目录中解析 VCarEA 路径 [${raw}]`);
}

/** 解析工程内路径，返回文件系统枚举得到的文件 URI。 */
export function resolveInventoryUri(path, extension) {
    return resolveInventoryCandidate(path, extension).entry.uri;
}

function inventoryPaths(entries, extension) {
    const paths = [];
    const seenNativePaths = new Set();
    for (const entry of entries) {
        if (!entry || typeof entry !== "object") {
            continue;
        }
        const path = String(entry.Path || "").trim();
        if (path === "" || !path.toLowerCase().endsWith(extension)) {
            continue;
        }
        const candidate = resolveInventoryCandidate(path, extension);
        if (seenNativePaths.has(candidate.native)) {
            continue;
        }
        seenNativePaths.add(candidate.native);
        paths.push({
            Path: path,
            Uri: candidate.entry.uri,
            NativePath: candidate.nativePath,
            Name: baseName(path),
        });
    }
    return paths;
}

function localProjectPaths(extension) {
    return projectInventory(extension).candidates.map((candidate) => ({
        Path: projectRelativePath(candidate.entry.uri),
        Uri: candidate.entry.uri,
        NativePath: candidate.nativePath,
        Name: candidate.entry.name,
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

function matchesPlanSelector(candidate, selector) {
    // TODO: 文档的 Plan 执行接口只接受路径，没有定义可用于筛选的 Plan ID；
    // 暂按相对路径、绝对路径、文件名或无扩展名文件名匹配任务输入。
    const normalizedSelector = normalizedMatchPath(selector);
    const relative = normalizedMatchPath(candidate.Path);
    const native = normalizedMatchPath(candidate.NativePath);
    const name = normalizedMatchPath(candidate.Name);
    const stem = normalizedMatchPath(fileStem(candidate.Name));
    return normalizedSelector === relative || normalizedSelector === native
        || normalizedSelector === name || normalizedSelector === stem;
}

function selectPlans(entries) {
    const available = inventoryPaths(entries, ".plan");
    if (available.length === 0) {
        const localPlans = localProjectPaths(".plan");
        if (localPlans.length > 0) {
            throw new Error(
                `任务工程中存在 ${localPlans.length} 个 .plan 文件，`
                + "但 VCarEA 工程树未返回可执行 Plan");
        }
        throw new Error("VCarEA 工程中没有可执行的 Plan");
    }
    if (requestedPlans.length === 0) {
        return available;
    }
    const selected = [];
    for (const selector of requestedPlans) {
        const matches = available.filter((candidate) =>
            matchesPlanSelector(candidate, selector));
        if (matches.length === 0) {
            throw new Error(
                `TEST_PLAN_IDS 中的计划 [${selector}] 不在工程 Plan 列表中`);
        }
        if (matches.length > 1) {
            throw new Error(
                `TEST_PLAN_IDS 中的计划 [${selector}] 匹配多个 Plan，请提供相对路径`);
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

function numericFailureCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function evaluatePlanStatus(events) {
    let observedVerdict = false;
    let failed = false;
    for (const event of events) {
        const data = event && event.Data && typeof event.Data === "object"
            ? event.Data : {};
        if (event.Topic.endsWith("Step/Stop")
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

function executionRequestData(planPath) {
    // 文档明确 ProjectPath、TCF、TBF 三个路径仅 Linux 版本需要；当前清单
    // 启动 Windows VCarEA，因此不向 Windows 服务发送这些可选字段。
    return {
        OperationType: 0,
        PlanPath: planPath,
        UpdateVariables: updateVariables(),
    };
}

function stopActivePlan(timeoutMs) {
    if (activePlanPath === "" || !isConnected()) {
        return;
    }
    request(
        TOPICS.planExecuteRequest,
        TOPICS.planExecuteResponse,
        {OperationType: 1, PlanPath: activePlanPath},
        timeoutMs);
}

function closeActivePlan(timeoutMs) {
    if (!activePlanMayBeOpen || activePlanPath === "" || !isConnected()) {
        return;
    }
    request(
        TOPICS.planOperationRequest,
        TOPICS.planOperationResponse,
        {OperationType: 1, PlanPath: activePlanPath},
        timeoutMs);
    activePlanMayBeOpen = false;
    activePlanPath = "";
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
        RequestedPlans: requestedPlans,
        ReportTypes: reportTypes,
        NativeReportType: "zip",
        Status: overallStatus(),
        Plans: executionResults,
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

/**
 * 等待 VCarEA 渲染完成报告目录。
 *
 * 实测执行停止后报告目录先写入数据库文件，约 2~3 秒后 html/pdf/xlsx
 * 才渲染完成；在此之前下载报告只能得到仅含数据库的 ZIP（2026-09-24 实测
 * 5359 字节，而完整报告为 609889 字节）。这里按固定间隔轮询工程目录中的
 * 报告目录，等到请求的格式文件全部出现再下载；仅请求 ZIP 时等待完整的
 * 三种旧版格式。超时只告警，下载仍按现状继续（保持回退语义）。
 *
 * @returns {boolean} 超时前是否观察到全部渲染产物。
 */
export function waitForReportRendered(reportPath) {
    const directoryUri = projectUriForNativePath(reportPath);
    if (directoryUri === "") {
        task.warning(
            `报告路径 [${reportPath}] 不在任务工程目录内，跳过渲染等待`);
        return false;
    }
    const requested = reportTypes.filter((type) => type !== "zip");
    const needed = requested.length > 0 ? requested : NATIVE_REPORT_FORMATS;
    const timeoutMs = optionInteger(
        "ReportRenderTimeoutMs",
        DEFAULT_REPORT_RENDER_TIMEOUT_MS,
        1000,
        600000);
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        task.checkCancelled();
        let names = [];
        try {
            names = fs.list(directoryUri, true)
                .filter((entry) => entry.type === "file")
                .map((entry) => entry.name.toLowerCase());
            lastError = null;
        } catch (error) {
            // 报告目录可能尚未创建（渲染完全未开始），按未就绪继续轮询。
            names = [];
            lastError = error;
        }
        if (needed.every((format) =>
            names.some((name) => name.endsWith(`.${format}`)))) {
            return true;
        }
        task.delay(Math.max(1, Math.min(
            REPORT_RENDER_PROBE_INTERVAL_MS, deadline - Date.now())));
    }
    task.warning(
        `等待 VCarEA 渲染报告超时（${timeoutMs} ms）：`
        + `${needed.join("、")}尚未出现在报告目录，`
        + `下载的 ZIP 可能缺少这些格式`
        + (lastError === null ? "" : `（${lastError.message}）`));
    return false;
}

/** 阶段 1：校验并解压工程包，解析测试计划选择及报告格式。 */
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
    const planFiles = projectFiles(".plan");
    if (planFiles.length === 0) {
        throw new Error("VCarEA 工程目录中未找到 .plan 测试计划文件");
    }
    requestedPlans = parseRequestedPlans();
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
        `VCarEA 工程已准备：${projectPath}；发现 Plan ${planFiles.length} 个；`
        + `计划筛选 ${requestedPlans.length} 项；`
        + `报告格式 ${reportTypes.join("、")}`);
    task.progress(5);
}

/** 阶段 2：默认启动 VCarEA；显式附加时复用已有实例。 */
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

/** 阶段 4：连接 MQTT，并等待 VCarEA 完成 API 客户端登记。 */
export function connect() {
    requirePrepared();
    ensureVcareaProcessRunning();
    connectEaApi(ensureVcareaProcessRunning);
    task.progress(25);
}

/** 阶段 5：打开工程，等待后台初始化完成，配置 TCF/TBF，然后确定待执行 Plan。 */
export function configure() {
    requirePrepared();
    if (!isConnected()) {
        throw new Error("配置工程前必须先连接 VCarEA MQTT 服务");
    }
    const readyTimeoutMs = optionInteger(
        "ProjectReadyTimeoutMs",
        DEFAULT_PROJECT_READY_TIMEOUT_MS,
        1,
        1800000);
    const probeIntervalMs = optionInteger(
        "ProjectReadyProbeIntervalMs",
        DEFAULT_PROJECT_READY_PROBE_INTERVAL_MS,
        100,
        10000);
    // 请求超时时无法确认 EA 是否已经打开工程，因此发送前就进入待清理状态。
    projectOpened = true;
    projectReady = false;
    // 本阶段宿主带后台恢复处理请求（打开工程与 TBF 配置实测 5~35 秒；
    // 恢复窗口内业务请求会被“其他接口正在工作”拒绝并自动重发），因此
    // 打开工程、就绪后首次查询与 TCF/TBF 配置统一使用阶段专用应答超时。
    const stageTimeoutMs = configureResponseTimeout();
    const opened = request(
        TOPICS.projectRequest,
        TOPICS.projectResponse,
        {
            OperationType: 0,
            ProjectPath: projectPath,
            ConstaraintUpdate: optionBoolean("ConstraintUpdate", true),
        },
        stageTimeoutMs);
    // 打开工程应答早于 VCarEA 后台恢复 TBF 与工程树构造：轮询配置列表，
    // 探测到两种配置同时可见才继续，替代按固定时长盲等。
    task.info(
        `等待 VCarEA 完成工程后台初始化（最长 ${readyTimeoutMs} ms）`);
    const ready = waitForProjectConfigurations(
        readyTimeoutMs, probeIntervalMs);
    projectReady = true;
    task.info(`VCarEA 工程后台初始化完成（等待 ${ready.WaitedMs} ms）`);
    const openedConfigurations = responseArray(opened, "Configurations");
    const configurations = ready.Configurations.length > 0
        ? ready.Configurations : openedConfigurations;

    const tcf = chooseConfiguration(configurations, ".tcf", "测试配置");
    const tbf = chooseConfiguration(configurations, ".tbf", "测试台配置");
    const constraintUpdate = optionBoolean("ConstraintUpdate", true);
    // 就绪后配置请求几乎总是一次成功，仍保留瞬态重试作为兜底。
    const configurationDeadline = Date.now() + readyTimeoutMs;
    configureProjectConfiguration(
        0,
        tcf.NativePath,
        constraintUpdate,
        Math.max(1, configurationDeadline - Date.now()));
    const remainingReadyMs = configurationDeadline - Date.now();
    if (remainingReadyMs <= 0) {
        throw new Error(
            `等待 VCarEA 工程配置就绪超时（${readyTimeoutMs} ms）：`
            + "TCF 已配置，但没有剩余时间配置 TBF");
    }
    configureProjectConfiguration(
        1,
        tbf.NativePath,
        constraintUpdate,
        remainingReadyMs);
    testConfigurationPath = tcf.NativePath;
    testbenchConfigurationPath = tbf.NativePath;
    task.info(
        `等待 VCarEA 返回可执行 Plan（最长 ${readyTimeoutMs} ms）`);
    const plans = waitForProjectPlans(readyTimeoutMs, probeIntervalMs);
    selectedPlans = selectPlans(plans.Plans);
    task.info(
        `VCarEA 工程已打开并配置：TCF=${tcf.Path}；TBF=${tbf.Path}；`
        + `待执行 Plan=${selectedPlans.length}`);
    task.progress(45);
}

/** 阶段 6：启动实验环境；启动应答即为就绪信号（实测同步加载 XIL 环境）。 */
export function startMeasurement() {
    if (!projectOpened) {
        throw new Error("启动实验环境前必须先打开 VCarEA 工程");
    }
    // 请求超时时无法确认环境是否已经启动，因此发送前就进入待清理状态。
    environmentStarted = true;
    const startedAt = Date.now();
    request(
        TOPICS.environmentRequest,
        TOPICS.environmentResponse,
        {OperationType: 0});
    task.info(
        `VCarEA 实验环境已启动（应答耗时 ${Date.now() - startedAt} ms）`);

    const settleMs = optionInteger(
        "EnvironmentSettleMs", DEFAULT_ENVIRONMENT_SETTLE_MS, 0, 60000);
    if (settleMs > 0) {
        task.delay(settleMs);
    }
    // 实测 1.8.4.0826 对执行端口查询接口无任何应答：只做一次有界观察并
    // 记录，不作为环境就绪或失败判据（环境启动应答即为就绪信号）。
    const probe = probeExecutionPort();
    if (probe.Port !== null) {
        task.info(`VCarEA 执行 MQTT 端口：${probe.Port}`);
    } else {
        task.info(
            "VCarEA 执行端口查询未返回端口（实测该接口常无应答，"
            + "不作为就绪判据）：" + (probe.Error || ""));
    }
    task.progress(55);
}

/** 阶段 7：依次打开并执行选中的 Plan，保留接口应答及报告事件状态。 */
export function execute() {
    if (!environmentStarted) {
        throw new Error("执行测试前必须先启动 VCarEA 实验环境");
    }
    if (selectedPlans.length === 0) {
        throw new Error("没有可执行的 VCarEA Plan");
    }
    for (let index = 0; index < selectedPlans.length; ++index) {
        task.checkCancelled();
        const selected = selectedPlans[index];
        activePlanPath = selected.NativePath;
        const eventStart = reportEventCount();
        let containedCases = [];
        let response = null;
        let executionFailed = false;
        try {
            // 请求超时时无法判断 EA 是否已经打开 Plan，因此在发送前进入待清理状态。
            activePlanMayBeOpen = true;
            const openedPlan = request(
                TOPICS.planOperationRequest,
                TOPICS.planOperationResponse,
                {OperationType: 0, PlanPath: activePlanPath});
            containedCases = responseArray(openedPlan, "");
            task.info(
                `执行 VCarEA Plan ${index + 1}/${selectedPlans.length}：`
                + `${selected.Path}（包含 ${containedCases.length} 个 Case）`);
            // Plan/Execute 应答与执行结束事件共享单个 Plan 的执行超时预算。
            const planDeadline = Date.now() + executionTimeout();
            response = request(
                TOPICS.planExecuteRequest,
                TOPICS.planExecuteResponse,
                executionRequestData(activePlanPath),
                Math.max(1, planDeadline - Date.now()));
            // 子 Case 的停止事件不能结束 Plan；只等待 Plan/Stop 或 Run/Stop。
            waitForPlanStop(eventStart, Math.max(1, planDeadline - Date.now()));
        } catch (error) {
            executionFailed = true;
            throw error;
        } finally {
            if (activePlanMayBeOpen && isConnected()) {
                const timeoutMs = cleanupTimeout();
                if (executionFailed) {
                    cleanupCall(
                        "停止执行失败的 VCarEA Plan",
                        () => stopActivePlan(timeoutMs));
                    cleanupCall(
                        "关闭执行失败的 VCarEA Plan",
                        () => closeActivePlan(timeoutMs));
                } else {
                    closeActivePlan(timeoutMs);
                }
            }
        }

        const eventSnapshot = reportEventsSince(eventStart);
        const reportPath = String(
            response && response.Data && response.Data.ReportPath || "").trim();
        executionResults.push({
            Plan: selected.Path,
            ContainedCases: containedCases,
            Status: evaluatePlanStatus(eventSnapshot.Events),
            ReportPath: reportPath,
            Response: response,
            ReportEvents: eventSnapshot.Events,
            DroppedReportEventCount: eventSnapshot.DroppedEventCount,
        });
        task.progress(55 + Math.round((index + 1) / selectedPlans.length * 35));
    }
}

/** 阶段 8：下载文档规定的 ZIP 报告，发布结构化执行结果。 */
export function collectArtifacts() {
    let reportIndex = 0;
    for (const result of executionResults) {
        if (result.ReportPath === "") {
            addCollectionError(`Plan [${result.Plan}] 的执行应答未返回 ReportPath`);
            continue;
        }
        reportIndex += 1;
        try {
            // 实测执行停止后 VCarEA 异步渲染报告：数据库先落盘、html/pdf/xlsx
            // 约 2~3 秒后才写入；渲染完成前下载只能得到仅含数据库的 ZIP。
            waitForReportRendered(result.ReportPath);
            const downloaded = downloadReport(
                result.ReportPath, reportIndex, reportTypes);
            reportDownloads.push({
                Plan: result.Plan,
                ReportPath: result.ReportPath,
                ...downloaded,
            });
        } catch (error) {
            addCollectionError(
                `下载 Plan [${result.Plan}] 报告失败：${error.message}`);
        }
    }
    publishExecutionSummary();
    const failedPlans = executionResults
        .filter((result) => result.Status === "failed")
        .map((result) => result.Plan);
    task.progress(100);
    if (failedPlans.length > 0 || collectionErrors.length > 0) {
        const failures = [];
        if (failedPlans.length > 0) {
            failures.push(`VCarEA 测试失败：${failedPlans.join("、")}`);
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

/**
 * 停止实验环境。
 *
 * 实测 VCarEA 在环境未运行时返回 Code=0 且消息为“未启动实验环境，
 * 请先启动实验环境”；若某些版本以非零 Code 表达同一语义，
 * 同样按幂等成功处理。
 */
function stopEnvironment(timeoutMs) {
    try {
        request(
            TOPICS.environmentRequest,
            TOPICS.environmentResponse,
            {OperationType: 1},
            timeoutMs);
    } catch (error) {
        if (isEnvironmentNotRunningError(error)) {
            task.info("VCarEA 实验环境此前未启动（按幂等成功处理）");
            return;
        }
        throw error;
    }
}

/** 清理阶段：关闭测试资源、MQTT、Connector SDK 和本次启动的宿主。 */
export function cleanup() {
    const timeoutMs = cleanupTimeout();
    if (isConnected()) {
        if (activePlanPath !== "") {
            cleanupCall("停止活动 VCarEA Plan", () => stopActivePlan(timeoutMs));
        }
        if (activePlanMayBeOpen) {
            cleanupCall("关闭活动 VCarEA Plan", () => closeActivePlan(timeoutMs));
        }
        if (environmentStarted) {
            cleanupCall("停止 VCarEA 实验环境",
                        () => stopEnvironment(timeoutMs));
            environmentStarted = false;
        }
        if (projectOpened) {
            if (!projectReady) {
                // 工程尚未确认就绪：先按清理应答超时做一次有界探测，让
                // VCarEA 完成工程树稳定后再关闭，避免打开后立即关闭；
                // 探测失败不阻塞关闭，仅记录警告。
                cleanupCall(
                    "等待 VCarEA 工程就绪",
                    () => waitForProjectConfigurations(
                        timeoutMs, DEFAULT_PROJECT_READY_PROBE_INTERVAL_MS));
            }
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
            projectReady = false;
        }
        cleanupCall("断开 VCarEA MQTT", disconnect);
    }
    cleanupCall("清理 VCarEA Connector", cleanupConnector);
    resetProtocol();
    resetExecutionState();
    task.info("VCarEA 测试适配器清理完成");
    task.progress(100);
}
