import * as cli from "@atech/cli";
import {openLibrary} from "./connector_sdk/index.js";
import * as fs from "@atech/fs";
import * as task from "@atech/task";

import {
    describeInstallation,
    resolveInstallation,
} from "./vcarea_utils.js";

/** 连接服务唯一标识的默认值；执行器服务使用 VCarEA.Executor。 */
const DEFAULT_CONNECTION_KEY = "VCarEA";
const SUPPORTED_CONNECTION_KEYS = ["VCarEA", "VCarEA.Executor"];

// TODO: Connector SDK 文档没有规定连接、查询、启动就绪超时和轮询间隔，
// 以下值沿用旧版适配器的实测假设，并由工作流阶段超时提供外层限制。
const CONNECT_PROBE_TIMEOUT_MS = 30000;
const CONNECT_QUERY_TIMEOUT_MS = 15000;
const QUERY_TIMEOUT_MS = 20000;
const READINESS_TIMEOUT_MS = 120000;
const READINESS_POLL_MS = 1000;
const READINESS_REPORT_ATTEMPTS = 10;

// dllnet worker 崩溃并重建会话后，旧程序集和对象句柄会全部失效。
const SESSION_RESET_MESSAGE = "DLL worker session was reset";
const HANDLE_INVALID_MESSAGE = "Assembly handle is invalid";

const WORKSPACE_CONFIG_URI = "workspace://vcarea/mqtt-config.json";
const ARTIFACT_CONFIG_URI = "artifact://vcarea/mqtt-config.json";

let installation = null;
let processHandle = null;
let processPid = 0;
let processStartedByPlugin = false;
let sdkLibrary = null;

function describeError(error) {
    if (error === null || error === undefined) {
        return "未知错误";
    }
    const code = error.code === undefined ? "" : `[${error.code}] `;
    const message = error.message === undefined ? String(error) : error.message;
    const details = error.details;
    if (details === undefined || details === null) {
        return `${code}${message}`;
    }
    let rendered = "";
    try {
        rendered = JSON.stringify(details);
    } catch (_) {
        rendered = String(details);
    }
    return rendered === "" || rendered === "{}"
        ? `${code}${message}`
        : `${code}${message}（${rendered}）`;
}

function isSessionResetError(error) {
    const text = describeError(error);
    return text.includes(SESSION_RESET_MESSAGE)
        || text.includes(HANDLE_INVALID_MESSAGE);
}

function dropSdkSession(reason) {
    if (sdkLibrary === null) {
        return;
    }
    task.warning(
        `dllnet worker 会话已重置（${reason}），下次调用将重新加载 Connector SDK`);
    try {
        sdkLibrary.close();
    } catch (_) {
        // 会话重置后旧句柄已经失效，此处只需丢弃本地引用。
    }
    sdkLibrary = null;
}

function decodeText(bytes) {
    if (bytes === undefined || bytes === null) {
        return "";
    }
    try {
        return new TextDecoder().decode(bytes).trim();
    } catch (_) {
        return "";
    }
}

function optionalDevice(key) {
    try {
        const value = task.device(key);
        return value === undefined || value === null ? "" : String(value).trim();
    } catch (_) {
        return "";
    }
}

function requireInstallation() {
    if (installation === null) {
        installation = resolveInstallation(
            optionalDevice("VCAR_EA_SOFTWARE_PATH"));
        task.info(`VCarEA 安装布局：${describeInstallation(installation)}`);
    }
    return installation;
}

function connectionKey() {
    const configured = String(
        task.option("ConnectionKey", DEFAULT_CONNECTION_KEY)).trim();
    if (!SUPPORTED_CONNECTION_KEYS.includes(configured)) {
        throw new Error(
            `不支持的连接服务标识 [${configured}]，可选值：`
            + SUPPORTED_CONNECTION_KEYS.join("、"));
    }
    return configured;
}

function loadSdkLibrary() {
    if (sdkLibrary !== null) {
        return sdkLibrary;
    }
    const target = requireInstallation();
    task.info(`加载 Connector SDK：${target.ConnectorSdkPath}`);
    try {
        sdkLibrary = openLibrary(target.ConnectorSdkPath);
    } catch (error) {
        throw new Error(
            `加载 Connector SDK 失败：${describeError(error)}；`
            + describeInstallation(target));
    }
    return sdkLibrary;
}

function connectClient(timeoutMs) {
    const client = loadSdkLibrary().Connect(null, {timeoutMs});
    if (client === null || client === undefined) {
        throw new Error("ConnectorServiceClient.Connect 未返回客户端实例");
    }
    return client;
}

