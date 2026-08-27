import * as fs from "@atech/fs";
import * as task from "@atech/task";

import {
    artifactReportUri,
    message,
    workspaceReportUri
} from "./constants.js";
import { executionState } from "./state.js";
import { requirePreparedWorkspace } from "./workspace.js";

/*
 * 报告模块将已完成的执行状态固化为 JSON，并把最终文件发布到 artifact://。
 * 工作区中的报告只是中间结果；只有 publishReport 发布的产物才会被宿主收集。
 */

/*
 * 工作流第四阶段：确认工作负载已完成，再生成并回读报告。
 * 回读用于验证写入的报告没有被截断或写入到错误位置。
 */
export async function verifyResult() {
    requirePreparedWorkspace();
    const {
        completedAt,
        helloWorldCompleted,
        startedAt,
        waitDurationSeconds
    } = executionState();
    // 开始与完成时间也能防止异常状态被误认为成功。
    if (!helloWorldCompleted || completedAt < startedAt) {
        throw new Error("Hello World workload did not complete successfully");
    }

    const report = {
        taskId: task.id(),
        status: "succeeded",
        message,
        waitDurationSeconds,
        durationMs: completedAt - startedAt
    };
    fs.writeText(workspaceReportUri, JSON.stringify(report, null, 2));
    const persistedReport = JSON.parse(fs.readText(workspaceReportUri));
    if (persistedReport.status !== "succeeded"
            || persistedReport.message !== message) {
        throw new Error("Hello World test report verification failed");
    }

    task.info("Hello World result verified");
    task.progress(90);
    await task.delay(100);
}

/*
 * 工作流第五阶段：将经过验证的工作区报告复制到产物区，并登记给宿主。
 * publication ID、显示名称和 MIME 类型是任务结果对外的稳定契约。
 */
export async function publishReport() {
    if (!fs.exists(workspaceReportUri)) {
        throw new Error("Hello World test report is missing");
    }

    fs.copy(workspaceReportUri, artifactReportUri, true);
    task.publish("REPORT_URI",
                 artifactReportUri,
                 "Hello World test report",
                 "application/json");
    task.info("Hello World test report published");
    task.progress(100);
    await task.delay(100);
}
