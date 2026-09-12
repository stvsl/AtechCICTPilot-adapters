import * as task from "@atech/task";

// 将宿主异常统一转换为可读文本，避免轮询层依赖 COM 实现细节。
export function errorMessage(error) {
    const message = error && error.message ? String(error.message) : String(error);
    const hresult = error && error.details && error.details.hresult
        ? String(error.details.hresult) : "";
    return hresult !== "" && !message.toLowerCase().includes(hresult.toLowerCase())
        ? `${message} (${hresult})` : message;
}

// 轮询超时使用独立错误码，调用方可以在需要降级时精确区分超时和业务错误。
export class WaitTimeoutError extends Error {
    constructor(description, timeoutMs, lastError = "") {
        const detail = lastError ? `; last error: ${lastError}` : "";
        super(`Timed out waiting for ${description} after ${timeoutMs} ms${detail}`);
        this.name = "WaitTimeoutError";
        this.code = "WAIT_TIMEOUT";
    }
}

function duration(value, fallback, allowZero = false) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    const minimum = allowZero ? 0 : 1;
    return Math.max(minimum, Math.floor(number));
}

async function runCancellationCleanup(onCancel, state, error) {
    if (state.handled || typeof onCancel !== "function") {
        return;
    }
    state.handled = true;
    try {
        await onCancel(error);
    } catch (cleanupError) {
        task.warning(`Cancellation cleanup failed: ${errorMessage(cleanupError)}`);
    }
}

/*
 * CANoe Automation 没有可移植的事件订阅接口，状态只能通过同步 COM 属性观察。
 * Poller 将取消、超时、退避和错误策略集中到一个入口，业务代码只需提供读取函数。
 */
export class Poller {
    constructor({intervalMs = 250, debug = null} = {}) {
        this.intervalMs = duration(intervalMs, 250);
        this.debug = typeof debug === "function" ? debug : () => {};
    }

    async until(read, {
        description = "condition",
        timeoutMs = 0,
        intervalMs = this.intervalMs,
        isReady = (value) => Boolean(value),
        retryOnError = null,
        onPoll = null,
        onCancel = null,
        ignoreCancellation = false
    } = {}) {
        if (typeof read !== "function") {
            throw new TypeError("Poller.until requires a read function");
        }
        const timeout = duration(timeoutMs, 0, true);
        const interval = duration(intervalMs, this.intervalMs);
        const started = Date.now();
        let lastError = "";
        const cancellationState = {handled: false};
        this.debug(`waiting for ${description}`);

        while (true) {
            if (!ignoreCancellation) {
                if (task.isCancelled()) {
                    await runCancellationCleanup(onCancel, cancellationState);
                }
                try {
                    task.checkCancelled();
                } catch (error) {
                    if (task.isCancelled()) {
                        await runCancellationCleanup(onCancel, cancellationState, error);
                    }
                    throw error;
                }
            }

            let value;
            let readSucceeded = false;
            try {
                value = await read();
                readSucceeded = true;
            } catch (error) {
                if (!ignoreCancellation && task.isCancelled()) {
                    await runCancellationCleanup(onCancel, cancellationState, error);
                }
                if (error && error.canoeFatal === true) {
                    throw error;
                }
                lastError = errorMessage(error);
                if (typeof retryOnError !== "function"
                        || !(await retryOnError(error))) {
                    throw error;
                }
            }

            if (readSucceeded && await isReady(value)) {
                this.debug(`${description} is ready after ${Date.now() - started} ms`);
                return value;
            }
            if (typeof onPoll === "function") {
                await onPoll(value, Date.now() - started);
            }

            const elapsed = Date.now() - started;
            if (elapsed >= timeout) {
                throw new WaitTimeoutError(description, timeout, lastError);
            }
            try {
                await task.delay(Math.min(interval, timeout - elapsed),
                                 ignoreCancellation);
            } catch (error) {
                if (!ignoreCancellation && task.isCancelled()) {
                    await runCancellationCleanup(onCancel, cancellationState, error);
                }
                throw error;
            }
        }
    }

    // 连接启动阶段允许在短暂窗口内失败，并由调用方选择备用连接方式。
    async tryUntil(read, options = {}) {
        try {
            return await this.until(read, options);
        } catch (error) {
            if (error && error.code === "WAIT_TIMEOUT") {
                return undefined;
            }
            throw error;
        }
    }

    // 固定延迟也经过同一取消策略，入口脚本无需直接接触 task.delay。
    async delay(milliseconds, {ignoreCancellation = false, onCancel = null} = {}) {
        const cancellationState = {handled: false};
        const durationMs = duration(milliseconds, 0, true);
        if (!ignoreCancellation) {
            if (task.isCancelled()) {
                await runCancellationCleanup(onCancel, cancellationState);
            }
            try {
                task.checkCancelled();
            } catch (error) {
                if (task.isCancelled()) {
                    await runCancellationCleanup(onCancel, cancellationState, error);
                }
                throw error;
            }
        }
        try {
            await task.delay(durationMs, ignoreCancellation);
        } catch (error) {
            if (!ignoreCancellation && task.isCancelled()) {
                await runCancellationCleanup(onCancel, cancellationState, error);
            }
            throw error;
        }
    }
}
