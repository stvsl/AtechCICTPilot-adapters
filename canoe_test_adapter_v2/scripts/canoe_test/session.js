import * as cli from "@atech/cli";
import * as com from "@atech/com";
import * as fs from "@atech/fs";
import * as task from "@atech/task";

import {
    ACTIVE_OBJECT_GRACE_TIMEOUT_MS,
    AUTOMATION_READY_TIMEOUT_MS,
    CONFIGURATION_READY_TIMEOUT_MS,
    MEASUREMENT_START_TIMEOUT_MS,
    MEASUREMENT_STOP_TIMEOUT_MS,
    TEST_ENVIRONMENT_READY_TIMEOUT_MS
} from "./constants.js";
import {
    collectionItem,
    collectionCount,
    debug,
    errorMessage,
    optionalProperty,
    propertyOr,
    release,
    waitUntil
} from "./com.js";

function createNewCanoeInstance() {
    const value = task.device("NEW_CANOE_WHEN_START");
    if (typeof value === "boolean") {
        return value;
    }
    const normalized = String(value === undefined || value === null ? "" : value)
        .trim().toLowerCase();
    if (normalized === "true") {
        return true;
    }
    if (normalized === "false") {
        return false;
    }
    throw new Error("NEW_CANOE_WHEN_START must be true or false");
}

function isTransientOpenFailure(error) {
    return /COM invocation failed/i.test(errorMessage(error));
}

function replaceAutomationHandles(context, application, measurement) {
    release(context.session.measurement);
    release(context.session.application);
    context.session.application = application;
    context.session.measurement = measurement;
}

async function closeExistingCanoe() {
    let existingApplication = null;
    try {
        existingApplication = com.getActive("CANoe.Application");
    } catch (_) {
        return;
    }
    try {
        existingApplication.call("Quit");
        task.info("Closed existing CANoe instance before starting a new one");
    } finally {
        release(existingApplication);
    }
    await waitUntil(() => {
        let activeApplication = null;
        try {
            activeApplication = com.getActive("CANoe.Application");
            return false;
        } catch (_) {
            return true;
        } finally {
            release(activeApplication);
        }
    }, AUTOMATION_READY_TIMEOUT_MS,
    "the existing CANoe Automation server to stop");
}

