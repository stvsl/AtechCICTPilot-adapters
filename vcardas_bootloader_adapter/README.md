# VCarDAS Boot刷写适配器

根据任务提供的 App、Driver 文件，动态匹配同一个 VCarDAS 工程内的 BOOT
刷写目标，并为每个匹配目标创建、编译和运行同名测试模块。

已实现工程随附 CMD 打包与产物校验、刷写数据加载、SDK 进程核验、模块重建编译、逐目标
单轮串行执行、结果与报告发布，以及取消和异常收尾。CAPL 保持原样，固定使用
`D:\KUNYI_flash\`。任务工程副本保存为仅含「测试配置」的单页布局，并在打开工程后通过
SDK 显示测试配置页，仅删除全树中与本次目标同名的 CAPL/XML 模块，保留其他测试项、环境结构和勾选状态，并在原有环境中创建本次模块；VCarDAS 仍会按自身流程加载工程数据。旧工程由用户先手动关闭，再复用空窗口打开本次工程；软件未
运行时启动指定 EXE，不修改 VCarDAS 用户共享配置。

已加入隔离目录中的本机脚本、模拟 SDK 与完整工作流回归。真实 VCarDAS 的可见空白
启动页已用于窗口空工程识别；CAPL 编译和台架刷写仍需现场验收。无法证明窗口为空时
会在打开工程前拒绝执行。

插件 ID：`vcardas_bootloader_adapter`；版本：`1.0.0`；脚本语言：`javascript`。

## 构建与使用

在仓库根目录执行：

```sh
cmake --preset=dev-fast
cmake --build --preset=dev-fast --target plugin_vcardas_bootloader_adapter
```

插件包位于 `build/dev-fast/plugins/vcardas_bootloader_adapter-<完整版本>.cictplugin`。
在 GUI 或 TUI 中导入并启用插件，配置设备属性，再创建任务。

## 文档与源码

- [输入、设备配置与执行说明](docs/usage.md)。
- [实现方案、SDK 对照与验证边界](docs/implementation.md)。
- [SDK 与实例调研](docs/sdk-research.md)。
- [插件清单](PackageInfo.json)与[工作流](StepConfig.groovy)。
- [脚本入口](scripts/entry.js)。

本 README 与 `docs/` 由本插件维护，修改行为时同步更新文档。