function closeClient(client, dispose = true) {
    if (client === null || client === undefined) {
        return;
    }
    // 连接失败时 Dispose 可能再次阻塞，只在确认连接可用后释放 SDK 会话。
    if (dispose) {
        try {
            client.Dispose();
        } catch (error) {
            if (!isSessionResetError(error)) {
                task.warning(`释放连接客户端失败：${describeError(error)}`);
            }
        }
    }
    try {
        client.close();
    } catch (error) {
        if (!isSessionResetError(error)) {
            task.warning(`关闭连接客户端句柄失败：${describeError(error)}`);
        }
    }
}

function probeConnectionServiceKey(key, timeoutMs) {
    let client = null;
    let connected = false;
    try {
        client = connectClient(timeoutMs);
        const info = client.TryGetConnectionInfo(key, {timeoutMs});
        connected = true;
        return info !== null && info !== undefined;
    } catch (error) {
        if (isSessionResetError(error)) {
            dropSdkSession(describeError(error));
        }
        task.info(`连接服务 [${key}] 暂不可用：${describeError(error)}`);
        return false;
    } finally {
        closeClient(client, connected);
    }
}

function missingConnectionServiceError(key) {
    return new Error(
        `连接服务 [${key}] 尚未创建：请确认 VCarEA 宿主已通过 `
        + "ReadOrCreateConnectorService 创建该 key");
}

/** 检查由适配器启动的 VCarEA 进程是否异常退出。 */
export function ensureVcareaProcessRunning() {
    if (processHandle === null || cli.isRunning(processHandle)) {
        return;
    }
    const finished = cli.wait(processHandle);
    cli.release(processHandle);
    processHandle = null;
    processPid = 0;
    if (!finished.crashed && finished.exitCode === 0) {
        // 单实例程序可能把请求交给已有实例后正常退出。
        task.warning("VCarEA 启动进程已退出，按已有实例继续等待服务");
        return;
    }
    const local = String(finished.standardErrorLocalText || "").trim();
    const stderr = local === "" ? decodeText(finished.standardError) : local;
    throw new Error(
        `VCarEA 启动失败：退出码 ${finished.exitCode}`
        + (stderr === "" ? "" : `，输出：${stderr}`));
}

function waitForConnectionService(key) {
    const startedAt = Date.now();
    const deadline = startedAt + READINESS_TIMEOUT_MS;
    let attempts = 0;
    while (Date.now() < deadline) {
        task.checkCancelled();
        ensureVcareaProcessRunning();
        attempts += 1;
        if (probeConnectionServiceKey(key, CONNECT_PROBE_TIMEOUT_MS)) {
            task.info(`VCarEA 宿主连接服务 [${key}] 已就绪`);
            return;
        }
        if (attempts % READINESS_REPORT_ATTEMPTS === 0
                && Date.now() < deadline) {
            const waitedSeconds = Math.round((Date.now() - startedAt) / 1000);
            task.info(
                `已等待连接服务 [${key}] ${waitedSeconds} 秒`
                + `（上限 ${READINESS_TIMEOUT_MS / 1000} 秒）`);
        }
        task.delay(Math.min(
            READINESS_POLL_MS, Math.max(1, deadline - Date.now())));
    }
    throw new Error(
        `等待 VCarEA 宿主连接服务 [${key}] 超时（${READINESS_TIMEOUT_MS} ms）：`
        + `请确认 ${requireInstallation().CentralServicePath} 已在运行`);
}

function requireText(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(
            `连接服务返回的字段 ${field} 无效：${JSON.stringify(value)}`);
    }
    return value;
}

function requireInteger(value, field, minimum, maximum) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
        throw new Error(
            `连接服务返回的字段 ${field} 无效：${JSON.stringify(value)}`);
    }
    return number;
}

function normalizeConnectionInfo(info, key) {
    if (info === null || typeof info !== "object") {
        throw new Error(
            `连接服务 [${key}] 返回的连接信息不是对象：${JSON.stringify(info)}`);
    }
    const host = requireText(info.Host, "Host");
    const port = requireInteger(info.Port, "Port", 1, 65535);
    return {
        Key: key,
        ClientName: requireText(info.ClientName, "ClientName"),
        Host: host,
        Port: port,
        UserName: typeof info.UserName === "string" ? info.UserName : "",
        Password: typeof info.Password === "string" ? info.Password : "",
        TimeoutSeconds:
            requireInteger(info.TimeoutSeconds, "TimeoutSeconds", 0, 86400),
        KeepAliveSeconds:
            requireInteger(info.KeepAliveSeconds, "KeepAliveSeconds", 0, 86400),
        ServerUri: `mqtt://${host}:${port}`,
    };
}

