# CANoe 测试插件版本支持维护

当前版本集合由本插件[清单](../PackageInfo.json)的 `CANOE_VERSION` 枚举和
[会话实现](../scripts/canoe_test/session.js)的 `SUPPORTED_CANOE_VERSIONS` 共同约束，
当前为 **15、16、17、18、19、20**。增加主版本时，例如 CANoe 21，按下列范围修改。

## 修改范围

1. 在本插件 `PackageInfo.json` 的 `CANOE_VERSION.values` 中加入新版本，保持顺序。
2. 更新 `scripts/canoe_test/session.js` 的版本白名单；只有清单改变会导致新版本在执行时被拒绝。
3. 核对 CANoe、sabcmd、Test Report Viewer 的安装发现配置。常规主版本变化不需要
   修改宿主发现器；产品显示名称或相对安装路径改变时，应同步调整权限声明和发现策略。
4. 同步本插件 [README](../README.md)、[执行说明](execution.md)中的支持范围和示例，
   按发布策略调整 `PackageVersion`。
5. 更新 `test/plugin_compiler_test.py` 与 `test/runtime_interface_test.cpp` 中该插件的
   版本集合、枚举顺序、版本匹配和包版本断言。

CANoe Flash 的版本范围由[刷写插件版本指南](../../canoe_flash_adapter/docs/version-support.md)
独立维护。两个插件同时声明支持新版本时，分别修改、验证各自的清单和会话脚本。

## 安装发现与版本核对

宿主根据 `CANOE_VERSION` 从 Windows Uninstall 安装项匹配产品名称、
`DisplayVersion` 主版本和相对可执行文件路径：

| 权限 Id | 相对路径 | 发现失败时的设备目录 |
| --- | --- | --- |
| `CANOE_EXECUTABLE` | `Exec64/CANoe64.exe` | `CANOE_INSTALL_DIR` |
| `CANOE_SABCMD` | `Exec64/sabcmd.exe` | `CANOE_INSTALL_DIR` |
| `CANOE_REPORT_VIEWER` | `ReportViewerCli.exe` | `CANOE_REPORT_VIEWER_DIR` |

注册表发现优先；失败后才使用可选目录属性。不得借目录回退绕过版本核对。
COM 使用无数字后缀的 `CANoe.Application`，连接后 `Application.Version`
必须等于 `CANOE_VERSION`。

准备阶段读取实际 `.cfg` 文件头，允许工程主版本小于或等于配置版本。
新增版本应覆盖同版本、向下加载、拒绝更高版本、无法识别文件头，以及失败后跳过
主阶段且仍尝试清理的路径。GUI / TUI 设备属性选项来自清单，前端只做通用必填校验。

## 验证

在仓库根目录重新配置并构建，再运行相关自动回归：

```sh
cmake --preset=dev-fast
cmake --build --preset=dev-fast
ctest --preset=dev-fast -R 'AtechCICTPilot_(plugin_compiler|canoe_project_version|runtime_interface|tui_)'
```

自动化断言通过后，仍需在安装了新 CANoe 版本的 Windows 工位核对：产品名和安装
路径、COM 版本、Measurement / TestConfiguration 接口、报告生成与转换、多版本
共存时的进程选择、任务结束后的资源释放。GUI 显示由用户验证。

不需要为常规新版本单独增加 QML / TUI 枚举，或向 `PluginService`、
`PluginExecution` 添加 CANoe 版本白名单。
