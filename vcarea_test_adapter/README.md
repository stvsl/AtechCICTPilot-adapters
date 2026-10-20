# VCarEA 测试适配器

`vcarea_test_adapter` 启动昆易 VCarEA，通过 Connector SDK 查询 MQTT 连接配置，
再通过 EA MQTT 接口打开工程、执行 Plan、采集 Case 事件并下载报告。

## 运行前提与快速开始

需要 Windows、VCarEA、Connector SDK、.NET 隔离 worker 及启用 CLI / MQTT / DLL.NET
能力的客户端。Connector 包装库位于 `scripts/vcarea/connector_sdk/`。

在仓库根目录构建：

```sh
cmake --preset=dev-fast
cmake --build --preset=dev-fast --target plugin_vcarea_test_adapter
```

在 GUI 或 TUI 中导入并启用生成的包，按需设置 `VCAR_EA_SOFTWARE_PATH`。
任务输入为工程 ZIP `VCAR_EA_PROJECT`、至少一种 `VCAR_EA_REPORT_TYPE`；
`TEST_PLAN_IDS` 可选。工程解压后需有唯一 `.hlt` 和至少一个 `.plan`。

## 文档与维护

- [依赖、执行、输入、选项与报告](docs/execution.md)。
- [EA 外部调用接口](docs/EA外部调用接口.md)：厂商 MQTT 协议参考。
- [排障辅助脚本](docs/main.py)与 [SDK 加载器](docs/sdk_loader.py)：使用前阅读执行说明中的 pythonnet 依赖。
- [Connector 包装库说明](scripts/vcarea/connector_sdk/README.md)。
- [插件清单](PackageInfo.json)、[工作流](StepConfig.groovy)与[脚本入口](scripts/vcarea_test.js)。
