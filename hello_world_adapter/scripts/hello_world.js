import * as fs from "@atech/fs";
import * as task from "@atech/task";

const message = "Hello, World!";
const maximumWaitDurationSeconds = 600;
const workspaceDirectoryUri = "workspace://hello-world";
const workspaceContextUri = `${workspaceDirectoryUri}/context.json`;
const workspaceReportUri = `${workspaceDirectoryUri}/report.json`;
const cleanupMarkerUri = `${workspaceDirectoryUri}/cleanup.json`;
const artifactReportUri = "artifact://hello-world-report.json";

let waitDurationSeconds = null;
let startedAt = 0;
let completedAt = 0;
let helloWorldCompleted = false;

function requirePreparedWorkspace() {
    if (!fs.exists(workspaceContextUri)) {
        throw new Error("Hello World test workspace has not been prepared");
    }
}

function readWaitDurationSeconds(waitDurationUri) {
    const value = fs.readText(waitDurationUri).trim();
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new Error("WAIT_DURATION_SECONDS must be an integer between 0 and 600");
    }

    const seconds = Number(value);
    if (seconds > maximumWaitDurationSeconds) {
        throw new Error("WAIT_DURATION_SECONDS must be between 0 and 600");
    }
    return seconds;
}

export async function prepareWorkspace() {
    waitDurationSeconds = null;
    startedAt = 0;
    completedAt = 0;
    helloWorldCompleted = false;

    fs.mkdir(workspaceDirectoryUri);
    fs.writeText(workspaceContextUri, JSON.stringify({
        taskId: task.id(),
        status: "prepared"
    }, null, 2));
    task.info(`Hello World test workspace prepared: ${workspaceDirectoryUri}`);
    task.progress(5);
    await task.delay(100);
}

export async function validateInput(waitDurationUri) {
    requirePreparedWorkspace();
    waitDurationSeconds = readWaitDurationSeconds(waitDurationUri);
    task.info(`Validated a ${waitDurationSeconds}-second workload`);
    task.progress(10);
    await task.delay(100);
}

export async function helloWorld() {
    requirePreparedWorkspace();
    if (waitDurationSeconds === null) {
        throw new Error("Hello World test parameters have not been validated");
    }

    startedAt = Date.now();
    task.info(`Simulating a ${waitDurationSeconds}-second workload`);
    task.progress(20);

    for (let elapsedSeconds = 0; elapsedSeconds < waitDurationSeconds;
         ++elapsedSeconds) {
        await task.delay(1000);
        const progress = 20 + Math.floor(
            (elapsedSeconds + 1) * 55 / waitDurationSeconds);
        task.progress(progress);
    }

    completedAt = Date.now();
    helloWorldCompleted = true;
    task.info(message);
    task.progress(75);
    return { message, waitDurationSeconds };
}

export async function verifyResult() {
    requirePreparedWorkspace();
    if (!helloWorldCompleted || completedAt < startedAt) {
        throw new Error("Hello World workload did not complete successfully");
    }

    const report = {
        taskId: task.id(),
        status: "succeeded",
        message,
        waitDurationSeconds,
        durationMs: completedAt - startedAt
    };
    fs.writeText(workspaceReportUri, JSON.stringify(report, null, 2));
    const persistedReport = JSON.parse(fs.readText(workspaceReportUri));
    if (persistedReport.status !== "succeeded"
            || persistedReport.message !== message) {
        throw new Error("Hello World test report verification failed");
    }

    task.info("Hello World result verified");
    task.progress(90);
    await task.delay(100);
}

export async function publishReport() {
    if (!fs.exists(workspaceReportUri)) {
        throw new Error("Hello World test report is missing");
    }

    fs.copy(workspaceReportUri, artifactReportUri, true);
    task.publish("REPORT_URI",
                 artifactReportUri,
                 "Hello World test report",
                 "application/json");
    task.info("Hello World test report published");
    task.progress(100);
    await task.delay(100);
}

export async function cleanup() {
    fs.mkdir(workspaceDirectoryUri);
    fs.writeText(cleanupMarkerUri, JSON.stringify({
        taskId: task.id(),
        reportCreated: fs.exists(workspaceReportUri),
        status: "cleaned"
    }, null, 2));
    task.info("Hello World test cleanup completed");
    await task.delay(100, true);
}
