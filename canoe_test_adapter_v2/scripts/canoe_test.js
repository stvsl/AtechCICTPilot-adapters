/*
 * StepConfig.groovy 只将本文件声明为工作流入口，因此阶段函数统一在这里导出。
 * 具体实现按契约、会话、测试环境和结果处理分离，入口本身不保存执行状态。
 */
export {
    cleanup,
    configureTestEnvironment,
    connectAutomation,
    executeTests,
    launchCanoe,
    openConfiguration,
    prepareProject,
    publishArtifacts
} from "./canoe_test/stages.js";
