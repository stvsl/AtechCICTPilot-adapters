import * as com from "@atech/com";
import * as cli from "@atech/cli";
import * as fs from "@atech/fs";
import * as task from "@atech/task";

import {Poller, errorMessage} from "./poller.js";

const CANOE_PROG_ID = "CANoe.Application";
const CANOE_EXECUTABLE_ID = "CANOE_EXECUTABLE";
const SUPPORTED_CANOE_VERSIONS = ["17", "18", "19", "20"];
const DEFAULT_TIMEOUT_MS = 120000;
const CANOE_CLASS_FACTORY_GRACE_MS = 5000;
const CANOE_NOT_READY_CODE = "CANOE_NOT_READY";
const CANOE_INSTANCE_MISMATCH_CODE = "CANOE_INSTANCE_MISMATCH";
const CANOE_VERSION_MISMATCH_CODE = "CANOE_VERSION_MISMATCH";

function normalizeCanoeVersion(value) {
    const version = String(value === undefined || value === null ? "" : value).trim();
    if (!SUPPORTED_CANOE_VERSIONS.includes(version)) {
        throw new Error(
            `Unsupported CANoe version "${version}"; expected one of `
            + SUPPORTED_CANOE_VERSIONS.join(", "));
    }
    return version;
}

function release(object) {
    if (object === null || object === undefined) {
        return;
    }
    try {
        object.release();
    } catch (_) {
        // 宿主会在阶段结束时回收仍未释放的 COM 句柄。
    }
}