function persistConfiguration(configuration) {
    const payload = `${JSON.stringify(configuration, null, 2)}\n`;
    fs.writeText(WORKSPACE_CONFIG_URI, payload);
    fs.writeText(ARTIFACT_CONFIG_URI, payload);
    task.publish(
        "MQTT_CONFIG",
        ARTIFACT_CONFIG_URI,
        "VCarEA MQTT 连接配置",
        "application/json",
        "");
    task.info(`MQTT 连接配置已保存并发布：${WORKSPACE_CONFIG_URI}`);
}

/** 默认启动 VCarEA；仅在显式附加模式下复用已有宿主实例。 */
export function launchVcarea(attachExisting = false) {
    const target = requireInstallation();
    const key = connectionKey();

    if (attachExisting) {
        if (!probeConnectionServiceKey(key, CONNECT_QUERY_TIMEOUT_MS)) {
            throw new Error(
                `AttachExisting=true，但连接服务 [${key}] 不可用：`
                + "请先启动 VCarEA 并等待其完成初始化");
        }
        task.info(
            `AttachExisting=true，复用已有 VCarEA 实例及连接服务 [${key}]`);
        return {Started: false, ExecutablePath: target.ExecutablePath};
    }

    task.info(`启动 VCarEA：${target.ExecutablePath}`);
    let started = null;
    try {
        started = cli.start({
            executable: target.ExecutablePath,
            arguments: [],
            // 绿色版会按当前目录发现 Gemini 模块和内置驱动。
            workingDirectoryUri: "executable://",
        });
    } catch (error) {
        throw new Error(
            `启动 VCarEA 失败：${describeError(error)}；`
            + describeInstallation(target));
    }
    processHandle = started.handle;
    processPid = started.pid;
    processStartedByPlugin = true;
    task.info(`VCarEA 进程已启动（PID ${processPid}），等待 Connector 服务`);
    waitForConnectionService(key);
    return {
        Started: true,
        Pid: processPid,
        ExecutablePath: target.ExecutablePath,
    };
}

/** 通过 Connector SDK 查询并发布宿主实际使用的 MQTT 配置。 */
export function readConnectorMqttConfiguration() {
    const key = connectionKey();
    task.info(`查询连接服务 [${key}] 的 MQTT 连接配置`);

    let client = null;
    try {
        client = connectClient(CONNECT_QUERY_TIMEOUT_MS);
    } catch (error) {
        if (isSessionResetError(error)) {
            dropSdkSession(describeError(error));
        }
        throw new Error(
            `连接中心服务失败：${describeError(error)}；`
            + `请确认 ${requireInstallation().CentralServicePath} 已在运行`);
    }

    let connected = false;
    try {
        let info = null;
        try {
            info = client.TryGetConnectionInfo(
                key, {timeoutMs: QUERY_TIMEOUT_MS});
            connected = true;
        } catch (error) {
            if (isSessionResetError(error)) {
                dropSdkSession(describeError(error));
            }
            throw new Error(
                `查询连接服务 [${key}] 失败：${describeError(error)}`);
        }
        if (info === null || info === undefined) {
            throw missingConnectionServiceError(key);
        }
        const configuration = normalizeConnectionInfo(info, key);
        persistConfiguration(configuration);
        return configuration;
    } finally {
        closeClient(client, connected);
    }
}

/** 释放 Connector SDK，并终止本次适配器实际启动的 VCarEA 进程。 */
export function cleanupConnector() {
    if (sdkLibrary !== null) {
        try {
            sdkLibrary.close();
        } catch (error) {
            task.warning(`关闭 Connector SDK 失败：${describeError(error)}`);
        }
        sdkLibrary = null;
    }

    if (processHandle !== null) {
        const handle = processHandle;
        processHandle = null;
        try {
            if (processStartedByPlugin && cli.isRunning(handle)) {
                cli.terminate(handle, 5000);
                task.info("已终止本次适配器启动的 VCarEA 进程");
            }
        } catch (error) {
            task.warning(`终止 VCarEA 失败：${describeError(error)}`);
        }
        try {
            if (!cli.isRunning(handle)) {
                cli.release(handle);
            }
        } catch (error) {
            task.warning(`释放 VCarEA 进程句柄失败：${describeError(error)}`);
        }
    }

    installation = null;
    processPid = 0;
    processStartedByPlugin = false;
}
