import * as fs from "@atech/fs";
import * as task from "@atech/task";

import {
    maximumTestCaseCount,
    maximumTestCaseDurationMs,
    maximumWaitDurationSeconds,
    message,
    minimumTestCaseCount,
    reportedTestCaseDetailLimit,
    simulatedTestCaseProgressReportLimit
} from "./constants.js";
import {
    completeWorkload,
    executionState,
    setTestParameters,
    startWorkload
} from "./state.js";
import { requirePreparedWorkspace } from "./workspace.js";

/*
 * 工作负载模块处理用户输入并模拟长时执行。它只依赖虚拟文件系统和 task API，
 * 因而不直接接触宿主本机路径或其他插件的数据。
 */

// 读取工作流传入的 input:// 文件，并将文本转换为落在闭区间内的整数。
function readIntegerParameter(parameterUri, parameterId, minimum, maximum) {
    const value = fs.readText(parameterUri).trim();
    // 先用正则排除负数、小数、空值和多余字符，避免 Number() 的宽松转换。
    const isInteger = /^(0|[1-9][0-9]*)$/.test(value);
    const parsed = Number(value);
    if (!isInteger || parsed < minimum || parsed > maximum) {
        throw new Error(`${parameterId} must be an integer between `
                        + `${minimum} and ${maximum}`);
    }
    return parsed;
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
 * 按配置的条数与单条时长模拟测试用例。每个用例严格输出开始和结束两条日志，
 * 供 CLI 控制台和任务事件订阅者观察。单条时长同时决定输出节奏，让运行时在
 * 每次等待期间检查暂停、取消和超时。
 */
async function simulateTestCases(testCaseCount, testCaseDurationMs) {
    let passed = 0;
    let failed = 0;
    // 逐用例明细只在宿主上限内保留，统计始终覆盖全部配置用例。
    const caseResults = [];
    // 进度最多上报 100 次，用例越多每批包含的用例越多。
    const progressStep = Math.max(
        1, Math.ceil(testCaseCount / simulatedTestCaseProgressReportLimit));

    for (let index = 1; index <= testCaseCount; ++index) {
        task.checkCancelled();
        const id = testCaseId(index);
        task.info(`正在执行${id}`);
        // 配置的单条执行时长代表该用例的模拟耗时。
        await task.delay(testCaseDurationMs);
        task.resetTimeout();

        const casePassed = testCasePassed(index);
        if (casePassed) {
            ++passed;
            task.info(`${id} 执行完成 -通过`);
        } else {
            ++failed;
            task.info(`${id} 执行完成 -失败`);
        }
        if (caseResults.length < reportedTestCaseDetailLimit) {
            caseResults.push({
                caseId: id,
                name: id,
                result: casePassed ? "passed" : "failed",
                durationMs: testCaseDurationMs,
                message: casePassed ? "" : "模拟测试用例执行失败"
            });
        }

        if (index % progressStep === 0 || index === testCaseCount) {
            // 45%-75% 用于展示模拟测试用例的批量执行进度。
            task.progress(45 + Math.floor(
                index * 30 / testCaseCount));
        }
    }

    return {
        total: testCaseCount,
        passed,
        failed,
        cases: caseResults
    };
}

/*
 * 工作流第二阶段：验证等待时长、用例条数和单条执行时长，并将结果写入共享状态。
 * 执行阶段不再读取输入文件，以保证整个执行过程使用同一组已验证的值。
 */
export async function validateInput(waitDurationUri,
                                    testCaseCountUri,
                                    testCaseDurationUri) {
    requirePreparedWorkspace();
    const waitDurationSeconds = readIntegerParameter(
        waitDurationUri,
        "WAIT_DURATION_SECONDS",
        0,
        maximumWaitDurationSeconds);
    const testCaseCount = readIntegerParameter(
        testCaseCountUri,
        "TEST_CASE_COUNT",
        minimumTestCaseCount,
        maximumTestCaseCount);
    const testCaseDurationMs = readIntegerParameter(
        testCaseDurationUri,
        "TEST_CASE_DURATION_MS",
        0,
        maximumTestCaseDurationMs);
    setTestParameters({
        waitDurationSeconds,
        testCaseCount,
        testCaseDurationMs
    });
    task.info(`Validated a ${waitDurationSeconds}-second workload with `
              + `${testCaseCount} test cases of ${testCaseDurationMs} ms`);
    task.progress(10);
    await task.delay(100);
}

/*
 * 工作流第三阶段先模拟等待，再执行配置条数的测试用例。
 * 0 秒等待是合法输入，等待循环不会执行，但测试用例仍会正常执行。
 */
export async function helloWorld() {
    requirePreparedWorkspace();
    const {
        testCaseCount,
        testCaseDurationMs,
        waitDurationSeconds
    } = executionState();
    // 未经验证的输入不能进入执行阶段，防止绕过 validateInput。
    if (waitDurationSeconds === null || testCaseCount === null
            || testCaseDurationMs === null) {
        throw new Error("Hello World test parameters have not been validated");
    }

    startWorkload();
    task.info(`Simulating a ${waitDurationSeconds}-second workload and `
              + `${testCaseCount} test cases of ${testCaseDurationMs} ms`);
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
    const testCaseSummary = await simulateTestCases(testCaseCount,
                                                    testCaseDurationMs);
    completeWorkload(testCaseSummary);
    // 上报结构化用例结果：统计覆盖全部用例，明细受宿主上限约束。
    task.reportResult({
        total: testCaseSummary.total,
        passed: testCaseSummary.passed,
        failed: testCaseSummary.failed,
        cases: testCaseSummary.cases
    });
    task.info(message);
    task.progress(75);
    return {
        message,
        testCaseSummary: {
            total: testCaseSummary.total,
            passed: testCaseSummary.passed,
            failed: testCaseSummary.failed
        },
        waitDurationSeconds,
        testCaseCount,
        testCaseDurationMs
    };
}
