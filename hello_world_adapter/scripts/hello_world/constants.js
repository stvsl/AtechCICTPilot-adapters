/*
 * 本模块集中保存整个插件固定不变的配置，避免多个阶段分别维护相同的 URI 或限制值。
 * 文件访问必须使用宿主提供的虚拟 URI；不能替换为本机绝对路径。
 */

// 完成工作负载后记录到日志、返回值和报告中的固定消息。
export const message = "Hello, World!";

// 输入参数的上限与 PackageInfo.json 中声明的范围一致。
export const maximumWaitDurationSeconds = 600;
export const minimumTestCaseCount = 1;
export const maximumTestCaseCount = 100000;
export const maximumTestCaseDurationMs = 60000;

// 无论用例总数多少，批量执行进度最多上报 100 次，避免进度事件数量随配置增长。
export const simulatedTestCaseProgressReportLimit = 100;

// 插件执行中间数据只写入当前节点私有的工作区。
export const workspaceDirectoryUri = "workspace://hello-world";
export const workspaceContextUri = `${workspaceDirectoryUri}/context.json`;
export const workspaceReportUri = `${workspaceDirectoryUri}/report.json`;
export const cleanupMarkerUri = `${workspaceDirectoryUri}/cleanup.json`;

// 工作区报告复制到产物区后，宿主通过该 URI 收集最终结果。
export const artifactReportUri = "artifact://hello-world-report.json";
