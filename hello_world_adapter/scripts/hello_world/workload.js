import * as fs from "@atech/fs";
import * as task from "@atech/task";

import {
    maximumWaitDurationSeconds,
    message
} from "./constants.js";
import {
    completeWorkload,
    executionState,
    setWaitDurationSeconds,
    startWorkload
} from "./state.js";
import { requirePreparedWorkspace } from "./workspace.js";

/*
 * 工作负载模块处理用户输入并模拟长时执行。它只依赖虚拟文件系统和 task API，
 * 因而不直接接触宿主本机路径或其他插件的数据。
 */

// 读取工作流传入的 input:// 文件，并将文本转换为受限的秒数。
function readWaitDurationSeconds(waitDurationUri) {
    const value = fs.readText(waitDurationUri).trim();
    // 先用正则排除负数、小数、空值和多余字符，避免 Number() 的宽松转换。
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new Error("WAIT_DURATION_SECONDS must be an integer between 0 and 600");
    }

    const seconds = Number(value);
    if (seconds > maximumWaitDurationSeconds) {
        throw new Error("WAIT_DURATION_SECONDS must be between 0 and 600");
    }
    return seconds;
}

/*
 * 工作流第二阶段：验证 WAIT_DURATION_SECONDS，并将结果写入共享状态。
 * 执行阶段不再读取输入文件，以保证整个执行过程使用已验证的同一个值。
 */
export async function validateInput(waitDurationUri) {
    requirePreparedWorkspace();
    const waitDurationSeconds = readWaitDurationSeconds(waitDurationUri);
    setWaitDurationSeconds(waitDurationSeconds);
    task.info(`Validated a ${waitDurationSeconds}-second workload`);
    task.progress(10);
    await task.delay(100);
}

/*
 * 工作流第三阶段：每秒更新一次进度并让出执行权，使取消和超时能被运行时处理。
 * 0 秒是合法输入，循环不会执行，但仍会正常记录完成状态和 75% 阶段进度。
 */
export async function helloWorld() {
    requirePreparedWorkspace();
    const { waitDurationSeconds } = executionState();
    // 未经验证的输入不能进入执行阶段，防止绕过 validateInput。
    if (waitDurationSeconds === null) {
        throw new Error("Hello World test parameters have not been validated");
    }

    startWorkload();
    task.info(`Simulating a ${waitDurationSeconds}-second workload`);
    task.progress(20);

    for (let elapsedSeconds = 0; elapsedSeconds < waitDurationSeconds;
         ++elapsedSeconds) {
        await task.delay(1000);
        // 20%-75% 留给实际等待过程，其余进度由前后阶段负责。
        const progress = 20 + Math.floor(
            (elapsedSeconds + 1) * 55 / waitDurationSeconds);
        task.progress(progress);
    }

    completeWorkload();
    task.info(message);
    task.progress(75);
    return { message, waitDurationSeconds };
}
