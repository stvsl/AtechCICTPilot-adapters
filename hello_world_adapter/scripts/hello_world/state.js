/*
 * QuickJS 会在一个插件节点内缓存 ES 模块，因此这里的模块级变量会在以下阶段间共享：
 * prepareWorkspace -> validateInput -> helloWorld -> verifyResult -> publishReport -> cleanup。
 * 状态仅用于同一次节点执行；prepareWorkspace 每次都会先重置，避免复用上一次执行结果。
 */
let waitDurationSeconds = null;
let testCaseCount = null;
let testCaseDurationMs = null;
let startedAt = 0;
let completedAt = 0;
let helloWorldCompleted = false;
let testCaseSummary = {
    total: 0,
    passed: 0,
    failed: 0
};

// 在准备工作区时清空所有阶段间数据，建立一次新的执行上下文。
export function resetExecutionState() {
    waitDurationSeconds = null;
    testCaseCount = null;
    testCaseDurationMs = null;
    startedAt = 0;
    completedAt = 0;
    helloWorldCompleted = false;
    testCaseSummary = {
        total: 0,
        passed: 0,
        failed: 0
    };
}

// 参数校验阶段确认输入后保存全部执行参数，执行阶段再从这里读取。
export function setTestParameters(parameters) {
    waitDurationSeconds = parameters.waitDurationSeconds;
    testCaseCount = parameters.testCaseCount;
    testCaseDurationMs = parameters.testCaseDurationMs;
}

// 返回当前状态快照，调用方只读取状态，修改必须通过专用函数完成。
export function executionState() {
    return {
        waitDurationSeconds,
        testCaseCount,
        testCaseDurationMs,
        startedAt,
        completedAt,
        helloWorldCompleted,
        testCaseSummary: {
            total: testCaseSummary.total,
            passed: testCaseSummary.passed,
            failed: testCaseSummary.failed
        }
    };
}

// 记录负载开始时刻，并清除可能残留的完成标记。
export function startWorkload() {
    startedAt = Date.now();
    completedAt = 0;
    helloWorldCompleted = false;
}

// 仅在等待任务完整结束后标记成功，供验证阶段确认前置阶段确实完成。
export function completeWorkload(summary) {
    completedAt = Date.now();
    helloWorldCompleted = true;
    testCaseSummary = {
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed
    };
}
