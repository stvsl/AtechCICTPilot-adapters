import * as mqtt from "@atech/mqtt";
import * as task from "@atech/task";

/** EA 外部调用接口文档规定的 MQTT 默认连接参数。 */
const DEFAULT_BROKER_CONFIGURATION = Object.freeze({
    ServerUri: "mqtt://127.0.0.1:11883",
    UserName: "VCarAPI",
    Password: "VCarAPI",
    KeepAliveSeconds: 60,
});
const APPLICATION_NAME = "AtechCICTPilot.exe";
const CLIENT_NAME = "AtechCICTPilot";

// TODO: 接口文档没有定义连接、接入就绪、应答及清理超时，以下为适配器假设值。
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_ACCESS_READY_TIMEOUT_MS = 120000;
const DEFAULT_ACCESS_RESPONSE_TIMEOUT_MS = 3000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 30000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 1800000;
const DEFAULT_REPORT_TIMEOUT_MS = 600000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5000;
const ACCESS_RETRY_INTERVAL_MS = 1000;
const PROJECT_CONFIGURATION_RETRY_INTERVAL_MS = 1000;
const PROBE_REPORT_INTERVAL_MS = 3000;
const RECEIVE_POLL_INTERVAL_MS = 250;

// 实测 VCarEA 1.8.4.0826：宿主同一时刻只处理一个业务接口，并发请求会被立即
// 拒绝（`Code=1`、消息“其他接口正在工作，请稍后重试！”），且该拒绝应答不复用
// 请求 ID。打开工程应答后宿主仍在后台恢复 TBF 与加载 XIL 环境（实测窗口最长
// 约 33 秒），期间所有业务请求都会被这样拒绝，因此识别到该应答后必须稍后重发，
// 而不是一直等待到超时。
const BUSY_REJECTION_TEXT = "其他接口正在工作";
const DEFAULT_BUSY_RETRY_INTERVAL_MS = 1000;
const BUSY_RETRY_REPORT_INTERVAL_MS = 5000;

// TODO: 接口文档没有规定“打开工程并配置测试环境”阶段单次应答上限：实测打开
// 工程应答耗时 5~35 秒（宿主把后台恢复计入应答时间时更久），TBF 配置同步加载
// XIL 环境需 16~24 秒，因此该阶段的单次请求默认给到 60 秒。
const DEFAULT_CONFIGURE_RESPONSE_TIMEOUT_MS = 60000;

// TODO: 接口文档未定义执行端口探测超时；实测 VCarEA 1.8.4.0826 对
// `Execution/MqttPort` 查询完全不产生应答，因此只做一次有界观察。
const DEFAULT_EXECUTION_PORT_PROBE_MS = 3000;

// TODO: 文档没有规定单次执行可产生的报告事件上限，暂限制为 10000 条，
// 并在执行结果中记录被丢弃的数量，避免异常服务耗尽脚本内存。
const MAX_REPORT_EVENTS = 10000;

class ProtocolResponseTimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = "ProtocolResponseTimeoutError";
    }
}

/**
 * 宿主“接口忙”拒绝错误。
 *
 * 宿主对并发请求的拒绝应答不回显请求 ID，适配器无法按 ID 匹配，只能按
 * 状态代码与消息文本识别；重发直到超出本次请求超时仍被拒绝时抛出本错误，
 * 使失败原因显示为“接口忙”而不是容易误导的“无应答”。
 */
class VcareaBusyError extends Error {
    constructor(responseTopic, requestId, attempts, hostMessage) {
        super(`VCarEA 接口忙，本次请求被拒绝 ${attempts} 次：${hostMessage}`
            + `（${responseTopic}；${requestId}）`);
        this.name = "VcareaBusyError";
        this.responseTopic = responseTopic;
        this.hostMessage = hostMessage;
    }
}

/** 保留 VCarEA 业务应答字段，供上层只重试明确的瞬态错误。 */
class VcareaResponseError extends Error {
    constructor(requestId, code, messageText) {
        super(
            `VCarEA 请求 ${requestId} 失败：Code=${code}`
            + `（${statusDescription(code)}）`
            + (messageText === "" ? "" : `，${messageText}`));
        this.name = "VcareaResponseError";
        this.responseCode = code;
        this.responseMessage = messageText;
    }
}

