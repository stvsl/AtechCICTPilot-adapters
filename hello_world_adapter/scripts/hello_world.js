/*
 * StepConfig.groovy 只将本文件声明为工作流入口，因此所有阶段函数都要从这里导出。
 * 具体逻辑按职责拆分到子目录：工作区管理、等待任务和报告处理彼此独立，入口仅负责
 * 组合它们。所有模块在同一 QuickJS runtime 中加载，因而能共享 state.js 中的阶段状态。
 */
import {
    cleanup,
    prepareWorkspace
} from "./hello_world/workspace.js";
import {
    helloWorld,
    validateInput
} from "./hello_world/workload.js";
import {
    publishReport,
    verifyResult
} from "./hello_world/report.js";

// 以下导出名称必须与 StepConfig.groovy 中的 runjs 配置保持一致。
export {
    cleanup,
    helloWorld,
    prepareWorkspace,
    publishReport,
    validateInput,
    verifyResult
};
