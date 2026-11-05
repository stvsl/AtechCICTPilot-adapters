# CANoe 测试适配器执行逻辑

本文说明 `canoe_test_adapter` 1.0.0 的工程规划、动态阶段、逐工程报告和错误处理。
插件在 GUI 与 TUI 中运行相同的 JavaScript 工作流。

## 工作流

`StepConfig.groovy` 声明固定准备阶段，并在 `beginExecution()` 运行时按工程计划动态添加
逐工程阶段。动态阶段会在静态的 `summarizeExecution()` 之前按序执行。

| 顺序 | 导出函数 | 用途 |
| --- | --- | --- |
| 固定 | `prepare(projectPackage)` | 解压 ZIP、生成工程计划、解析报告和用例输入 |
| 固定 | `launch()` | 按设备设置附加实例，或切换 COM 注册后启动目标 CANoe |
| 固定 | `connect()` | 连接并核对 Automation 实例版本 |
| 固定 | `beginExecution()` | 添加第一个动态工程阶段 |
| 动态 | `executeProject(index)` | 打开单个配置、运行测试、收集报告、释放当前配置 |
| 固定 | `summarizeExecution()` | 发布所有工程结果并在存在失败时结束为失败 |
| 收尾 | `collectArtifacts()` | 失败、取消或中断时补收当前工程部分报告并发布摘要 |
| 清理 | `cleanup()` | 停止测试和 Measurement，按实例所有权退出 CANoe 并释放句柄 |

`task.addStage()` 每次只添加一个后继工程阶段；当前阶段完成后，新阶段再按相同方式添加
下一个工程。每个动态阶段的总超时为 24 小时，用例进展会续期宿主节点预算。

### 启动与 COM 注册

`NEW_CANOE_WHEN_START=true` 时，`launch()` 按以下顺序执行：

1. 根据 `CANOE_VERSION` 解析目标 `Exec64/CANoe64.exe`，关闭当前活动的 Automation
   实例并等待它退出。
2. 查询 `CANoe.Application` 的 CLSID 及其 `LocalServer32`。注册缺失或所指
   可执行文件与目标路径不一致时，解析同一目标安装中的
   `Exec64/RegisterComponents.exe`。
3. 通过 Windows UAC 以管理员权限运行注册工具。该工具不带参数时会注册其所属
   CANoe 安装；适配器等待它结束，并要求退出码为 0。
4. 重新读取 `LocalServer32`，只有它严格指向目标 `CANoe64.exe` 才以
   `-embedding` 启动进程，随后由 `connect()` 核对 Automation 的可执行路径和主版本。

注册已经匹配时不会请求 UAC。用户取消 UAC、注册工具启动失败/超时/返回非零退出码，
或注册后复核仍不匹配，都会立即终止主流程，不再进入 Automation 连接等待。任务结束后
不会恢复原先的 COM 注册；最后成功选择的目标版本保持为后续 Automation 默认版本。

`NEW_CANOE_WHEN_START=false` 时只附加当前活动实例，不关闭进程、不运行注册工具，也不
修改 COM 注册；`connect()` 仍要求该实例的 `Application.Version` 等于
`CANOE_VERSION`。

## 工程计划

优先级如下：

1. 提供 `TEST_CASES` 时，按用例文件（`.json` 或 `.txt`）中配置的工程顺序和用例名称
   执行。每个配置的 `.cfg` 路径相对于 ZIP 根目录；相同配置条目会合并用例名称。
   文本格式每行为 `<相对 .cfg 路径>:<用例>[,<用例>...]`。
2. 未提供 `TEST_CASES` 且存在唯一 `canoe.json` 时，解析版本组，筛选
   `CanoeVersion <= CANOE_VERSION`，选择最高兼容版本。该版本组的 `Configuration`
   数组顺序就是执行顺序；路径相对于 `canoe.json` 所在目录。
3. 没有 `canoe.json` 时，递归查找全部 `.cfg`，以相对路径排序后执行。

所有配置都必须存在且为安全相对 `.cfg` 路径。用例文件和清单均在开始 CANoe 执行前
验证路径；准备阶段提前核验首个 `.cfg` 的文件头版本，避免不兼容时启动 CANoe。
后续 `.cfg` 在该工程即将执行时核验，因此前序工程已完成后，才会遇到后续配置的
版本不兼容并停止。

当前 CANoe 主版本支持 15 至 20。配置文件的 CANoe 软件主版本必须小于或等于设备版本，
例如 CANoe 17 可以向下打开 CANoe 16 工程。无法识别的版本头和高于系统版本的配置都
作为致命错误处理。

## 每工程执行和资源边界

每个动态阶段按以下顺序运行：

1. 核验 `.cfg` 版本，并调用 `Application.Open` 打开配置；配置切换前停止旧工程的
   Measurement，释放旧 Configuration / Measurement COM 句柄。
