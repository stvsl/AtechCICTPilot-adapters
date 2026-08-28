import * as fs from "@atech/fs";
import * as task from "@atech/task";

import {
    cleanupMarkerUri,
    workspaceContextUri,
    workspaceDirectoryUri,
    workspaceReportUri
} from "./constants.js";
import { resetExecutionState } from "./state.js";

/*
 * 工作区模块负责建立阶段前置条件和始终执行的清理记录。
 * context.json 是准备阶段成功的标记；后续阶段通过它阻止跳过 prepareWorkspace 的调用。
 */

// 后续阶段先检查准备标记，避免在未初始化的工作区中继续运行。
export function requirePreparedWorkspace() {
    if (!fs.exists(workspaceContextUri)) {
        throw new Error("Hello World test workspace has not been prepared");
    }
}

/*
 * 工作流第一阶段：创建工作目录、清空上一次运行状态，并写入任务关联信息。
 * 这里的短暂 delay 同时让宿主有机会处理取消请求和日志事件。
 */
export async function prepareWorkspace() {
    resetExecutionState();

    fs.mkdir(workspaceDirectoryUri);
    fs.writeText(workspaceContextUri, JSON.stringify({
        taskId: task.id(),
        status: "prepared"
    }, null, 2));
    task.info(`Hello World test workspace prepared: ${workspaceDirectoryUri}`);
    task.progress(5);
    await task.delay(100);
}

/*
 * 工作流的 always 清理阶段：无论正常完成、失败、超时还是取消都会执行。
 * 清理阶段只写入标记而不删除报告，便于宿主和测试确认是否执行过清理。
 */
export async function cleanup() {
    fs.mkdir(workspaceDirectoryUri);
    fs.writeText(cleanupMarkerUri, JSON.stringify({
        taskId: task.id(),
        reportCreated: fs.exists(workspaceReportUri),
        status: "cleaned"
    }, null, 2));
    task.info("Hello World test cleanup completed");
    // 清理已开始后忽略取消，确保清理标记能够稳定落盘。
    await task.delay(100, true);
}
