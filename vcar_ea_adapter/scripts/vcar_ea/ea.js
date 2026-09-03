import * as fs from "@atech/fs";
import * as task from "@atech/task";

import {
    APPLICATION_NAME,
    TOPICS
} from "./constants.js";
import { bytesLength } from "./codec.js";
import {
    connectAndSubscribe,
    disconnect,
    executionTimeout,
    publishJson,
    request,
    responseTimeout
} from "./mqtt.js";
import { downloadReport } from "./report.js";
import {
    clearExecutionContext,
    currentExecutionContext,
    requireExecutionContext,
    resetExecutionContext
} from "./state.js";

function optionalRequirement(key) {
    try {
        return task.requirement(key);
    } catch (_) {
        return "";
    }
}

function nativeRequirement(key) {
    const uri = optionalRequirement(key);
    return uri ? fs.nativePath(uri) : "";
}

function optionString(name, fallback = "") {
    const value = task.option(name, fallback);
    return value === undefined || value === null ? fallback : String(value);
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
    throw new Error(`${name} must be true or false`);
}

function executionMode() {
    const configured = optionString("ExecutionMode", "").trim().toLowerCase();
    if (configured === "case" || configured === "plan") {
        return configured;
    }
    const caseUri = optionalRequirement("EA_CASE");
    const planUri = optionalRequirement("EA_PLAN");
    if (caseUri && planUri) {
        throw new Error("EA_CASE and EA_PLAN cannot both be selected without ExecutionMode");
    }
    return planUri ? "plan" : "case";
}

function absolutePath(value) {
    const path = String(value || "");
    return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)
        || path.startsWith("\\\\");
}

function inventoryItems(context, key) {
    const value = context.inventory && context.inventory[key];
    return Array.isArray(value) ? value : [];
}

function firstInventoryPath(context, key, type) {
    const item = inventoryItems(context, key).find((entry) =>
        entry && (!type || String(entry.Type || "").toLowerCase() === type));
    return item && item.Path ? String(item.Path) : "";
}

function pathFromRequirementOrOption(requirementKey, optionKey) {
    const requirementPath = nativeRequirement(requirementKey);
    if (requirementPath) {
        return requirementPath;
    }
    return optionString(optionKey, "").trim();
}

function updateVariables() {
    const value = task.option("UpdateVariables", null);
    if (value === undefined || value === null || value === "") {
        return null;
    }
    if (!Array.isArray(value)) {
        throw new Error("UpdateVariables must be an array");
    }
    return value;
}

export function prepare() {
    const projectPath = nativeRequirement("EA_PROJECT");
    if (!projectPath || !absolutePath(projectPath)) {
        throw new Error("EA_PROJECT must resolve to an absolute native path");
    }
    const mode = executionMode();
    const context = resetExecutionContext({
        projectPath,
        casePath: nativeRequirement("EA_CASE"),
        planPath: nativeRequirement("EA_PLAN"),
        testConfigurationPath: nativeRequirement("EA_TEST_CONFIGURATION"),
        testbenchConfigurationPath: nativeRequirement("EA_TESTBENCH_CONFIGURATION"),
        executionMode: mode,
        clientId: `${APPLICATION_NAME}_${task.id()}_${Date.now()}`
    });
    if (context.casePath && !absolutePath(context.casePath)) {
        throw new Error("EA_CASE must resolve to an absolute native path");
    }
    if (context.planPath && !absolutePath(context.planPath)) {
        throw new Error("EA_PLAN must resolve to an absolute native path");
    }
    task.info(`Prepared VCarEA ${mode} execution for ${projectPath}`);
    task.progress(5);
}

export function connect() {
    requireExecutionContext();
    connectAndSubscribe();
    task.progress(15);
}

export function registerAccess() {
    const context = requireExecutionContext();
    const response = request(
        TOPICS.accessRequest,
        TOPICS.accessResponse,
        {
            AccessAPPName: APPLICATION_NAME,
            Target: "VCarEA"
        });
    context.accessRegistered = true;
    task.info(`VCarEA API access registered (${response.Msg || "succeed"})`);
    task.progress(25);
}

export function openProject() {
    const context = requireExecutionContext();
    if (!context.accessRegistered) {
        throw new Error("VCarEA API access has not been registered");
    }
    const response = request(
        TOPICS.projectRequest,
        TOPICS.projectResponse,
        {
            OperationType: 0,
            ProjectPath: context.projectPath,
            ConstaraintUpdate: optionBoolean("ConstraintUpdate", true)
        },
        responseTimeout());
    context.projectOpened = true;
    if (response.Data && typeof response.Data === "object") {
        context.inventory = {
            Configurations: Array.isArray(response.Data.Configurations)
                ? response.Data.Configurations : [],
            Cases: Array.isArray(response.Data.Cases) ? response.Data.Cases : [],
            Plans: Array.isArray(response.Data.Plans) ? response.Data.Plans : []
        };
    }
    task.info(`VCarEA project opened: ${context.projectPath}`);
    task.progress(35);
}

