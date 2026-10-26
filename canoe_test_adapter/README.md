# CANoe 测试适配器

`canoe_test_adapter` 使用 Windows CANoe Automation 执行 ZIP 压缩包中的多个 `.cfg`
工程。适配器按工程清单顺序运行；每个工程结束后先生成并发布报告，再切换到下一个工程。
用例判定失败和报告转换失败会记录到最终汇总并继续后续工程；工程无法打开、版本不兼容
或 Automation 断开时终止剩余工程。

需要 Windows、CANoe 和相应测试工程 / 授权。当前支持主版本 **15、16、17、18、19、20**；
报告转换还需要清单声明的 `sabcmd` 或 CANoe Test Report Viewer。

启动新实例时，适配器会先检查 `CANoe.Application` 当前注册的 `LocalServer32`。
若它没有指向 `CANOE_VERSION` 对应的 `CANoe64.exe`，适配器将通过该安装目录下的
`Exec64/RegisterComponents.exe` 请求 Windows 管理员权限，切换并复核 COM 注册后才
启动 CANoe。此时需要在 UAC 提示中批准；取消或切换失败会立即终止任务。附加已有实例
不会修改 COM 注册，但仍会校验实际实例版本。

在仓库根目录构建插件：

```sh
cmake --preset=dev-fast
cmake --build --preset=dev-fast --target plugin_canoe_test_adapter
```

在 GUI 或 TUI 中导入并启用生成的插件，配置 `CANOE_VERSION` 和
`NEW_CANOE_WHEN_START`。任务需提供 `CANOE_PROJECT` ZIP，并在 `CANOE_REPORT_TYPE`
中至少选择一种报告格式。需要筛选用例时加载 `TEST_CASES` 测试用例名称配置文件
（`.json` 或 `.txt`）。

工程规划规则、`canoe.json` 格式以及 JSON / 文本两种用例文件示例见
[工程包说明](docs/project-package.md)。
逐工程动态阶段、报告处理、失败和清理行为见[执行说明](docs/execution.md)。
版本维护见[版本指南](docs/version-support.md)。