function optionalProperty(object, name) {
    if (object === null || object === undefined) {
        return undefined;
    }
    try {
        return object.get(name);
    } catch (error) {
        if (isAutomationDisconnectFailure(error)) {
            error.canoeFatal = true;
            throw error;
        }
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

function contextualError(context, error) {
    const wrapped = new Error(`${context}: ${errorMessage(error)}`);
    if (error && typeof error.code === "string") {
        wrapped.code = error.code;
    }
    if (error && error.details && typeof error.details === "object") {
        wrapped.details = error.details;
    }
    return wrapped;
}

function processOutput(result) {
    return [result && result.standardError, result && result.standardOutput]
        .map((value) => String(value === undefined || value === null ? "" : value).trim())
        .filter((value) => value !== "")
        .join("; ");
}

function hresult(error) {
    const detail = error && error.details && error.details.hresult;
    if (detail !== undefined && detail !== null && String(detail).trim() !== "") {
        return String(detail).trim().toLowerCase();
    }
    const match = errorMessage(error).match(/0x[0-9a-f]{8}/i);
    return match ? match[0].toLowerCase() : "";
}

function isAutomationDisconnectFailure(error) {
    const code = hresult(error);
    return code === "0x800706ba" || code === "0x800706be"
        || code === "0x80010108"
        || /rpc server is unavailable|rpc 服务器不可用|远程过程调用失败|object invoked has disconnected|对象已与其客户端断开连接/i
            .test(errorMessage(error));
}

function isTransientComFailure(error) {
    const message = errorMessage(error);
    return !isAutomationDisconnectFailure(error)
        && ((error && error.code === CANOE_NOT_READY_CODE)
            || /0x80010001|0x8001010a|0x8001010d|call was rejected|调用被拒绝|server busy|服务器忙/i
                .test(message));
}

function isTransientActivationFailure(error) {
    return (error && error.code === CANOE_INSTANCE_MISMATCH_CODE)
        || isTransientComFailure(error) || isAutomationDisconnectFailure(error)
        || /0x80080005|server execution failed|服务器运行失败/i
            .test(errorMessage(error));
}

function isTransientOpenFailure(error) {
    return /COM invocation failed/i.test(errorMessage(error));
}

function normalizeNativePath(value) {
    let path = String(value === undefined || value === null ? "" : value).trim();
    if (path.length >= 2
            && ((path.startsWith('"') && path.endsWith('"'))
                || (path.startsWith("'") && path.endsWith("'")))) {
        path = path.substring(1, path.length - 1).trim();
    }
    path = path.replace(/\\/g, "/");
    if (path.toLowerCase().startsWith("//?/")) {
        path = path.substring(4);
    }
    return path.replace(/\/+$/, "").toLowerCase();
}

function parentNativePath(path) {
    const normalized = normalizeNativePath(path);
    const separator = normalized.lastIndexOf("/");
    return separator < 0 ? "" : normalized.substring(0, separator);
}

function versionText(version) {
    if (version === null || version === undefined) {
        return "";
    }
    if (typeof version !== "object") {
        return String(version).trim();
    }
    const parts = [];
    for (const name of ["Major", "Minor", "Build", "Patch"]) {
        const value = optionalProperty(version, name);
        if (value !== undefined && value !== null && String(value).trim() !== "") {
            parts.push(String(value).trim());
        }
    }
    return parts.join(".");
}

export class CanoeSession {
    constructor({version, intervalMs = 250, debug = null} = {}) {
        this.version = normalizeCanoeVersion(version);
        this.waiter = new Poller({intervalMs, debug});
        this.debug = typeof debug === "function" ? debug : () => {};
        this.application = null;
        this.measurement = null;
        this.configuration = null;
        this.process = null;
        this.ownsProcess = false;
        this.attached = false;
        this.measurementRunning = false;
        this.executable = "";
        this.launchedAt = 0;
    }

    installedExecutable() {
        return cli.resolveExecutable(CANOE_EXECUTABLE_ID);
    }

    async clearExisting(timeoutMs = DEFAULT_TIMEOUT_MS) {
        let existingApplication = null;
        try {
            existingApplication = com.getActive(CANOE_PROG_ID);
        } catch (_) {
            return;
        }
        try {
            existingApplication.call("Quit");
            task.info("Closed existing CANoe instance before starting a new one");
        } catch (error) {
            throw contextualError("Unable to close existing CANoe instance", error);
        } finally {
            release(existingApplication);
        }
        await this.waiter.until(() => {
            let activeApplication = null;
            try {
                activeApplication = com.getActive(CANOE_PROG_ID);
                return false;
            } catch (_) {
                return true;
            } finally {
                release(activeApplication);
            }
        }, {
            timeoutMs,
            description: "the existing CANoe Automation server to stop",
            isReady: (value) => value === true
        });
    }

    async launch({attachExisting = false, clearExisting = false, executable = "",
        clearTimeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
        this.attached = Boolean(attachExisting);
        if (this.attached) {
            this.ownsProcess = false;
            return;
        }
        if ((this.application !== null && this.application !== undefined)
                || this.process !== null) {
            return;
        }
        const executablePath = executable === undefined || executable === null
            ? "" : String(executable).trim();
        if (executablePath === "") {
            throw new Error("CANoe executable is required when starting a new instance");
        }
        if (clearExisting) {
            await this.clearExisting(clearTimeoutMs);
        }

        try {
            this.debug(`launch: starting configured CANoe executable: ${executablePath}`);
            this.process = cli.start({
                executable: executablePath,
                arguments: ["-embedding"]
            });
            this.executable = executablePath;
            this.launchedAt = Date.now();
            this.ownsProcess = true;
        } catch (error) {
            throw contextualError("Unable to start configured CANoe executable", error);
        }
    }

    processExitError() {
        let result;
        try {
            result = cli.wait(this.process, 0);
        } catch (error) {
            const wrapped = contextualError(
                "Unable to inspect the configured CANoe process after it stopped", error);
            wrapped.canoeFatal = true;
            return wrapped;
        }
        const state = result.crashed ? "crashed" : "exited";
        const output = processOutput(result);
        const suffix = output === "" ? "" : `: ${output}`;
        const error = new Error(
            `Configured CANoe process ${state} unexpectedly with code ${result.exitCode} `
            + `(pid=${this.process.pid}, executable=${this.executable})${suffix}`);
        error.canoeFatal = true;
        return error;
    }

    ensureLaunchedProcessRunning() {
        if (this.process === null) {
            const error = new Error(
                "CANoe process was not started during the launch stage");
            error.canoeFatal = true;
            throw error;
        }
        if (!cli.isRunning(this.process)) {
            throw this.processExitError();
        }
    }

    ensureOwnedProcessRunning() {
        if (!this.attached && this.ownsProcess) {
            this.ensureLaunchedProcessRunning();
        }
    }

    validateApplication(application) {
        let version = null;
        let applicationVersion;
        try {
            version = application.get("Version");
            applicationVersion = versionText(version);
        } catch (error) {
            throw contextualError(
                "Unable to identify the CANoe Automation version", error);
        } finally {
            release(version);
        }

        let fullName = "";
        let applicationPath = "";
        if (this.executable !== "") {
            try {
                fullName = application.get("FullName");
                applicationPath = application.get("Path");
            } catch (error) {
                throw contextualError(
                    "Unable to identify the started CANoe Automation executable", error);
            }

            const expected = normalizeNativePath(this.executable);
            const actualFullName = normalizeNativePath(fullName);
            const actualPath = normalizeNativePath(applicationPath);
            const matches = actualFullName !== ""
                ? actualFullName === expected
                : actualPath === expected || actualPath === parentNativePath(expected);
            const actual = String(fullName || applicationPath || "").trim();
            if (!matches) {
                const versionDetail = applicationVersion
                    ? `, version=${applicationVersion}` : "";
                const error = new Error(
                    `CANoe Automation instance mismatch: configured executable="${this.executable}", `
                    + `connected executable="${actual || "unknown"}"${versionDetail}`);
                error.code = CANOE_INSTANCE_MISMATCH_CODE;
                error.canoeFatal = true;
                throw error;
            }
        }

        const actualMajorVersion = applicationVersion.split(".")[0];
        if (actualMajorVersion !== this.version) {
            const error = new Error(
                `CANoe Automation version mismatch: configured version="${this.version}", `
                + `connected version="${applicationVersion || "unknown"}"`);
            error.code = CANOE_VERSION_MISMATCH_CODE;
            error.canoeFatal = true;
            throw error;
        }

        if (this.executable === "") {
            this.debug(`connect: verified CANoe Automation version=${applicationVersion}`);
            return {fullName: "", path: "", version: applicationVersion};
        }

        const actual = String(fullName || applicationPath || "").trim();
        this.debug(`connect: verified CANoe Automation executable=${actual}`
            + (applicationVersion ? `, version=${applicationVersion}` : ""));
        return {
            fullName: String(fullName || ""),
            path: String(applicationPath || ""),
            version: applicationVersion
        };
    }

    tryAdoptStartedApplication() {
        let candidate = null;
        try {
            this.ensureLaunchedProcessRunning();
            candidate = com.getActive(CANOE_PROG_ID);
            this.ensureLaunchedProcessRunning();
            this.adopt(candidate, null);
            candidate = null;
            return true;
        } catch (error) {
            release(candidate);
            this.ensureLaunchedProcessRunning();
            if (error && error.code === CANOE_VERSION_MISMATCH_CODE) {
                throw error;
            }
            if (error && error.code === CANOE_INSTANCE_MISMATCH_CODE) {
                this.debug(`connect: rejected active CANoe instance: ${errorMessage(error)}`);
            }
            return false;
        }
    }

    async waitForClassFactory(timeoutMs) {
        // 优先从 ROT 取得显式启动的实例；部分 CANoe 版本不会及时注册，
        // 此时等待类工厂稳定后再回退到 ProgID 激活。
        await this.waiter.until(() => {
            this.ensureLaunchedProcessRunning();
            if (this.tryAdoptStartedApplication()) {
                return true;
            }
            return Date.now() - this.launchedAt >= CANOE_CLASS_FACTORY_GRACE_MS;
        }, {
            timeoutMs,
            description: "configured CANoe process to initialize its Automation server",
            isReady: (ready) => ready === true
        });
    }

    async activateStartedApplication(timeoutMs) {
        await this.waiter.until(() => {
            this.ensureLaunchedProcessRunning();
            let candidate = null;
            try {
                candidate = com.create(CANOE_PROG_ID);
                this.ensureLaunchedProcessRunning();
                this.adopt(candidate, null);
                candidate = null;
                return true;
            } catch (error) {
                release(candidate);
                this.ensureLaunchedProcessRunning();
                if (error && error.code === CANOE_INSTANCE_MISMATCH_CODE) {
                    error.canoeFatal = false;
                }
                throw error;
            }
        }, {
            timeoutMs,
            description: "configured CANoe Automation server to accept COM activation",
            isReady: (value) => value === true,
            retryOnError: (error) => isTransientActivationFailure(error)
        });
    }

    async waitForMeasurement(timeoutMs = DEFAULT_TIMEOUT_MS) {
        await this.waiter.until(() => {
            try {
                this.ensureOwnedProcessRunning();
                this.refreshMeasurement();
                return true;
            } catch (error) {
                if (!isTransientComFailure(error)) {
                    error.canoeFatal = true;
                    throw error;
                }
                return false;
            }
        }, {
            timeoutMs,
            description: "CANoe Measurement Automation object to become available",
            isReady: (value) => value === true
        });
    }

    async connect({attached = false, timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
        this.attached = Boolean(attached);
        if (this.application !== null && this.application !== undefined) {
            if (!this.attached) {
                await this.waitForMeasurement(timeoutMs);
            }
            return;
        }
        if (this.attached) {
            await this.waiter.until(() => this.tryConnect(), {
                timeoutMs,
                description: "CANoe Automation server to become available",
                isReady: (value) => value === true
            });
            return;
        }
        const started = Date.now();
        const remaining = () => Math.max(0, timeoutMs - (Date.now() - started));
        await this.waitForClassFactory(remaining());
        if (this.application === null || this.application === undefined) {
            await this.activateStartedApplication(remaining());
        }
        await this.waitForMeasurement(remaining());
    }

    tryConnect() {
        if (!this.attached) {
            return false;
        }
        let candidate = null;
        try {
            candidate = com.getActive(CANOE_PROG_ID);
            this.adopt(candidate, null);
            candidate = null;
            this.refreshMeasurement();
            return true;
        } catch (error) {
            release(candidate);
            if (error && error.code === CANOE_VERSION_MISMATCH_CODE) {
                throw error;
            }
            return false;
        }
    }

    adopt(application, measurement) {
        this.validateApplication(application);
        if (this.measurement !== measurement) {
            release(this.measurement);
        }
        if (this.application !== application) {
            release(this.application);
        }
        this.application = application;
        this.measurement = measurement;
    }

    refreshMeasurement() {
        if (this.application === null || this.application === undefined) {
            throw new Error("CANoe Automation is not connected");
        }
        let candidate = null;
        try {
            candidate = this.application.get("Measurement");
            if (candidate === null || candidate === undefined) {
                const error = new Error("CANoe Measurement is not available yet");
                error.code = CANOE_NOT_READY_CODE;
                throw error;
            }
            candidate.get("Running");
            if (this.measurement !== candidate) {
                release(this.measurement);
            }
            this.measurement = candidate;
            candidate = null;
        } finally {
            release(candidate);
        }
    }

    recoverMeasurement(error) {
        if (!isTransientComFailure(error)) {
            return false;
        }
        this.ensureOwnedProcessRunning();
        if (this.attached) {
            this.tryConnect();
        } else {
            try {
                this.refreshMeasurement();
            } catch (_) {
                // 保留当前 Automation 对象，下一轮继续读取其状态。
            }
        }
        return true;
    }

    recoverConfiguration(error) {
        if (!isTransientComFailure(error)) {
            return false;
        }
        this.ensureOwnedProcessRunning();
        if (this.attached && this.tryConnect()) {
            release(this.configuration);
            this.configuration = null;
        } else if (!this.attached) {
            release(this.configuration);
            this.configuration = null;
        }
        return true;
    }

    async readMeasurementRunning(timeoutMs = DEFAULT_TIMEOUT_MS,
        description = "CANoe Measurement Automation object to become available") {
        return this.waiter.until(() => {
            this.ensureOwnedProcessRunning();
            if (this.measurement === null || this.measurement === undefined) {
                this.refreshMeasurement();
            }
            return this.measurement.get("Running") === true;
        }, {
            timeoutMs,
            description,
            isReady: (value) => typeof value === "boolean",
            retryOnError: (error) => this.recoverMeasurement(error)
        });
    }

    async callMeasurementCommand(command, expectedRunning,
        timeoutMs = DEFAULT_TIMEOUT_MS) {
        this.ensureOwnedProcessRunning();
        if (this.measurement === null || this.measurement === undefined) {
            this.refreshMeasurement();
        }
        try {
            this.measurement.call(command);
            return;
        } catch (error) {
            if (!isTransientComFailure(error)) {
                throw error;
            }
            // 调用返回失败时先读取真实状态，避免重复触发已经生效的命令。
            const running = await this.readMeasurementRunning(
                timeoutMs, "CANoe Measurement Automation object to recover");
            if (running === expectedRunning) {
                return;
            }
            this.ensureOwnedProcessRunning();
            this.measurement.call(command);
        }
    }

    async waitForMeasurementState(expected, timeoutMs, description) {
        await this.waiter.until(() => {
            this.ensureOwnedProcessRunning();
            if (this.measurement === null || this.measurement === undefined) {
                this.refreshMeasurement();
            }
            return this.measurement.get("Running") === expected;
        }, {
            timeoutMs,
            description,
            isReady: (value) => value === true,
            retryOnError: (error) => this.recoverMeasurement(error)
        });
    }

    async stopMeasurementBeforeOpening(timeoutMs = DEFAULT_TIMEOUT_MS) {
        const running = await this.readMeasurementRunning(
            timeoutMs, "CANoe Measurement Automation object to become available");
        if (!running) {
            this.measurementRunning = false;
            return;
        }
        this.debug("openConfiguration: stopping existing measurement");
        await this.callMeasurementCommand("Stop", false, timeoutMs);
        await this.waitForMeasurementState(
            false, timeoutMs,
            "CANoe Measurement to stop before opening the configuration");
        this.measurementRunning = false;
    }

    checkOpenResult(resultOverride) {
        let openResult = resultOverride;
        if (openResult === undefined || openResult === null) {
            openResult = optionalProperty(this.configuration,
                                          "OpenConfigurationResult");
        }
        if (openResult === undefined || openResult === null) {
            openResult = optionalProperty(this.application,
                                          "OpenConfigurationResult");
        }
        if (openResult === undefined || openResult === null) {
            return true;
        }

        const resultCode = typeof openResult === "number"
            ? openResult : propertyOr(openResult, ["result", "Result"]);
        const openError = optionalProperty(openResult, "ErrorMessage");
        release(openResult);
        if (resultCode === undefined || resultCode === null
                || Number(resultCode) === 0) {
            return true;
        }
        if (Number(resultCode) === 2) {
            task.warning(`CANoe opened the configuration with a warning${
                openError ? `: ${openError}` : ""}`);
            return true;
        }
        const detail = openError ? `: ${openError}` : ` with result ${resultCode}`;
        const error = new Error(`CANoe configuration open failed${detail}`);
        error.canoeFatal = true;
        throw error;
    }

    async waitForConfiguration(timeoutMs = DEFAULT_TIMEOUT_MS) {
        await this.waiter.until(() => {
            this.ensureOwnedProcessRunning();
            if (this.configuration === null || this.configuration === undefined) {
                const opened = this.application.get("Configuration");
                if (opened === null || opened === undefined) {
                    return false;
                }
                this.configuration = opened;
            }
            return this.checkOpenResult();
        }, {
            timeoutMs,
            description: "CANoe configuration to finish loading",
            isReady: (value) => value === true,
            retryOnError: (error) => this.recoverConfiguration(error)
        });
    }

    async openConfiguration(configurationUri, {
        setupReady = null,
        setupDescription = "CANoe project test setup to finish loading",
        configurationTimeoutMs = DEFAULT_TIMEOUT_MS,
        setupTimeoutMs = DEFAULT_TIMEOUT_MS,
        measurementStopTimeoutMs = DEFAULT_TIMEOUT_MS
    } = {}) {
        if (this.application === null || this.application === undefined) {
            throw new Error("CANoe Automation is not connected");
        }
        this.ensureOwnedProcessRunning();
        if (this.configuration === null || this.configuration === undefined) {
            await this.stopMeasurementBeforeOpening(measurementStopTimeoutMs);
            release(this.measurement);
            this.measurement = null;
            try {
                this.debug(`openConfiguration: calling Application.Open (${configurationUri})`);
                const result = this.application.call(
                    "Open", fs.nativePath(configurationUri), true, false);
                this.checkOpenResult(result);
            } catch (error) {
                if (isTransientOpenFailure(error)) {
                    const disconnected = contextualError(
                        "CANoe Application became unavailable after initialization",
                        error);
                    disconnected.canoeFatal = true;
                    throw disconnected;
                }
                throw error;
            }
        }
        await this.waitForConfiguration(configurationTimeoutMs);
        if (typeof setupReady === "function") {
            await this.waiter.until(() => {
                this.ensureOwnedProcessRunning();
                return setupReady();
            }, {
                timeoutMs: setupTimeoutMs,
                description: setupDescription,
                isReady: (value) => value === true,
                retryOnError: (error) => this.recoverConfiguration(error)
            });
        }
        return this.configuration;
    }

    async ensureMeasurementStarted({readyTimeoutMs = DEFAULT_TIMEOUT_MS,
        startTimeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
        const running = await this.readMeasurementRunning(
            readyTimeoutMs,
            "CANoe Measurement Automation object to become available");
        if (!running) {
            await this.callMeasurementCommand("Start", true, readyTimeoutMs);
        }
        await this.waitForMeasurementState(
            true, startTimeoutMs, "CANoe Measurement to start");
        this.measurementRunning = true;
        return running;
    }

    async close({quit = false} = {}) {
        try {
            try {
                if (this.measurement !== null && this.measurementRunning
                        && this.measurement.get("Running") === true) {
                    this.measurement.call("Stop");
                }
            } catch (error) {
                task.warning(`Unable to stop CANoe Measurement: ${errorMessage(error)}`);
            }
            try {
                if (this.application !== null && quit) {
                    this.application.call("Quit");
                }
            } catch (error) {
                task.warning(`Unable to quit CANoe: ${errorMessage(error)}`);
            }
            this.releaseProcess();
        } finally {
            this.releaseHandles();
            this.process = null;
            this.ownsProcess = false;
            this.attached = false;
            this.measurementRunning = false;
            this.executable = "";
            this.launchedAt = 0;
        }
    }

    releaseProcess() {
        if (this.process === null) {
            return;
        }
        try {
            if (cli.isRunning(this.process)) {
                cli.terminate(this.process, 3000);
            }
        } catch (error) {
            task.warning(`Unable to terminate CANoe process: ${errorMessage(error)}`);
        }
        try {
            cli.release(this.process);
        } catch (error) {
            task.warning(`Unable to release CANoe process: ${errorMessage(error)}`);
        }
        this.process = null;
    }

    releaseHandles() {
        release(this.configuration);
        release(this.measurement);
        release(this.application);
        this.configuration = null;
        this.measurement = null;
        this.application = null;
    }
}

export {
    errorMessage,
    isAutomationDisconnectFailure,
    isTransientComFailure,
    optionalProperty,
    release
};
