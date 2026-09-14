import * as cli from "@atech/cli";
import * as dllnet from "@atech/dllnet";
import * as fs from "@atech/fs";
import * as task from "@atech/task";

import {
    describeInstallation,
    resolveInstallation,
} from "./vcarea/vcarea_utils.js";

// VCarEA 测试适配器入口：启动 VCarEA 宿主，并通过 Connector SDK 查询
// 宿主已创建的 MQTT 连接服务配置（与适配器 docs/main.py 使用同一只读接口）。
// 导出名称必须与 StepConfig.groovy 中的 runjs 配置保持一致。

/** Connector SDK 中的只读客户端类型。 */
const SDK_CLIENT_TYPE = "KY.VCar.Central.Connector.Sdk.ConnectorServiceClient";

/** 连接服务唯一标识的默认值；执行器服务使用 VCarEA.Executor。 */
const DEFAULT_CONNECTION_KEY = "VCarEA";
const SUPPORTED_CONNECTION_KEYS = ["VCarEA", "VCarEA.Executor"];

// 探测用于判断服务是否就绪：服务未运行时 SDK 会快速失败，而宿主启动过渡
// 期间的连接调用可能长时间阻塞，因此超时取 broker 默认值 30 秒，
// 避免把一次慢握手误判为服务不可用。
const CONNECT_PROBE_TIMEOUT_MS = 30000;
const CONNECT_QUERY_TIMEOUT_MS = 15000;
const QUERY_TIMEOUT_MS = 20000;

// 启动后等待宿主连接服务就绪的上限，受阶段 timeout 二次约束。
const READINESS_TIMEOUT_MS = 120000;
const READINESS_POLL_MS = 1000;

const WORKSPACE_CONFIG_URI = "workspace://vcarea/mqtt-config.json";
const ARTIFACT_CONFIG_URI = "artifact://vcarea/mqtt-config.json";

let installation = null;
let processHandle = null;
let processPid = 0;
let processStartedByPlugin = false;
let sdkAssembly = null;