export const TOPICS = Object.freeze({
    will: "KY/VCar/Will",
    accessRequest: "KY/VCar/AccessInformation/Request",
    accessResponse: "KY/VCar/AccessInformation/Response",
    projectRequest: "KY/VCar/EA/ProjectManagement/Request",
    projectResponse: "KY/VCar/EA/ProjectManagement/Response",
    configurationsRequest: "KY/VCar/EA/Configurations/Request",
    configurationsResponse: "KY/VCar/EA/Configurations/Response",
    settingRequest: "KY/VCar/EA/SettingConfiguration/Request",
    settingResponse: "KY/VCar/EA/SettingConfiguration/Response",
    environmentRequest: "KY/VCar/EA/Environment/Request",
    environmentResponse: "KY/VCar/EA/Environment/Response",
    casesRequest: "KY/VCar/EA/Cases/Request",
    casesResponse: "KY/VCar/EA/Cases/Response",
    caseOperationRequest: "KY/VCar/EA/Case/Operation/Request",
    caseOperationResponse: "KY/VCar/EA/Case/Operation/Response",
    caseExecuteRequest: "KY/VCar/EA/Case/Execute/Request",
    caseExecuteResponse: "KY/VCar/EA/Case/Execute/Response",
    reportDownloadRequest: "KY/VCar/EA/Report/Download/Request",
    reportDownloadResponse: "KY/VCar/EA/Report/Download/Response",
    reportPushRequest: "KY/VCar/EA/Report/Push/Request",
    reportPushResponse: "KY/VCar/EA/Report/Push/Response",
    executionPortRequest: "KY/VCar/EA/Execution/MqttPort/Request",
    executionPortResponse: "KY/VCar/EA/Execution/MqttPort/Response",
});

/**
 * 测试报告事件主题。
 *
 * 实测 VCarEA 1.8.4.0826：执行事件由宿主从执行器 broker 转发到主 broker，
 * 主题统一带 `KY/` 前缀，且当前版本只转发停止类事件（`Run/Stop` 与
 * `Case/Stop`，后者附带 RunID 与失败计数）；文档里 `VCar/EA/TestReport/...`
 * （无前缀）的写法及 Start/Step 事件不会到达。订阅整个前缀既能覆盖已知
 * 事件，也能接住未来版本新增的转发类型。
 */
const REPORT_TOPIC_PREFIX = "KY/VCar/EA/TestReport/";
export const REPORT_TOPIC_SUBSCRIPTION = `${REPORT_TOPIC_PREFIX}#`;
export const REPORT_TOPICS = Object.freeze({
    runStop: `${REPORT_TOPIC_PREFIX}Run/Stop`,
    caseStop: `${REPORT_TOPIC_PREFIX}Case/Stop`,
});

const RESPONSE_TOPICS = Object.freeze([
    TOPICS.accessResponse,
    TOPICS.projectResponse,
    TOPICS.configurationsResponse,
    TOPICS.settingResponse,
    TOPICS.environmentResponse,
    TOPICS.casesResponse,
    TOPICS.caseOperationResponse,
    TOPICS.caseExecuteResponse,
    TOPICS.reportDownloadResponse,
    TOPICS.reportPushResponse,
    TOPICS.executionPortResponse,
]);

const STATUS_TEXT = Object.freeze({
    1: "失败",
    2: "超时",
    3: "非法调用",
    4: "系统错误",
    104: "项目已关闭或未打开",
    105: "缺少测试配置",
    106: "缺少测试台配置",
    107: "mrtd 连接失败",
    108: "执行步骤无效",
    109: "执行 Case 无效",
});

let connectionHandle = null;
let currentClientId = "";
let subscriptions = [];
let reportEvents = [];
let droppedReportEvents = 0;
let brokerConfiguration = {...DEFAULT_BROKER_CONFIGURATION};

