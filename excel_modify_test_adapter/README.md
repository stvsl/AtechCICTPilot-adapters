# ExcelModifyTest 插件

`ExcelModifyTest` 使用随插件携带的纯 JavaScript ZIP / XML 库，将内置
`BootloaderTest.xlsx` 中 `FlashPath` 表的 `CfgDriverFile` 对应值更新为
执行时的本地 ISO 8601 时间，保留其他工作簿部件。

## 运行前提与快速开始

需要启用 JavaScript 运行时的客户端，无额外设备属性和任务输入。
运行时无需安装 Excel 或 Node.js。

在仓库根目录构建：

```sh
cmake --preset=dev-fast
cmake --build --preset=dev-fast --target plugin_ExcelModifyTest
```

在 GUI 或 TUI 中导入生成的插件包并启用，创建包含 `ExcelModifyTest` 节点的
离线任务。完成后查看 `BootloaderTest.xlsx` 与 `ExcelModifyTest-result.json` 产物。

## 文档与维护

- [修改边界、依赖构建与验证](docs/implementation.md)。
- [插件清单](PackageInfo.json)、[工作流](StepConfig.groovy)与[脚本入口](scripts/excel_modify_test.js)。
- [工作簿模板](scripts/data/BootloaderTest.xlsx)与[定点修改实现](scripts/xlsx.js)。

供应商库的构建源和锁文件由 `tools/excel_modify_test_vendor/` 维护；插件文档
负责记录随包依赖、许可证和可支持的工作簿范围。
