# 动态阶段测试插件

`dynamic_stage_test_plugin` 用于验证插件在执行过程中创建后继阶段。无需外部软件、
设备权限或自检，支持 Windows、Linux 和 macOS。

`StepConfig.groovy` 仍声明引导、最终验证和收尾。引导阶段只生成 `dynamic_1`；
每个动态阶段执行成功后再生成下一个阶段，全部完成后继续静态验证阶段。
动态阶段有独立 ID、名称、实参、超时、进度和日志，沿用任务暂停与取消机制。

```sh
cmake --preset=dev-fast
cmake --build --preset=dev-fast --target plugin_dynamic_stage_test_plugin
```

在 GUI 或 TUI 的适配器管理中导入
`build/dev-fast/plugins/dynamic_stage_test_plugin-<完整版本>.cictplugin`，
进入离线执行，选择“动态阶段测试”。全部输入留空即可执行三个动态阶段。
任务详情展示实际生成的阶段，发布资源包含 `dynamic-stage-report.json`。

详细参数、失败与取消操作及测试命令见[使用与验收](docs/usage.md)。
公共接口见[JavaScript 运行时](../../../docs/runtime/javascript.dox)和
[执行契约](../../../docs/runtime/execution.dox)。
