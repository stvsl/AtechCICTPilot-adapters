# CANoe 测试适配器

`canoe_test_adapter` 通过 Windows CANoe Automation 执行 VTEST 或通信测试，
支持用例筛选、暂停检查点、进度与原生 / 转换报告发布。

## 运行前提与快速开始

需要 Windows、CANoe 及对应测试工程 / 授权。当前支持主版本
**15、16、17、18、19、20**；报告转换还需要清单声明的 `sabcmd` 或
Test Report Viewer。脚本使用 JavaScript、COM 和 CLI 运行时。

在仓库根目录构建：

```sh
cmake --preset=dev-fast
cmake --build --preset=dev-fast --target plugin_canoe_test_adapter
```

在 GUI 或 TUI 中导入并启用生成的插件，配置 `CANOE_VERSION` 与
`NEW_CANOE_WHEN_START`。创建任务时提供 `CANOE_PROJECT` ZIP，并为
`CANOE_REPORT_TYPE` 至少选择一种格式；`TEST_CASE_IDS` 可选。

## 文档与维护

- [工程包与用例筛选](docs/project-package.md)：当前 `ContractVersion: "1.0"` 契约。
- [完整执行逻辑](docs/execution.md)：阶段、实例所有权、报告、异常与清理。
- [增加 CANoe 版本支持](docs/version-support.md)：本插件的清单、脚本和验证清单。
- [插件清单](PackageInfo.json)、[工作流](StepConfig.groovy)与[脚本入口](scripts/canoe_test.js)。

CANoe Flash 的工程与行为由[刷写插件](../canoe_flash_adapter/README.md)独立维护。
