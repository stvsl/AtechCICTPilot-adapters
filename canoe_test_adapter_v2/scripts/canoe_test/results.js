import * as fs from "@atech/fs";
import * as task from "@atech/task";

import {
    RESULTS_ARTIFACT_URI,
    RESULTS_DIRECTORY_URI,
    RESULTS_SOURCE_URI
} from "./constants.js";
import {
    baseName,
    requireSafeRelativePath
} from "./contract.js";
import {
    nativePathToWorkspaceUri,
    optionalProperty
} from "./com.js";

function resultKey(result) {
    return `${result.testModule}\u0000${result.id}`;
}

function relativePath(rootUri, uri) {
    const root = String(rootUri).replace(/\/$/, "");
    const prefix = `${root}/`;
    if (!String(uri).startsWith(prefix)) {
        throw new Error(`CANoe artifact is outside the extracted project: ${uri}`);
    }
    return requireSafeRelativePath(String(uri).substring(prefix.length), "Artifact path");
}

function mediaType(path) {
    return path.toLowerCase().endsWith(".json")
        ? "application/json" : "application/octet-stream";
}

export function recordCompletedResults(context, candidates) {
    for (const candidate of candidates) {
        const key = resultKey(candidate);
        if (context.test.resultKeys[key]) {
            continue;
        }
        context.test.resultKeys[key] = true;
        context.test.results.push(candidate);
    }
}

export function resultStatus(context) {
    if (context.execution.error || context.execution.artifactErrors.length > 0) {
        return "error";
    }
    if (context.test.results.length !== context.test.selectedCases.length) {
        return "incomplete";
    }
    return context.test.results.every((result) => result.passed) ? "passed" : "failed";
}

export function createResultsDocument(context) {
    return {
        schemaVersion: "2.0",
        taskId: task.id(),
        status: resultStatus(context),
        selectedTestCaseCount: context.test.selectedCases.length,
        completedTestCaseCount: context.test.results.length,
        executionError: context.execution.error || null,
        artifactErrors: context.execution.artifactErrors.slice(),
        results: context.test.results.slice()
    };
}

function reportUris(context) {
    const uris = [];
    for (const report of context.test.reportObjects) {
        const nativePath = optionalProperty(report, "LastWrittenFullPath")
            || optionalProperty(report, "LastWrittenFullName");
        if (typeof nativePath !== "string"
                || !nativePath.toLowerCase().endsWith(".vtestreport")) {
            continue;
        }
        const uri = nativePathToWorkspaceUri(context.project.rootUri, nativePath);
        if (uri && fs.exists(uri) && !uris.includes(uri)) {
            uris.push(uri);
        }
    }
    return uris;
}

function publishFile(context, source, relative, publicationId) {
    const destination = `artifact://canoe-test/${relative}`;
    if (context.publication.artifactUris[destination]) {
        return;
    }
    fs.copy(source, destination, true);
    context.publication.artifactUris[destination] = true;
    task.publish(publicationId, destination, baseName(relative), mediaType(relative));
}

function collectSupplementalArtifacts(context) {
    for (const uri of reportUris(context)) {
        const relative = relativePath(context.project.rootUri, uri);
        try {
            publishFile(context, uri, relative, `CANOE_REPORT:${relative}`);
        } catch (error) {
            const message = `Unable to publish CANoe report ${relative}: ${error.message}`;
            context.execution.artifactErrors.push(message);
            task.error(message);
        }
    }
    for (const relative of context.project.descriptor.artifactPaths) {
        const source = `${context.project.rootUri}/${relative}`;
        if (!fs.exists(source)) {
            const message = `Declared CANoe artifact is missing: ${relative}`;
            context.execution.artifactErrors.push(message);
            task.error(message);
            continue;
        }
        try {
            publishFile(context, source, relative, `ARTIFACT:${relative}`);
        } catch (error) {
            const message = `Unable to publish declared CANoe artifact ${relative}: ${error.message}`;
            context.execution.artifactErrors.push(message);
            task.error(message);
        }
    }
}

function publishSummary(context) {
    fs.mkdir(RESULTS_DIRECTORY_URI);
    fs.writeText(RESULTS_SOURCE_URI,
                 JSON.stringify(createResultsDocument(context), null, 2));
    context.publication.summaryWritten = true;
    fs.copy(RESULTS_SOURCE_URI, RESULTS_ARTIFACT_URI, true);
    task.publish("REPORT_URI", RESULTS_ARTIFACT_URI,
                 "CANoe test results", "application/json");
    context.publication.summaryPublished = true;
}

export function publishTestArtifacts(context) {
    collectSupplementalArtifacts(context);
    publishSummary(context);
}

export function throwForFinalOutcome(context) {
    if (context.execution.artifactErrors.length > 0) {
        throw new Error(context.execution.artifactErrors.join("; "));
    }
    if (context.execution.error) {
        throw new Error(`CANoe test execution failed: ${context.execution.error}`);
    }
    const status = resultStatus(context);
    if (status === "incomplete") {
        throw new Error("CANoe did not produce verdicts for every selected test case");
    }
    if (status === "failed") {
        throw new Error("One or more CANoe test cases failed");
    }
}
