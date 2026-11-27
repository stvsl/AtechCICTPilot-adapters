# VCarDAS SDK 与实例调研

调研日期：2026-11-16。本文记录提供的 SDK、程序和公开资料中的可核查行为。
当前业务方案以[实现方案](implementation.md)为准，不将只读调研等同于真实工具
联调通过。

## 范围

- Python SDK：`VCarDas/TestModuleSDKApps/DasPythonSDK`，包括使用文档、正式
  `sdk/`、示例和启动相关测试。
- 随附程序：`VCarDas/TestModuleSDKApps/Das2App_SDK_1111` 的
  `VCarDAS2.exe`、`VCarDAS2.dll`、`Gemini.dll` 以及配置文件。
- 随附中英文手册：`Helps/Das2Halpbook.pdfky`（152 页）、
  `Helps/Das2HalpbookEN.pdfky`（213 页）。这两个文件实际为可读取的 PDF。
- 官方[VCAR DAS 产品页](https://www.vcarsystem.cn/products/55.html)、
  [下载页](https://www.vcarsystem.cn/downloads.html?type=product&id=55)
  以及下载页链接的公开产品手册。

本地参考路径相对于用户提供的 `doc/VCarSystem` 目录。调研中读取版本资源得到：
`VCarDAS2.exe` / `VCarDAS2.dll` 文件版本为 `1.0.0.0`，`Gemini.dll` 为
`2.3.14.0`；这些资源字段不能代替厂商对具体交付版本的确认。

## SDK 中的端口与进程

`sdk/sdk.py` 将 `DAS2SDK(host, port, request_timeout)` 的 `host`、`port` 拼接为
`ws://<host>:<port>`，交给客户端。它们只控制客户端连接地址。

`sdk/application.py` 的 `ApplicationModule.start()`：

1. 先连接目标 RPC 地址探测已有会话；若已连接，断开并报错
   `RPC endpoint already has a session; refusing to start another DAS`。
2. 以指定 EXE 和 `--unattended` 启动新进程，工作目录是 EXE 所在目录。
3. 查询 `ApplicationStatus`，核对 `ProcessId` 与新启动的 PID 一致并等待 Ready。

启动时没有将 SDK 的 `port` 传给 EXE。示例脚本的 `--port` 也只是客户端连接参数，
不能当成 VCarDAS 支持同名启动参数的依据。SDK 使用文档第 5.1 节及
`tests/test_application.py` 的 `test_existing_endpoint_is_not_reused` 与上述
行为一致。

## 随附程序的监听地址

只读检查提供程序的启动与服务初始化逻辑，发现：

| 位置 | 行为 |
| --- | --- |
| `VCarDAS2.StartupArguments.Parse` | 识别 `--unattended` 和存在的 `.das` 路径，未找到服务端端口参数 |
| `Gemini.AppBootstrapper.StartRemoteServices` | 从 `ConfigHelper.LoadConfig().RemoteUrl` 读取监听地址，空值时使用 `ws://localhost:8777` |
| `Gemini.Helpers.ConfigHelper` | 从 Windows“文档”目录下的 `VCARSYSTEM/VCARDAS2/config.json` 读取配置 |
| `Gemini.RemoteHelper.WebSocketServer` | 将上述 URL 交给 WebSocket 服务端，当前代码路径未发现自动选择另一个空闲端口的逻辑 |

`VCarDAS2.dll.config` 中为主题设置，未找到实例端口设置。没有发现按 EXE 目录自动
隔离 `RemoteUrl` 的证据，因此不能将复制软件目录视为可用的端口隔离方案。

随附中英文手册和已核查官网公开资料均未找到符合要求的多实例启动命令、独立配置
参数或 SDK 示例。中文手册中“多开”指 Trace、Data、示波器等软件内部窗口，不是
可分别控制的进程实例。

结论限于已检查资料：**未确认不修改用户共享配置的多实例控制方式，不能据此断言
产品不支持多实例。** 临时修改共享 `RemoteUrl` 的方式已被用户排除。用户已接受
先处理旧工程再执行本次工程，不再以取得厂商多实例方式为实现前提。

## 旧工程的保存行为

SDK 使用文档第 5.1 节与 `ApplicationModule.close_project()` 明确说明：
`CloseProject` 会保存旧工程后关闭。它不能用作“不保存关闭旧工程”的接口。

用户已选择旧工程由用户手动关闭，再复用保留的空窗口打开本次工程；软件未运行时
启动指定 EXE。插件不自动保存关闭旧工程。

`ApplicationStatus` 当前只返回 `ProcessId`、`Ready`、`FrameworkVersion`。只读
检查显示 Ready 取自主窗口的 `IsLoaded`，不能证明没有旧工程。自动化执行前旧工程
须已由用户关闭，具体状态检查还需联调验证，不以空测试配置树代替工程状态。

该次只读调研没有调用外部 VCarDAS 的打开 / 关闭接口，没有修改共享配置、提供的
工程或 CAPL，也没有启动实际测量、执行刷写。

[返回实现方案](implementation.md)。