function describeError(error) {
    if (error === null || error === undefined) {
        return "未知错误";
    }
    const code = error.code === undefined ? "" : `[${error.code}] `;
    const message = error.message === undefined ? String(error) : error.message;
    // 运行时错误可能携带诊断细节（如 worker 退出码与 stderr）。
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

/** 读取可选的工位属性；未声明或未配置时返回空字符串。 */
function optionalDevice(key) {
    try {
        const value = task.device(key);
        return value === undefined || value === null ? "" : String(value).trim();
    } catch (_) {
        return "";
    }
}

/** 解析当前节点的 VCarEA 安装布局，结果在节点生命周期内复用。 */
function requireInstallation() {
    if (installation === null) {
        installation = resolveInstallation(optionalDevice("VCAR_EA_SOFTWARE_PATH"));
        task.info(`VCarEA 安装布局：${describeInstallation(installation)}`);
    }
    return installation;
}

/** 读取需要查询的连接服务 key。 */
function connectionKey() {
    const configured = String(task.option("ConnectionKey", DEFAULT_CONNECTION_KEY))
        .trim();
    if (!SUPPORTED_CONNECTION_KEYS.includes(configured)) {
        throw new Error(
            `不支持的连接服务标识 [${configured}]，可选值：${SUPPORTED_CONNECTION_KEYS.join("、")}`);
    }
    return configured;
}

/** 加载 Connector SDK 程序集并在节点内复用。 */
function loadSdkAssembly() {
    if (sdkAssembly !== null) {
        return sdkAssembly;
    }
    const target = requireInstallation();
    task.info(`加载 Connector SDK：${target.ConnectorSdkPath}`);
    try {
        sdkAssembly = dllnet.load(target.ConnectorSdkPath);
    } catch (error) {
        throw new Error(
            `加载 Connector SDK 失败：${describeError(error)}；${describeInstallation(target)}`);
    }
    return sdkAssembly;
}

/** 连接宿主的中心服务并返回客户端句柄。 */
function connectClient(timeoutMs) {
    const assembly = loadSdkAssembly();
    const client = assembly.callObject(
        `${SDK_CLIENT_TYPE}::Connect`, [null], {timeoutMs});
    if (client === null || client === undefined) {
        throw new Error("ConnectorServiceClient.Connect 未返回客户端实例");
    }
    return client;
}

/** 释放客户端会话；句柄始终回收，SDK 会话仅在连接可用时释放。 */
function closeClient(client, dispose = true) {
    if (client === null || client === undefined) {
        return;
    }
    // 连接失败的客户端在 Dispose 时可能长时间阻塞，触发请求超时并终止 worker，
    // 因此仅在调用成功后释放 SDK 会话；失败的会话只回收句柄。
    if (dispose) {
        try {
            client.call("Dispose");
        } catch (error) {
            task.warning(`释放连接客户端失败：${describeError(error)}`);
        }
    }
    try {
        client.close();
    } catch (error) {
        task.warning(`关闭连接客户端句柄失败：${describeError(error)}`);
    }
}

/** 探测中心服务是否可用；不可用时返回 false 并输出原因。 */
function probeConnectionService(timeoutMs) {
    let client = null;
    let connected = false;
    try {
        client = connectClient(timeoutMs);
        connected = true;
        return true;
    } catch (error) {
        task.info(`连接服务暂不可用：${describeError(error)}`);
        return false;
    } finally {
        closeClient(client, connected);
    }
}

/** 探测宿主是否已创建指定 key 的连接服务。 */
function probeConnectionServiceKey(key, timeoutMs) {
    let client = null;
    let connected = false;
    try {
        client = connectClient(timeoutMs);
        const info = client.call("TryGetConnectionInfo", [key], {timeoutMs});
        connected = true;
        return info !== null;
    } catch (error) {
        task.info(`连接服务 [${key}] 暂不可用：${describeError(error)}`);
        return false;
    } finally {
        closeClient(client, connected);
    }
}

/** 连接服务缺失时的统一报错信息。 */
function missingConnectionServiceError(key) {
    return new Error(
        `连接服务 [${key}] 尚未创建：请确认 VCarEA 宿主已通过 `
        + "ReadOrCreateConnectorService 创建该 key");
}

/** 确认插件启动的 VCarEA 进程仍存活；异常退出时给出诊断。 */
function ensureProcessRunning() {
    if (processHandle === null || cli.isRunning(processHandle)) {
        return;
    }
    const finished = cli.wait(processHandle);
    cli.release(processHandle);
    processHandle = null;
    if (!finished.crashed && finished.exitCode === 0) {
        // 单实例软件在已有实例时会直接正常退出，继续按已有实例等待服务。
        task.warning("VCarEA 启动进程已退出（退出码 0），按已有实例继续等待连接服务");
        return;
    }
    const stderr = decodeText(finished.standardError);
    throw new Error(
        `VCarEA 启动失败：退出码 ${finished.exitCode}`
        + (stderr === "" ? "" : `，输出：${stderr}`));
}

/** 轮询 Connector SDK，直到宿主连接服务就绪或超出等待上限。 */
function waitForConnectionService(key) {
    const deadline = Date.now() + READINESS_TIMEOUT_MS;
    while (Date.now() < deadline) {
        task.checkCancelled();
        ensureProcessRunning();
        if (probeConnectionServiceKey(key, CONNECT_PROBE_TIMEOUT_MS)) {
            task.info(`VCarEA 宿主连接服务 [${key}] 已就绪`);
            return;
        }
        task.delay(READINESS_POLL_MS);
    }
    throw new Error(
        `等待 VCarEA 宿主连接服务 [${key}] 超时（${READINESS_TIMEOUT_MS} ms）：`
        + `请确认 ${requireInstallation().CentralServicePath} 已在运行`);
}

function requireText(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`连接服务返回的字段 ${field} 无效：${JSON.stringify(value)}`);
    }
    return value;
}

function requireInteger(value, field, minimum, maximum) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
        throw new Error(`连接服务返回的字段 ${field} 无效：${JSON.stringify(value)}`);
    }
    return number;
}

/** 把 ConnectorConnectionInfo 规范化为适配器内部的连接配置结构。 */
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

