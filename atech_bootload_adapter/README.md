# ATECH BootLoad 适配器

`atech_bootload_adapter` 通过 ATECH BootLoad CLI 执行 CAN / DoIP 离线刷写，
解析 CLI 输出并向 GUI / TUI 上报进度，保存配置、原始输出与执行诊断。

## 运行前提与快速开始

需要 Windows 工位上的完整 ATECH BootLoad 工具目录、驱动和设备。
当前 CLI 接口按厂商版本 **1.0.0.1** 验证；脚本使用 JavaScript 和 CLI 运行时。

在仓库根目录构建：

```sh
cmake --preset=dev-fast
cmake --build --preset=dev-fast --target plugin_atech_bootload_adapter
```

在 GUI 或 TUI 的适配器管理中导入并启用生成的包，设置设备属性 `CLI_PATH`，
再创建离线刷写任务。必填输入为配置 ZIP `CONFIG_PACKAGE` 和 Application 固件
`APP_FILE`；Flash Driver 与 Calibration 固件可选。三类固件均支持
`.hex`、`.vbf`、`.s19`、`.mot`、`.sre`、`.mbf`、`.srec`，扩展名不区分大小写。

本版支持 UTF-8 与 Windows 本地代码页输出；客户端与插件包需同时更新，
以提供 `cli.decodeText()` 解码接口。进度条中的方块显示为问号时仍可更新百分比。

## 文档与维护

- [使用、YAML 参数、进度和产物](docs/usage.md)。
- [CAN 模板](docs/examples/can-download.yaml)与 [DoIP 模板](docs/examples/doip-download.yaml)。
- [CLI 调研与验证记录](docs/cli-research.md)：历史证据及真实设备验证边界。
- [插件清单](PackageInfo.json)、[工作流](StepConfig.groovy)与[脚本入口](scripts/entry.js)。

生成配置 ZIP 的工具为 `tools/package_bootload_examples.py`，直接读取本插件
`docs/examples/` 中的模板。更新模板时同步核对打包工具与 BootLoad 专项测试。
