# CANoe Flash 适配器

`canoe_flash_adapter` 将固件和刷写参数装配到 CANoe 工程，通过 Automation
运行指定测试模块，并根据报告中的软件版本与 Verdict 判断刷写结果。

## 运行前提与快速开始

需要 Windows、CANoe 及包含刷写测试模块的工程。当前支持主版本
**15、16、17、18、19、20**。脚本使用 JavaScript、COM 和 CLI 运行时。

启动新实例时，适配器会先检查 `CANoe.Application` 的 `LocalServer32`。若当前 COM
注册指向其他版本，将通过目标安装目录的 `Exec64/RegisterComponents.exe` 请求 UAC，
切换并复核注册后才启动 CANoe。取消 UAC 或切换失败会立即终止；附加已有实例不会修改
注册，但仍会校验实例版本。

在仓库根目录构建：

```sh
cmake --preset=dev-fast
cmake --build --preset=dev-fast --target plugin_canoe_flash_adapter
```

在 GUI 或 TUI 中导入并启用生成的插件，配置设备属性 `CANOE_VERSION`，
再提供工程 ZIP `CANOE_PROJECT` 和固件 `SOFTWARE_PACKAGE`；
`FLASH_PARAMETERS` JSON 为可选输入。

## 文档与维护

- [工程契约、执行流程与产物](docs/usage.md)。
- [增加 CANoe 版本支持](docs/version-support.md)。
- [插件清单](PackageInfo.json)、[工作流](StepConfig.groovy)与[脚本入口](scripts/canoe_flash.js)。

测试用例与多格式测试报告的规则见[CANoe 测试插件](../canoe_test_adapter/README.md)。