function checkOpenResult(context, resultOverride) {
    let result = resultOverride;
    if (result === undefined || result === null) {
        result = optionalProperty(context.session.configuration,
                                  "OpenConfigurationResult");
    }
    if (result === undefined || result === null) {
        result = optionalProperty(context.session.application,
                                  "OpenConfigurationResult");
    }
    if (result === undefined || result === null) {
        return true;
    }
    const resultCode = typeof result === "number"
        ? result : propertyOr(result, ["result", "Result"]);
    const openError = optionalProperty(result, "ErrorMessage");
    release(result);
    if (resultCode === undefined || resultCode === null || Number(resultCode) === 0) {
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

async function waitForConfiguration(context) {
    await waitUntil(() => {
        if (context.session.configuration === null) {
            const configuration = context.session.application.get("Configuration");
            if (configuration === null || configuration === undefined) {
                return false;
            }
            context.session.configuration = configuration;
        }
        return checkOpenResult(context);
    }, CONFIGURATION_READY_TIMEOUT_MS,
    "CANoe configuration to finish loading");
}

async function waitForTestEnvironmentCollection(context) {
    await waitUntil(() => {
        const setup = optionalProperty(context.session.configuration, "TestSetup");
        const environments = optionalProperty(setup, "TestEnvironments");
        if (setup !== undefined && setup !== null
                && environments !== undefined && environments !== null
                && testEnvironmentCollectionIsReady(environments)) {
            context.test.setup = setup;
            context.test.environments = environments;
            return true;
        }
        release(environments);
        release(setup);
        return false;
    }, TEST_ENVIRONMENT_READY_TIMEOUT_MS,
    "CANoe TestEnvironment collection to finish loading");
}

function testEnvironmentCollectionIsReady(environments) {
    const count = collectionCount(environments);
    if (count !== 1) {
        return count > 1;
    }

    let environment = null;
    let modules = null;
    let items = null;
    try {
        environment = collectionItem(environments, 0);
        modules = optionalProperty(environment, "TestModules");
        items = optionalProperty(environment, "Items");
        return (modules !== undefined && modules !== null)
            || (items !== undefined && items !== null);
    } finally {
        release(items);
        release(modules);
        release(environment);
    }
}

async function stopMeasurementBeforeOpening(context) {
    if (context.session.measurement === null) {
        context.session.measurement = context.session.application.get("Measurement");
    }
    if (context.session.measurement.get("Running") !== true) {
        return;
    }
    debug("openConfiguration: stopping existing measurement");
    context.session.measurement.call("Stop");
    await waitUntil(() => context.session.measurement.get("Running") !== true,
                    MEASUREMENT_STOP_TIMEOUT_MS,
                    "CANoe Measurement to stop before opening the configuration");
}

async function connectToActiveServer(context) {
    await waitUntil(() => {
        let application = null;
        let measurement = null;
        try {
            application = com.getActive("CANoe.Application");
            measurement = application.get("Measurement");
            measurement.get("Running");
            replaceAutomationHandles(context, application, measurement);
            application = null;
            measurement = null;
            return true;
        } catch (_) {
            release(measurement);
            release(application);
            return false;
        }
    }, AUTOMATION_READY_TIMEOUT_MS,
    "CANoe Automation server to become available");
}

async function connectToLaunchedServer(context) {
    const started = Date.now();
    debug("connect: checking whether the started CANoe instance is active");
    while (Date.now() - started < ACTIVE_OBJECT_GRACE_TIMEOUT_MS) {
        task.checkCancelled();
        let application = null;
        let measurement = null;
        try {
            application = com.getActive("CANoe.Application");
            measurement = application.get("Measurement");
            measurement.get("Running");
            replaceAutomationHandles(context, application, measurement);
            application = null;
            measurement = null;
            return;
        } catch (_) {
            release(measurement);
            release(application);
            await task.delay(250);
        }
    }

    // 部分 CANoe 版本不会把 -embedding 实例及时注册到 ROT，只能通过 ProgID 激活.
    debug("connect: calling com.create(CANoe.Application)");
    const application = com.create("CANoe.Application");
    const measurement = application.get("Measurement");
    replaceAutomationHandles(context, application, measurement);
}

export async function launchCanoeSession(context) {
    const createNew = createNewCanoeInstance();
    context.session.attached = !createNew;
    if (!createNew) {
        task.info("Attaching to an existing CANoe process");
        return;
    }

    await closeExistingCanoe();
    const executable = task.device("CANOE_SOFTWARE_POSITION");
    context.session.process = cli.start({
        executable,
        arguments: ["-embedding"]
    });
    context.session.ownsProcess = true;
    debug(`launch: process started (pid=${context.session.process.pid})`);
}

export async function connectAutomationServer(context) {
    if (context.session.attached) {
        await connectToActiveServer(context);
    } else {
        await connectToLaunchedServer(context);
    }
}

export async function openProjectConfiguration(context) {
    if (context.session.application === null) {
        throw new Error("CANoe Automation is not connected");
    }
    if (context.session.configuration === null) {
        await stopMeasurementBeforeOpening(context);
        try {
            const result = context.session.application.call(
                "Open", fs.nativePath(context.project.configurationUri), true, false);
            checkOpenResult(context, result);
        } catch (error) {
            if (isTransientOpenFailure(error)) {
                throw new Error("CANoe Application became unavailable after "
                    + `initialization: ${errorMessage(error)}`);
            }
            throw error;
        }
    }
    await waitForConfiguration(context);
    await waitForTestEnvironmentCollection(context);
}

export async function ensureMeasurementStarted(context) {
    if (context.session.measurement === null) {
        context.session.measurement = context.session.application.get("Measurement");
    }
    if (context.session.measurement.get("Running") !== true) {
        debug("execute: calling Measurement.Start");
        context.session.measurement.call("Start");
    }
    await waitUntil(() => context.session.measurement.get("Running") === true,
                    MEASUREMENT_START_TIMEOUT_MS,
                    "CANoe Measurement to start");
    context.session.measurementRunning = true;
}

export async function closeCanoeSession(context) {
    try {
        if (context.session.measurement !== null && context.session.measurementRunning
                && context.session.measurement.get("Running") === true) {
            context.session.measurement.call("Stop");
        }
    } catch (error) {
        task.warning(`Unable to stop CANoe Measurement: ${errorMessage(error)}`);
    }
    try {
        if (context.session.application !== null && context.session.ownsProcess) {
            context.session.application.call("Quit");
        }
    } catch (error) {
        task.warning(`Unable to quit CANoe: ${errorMessage(error)}`);
    }
    if (context.session.process !== null) {
        try {
            if (cli.isRunning(context.session.process)) {
                cli.terminate(context.session.process, 3000);
            }
        } catch (error) {
            task.warning(`Unable to terminate CANoe process: ${errorMessage(error)}`);
        }
        try {
            cli.release(context.session.process);
        } catch (_) {
            // 进程句柄可能已由 CANoe 正常退出回收.
        }
    }
}

export function releaseSessionHandles(context) {
    release(context.session.configuration);
    release(context.session.measurement);
    release(context.session.application);
    context.session.configuration = null;
    context.session.measurement = null;
    context.session.application = null;
    context.session.process = null;
}
