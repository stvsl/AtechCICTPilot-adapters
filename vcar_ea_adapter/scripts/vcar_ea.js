/*
 * VCarEA 插件入口。MQTT 地址、认证信息和主题属于 EA 协议契约，全部由
 * 插件维护；运行时只提供原始 MQTT 操作，不对这些业务字段做任何封装。
 */
import {
    cleanup,
    connect,
    registerAccess,
    openProject,
    configure,
    startEnvironment,
    execute,
    collectReport,
    stopEnvironment,
    closeProject,
    prepare
} from "./vcar_ea/ea.js";

export {
    cleanup,
    connect,
    registerAccess,
    openProject,
    configure,
    startEnvironment,
    execute,
    collectReport,
    stopEnvironment,
    closeProject,
    prepare
};
