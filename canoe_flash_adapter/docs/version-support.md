# CANoe Flash 版本支持维护

本插件当前支持 **15、16、17、18、19、20**。版本由本插件
[PackageInfo.json](../PackageInfo.json) 和
[session.js](../scripts/canoe_flash/session.js) 独立维护。

## 增加主版本

1. 在 `PackageInfo.json` 的 `CANOE_VERSION.values` 中加入新主版本。
2. 更新 `scripts/canoe_flash/session.js` 的 `SUPPORTED_CANOE_VERSIONS`。
3. 核对权限 `CANOE_EXECUTABLE` 的安装发现：产品名模板为 `Vector CANoe {version}`，
   相对路径为 `Exec64/CANoe64.exe`，发现失败后使用 `CANOE_INSTALL_DIR`。
4. 同步本插件 [README](../README.md) 和本说明，按发布策略调整包版本。
5. 更新 `test/plugin_compiler_test.py`、`test/runtime_interface_test.cpp` 中刷写插件
   的版本集合、数量、顺序、安装发现与包版本断言。

本插件无需测试报告转换工具。若同时扩展 CANoe 测试能力，应按
[测试插件版本指南](../../canoe_test_adapter/docs/version-support.md)单独核对
其 sabcmd / Test Report Viewer 权限和报告接口。

## 版本与工程边界

COM ProgID 使用 `CANoe.Application`，不拼接主版本。连接后的
`Application.Version` 必须等于 `CANOE_VERSION`。
工程 `.cfg` 的主版本可以低于或等于该设备属性，不能高于它；检查在复制固件、修改
系统变量、启动 CANoe 之前执行。

常规新版本无需修改宿主 `WindowsInstalledExecutableResolver`、`PluginService`、
`PluginExecution` 或 GUI / TUI 枚举。产品名、安装布局、配置头或 Automation 接口
变化时，应调整对应实现并增加测试。

## 验证

```sh
cmake --preset=dev-fast
cmake --build --preset=dev-fast
ctest --preset=dev-fast -R 'AtechCICTPilot_(plugin_compiler|canoe_project_version|runtime_interface|tui_)'
```

覆盖新主版本的同版本工程、向下加载、更高版本拒绝、实际实例版本不匹配，以及
失败后清理仍执行。真实 Windows 工位还需验证多版本共存时的可执行文件选择、
工程系统变量、刷写模块、报告版本提取和任务退出后的进程回收。GUI 效果交由用户验证。
