# Hello World 输入与执行

## 输入与参数

| 输入 | 必填 | 规则 |
| --- | --- | --- |
| `CANOE_PROJECT` | 是 | `.zip`；用于客户端任务输入装配契约，当前模拟脚本不读取工程内容 |
| `TEST_CASE_IDS` | 否 | `.json` / `.txt`；当前模拟脚本不读取此筛选项 |
| `WAIT_DURATION_SECONDS` | 是 | 整数秒，0～600 |
| `TEST_CASE_COUNT` | 是 | 整数，1～100000 |
| `TEST_CASE_DURATION_MS` | 是 | 整数毫秒，0～60000 |
| `TEST_CONFIG_COUNT` | 是 | 整数，1～8；用例树按该数量拆成多个 config |

无设备属性。整数由宿主装配为 `input://` 文本文件，脚本严格检查整数格式和范围。
该插件验证模拟工作负载，输入名沿用测试平台工程分类；不会操作 CANoe。

在 GUI 或 TUI 离线执行中使用相同输入。较大的条数和耗时组合可能超过工作流
`helloWorld` 阶段的 660 秒总预算；每个完成的用例只重置节点预算。

## 阶段与产物

| 阶段导出 | 行为 |
| --- | --- |
| `prepareWorkspace` | 创建 `workspace://hello-world`，重置状态并写入 `context.json` |
| `validateInput` | 校验三个整数参数并保存本次执行快照 |
| `helloWorld` | 等待指定秒数，再逐条模拟用例；输出开始 / 结束日志与批量进度 |
| `verifyResult` | 校验执行完成状态与统计，生成并回读 `report.json` |
| `publishReport` | 发布 `REPORT_URI`，对应 `artifact://hello-world-report.json` |
| `cleanup` | `post.always` 写入 `cleanup.json`，保留报告和工作区供诊断 |

用例 ID 为 `CT_TEST_CASE_01` 起的递增编号；奇数用例通过，偶数用例失败。
这些失败是模拟数据，批次完整执行后仍生成成功报告。报告包含任务 ID、消息、
参数、通过 / 失败数量和实际耗时。进度批量上报最多 100 次。

`helloWorld` 阶段还通过 `task.reportResult()` 上报逐用例明细与统计：用例 ID、名称、
结论、模拟耗时和失败说明随任务结果进入 `result_json`，供平台执行结果与用例明细使用。
统计始终覆盖配置的全部用例，逐用例明细最多上报 5000 条，避免超大任务撑大结果快照。

## 测试用例树（`@atech/task/case`）

本插件同时演示宿主新增的用例树 API，用于驱动任务详情页的「测试详情」页签：

| 调用 | 时机 | 说明 |
| --- | --- | --- |
| `taskCase.publish(tree)` | `validateInput` | 发布一个 config 的完整用例树，重复发布整棵替换 |
| `taskCase.start(caseId, {configId})` | 每条用例开始前 | 标记用例进入执行中 |
| `taskCase.finish(caseId, {configId, result, durationMs, message})` | 每条用例结束后 | 写入结论与实测耗时 |
| `taskCase.stats()` / `taskCase.trees()` | 需要时 | 读取汇总统计与已发布树清单 |

树结构为两级：config → 通信层 / 应用层 → 用例。用例按 `TEST_CONFIG_COUNT`
均分到多个 config，因此把该参数设为大于 1 即可验证"同一任务多棵用例树"的
分组展示；设为 1 时界面只显示单棵树。层级节点的结论与耗时由宿主按子用例
自动汇总，脚本不需要计算。

用例状态先由 `start` 置为执行中、再由 `finish` 置为通过或失败，因此执行过程
中测试详情页能看到实时进度。`durationMs` 用真实计时器测量，反映实际执行耗时
而不是配置值。

## 维护与验证

入口 [hello_world.js](../scripts/hello_world.js) 只组合并导出各模块函数。
工作区、参数执行和报告分别位于 `scripts/hello_world/`，固定限制与 URI 集中在
`constants.js`；修改输入范围时同步核对清单与本说明。

可用短任务核对阶段、日志、报告、清理，再用长任务核对暂停、继续、取消与超时。
生产脚本的自动回归由运行时测试覆盖：

```sh
ctest --preset=dev-fast -R 'AtechCICTPilot_(plugin_compiler|runtime_interface|tui_)'
```

GUI 操作效果由用户验证。全体适配器共用的开发规范见
[插件开发约定](../../../../docs/development/plugin-development.md)。
