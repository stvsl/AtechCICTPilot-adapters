import * as task from "@atech/task";

import {
    clearExecutionContext,
    currentExecutionContext,
    requireExecutionContext,
    resetExecutionContext
} from "./context.js";
import {
    loadProject,
    loadRequestedTestCaseIds
} from "./contract.js";
import {
    errorMessage,
    releaseAll
} from "./com.js";
import {
    configureCommunicationTestEnvironment,
    executeCommunicationTests,
    stopCommunicationTests
} from "./environment.js";
import {
    publishTestArtifacts,
    recordCompletedResults,
    throwForFinalOutcome
} from "./results.js";
import {
    closeCanoeSession,
    connectAutomationServer,
    ensureMeasurementStarted,
    launchCanoeSession,
    openProjectConfiguration,
    releaseSessionHandles
} from "./session.js";

function optionalRequirement(key) {
    try {
        return task.requirement(key);
    } catch (error) {
        if (/Requirement property is missing/i.test(errorMessage(error))) {
            return "";
        }
        throw error;
    }
}

export async function prepareProject(projectPackage) {
    const project = loadProject(projectPackage);
    const requestedIds = loadRequestedTestCaseIds(
        optionalRequirement("TEST_CASE_IDS"));
    resetExecutionContext(project, requestedIds);
    task.info(`Prepared CANoe project: ${project.descriptor.configurationPath}`);
    task.progress(5);
}

export async function launchCanoe() {
    await launchCanoeSession(requireExecutionContext());
    task.progress(10);
}

export async function connectAutomation() {
    await connectAutomationServer(requireExecutionContext());
    task.progress(15);
}

export async function openConfiguration() {
    await openProjectConfiguration(requireExecutionContext());
    task.progress(20);
}

export async function configureTestEnvironment() {
    const context = requireExecutionContext();
    configureCommunicationTestEnvironment(context);
    task.info(`Configured ${context.test.selectedCases.length} CANoe test case(s)`);
    task.progress(25);
}

export async function executeTests() {
    const context = requireExecutionContext();
    try {
        await ensureMeasurementStarted(context);
        await executeCommunicationTests(context, (candidates) =>
            recordCompletedResults(context, candidates));
        task.info(`Completed ${context.test.results.length} CANoe test case(s)`);
    } catch (error) {
        if (task.isCancelled()) {
            throw error;
        }
        context.execution.error = errorMessage(error);
        task.error(`CANoe test execution failed: ${context.execution.error}`);
    }
    task.progress(90);
}

export async function publishArtifacts() {
    const context = requireExecutionContext();
    publishTestArtifacts(context);
    task.progress(100);
    throwForFinalOutcome(context);
}

export async function cleanup() {
    const context = currentExecutionContext();
    if (context === null) {
        return;
    }
    try {
        stopCommunicationTests(context);
        await closeCanoeSession(context);
    } finally {
        releaseAll(context.test.caseHandles);
        releaseAll(context.test.moduleHandles);
        releaseAll(context.test.reportObjects);
        releaseAll([
            context.test.environment,
            context.test.environments,
            context.test.setup
        ]);
        releaseSessionHandles(context);
        clearExecutionContext();
    }
}
