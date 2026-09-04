import * as com from "@atech/com";
import * as fs from "@atech/fs";
import * as task from "@atech/task";

import {Poller, errorMessage} from "./poller.js";

const CANOE_PROG_ID = "CANoe.Application";
const DEFAULT_TIMEOUT_MS = 120000;
const CANOE_NOT_READY_CODE = "CANOE_NOT_READY";

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

function isTransientComFailure(error) {
    const message = errorMessage(error);
    return (error && error.code === CANOE_NOT_READY_CODE)
        || /0x80010001|0x8001010a|0x8001010d|0x800706ba|rpc|server unavailable|服务器不可用|call was rejected|调用被拒绝|server busy|服务器忙/i
            .test(message);
}

function isTransientOpenFailure(error) {
    return /COM invocation failed/i.test(errorMessage(error));
}

export class CanoeSession {
    constructor({intervalMs = 250, debug = null} = {}) {
        this.waiter = new Poller({intervalMs, debug});
        this.debug = typeof debug === "function" ? debug : () => {};
        this.application = null;
        this.measurement = null;
        this.configuration = null;
        this.process = null;
        this.ownsProcess = false;
        this.attached = false;
        this.measurementRunning = false;
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
            throw new Error(`Unable to close existing CANoe instance: ${errorMessage(error)}`);
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

    async launch({attachExisting = false, clearExisting = false,
        clearTimeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
        this.attached = Boolean(attachExisting);
        if (this.attached) {
            this.ownsProcess = false;
            return;
        }
        if (this.application !== null && this.application !== undefined) {
            return;
        }
        if (clearExisting) {
            await this.clearExisting(clearTimeoutMs);
        }

        // COM 激活直接返回任务拥有的 Automation 对象，避免 CLI 进程与
        // COM 激活之间的竞态导致第二个 CANoe 实例。
        let createdApplication = null;
        try {
            this.debug("launch: creating CANoe Automation instance");
            createdApplication = com.create(CANOE_PROG_ID);
            this.adopt(createdApplication, null);
            createdApplication = null;
            this.ownsProcess = true;
        } catch (error) {
            release(createdApplication);
            throw new Error(`Unable to launch CANoe Automation: ${errorMessage(error)}`);
        }
    }

    async waitForMeasurement(timeoutMs = DEFAULT_TIMEOUT_MS) {
        await this.waiter.until(() => {
            try {
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
        if (!this.attached) {
            throw new Error(
                "CANoe Automation was not created during the launch stage");
        }
        await this.waiter.until(() => this.tryConnect(), {
            timeoutMs,
            description: "CANoe Automation server to become available",
            isReady: (value) => value === true
        });
    }

    tryConnect() {
        if (!this.attached) {
            return false;
        }
        let candidate = null;
        let candidateMeasurement = null;
        try {
            candidate = com.getActive(CANOE_PROG_ID);
            candidateMeasurement = candidate.get("Measurement");
            candidateMeasurement.get("Running");
            this.adopt(candidate, candidateMeasurement);
            candidate = null;
            candidateMeasurement = null;
            return true;
        } catch (_) {
            release(candidateMeasurement);
            release(candidate);
            return false;
        }
    }

    adopt(application, measurement) {
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
            this.measurement.call(command);
        }
    }

    async waitForMeasurementState(expected, timeoutMs, description) {
        await this.waiter.until(() => {
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
                    throw new Error("CANoe Application became unavailable after "
                        + `initialization: ${errorMessage(error)}`);
                }
                throw error;
            }
        }
        await this.waitForConfiguration(configurationTimeoutMs);
        if (typeof setupReady === "function") {
            await this.waiter.until(setupReady, {
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
        }
    }

    releaseProcess() {
        // COM 激活没有独立的 CLI 进程句柄，实例由 Application.Quit 管理。
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

export {errorMessage, isTransientComFailure, optionalProperty, release};
