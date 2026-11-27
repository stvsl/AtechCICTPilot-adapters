import * as websocket from "@atech/websocket";
import * as task from "@atech/task";

const SDK_URL = "ws://localhost:8777";

export class RpcConnection {
    constructor({websocketApi = websocket, taskApi = task} = {}) {
        this.api = websocketApi;
        this.task = taskApi;
        this.handle = null;
    }

    open(timeoutMs = 1000) {
        this.close();
        this.handle = this.api.connect({url: SDK_URL, timeoutMs}).handle;
    }

    close() {
        const handle = this.handle;
        this.handle = null;
        if (handle !== null) {
            try {
                this.api.close(handle);
            } catch (_) {
                // 超时或取消后仍须先隔离旧连接，不能复用迟到响应。
            }
        }
    }

    call(method, parameters = [], timeoutMs = 30000, ignoreWarnings = false) {
        if (this.handle === null) {
            throw new Error(`SDK 连接已废弃，不能调用 ${method}`);
        }
        const request = {MethodName: method, Parameters: parameters};
        if (ignoreWarnings) {
            request.Options = {IgnoreWarningDialogs: true};
        }
        let response;
        try {
            const deadline = Date.now() + timeoutMs;
            this.api.sendText(this.handle, JSON.stringify(request), timeoutMs);
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error(`${method} RPC 超时`);
            }
            const message = this.api.receive(this.handle, remaining);
            if (!message) {
                throw new Error(`${method} RPC 超时`);
            }
            if (message.type !== "text") {
                throw new Error(`${method} 收到非文本响应`);
            }
            response = JSON.parse(message.text);
            if (!response || typeof response !== "object" || Array.isArray(response)
                    || typeof response.Success !== "boolean"
                    || (response.Success && !("Result" in response))) {
                throw new Error(`${method} 响应结构损坏`);
            }
            if (ignoreWarnings || response.Warnings !== undefined) {
                if (!Array.isArray(response.Warnings)
                        || response.Warnings.some((warning) => !warning
                            || typeof warning.Message !== "string"
                            || warning.Severity !== "Warning")) {
                    throw new Error(`${method} 警告字段损坏`);
                }
            }
        } catch (error) {
            this.close();
            throw error;
        }
        for (const warning of response.Warnings || []) {
            this.task.warning(`${method}: ${warning.Message}`);
        }
        if (!response.Success) {
            throw new Error(`${method}: ${response.Error || "SDK 拒绝请求"}`);
        }
        return response.Result;
    }
}
