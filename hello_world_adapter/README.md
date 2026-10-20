# Hello World 测试适配器

`hello_world_adapter` 用于验证多阶段执行、模拟长时任务、日志、进度、报告和
始终清理行为，使用 JavaScript 运行时，无外部软件或设备依赖。

## 快速开始

在仓库根目录构建：

```sh
cmake --preset=dev-fast
cmake --build --preset=dev-fast --target plugin_hello_world_adapter
```

在 GUI 或 TUI 中导入并启用生成的插件包，然后创建离线任务。
按清单提供 `CANOE_PROJECT` ZIP、等待秒数、模拟用例条数和单条耗时；
短任务可选择 `0` 秒、`2` 条、每条 `0` 毫秒。

完成后查看 `artifact://hello-world-report.json`。模拟用例交替通过与失败，
工作流在模拟批次完整执行并校验成功后完成。

## 文档与维护

- [输入、执行阶段与验证边界](docs/usage.md)。
- [插件清单](PackageInfo.json)、[工作流](StepConfig.groovy)与[脚本入口](scripts/hello_world.js)。

本插件的示例和模拟约定在本目录维护。宿主执行机制见
[运行时执行契约](../../../docs/runtime/execution.dox)。