export function configure() {
    const context = requireExecutionContext();
    if (!context.projectOpened) {
        throw new Error("VCarEA project has not been opened");
    }
    const tcf = pathFromRequirementOrOption(
        "EA_TEST_CONFIGURATION", "TestConfigurationPath");
    const tbf = pathFromRequirementOrOption(
        "EA_TESTBENCH_CONFIGURATION", "TestbenchConfigurationPath");
    const constraintUpdate = optionBoolean("ConstraintUpdate", true);
    if (tcf) {
        if (!absolutePath(tcf)) {
            throw new Error("TestConfigurationPath must be absolute");
        }
        request(TOPICS.settingRequest, TOPICS.settingResponse, {
            OperationType: 0,
            ConstaraintUpdate: constraintUpdate,
            ConfigPath: tcf
        });
        context.testConfigurationPath = tcf;
    }
    if (tbf) {
        if (!absolutePath(tbf)) {
            throw new Error("TestbenchConfigurationPath must be absolute");
        }
        request(TOPICS.settingRequest, TOPICS.settingResponse, {
            OperationType: 1,
            ConstaraintUpdate: constraintUpdate,
            ConfigPath: tbf
        });
        context.testbenchConfigurationPath = tbf;
    }
    if (!tcf && !tbf) {
        task.info("No explicit TCF/TBF was supplied; using the EA project configuration");
    } else {
        task.info("VCarEA test configuration applied");
    }
    task.progress(45);
}

export function startEnvironment() {
    const context = requireExecutionContext();
    if (!context.projectOpened) {
        throw new Error("VCarEA project has not been opened");
    }
    const responseData = {};
    const tbf = context.testbenchConfigurationPath
        || optionString("TestbenchConfigurationPath", "").trim()
        || firstInventoryPath(context, "Configurations", "tbf");
    if (tbf && absolutePath(tbf)) {
        responseData.TestbenchConfigurationPath = tbf;
    }
    request(TOPICS.environmentRequest, TOPICS.environmentResponse, {
        OperationType: 0,
        ...responseData
    });
    context.environmentStarted = true;
    task.info("VCarEA experiment environment started");
    task.progress(55);
}

function selectedTarget(context) {
    const selected = context.executionMode === "plan"
        ? context.planPath : context.casePath;
    if (selected) {
        return selected;
    }
    const inventoryKey = context.executionMode === "plan" ? "Plans" : "Cases";
    const discovered = firstInventoryPath(context, inventoryKey);
    if (!discovered || !absolutePath(discovered)) {
        throw new Error(`No absolute ${context.executionMode} path is available; supply EA_${context.executionMode.toUpperCase()}`);
    }
    return discovered;
}

function executeData(context) {
    const target = selectedTarget(context);
    const data = {
        OperationType: 0,
        UpdateVariables: updateVariables()
    };
    if (context.executionMode === "plan") {
        data.PlanPath = target;
    } else {
        data.CasePath = target;
    }
    if (context.projectPath) {
        data.ProjectPath = context.projectPath;
    }
    if (context.testConfigurationPath) {
        data.TestConfigurationPath = context.testConfigurationPath;
    }
    if (context.testbenchConfigurationPath) {
        data.TestbenchConfigurationPath = context.testbenchConfigurationPath;
    }
    return data;
}

export function execute() {
    const context = requireExecutionContext();
    if (!context.environmentStarted) {
        throw new Error("VCarEA experiment environment has not started");
    }
    const responseTopic = context.executionMode === "plan"
        ? TOPICS.planExecuteResponse : TOPICS.caseExecuteResponse;
    const requestTopic = context.executionMode === "plan"
        ? TOPICS.planExecuteRequest : TOPICS.caseExecuteRequest;
    const response = request(requestTopic,
                             responseTopic,
                             executeData(context),
                             executionTimeout());
    context.executionResponse = response;
    if (response.Data && response.Data.ReportPath) {
        context.reportPath = String(response.Data.ReportPath);
    }
    task.info(`VCarEA ${context.executionMode} execution completed`);
    task.progress(75);
}

export function collectReport() {
    const context = requireExecutionContext();
    if (optionBoolean("CollectReport", true)) {
        downloadReport(context);
    } else {
        task.info("Report download disabled by CollectReport=false");
    }
    const summary = {
        taskId: task.id(),
        mode: context.executionMode,
        projectPath: context.projectPath,
        reportPath: context.reportPath,
        response: context.executionResponse || null,
        downloaded: Boolean(context.reportArtifactUri)
    };
    context.summaryArtifactUri = "artifact://vcar-ea/execution.json";
    fs.writeText(context.summaryArtifactUri, JSON.stringify(summary, null, 2));
    task.publish("EA_EXECUTION_RESULT",
                 context.summaryArtifactUri,
                 "VCarEA execution result",
                 "application/json");
    task.progress(90);
}

export function stopEnvironment() {
    const context = requireExecutionContext();
    if (!context.environmentStarted) {
        return;
    }
    request(TOPICS.environmentRequest,
            TOPICS.environmentResponse,
            {OperationType: 1});
    context.environmentStarted = false;
    task.info("VCarEA experiment environment stopped");
    task.progress(94);
}

export function closeProject() {
    const context = requireExecutionContext();
    if (!context.projectOpened) {
        return;
    }
    request(TOPICS.projectRequest,
            TOPICS.projectResponse,
            {OperationType: 1});
    context.projectOpened = false;
    task.info("VCarEA project closed");
    task.progress(97);
}

export function cleanup() {
    const context = currentExecutionContext();
    if (context === null) {
        return;
    }
    try {
        if (context.environmentStarted) {
            try {
                request(TOPICS.environmentRequest,
                        TOPICS.environmentResponse,
                        {OperationType: 1},
                        5000);
            } catch (error) {
                task.warning(`Unable to stop VCarEA environment during cleanup: ${error.message}`);
            }
        }
        if (context.projectOpened) {
            try {
                request(TOPICS.projectRequest,
                        TOPICS.projectResponse,
                        {OperationType: 1},
                        5000);
            } catch (error) {
                task.warning(`Unable to close VCarEA project during cleanup: ${error.message}`);
            }
        }
        try {
            disconnect();
        } catch (error) {
            task.warning(`Unable to disconnect VCarEA MQTT: ${error.message}`);
        }
    } finally {
        clearExecutionContext();
    }
    task.info("VCarEA MQTT cleanup completed");
}