/** 保存并发布连接配置，供后续阶段与产物收集使用。 */
function persistConfiguration(configuration) {
    const payload = `${JSON.stringify(configuration, null, 2)}\n`;
    fs.writeText(WORKSPACE_CONFIG_URI, payload);
    fs.writeText(ARTIFACT_CONFIG_URI, payload);
    task.publish("MQTT_CONFIG",
                 ARTIFACT_CONFIG_URI,
                 "VCarEA MQTT 连接配置",
                 "application/json");
    task.info(`MQTT 连接配置已保存到 ${WORKSPACE_CONFIG_URI} 并发布为产物`);
}

/** 阶段 1：启动 VCarEA 宿主，并等待其连接服务就绪。 */
export function launch() {
    const target = requireInstallation();
    const key = connectionKey();

    if (probeConnectionService(CONNECT_PROBE_TIMEOUT_MS)) {
        task.info("VCarEA 宿主连接服务已在运行，跳过启动");
        if (!probeConnectionServiceKey(key, CONNECT_QUERY_TIMEOUT_MS)) {
            throw missingConnectionServiceError(key);
        }
        task.progress(100);
        return {Started: false, ExecutablePath: target.ExecutablePath};
    }

    task.info(`启动 VCarEA：${target.ExecutablePath}`);
    let started = null;
    try {
        started = cli.start({
            executable: target.ExecutablePath,
            arguments: [],
            // VCarEA 会在进程工作目录下创建 Logs 目录，使用节点临时目录避免污染工作区。
            workingDirectoryUri: "temp://",
        });
    } catch (error) {
        throw new Error(
            `启动 VCarEA 失败：${describeError(error)}；${describeInstallation(target)}`);
    }
    processHandle = started.handle;
    processPid = started.pid;
    processStartedByPlugin = true;
    task.info(`VCarEA 进程已启动（PID ${processPid}），等待宿主连接服务就绪`);

    waitForConnectionService(key);
    task.progress(100);
    return {
        Started: true,
        Pid: processPid,
        ExecutablePath: target.ExecutablePath,
    };
}

/** 阶段 2：通过 Connector SDK 查询宿主已创建的 MQTT 连接服务配置。 */
export function readMqttConfig() {
    const key = connectionKey();
    task.info(`查询连接服务 [${key}] 的 MQTT 连接配置`);

    let client = null;
    try {
        client = connectClient(CONNECT_QUERY_TIMEOUT_MS);
    } catch (error) {
        throw new Error(
            `连接中心服务失败：${describeError(error)}；`
            + `请确认 ${requireInstallation().CentralServicePath} 已在运行`);
    }

    // 查询成功即视为连接可用；失败时只回收句柄，避免 SDK Dispose 阻塞。
    let connected = false;
    try {
        let info = null;
        try {
            info = client.call("TryGetConnectionInfo",
                               [key],
                               {timeoutMs: QUERY_TIMEOUT_MS});
            connected = true;
        } catch (error) {
            throw new Error(`查询连接服务 [${key}] 失败：${describeError(error)}`);
        }
        if (info === null || info === undefined) {
            throw missingConnectionServiceError(key);
        }
        const configuration = normalizeConnectionInfo(info, key);
        persistConfiguration(configuration);
        task.progress(100);
        return configuration;
    } finally {
        closeClient(client, connected);
    }
}

/** 清理阶段：释放 SDK 句柄，并按选项决定是否关闭插件启动的 VCarEA 进程。 */
export function cleanup() {
    if (sdkAssembly !== null) {
        try {
            sdkAssembly.close();
        } catch (error) {
            task.warning(`关闭 Connector SDK 失败：${describeError(error)}`);
        }
        sdkAssembly = null;
    }

    if (processHandle !== null) {
        const handle = processHandle;
        processHandle = null;
        if (processStartedByPlugin
                && Boolean(task.option("CloseVcareaOnCleanup", false))) {
            try {
                cli.terminate(handle, 5000);
                task.info("已终止插件启动的 VCarEA 进程");
            } catch (error) {
                task.warning(`终止 VCarEA 失败：${describeError(error)}`);
            }
        }
        try {
            // 仍在运行的进程由运行时在节点结束时回收，句柄只能在进程结束后释放。
            if (!cli.isRunning(handle)) {
                cli.release(handle);
            }
        } catch (error) {
            task.warning(`释放 VCarEA 进程句柄失败：${describeError(error)}`);
        }
    }

    task.info("VCarEA 适配器清理完成");
    task.progress(100);
}
