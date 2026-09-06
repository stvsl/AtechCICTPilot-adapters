import * as task from "@atech/task";
import * as fs from "@atech/fs";
import * as mqtt from "@atech/mqtt";

// 昆易测试执行 的入口脚本；阶段逻辑可在此基础上继续拆分为多个模块。

// 启动VCAR EA
export async function startVcarEA(...stageArgs) {
    task.info("开始阶段：启动VCAR EA");
    void stageArgs;
    task.progress(100);
}

// 清理
export async function cleanup(...stageArgs) {
    task.info("开始阶段：清理");
    void stageArgs;
    task.progress(100);
}
