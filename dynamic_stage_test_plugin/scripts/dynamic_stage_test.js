import * as fs from "@atech/fs";
import * as task from "@atech/task";

const state = {
    config: null,
    created: [],
    started: [],
    completed: [],
    verified: false
};

function integerInput(key, fallback, minimum, maximum) {
    let value = task.option(key, fallback);
    let uri;
    try {
        // 与离线和平台任务保持一致：需求值来自宿主隔离的输入文件。
        uri = task.requirement(key);
    } catch (error) {
        if (error.code !== "NOT_FOUND") {
            throw error;
        }
    }
    if (uri !== undefined) {
        value = fs.readText(uri).trim();
    }
    if ((typeof value !== "string" && typeof value !== "number")
        || String(value).trim() === "" || !/^[0-9]+$/.test(String(value))) {
        throw new Error(key + " 必须为非负整数");
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
        throw new Error(key + " 必须位于 " + minimum + " 到 " + maximum + " 之间");
    }
    return number;
}

function createStage(index) {
    task.addStage({
        stageId: "dynamic_" + index,
        name: "动态阶段 " + index + "/" + state.config.stageCount,
        exportName: "executeDynamicStage",
        timeoutMs: state.config.delayMs + 5000,
        arguments: [index, { previous: index - 1, marker: "动态实参" }]
    });
    state.created.push(index);
    task.info("已动态创建阶段 dynamic_" + index);
}

export function seedStages() {
    state.config = {
        stageCount: integerInput("STAGE_COUNT", 3, 1, 100),
        delayMs: integerInput("STAGE_DELAY_MS", 500, 0, 10000),
        failAtStage: integerInput("FAIL_AT_STAGE", 0, 0, 100)
    };
    if (state.config.failAtStage > state.config.stageCount) {
        throw new Error("FAIL_AT_STAGE 不能超过 STAGE_COUNT");
    }
    fs.writeText("workspace://dynamic-stage-state.json", "{}\n", true);
    // 引导阶段只创建一个节点，后面的节点只能由已执行的动态阶段创建。
    createStage(1);
    return state.config;
}

export function executeDynamicStage(index, context) {
    state.started.push(index);
    if (context.previous !== index - 1 || context.marker !== "动态实参"
        || state.completed.length !== index - 1) {
        throw new Error("动态阶段顺序或嵌套实参不正确");
    }
    task.info("正在执行动态阶段 dynamic_" + index);
    task.checkpoint();
    task.delay(state.config.delayMs);
    if (state.config.failAtStage === index) {
        throw new Error("按测试配置注入失败：dynamic_" + index);
    }
    state.completed.push(index);
    // 根据当前阶段的结果决定是否创建下一阶段，静态验证阶段始终排在最后。
    if (index < state.config.stageCount) {
        createStage(index + 1);
    }
    task.progress(index / state.config.stageCount * 90);
    task.resetTimeout();
    return { index: index, completed: true };
}

export function verifyStages() {
    const expected = Array.from({ length: state.config.stageCount }, function (_, index) {
        return index + 1;
    });
    if (JSON.stringify(state.created) !== JSON.stringify(expected)
        || JSON.stringify(state.completed) !== JSON.stringify(expected)) {
        throw new Error("动态阶段没有按预期逐个生成和执行");
    }
    state.verified = true;
    task.progress(100);
    task.info("动态流程验证通过，共 " + expected.length + " 个动态阶段");
}

export function publishReport() {
    // 收尾阶段在失败、取消和超时后也会执行，保留部分执行现场。
    const report = {
        taskId: task.id(),
        config: state.config,
        created: state.created,
        started: state.started,
        completed: state.completed,
        verified: state.verified
    };
    const uri = "artifact://dynamic-stage-report.json";
    // 重新开始共用产物目录，报告必须原子覆盖上一轮结果。
    fs.writeText(uri, JSON.stringify(report, null, 2) + "\n", true);
    task.publish("DYNAMIC_STAGE_REPORT", uri, "动态流程测试报告", "application/json");
    return report;
}

export function cleanup() {
    if (fs.exists("workspace://dynamic-stage-state.json")) {
        fs.remove("workspace://dynamic-stage-state.json", false);
    }
    task.info("动态流程测试状态已清理");
}