2. 检测当前工程的 `TestConfiguration` 或 `TestEnvironment`。用例文件存在时，按测试
   用例名称启用匹配项；未指定用例时复用工程内已有的启用项。
3. 保存报告文件基线、设置所选原生报告格式并启动 Measurement。
4. 串行运行配置中的测试，轮询用例 Verdict、记录结果和进度。
5. 测试结束后等待 CANoe 报告写入完成，按需转换格式并立即发布当前工程报告。
6. 停止测试和 Measurement，释放本工程 COM 句柄，但保留 CANoe 应用会话供下一个工程使用。

报告产物使用 `artifact://canoe-test/reports/<cfg 文件名（不含扩展名）>/`，保留原名中的
中文、空格和标点，并保留工程内相对目录。同名配置（不区分大小写）按执行顺序为后续目录
追加 `-2`、`-3` 等编号，跳过其他配置本身使用的名称，避免报告覆盖。最后发布
`artifact://canoe-test/execution-result.json`，其中包含工程状态、用例 Verdict、报告错误、
各工程报告路径和执行错误。

摘要的 `Completed` 表示所有工程的测试已运行完毕，`Passed` 表示所有工程和报告均通过。
`StartedProjectCount` 和 `CompletedProjectCount` 分别统计已开始和已完成测试的工程数量；
取消、致命错误和未执行工程不会被计为通过。

收尾阶段（`collectArtifacts`）还会通过 `task.reportResult()` 把逐用例 Verdict 与
通过 / 失败统计上报宿主：`caseId` 由“工程序号 / 测试单元 / 用例 ID”组成，`result`
为 `passed` / `failed`，`message` 记录原始 Verdict。统计覆盖全部已执行用例，逐用例
明细最多上报 5000 条（超出部分只保留在本地摘要中）。未执行任何用例时不上报，
不会把“未执行”伪造成“全部通过”。

## 失败与取消

| 情况 | 后续工程 | 最终结果 |
| --- | --- | --- |
| 测试用例 Verdict 未通过 | 继续 | 汇总阶段将任务判为失败 |
| 报告生成、转换或发布失败 | 继续 | 记录报告错误，汇总阶段将任务判为失败 |
| 工程测试配置或执行发生可恢复错误 | 尝试清理后继续 | 该工程记为失败，汇总阶段将任务判为失败 |
| COM 注册切换失败或用户取消 UAC | 终止 | 未启动目标 CANoe，立即进入收尾 |
| `.cfg` 版本高于 CANoe、配置打不开 | 终止 | 保留当前部分结果，执行收尾和资源清理 |
| CANoe Automation 断开或进程异常退出 | 终止 | 执行收尾和资源清理 |
| 用户取消或阶段超时 | 停止新增工程阶段 | 尝试补收当前部分报告并清理资源 |

报告转换失败不会阻止后续工程。Automation 断开是例外：报告处理检测到断连后立即终止
工程序列。主阶段失败后，宿主仍运行 `post.always`；收尾只补收尚未处理的当前工程，正常
完成过的报告不会重复发布。

`NEW_CANOE_WHEN_START=true` 时由插件启动并拥有 CANoe 进程，最终清理会退出该进程；
附加现有进程时默认保留它。设置 `QuitAttachedInstance=true` 可显式请求退出附加实例。

## 输入和运行前提

| 输入 | 要求 |
| --- | --- |
| `CANOE_PROJECT` | 必填 `.zip`，含一个或多个 `.cfg`，可含 `canoe.json` |
| `TEST_CASES` | 可选 `.json` 或 `.txt`，列出配置路径和测试用例名称 |
| `CANOE_REPORT_TYPE` | 必填多选：`vtestreport`、`XML`、`HTML`、`PDF` |
| `CANOE_VERSION` | 必填 CANoe 主版本 15、16、17、18、19 或 20 |
| `NEW_CANOE_WHEN_START` | 必填布尔值：启动新实例或附加当前实例 |

需要 Windows CANoe Automation。启动新实例还要求目标安装包含
`Exec64/RegisterComponents.exe`，并允许用户批准 UAC。报告转换使用宿主按
`CANOE_VERSION` 发现的 CANoe Report Viewer 和 `sabcmd.exe`；版本安装路径可通过
清单中的可选设备目录指定为发现失败时的回退路径。

## 源码定位

- [工作流](../StepConfig.groovy)
- [插件清单](../PackageInfo.json)
- [入口和逐工程执行](../scripts/canoe_test.js)
- [工程规划和用例文件校验](../scripts/canoe_test/project_plan.js)
- [CANoe 会话和配置切换](../scripts/canoe_test/session.js)
- [报告自动化](../scripts/canoe_test/report_automation.js)
- [报告文件跟踪](../scripts/canoe_test/report_files.js)
- [工程包格式](project-package.md)
- [版本支持维护](version-support.md)
