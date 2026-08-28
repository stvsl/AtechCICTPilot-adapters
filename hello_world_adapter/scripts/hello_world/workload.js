import * as fs from "@atech/fs";
import * as task from "@atech/task";

import {
    maximumWaitDurationSeconds,
    message,
    simulatedTestCaseBatchSize,
    simulatedTestCaseCount,
    simulatedTestCaseOutputDelayMs
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

// 用例编号至少保留两位，以保证首个用例与控制台约定一致。
function testCaseId(index) {
    return `CT_TEST_CASE_${String(index).padStart(2, "0")}`;
}

/*
 * 用固定的交替结果覆盖通过与失败两种控制台输出，避免随机结果导致问题无法复现。
 * 单个用例失败只代表模拟结果，完整批次仍会继续执行并生成汇总报告。
 */
function testCasePassed(index) {
    return index % 2 === 1;
}

/*
 * 模拟执行 10000 个测试用例。每个用例严格输出开始和结束两条日志，供 CLI
 * 控制台和任务事件订阅者观察。每条输出之间间隔 5 毫秒，模拟逐条执行的
 * 真实节奏，同时让运行时在每次等待期间检查暂停、取消和超时。
 */
async function simulateTestCases() {
    let passed = 0;
    let failed = 0;

    for (let index = 1; index <= simulatedTestCaseCount; ++index) {
        task.checkCancelled();
        const id = testCaseId(index);
        task.info(`正在执行${id}`);
        // 每条输出之间等待 5 毫秒，避免输出瞬间刷屏。
        await task.delay(simulatedTestCaseOutputDelayMs);

        if (testCasePassed(index)) {
            ++passed;
            task.info(`${id} 执行完成 -通过`);
        } else {
            ++failed;
            task.info(`${id} 执行完成 -失败`);
        }
        await task.delay(simulatedTestCaseOutputDelayMs);

        if (index % simulatedTestCaseBatchSize === 0) {
            // 45%-75% 用于展示模拟测试用例的批量执行进度。
            task.progress(45 + Math.floor(
                index * 30 / simulatedTestCaseCount));
        }
    }

    return {
        total: simulatedTestCaseCount,
        passed,
        failed
    };
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
 * 工作流第三阶段先模拟等待，再执行固定的 10000 条测试用例。
 * 0 秒是合法输入，等待循环不会执行，但测试用例仍会正常执行。
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
        // 20%-45% 留给实际等待过程，其余进度由用例执行和前后阶段负责。
        const progress = 20 + Math.floor(
            (elapsedSeconds + 1) * 25 / waitDurationSeconds);
        task.progress(progress);
    }

    task.progress(45);
    const testCaseSummary = await simulateTestCases();
    completeWorkload(testCaseSummary);
    task.info(message);
    task.progress(75);
    return { message, testCaseSummary, waitDurationSeconds };
}