function optionInteger(name, fallback, minimum, maximum) {
    const value = Number(task.option(name, fallback));
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(
            `${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
    }
    return value;
}

function optionString(name, fallback = "") {
    const value = task.option(name, fallback);
    return value === undefined || value === null ? fallback : String(value);
}

function optionalBoolean(name) {
    const value = task.option(name, undefined);
    if (value === undefined || value === null) {
        return null;
    }
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

function randomHex(length) {
    let result = "";
    while (result.length < length) {
        result += Math.floor(Math.random() * 0x100000000)
            .toString(16).padStart(8, "0");
    }
    return result.substring(0, length);
}

/** 按文档建议生成“进程名 + 16 字节 GUID”形式的 MQTT Client ID。 */
function createClientId() {
    const hex = randomHex(32);
    const guid = `${hex.substring(0, 8)}-${hex.substring(8, 12)}`
        + `-${hex.substring(12, 16)}-${hex.substring(16, 20)}`
        + `-${hex.substring(20)}`;
    return `${CLIENT_NAME}_${guid}`;
}

function jsonBytes(value) {
    return new TextEncoder().encode(JSON.stringify(value));
}

function parseJsonBytes(value, description) {
    let parsed;
    try {
        parsed = JSON.parse(new TextDecoder().decode(value));
    } catch (error) {
        throw new Error(`${description} 不是有效的 UTF-8 JSON：${error.message}`);
    }
    if (parsed === null || typeof parsed !== "object") {
        throw new Error(`${description} 必须是 JSON 对象`);
    }
    return parsed;
}

function messagePayload(message) {
    return message && message.payload !== undefined
        ? message.payload : new Uint8Array(0);
}

function compactEventValue(value, key = "", depth = 0) {
    if (key === "ResourceBase64" && typeof value === "string") {
        return {Base64Length: value.length};
    }
    if (depth >= 8) {
        return "<省略过深的事件数据>";
    }
    if (Array.isArray(value)) {
        return value.map((item) => compactEventValue(item, "", depth + 1));
    }
    if (value !== null && typeof value === "object") {
        const result = {};
        for (const property of Object.keys(value)) {
            result[property] = compactEventValue(
                value[property], property, depth + 1);
        }
        return result;
    }
    return value;
}

function appendReportEvent(topic, payload) {
    if (reportEvents.length >= MAX_REPORT_EVENTS) {
        reportEvents.shift();
        droppedReportEvents += 1;
    }
    reportEvents.push({
        Topic: topic,
        ReceivedAt: Date.now(),
        Data: compactEventValue(payload),
    });
}

function requireConnected() {
    if (connectionHandle === null || !mqtt.isConnected(connectionHandle)) {
        throw new Error("VCarEA MQTT 连接尚未建立或已经断开");
    }
}

function statusDescription(code) {
    return STATUS_TEXT[code] || "未知状态";
}

function isRetryableAccessError(error) {
    if (error instanceof ProtocolResponseTimeoutError
            || error instanceof VcareaBusyError) {
        return true;
    }
    const code = error && error.code !== undefined
        ? String(error.code).toUpperCase() : "";
    return code === "MQTT_ERROR" || code === "TIMEOUT";
}

/**
 * 判断工程配置请求是否属于可重试的瞬态失败。
 *
 * 以下两种应答都说明宿主尚未准备好接受配置，且都没有产生配置副作用，
 * 重发是安全的：
 * 1. 工程树仍在后台恢复时返回的“当前项目未找到路径…的测试配置”业务错误；
 * 2. 宿主正在处理其它接口时返回的忙拒绝（见 BUSY_REJECTION_TEXT）。
 */
function isProjectConfigurationRetryableError(error) {
    if (error instanceof VcareaBusyError) {
        return true;
    }
    if (!(error instanceof VcareaResponseError)
            || error.responseCode !== 1) {
        return false;
    }
    const message = String(error.responseMessage || "");
    return message.includes("当前项目") && message.includes("未找到路径")
        && message.includes("配置");
}

export function responseTimeout() {
    return optionInteger(
        "ResponseTimeoutMs", DEFAULT_RESPONSE_TIMEOUT_MS, 1, 1800000);
}

/**
 * “打开工程并配置测试环境”阶段的单次请求应答超时。
 *
 * 打开工程应答可能包含宿主后台恢复（实测 5~35 秒），TBF 配置同步加载
 * XIL 环境（实测 16~24 秒），宿主忙拒绝重发也要在该窗口内完成，因此本
 * 阶段的打开工程、工程配置与就绪后首次查询统一使用该超时。
 */
export function configureResponseTimeout() {
    return optionInteger(
        "ConfigureResponseTimeoutMs",
        DEFAULT_CONFIGURE_RESPONSE_TIMEOUT_MS,
        1,
        1800000);
}

/** 宿主忙拒绝后的重发间隔；仅调试或极端主机性能下需要调整。 */
export function busyRetryInterval() {
    return optionInteger(
        "BusyRetryIntervalMs", DEFAULT_BUSY_RETRY_INTERVAL_MS, 100, 60000);
}

export function executionTimeout() {
    return optionInteger(
        "ExecutionTimeoutMs", DEFAULT_EXECUTION_TIMEOUT_MS, 1, 86400000);
}

export function reportTimeout() {
    return optionInteger(
        "ReportTimeoutMs", DEFAULT_REPORT_TIMEOUT_MS, 1, 86400000);
}

export function cleanupTimeout() {
    return optionInteger(
        "CleanupTimeoutMs", DEFAULT_CLEANUP_TIMEOUT_MS, 1, 60000);
}

export function initializeProtocol() {
    currentClientId = createClientId();
    reportEvents = [];
    droppedReportEvents = 0;
}

/** 使用 Connector SDK 返回的宿主实际 MQTT 参数覆盖文档默认值。 */
export function configureBroker(configuration) {
    if (connectionHandle !== null) {
        throw new Error("VCarEA MQTT 已连接，不能再修改 broker 配置");
    }
    if (configuration === null || typeof configuration !== "object") {
        throw new Error("Connector MQTT 配置必须是对象");
    }
    const serverUri = String(configuration.ServerUri || "").trim();
    if (!/^mqtts?:\/\//i.test(serverUri)) {
        throw new Error(`Connector 返回的 MQTT ServerUri 无效：${serverUri}`);
    }
    const keepAliveSeconds = Number(configuration.KeepAliveSeconds);
    if (!Number.isInteger(keepAliveSeconds)
            || keepAliveSeconds < 0 || keepAliveSeconds > 65535) {
        throw new Error(
            "Connector 返回的 MQTT KeepAliveSeconds 必须在 0 到 65535 之间");
    }
    brokerConfiguration = {
        ServerUri: serverUri,
        UserName: typeof configuration.UserName === "string"
            ? configuration.UserName : "",
        Password: typeof configuration.Password === "string"
            ? configuration.Password : "",
        KeepAliveSeconds: keepAliveSeconds,
    };
    task.info(
        `已应用 Connector MQTT 配置：${brokerConfiguration.ServerUri}；`
        + `KeepAlive=${brokerConfiguration.KeepAliveSeconds}s`);
}

export function clientId() {
    if (currentClientId === "") {
        throw new Error("VCarEA MQTT 客户端尚未初始化");
    }
    return currentClientId;
}

export function createRequest(data) {
    const request = {
        ID: `${clientId()}-${Date.now()}-${randomHex(8)}`,
        ClientID: clientId(),
    };
    if (data !== undefined) {
        request.Data = data;
    }
    const targetClientId = optionString("TargetClientID").trim();
    if (targetClientId !== "") {
        request.TargetClientID = targetClientId;
    }
    const broadcast = optionalBoolean("IsBroadcast");
    if (broadcast !== null) {
        request.IsBroadcast = broadcast;
    }
    return request;
}

export function publishJson(topic, value, timeoutMs = responseTimeout()) {
    requireConnected();
    mqtt.publish(connectionHandle, {
        topic,
        payload: jsonBytes(value),
        qos: 1,
        retained: false,
    }, timeoutMs);
}

export function receiveMessage(timeoutMs) {
    requireConnected();
    return mqtt.receive(connectionHandle, timeoutMs);
}

export function subscribe(topic, qos = 1) {
    requireConnected();
    if (subscriptions.includes(topic)) {
        return;
    }
    mqtt.subscribe(connectionHandle, topic, qos);
    subscriptions.push(topic);
}

export function unsubscribe(topic) {
    if (connectionHandle === null || !subscriptions.includes(topic)) {
        return;
    }
    mqtt.unsubscribe(connectionHandle, topic);
    subscriptions = subscriptions.filter((entry) => entry !== topic);
}

/** 判断消息是否为宿主转发的测试报告事件，并保留不含大块 Base64 的快照。 */
export function routeProtocolMessage(message) {
    if (!message || !String(message.topic).startsWith(REPORT_TOPIC_PREFIX)) {
        return false;
    }
    try {
        appendReportEvent(
            message.topic,
            parseJsonBytes(messagePayload(message), `报告事件 ${message.topic}`));
    } catch (error) {
        task.warning(`忽略无法解析的 VCarEA 报告事件：${error.message}`);
    }
    return true;
}

/** 当消息属于指定应答时返回已校验的应答，否则返回 null。 */
export function responseFromMessage(message, responseTopic, requestId) {
    if (!message || message.topic !== responseTopic) {
        return null;
    }
    const response = parseJsonBytes(
        messagePayload(message), `VCarEA 应答 ${responseTopic}`);
    if (String(response.ID || "") !== String(requestId)) {
        return null;
    }
    const code = Number(response.Code);
    if (!Number.isInteger(code)) {
        throw new Error(`VCarEA 应答 ${requestId} 的 Code 字段无效`);
    }
    if (code !== 0) {
        const messageText = String(response.Msg || "").trim();
        throw new VcareaResponseError(requestId, code, messageText);
    }
    return response;
}

/**
 * 提取宿主的“接口忙”拒绝应答。
 *
 * 实测 1.8.4.0826：并发请求会立即收到 `Code=1` 且消息为“其他接口正在工作，
 * 请稍后重试！”的应答，该应答的 `ID` 由宿主重新生成，与请求完全不匹配，
 * 因此不能按 ID 匹配（按 ID 匹配会把拒绝当成无关消息而一直等到超时）。
 * 返回非空字符串表示命中忙拒绝，调用方应稍后重发同一请求。
 */
export function busyRejectionMessage(message, responseTopic) {
    if (!message || message.topic !== responseTopic) {
        return null;
    }
    let response = null;
    try {
        response = parseJsonBytes(
            messagePayload(message), `VCarEA 应答 ${responseTopic}`);
    } catch (_) {
        return null;
    }
    if (Number(response.Code) !== 1) {
        return null;
    }
    const messageText = String(response.Msg || "").trim();
    return messageText.includes(BUSY_REJECTION_TEXT) ? messageText : null;
}

/**
 * 记录忙拒绝重试进度：首次命中与之后的报告间隔各输出一次，避免刷屏。
 *
 * @param {{count: number, reportedAt: number}} state 调用方持有的重试状态。
 */
export function reportBusyRetry(state, responseTopic, hostMessage) {
    state.count += 1;
    const now = Date.now();
    if (state.count > 1
            && now - state.reportedAt < BUSY_RETRY_REPORT_INTERVAL_MS) {
        return;
    }
    state.reportedAt = now;
    task.info(
        `VCarEA 正忙，${responseTopic} 第 ${state.count} 次被拒绝：`
        + `${hostMessage}（稍后自动重发）`);
}

export function waitForResponse(responseTopic,
                                requestId,
                                timeoutMs = responseTimeout(),
                                accept = null,
                                resend = null) {
    requireConnected();
    const deadline = Date.now() + timeoutMs;
    const busyState = {count: 0, reportedAt: 0};
    let lastBusyMessage = "";
    while (Date.now() < deadline) {
        task.checkCancelled();
        const remaining = Math.max(
            1, Math.min(RECEIVE_POLL_INTERVAL_MS, deadline - Date.now()));
        const message = receiveMessage(remaining);
        if (message === null || message === undefined) {
            continue;
        }
        if (routeProtocolMessage(message)) {
            continue;
        }
        const busyMessage = busyRejectionMessage(message, responseTopic);
        if (busyMessage !== null) {
            lastBusyMessage = busyMessage;
            reportBusyRetry(busyState, responseTopic, busyMessage);
            if (resend !== null) {
                resend();
            }
            if (Date.now() < deadline) {
                task.delay(Math.max(1, Math.min(
                    busyRetryInterval(), deadline - Date.now())));
            }
            continue;
        }
        const response = responseFromMessage(message, responseTopic, requestId);
        if (response === null) {
            continue;
        }
        if (accept !== null && !accept(response)) {
            continue;
        }
        return response;
    }
    if (busyState.count > 0) {
        throw new VcareaBusyError(
            responseTopic, requestId, busyState.count, lastBusyMessage);
    }
    throw new ProtocolResponseTimeoutError(
        `等待 VCarEA 应答超时：${responseTopic}（${requestId}）`);
}

export function request(requestTopic,
                        responseTopic,
                        data,
                        timeoutMs = responseTimeout(),
                        accept = null) {
    const requestData = createRequest(data);
    const publishTimeoutMs = Math.min(timeoutMs, responseTimeout());
    const resend = () =>
        publishJson(requestTopic, requestData, publishTimeoutMs);
    resend();
    return waitForResponse(
        responseTopic, requestData.ID, timeoutMs, accept, resend);
}

/**
 * 配置工程的 TCF/TBF。
 *
 * 工程树尚在后台加载或宿主正忙时按“可重试的瞬态失败”重试
 * （见 isProjectConfigurationRetryableError）：前者的应答确认配置未生效，
 * 后者的应答确认宿主没有执行任何操作，重发都不会重复未知副作用；完全没有
 * 应答的单次超时仍立即返回，因为它无法排除“宿主已执行但应答丢失”。
 */
export function configureProjectConfiguration(operationType,
                                              configPath,
                                              constraintUpdate,
                                              timeoutMs) {
    if (operationType !== 0 && operationType !== 1) {
        throw new Error("VCarEA 配置类型只能是 0（TCF）或 1（TBF）");
    }
    const path = String(configPath || "").trim();
    if (path === "") {
        throw new Error("VCarEA 工程配置路径不能为空");
    }
    const overallTimeoutMs = Number(timeoutMs);
    if (!Number.isInteger(overallTimeoutMs) || overallTimeoutMs < 1) {
        throw new Error("VCarEA 工程配置就绪超时必须是正整数");
    }

    const deadline = Date.now() + overallTimeoutMs;
    let attempts = 0;
    let lastError = null;
    while (Date.now() < deadline) {
        task.checkCancelled();
        attempts += 1;
        try {
            return request(
                TOPICS.settingRequest,
                TOPICS.settingResponse,
                {
                    OperationType: operationType,
                    ConstaraintUpdate: Boolean(constraintUpdate),
                    ConfigPath: path,
                },
                Math.min(
                    configureResponseTimeout(),
                    Math.max(1, deadline - Date.now())));
        } catch (error) {
            if (!isProjectConfigurationRetryableError(error)) {
                throw error;
            }
            lastError = error;
        }
        if (attempts % 10 === 0 && Date.now() < deadline) {
            task.info(
                `VCarEA 工程配置仍在初始化，已重试 ${attempts} 次：`
                + lastError.message);
        }
        if (Date.now() < deadline) {
            task.delay(Math.min(
                PROJECT_CONFIGURATION_RETRY_INTERVAL_MS,
                Math.max(1, deadline - Date.now())));
        }
    }
    throw new Error(
        `等待 VCarEA 工程配置就绪超时（${overallTimeoutMs} ms）：`
        + (lastError === null ? "未执行配置请求" : lastError.message));
}

/** 配置列表中出现测试配置与测试台配置即视为工程后台初始化完成。 */
function hasProjectConfigurations(entries) {
    const suffixes = [".tcf", ".tbf"];
    return suffixes.every((suffix) => entries.some((entry) =>
        String(entry && entry.Path ? entry.Path : "")
            .toLowerCase().endsWith(suffix)));
}

/**
 * 轮询配置列表，直到 VCarEA 完成工程后台初始化。
 *
 * 打开工程应答早于 VCarEA 后台恢复 TBF 与工程树构造：探测到测试配置和
 * 测试台配置同时出现在配置列表中即提前返回，替代按固定时长盲等；探测
 * 失败按间隔重试，超时后抛出最近一次失败原因。
 */
export function waitForProjectConfigurations(timeoutMs, probeIntervalMs) {
    const overallTimeoutMs = Number(timeoutMs);
    if (!Number.isInteger(overallTimeoutMs) || overallTimeoutMs < 1) {
        throw new Error("VCarEA 工程就绪超时必须是正整数");
    }
    const probeInterval = Math.max(1, Math.floor(Number(probeIntervalMs) || 0));
    // 单次探测使用独立的短应答超时，保证未就绪时能按间隔持续探测。
    const probeResponseTimeoutMs = Math.min(
        responseTimeout(), Math.max(2000, probeInterval * 2));
    const startedAt = Date.now();
    const deadline = startedAt + overallTimeoutMs;
    let configurations = [];
    let lastError = null;
    let lastReportAt = startedAt;
    while (Date.now() < deadline) {
        task.checkCancelled();
        try {
            const response = request(
                TOPICS.configurationsRequest,
                TOPICS.configurationsResponse,
                undefined,
                Math.min(
                    probeResponseTimeoutMs,
                    Math.max(1, deadline - Date.now())));
            configurations = Array.isArray(response.Data)
                ? response.Data : [];
            if (hasProjectConfigurations(configurations)) {
                return {
                    Configurations: configurations,
                    WaitedMs: Date.now() - startedAt,
                };
            }
            lastError = new Error("配置列表中尚未出现测试配置或测试台配置");
        } catch (error) {
            lastError = error;
        }
        const now = Date.now();
        if (now - lastReportAt >= PROBE_REPORT_INTERVAL_MS) {
            lastReportAt = now;
            task.info(
                `VCarEA 工程仍在后台初始化（已等待 `
                + `${Math.round((now - startedAt) / 1000)} 秒）：`
                + (lastError === null ? "未知原因" : lastError.message));
        }
        if (Date.now() < deadline) {
            task.delay(Math.min(
                probeInterval, Math.max(1, deadline - Date.now())));
        }
    }
    throw new Error(
        `等待 VCarEA 工程配置就绪超时（${overallTimeoutMs} ms）：`
        + (lastError === null ? "未执行配置探测" : lastError.message));
}

/**
 * 查询执行 MQTT 端口（可选观察）。
 *
 * 实测 VCarEA 1.8.4.0826 对该请求完全不产生应答（包括 Case 执行期间），
 * 因此只执行一次短超时请求：无应答或业务错误按 `{Port: null, Error}` 返回，
 * 不视为失败；连接级错误仍向上抛出，避免掩盖真实故障。
 */
export function probeExecutionPort(timeoutMs = optionInteger(
    "ExecutionPortProbeMs", DEFAULT_EXECUTION_PORT_PROBE_MS, 1, 60000)) {
    try {
        const response = request(
            TOPICS.executionPortRequest,
            TOPICS.executionPortResponse,
            undefined,
            timeoutMs);
        const port = Number(response.Data && response.Data.ExecutionMqttPort);
        if (Number.isInteger(port) && port >= 0 && port <= 65535) {
            return {Port: port, Error: null};
        }
        return {Port: null, Error: "执行端口应答中的 ExecutionMqttPort 无效"};
    } catch (error) {
        if (error instanceof ProtocolResponseTimeoutError
                || error instanceof VcareaResponseError
                || error instanceof VcareaBusyError) {
            return {Port: null, Error: error.message};
        }
        throw error;
    }
}

/**
 * 判断“实验环境未启动”的幂等应答错误。
 *
 * 实测停止环境时 VCarEA 可能返回 Code=0 且消息为“未启动实验环境，
 * 请先启动实验环境”；若某些版本以非零 Code 表达同一语义，清理阶段
 * 也不应视为失败。
 */
export function isEnvironmentNotRunningError(error) {
    return error instanceof VcareaResponseError
        && String(error.responseMessage || "").includes("未启动");
}

function disconnectCurrentConnection() {
    if (connectionHandle === null) {
        return;
    }
    const handle = connectionHandle;
    connectionHandle = null;
    subscriptions = [];
    try {
        mqtt.disconnect(handle, DEFAULT_CLEANUP_TIMEOUT_MS);
    } catch (_) {
        // 重连路径只负责丢弃失效句柄，最终清理阶段会记录可诊断的断开失败。
    }
}

function connectBroker() {
    if (connectionHandle !== null && mqtt.isConnected(connectionHandle)) {
        return;
    }
    disconnectCurrentConnection();
    const will = {
        ID: `${clientId()}-will`,
        ClientID: clientId(),
        Data: {AppName: APPLICATION_NAME},
    };
    const result = mqtt.connect({
        serverUri: brokerConfiguration.ServerUri,
        clientId: clientId(),
        username: brokerConfiguration.UserName,
        password: new TextEncoder().encode(brokerConfiguration.Password),
        keepAliveSeconds: brokerConfiguration.KeepAliveSeconds,
        connectTimeoutMs: optionInteger(
            "ConnectTimeoutMs", DEFAULT_CONNECT_TIMEOUT_MS, 1, 120000),
        cleanSession: true,
        cleanStart: true,
        will: {
            topic: TOPICS.will,
            payload: jsonBytes(will),
            qos: 1,
            retained: false,
        },
    });
    connectionHandle = result.handle;
    subscriptions = [];
    // 报告事件只在主 broker 上转发（主题带 KY/ 前缀）；执行器 broker 仅存于
    // 执行期间且使用动态凭据，适配器不连接它。
    for (const topic of [...RESPONSE_TOPICS, REPORT_TOPIC_SUBSCRIPTION]) {
        subscribe(topic, 1);
    }
    task.info(`已连接 VCarEA MQTT 服务：${brokerConfiguration.ServerUri}`);
}

/** 连接 MQTT，并重试接入握手直到 VCarEA 的业务 API 完成初始化。 */
export function connectEaApi(checkProcess = null) {
    const timeoutMs = optionInteger(
        "AccessReadyTimeoutMs", DEFAULT_ACCESS_READY_TIMEOUT_MS, 1, 1800000);
    const responseTimeoutMs = optionInteger(
        "AccessResponseTimeoutMs",
        DEFAULT_ACCESS_RESPONSE_TIMEOUT_MS,
        1,
        60000);
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let attempts = 0;
    let lastError = null;
    while (Date.now() < deadline) {
        task.checkCancelled();
        if (checkProcess !== null) {
            checkProcess();
        }
        attempts += 1;
        try {
            connectBroker();
            const response = request(
                TOPICS.accessRequest,
                TOPICS.accessResponse,
                {AccessAPPName: APPLICATION_NAME, Target: "VCarEA"},
                Math.min(
                    responseTimeoutMs, Math.max(1, deadline - Date.now())));
            task.info(
                `VCarEA API 客户端登记成功：${response.Msg || "succeed"}`);
            return;
        } catch (error) {
            if (!isRetryableAccessError(error)) {
                throw error;
            }
            lastError = error;
            if (connectionHandle !== null
                    && !mqtt.isConnected(connectionHandle)) {
                disconnectCurrentConnection();
            }
        }
        if (attempts % 10 === 0 && Date.now() < deadline) {
            const waitedSeconds = Math.round((Date.now() - startedAt) / 1000);
            task.info(
                `已等待 VCarEA API 接入就绪 ${waitedSeconds} 秒，最近错误：`
                + lastError.message);
        }
        if (Date.now() < deadline) {
            task.delay(Math.min(
                ACCESS_RETRY_INTERVAL_MS, Math.max(1, deadline - Date.now())));
        }
    }
    throw new Error(
        `等待 VCarEA API 接入就绪超时（${timeoutMs} ms）`
        + (lastError === null ? "" : `：${lastError.message}`));
}

export function isConnected() {
    return connectionHandle !== null && mqtt.isConnected(connectionHandle);
}

export function reportEventCount() {
    return droppedReportEvents + reportEvents.length;
}

export function reportEventsSince(index) {
    const requestedIndex = Math.max(0, Number(index) || 0);
    return {
        Events: reportEvents.slice(
            Math.max(0, requestedIndex - droppedReportEvents)),
        DroppedEventCount: Math.max(
            0, droppedReportEvents - requestedIndex),
    };
}

export function disconnect() {
    if (connectionHandle === null) {
        return;
    }
    const handle = connectionHandle;
    connectionHandle = null;
    subscriptions = [];
    mqtt.disconnect(handle, cleanupTimeout());
}

export function resetProtocol() {
    connectionHandle = null;
    currentClientId = "";
    subscriptions = [];
    reportEvents = [];
    droppedReportEvents = 0;
    brokerConfiguration = {...DEFAULT_BROKER_CONFIGURATION};
}
