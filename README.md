# 内置适配器与文档

每个插件在自己的目录中维护 `README.md` 和 `docs/`：README 提供定位、依赖、
快速开始与详细文档入口；`docs/` 保存使用契约、示例、维护指南与历史调研。
修改插件行为时同步修改本插件文档。

| 插件 | PackageId | 主要用途 |
| --- | --- | --- |
| [ATECH BootLoad](atech_bootload_adapter/README.md) | `atech_bootload_adapter` | 调用厂商 CLI 进行 CAN / DoIP 离线刷写 |
| [CANoe 测试](canoe_test_adapter/README.md) | `canoe_test_adapter` | VTEST / 通信测试、报告生成与发布 |
| [CANoe Flash](canoe_flash_adapter/README.md) | `canoe_flash_adapter` | 调用工程中的刷写模块并验证软件版本 |
| [ExcelModifyTest](excel_modify_test_adapter/README.md) | `ExcelModifyTest` | 验证随包 JavaScript 库定点修改 XLSX |
| [Hello World](hello_world_adapter/README.md) | `hello_world_adapter` | 验证多阶段执行、日志、进度、产物与清理 |
| [VCarEA 测试](vcarea_test_adapter/README.md) | `vcarea_test_adapter` | Connector 配置发现、MQTT Plan 执行与报告下载 |

公共开发规则见[插件开发约定](../../docs/development/plugin-development.md)，
脚本可用的模块和权限见[运行时文档](../../docs/runtime/README.md)。
新建插件可使用[适配器插件工作台](../../tools/adapter_scaffold/README.md)，
其模板会一并生成 README 和使用文档。
