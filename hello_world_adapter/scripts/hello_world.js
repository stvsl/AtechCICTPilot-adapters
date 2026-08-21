import * as fs from "@atech/fs";
import * as task from "@atech/task";

const message = "Hello, World!";
const maximumWaitDurationSeconds = 600;

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

export async function helloWorld(waitDurationUri) {
    const waitDurationSeconds = readWaitDurationSeconds(waitDurationUri);
    task.output("WAIT_DURATION_SECONDS", waitDurationSeconds);
    task.log("info", `Simulating a ${waitDurationSeconds}-second workload`);

    for (let elapsedSeconds = 0; elapsedSeconds < waitDurationSeconds;
         ++elapsedSeconds) {
        const progress = Math.floor(elapsedSeconds * 95 / waitDurationSeconds);
        task.progress(progress,
                      `Simulating workload: ${elapsedSeconds + 1}/${waitDurationSeconds} seconds`);
        await task.delay(1000);
    }

    task.log("info", message);
    task.output("MESSAGE", message);
    task.progress(100, message);
    return { message, waitDurationSeconds };
}
