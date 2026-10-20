# 埃泰克 BootLoad CLI 调研与离线刷写方案

> 历史调研与验证记录，基于 2026-10-19 的工具和环境。下文的方案与实施日志保留
> 当时的上下文；当前操作与参数约定以[使用说明](usage.md)和本插件生产脚本为准。

## 已确认的需求

- 本次实现离线刷写和客户端进度展示，GUI 与 TUI 使用同一后端。
- 插件设备配置只保留一个文件选择框，选择 `ATECH BootLoad CLI.exe`。
- 配置输入是真实 ZIP 压缩包，内部只放一份 YAML 配置。
- Application 必选，Flash Driver、Calibration 可选，三类固件均仅接受 `.hex` 文件。
- 开发第一步完成 CAN、DoIP 两份 YAML 配置文件及配置 ZIP 示例，再实现配置解析。
- 复用现有 `src/adapter/atech_bootload_adapter/`，插件 ID 为
  `atech_bootload_adapter`。

本文记录调研结论、已实施方案及验证结果；尚未完成真实设备刷写验证。

## 调研对象与验证方法

调研日期：2026-10-19。

实际程序目录：
`D:\Work\2.Projects\11_CICT\docs\ATECH BootLoad Tools_v1.0.0.1`。

两个入口的文件版本均为 `1.0.0.1`：

- `ATECH BootLoad CLI.exe`：命令行入口，调用
  `uds_test.CommandLineHost.Run(args)`。
- `ATECH BootLoad Tools.exe`：包含共享刷写运行时和命令行实现。
  部署时需要保留原工具目录中的依赖程序集及驱动目录。

已执行 `help`、`list-projects`，并使用 ILSpy 静态检查
`CommandLineHost`、`BootLoadRuntime`、`CommandLineOptions`。
另在 32 位 PowerShell 中仅实例化 `ConsoleProgressRenderer`，验证输出重定向时
的进度文本；该验证不构造刷写运行时、不连接 CAN 或 DoIP 设备。

未执行 `can-download` 或 `doip-download`。

## 进度能力结论

**现有 CLI 已提供可供插件读取的进度文本，无需增加进度参数即可接入。**

`BootLoadRuntime` 提供内部事件：

```csharp
public event Action<string> Output;
public event Action<int> Progress;
```

刷写循环读取 `downloadStep.progress`，在数值变化时触发 `Progress`。
`CommandLineHost` 将该事件接入 `ConsoleProgressRenderer.Report(int)`，
最终写入标准输出。该 C# 事件属于进程内部接口，插件调用 EXE 时通过 stdout
接收它的文本表示。

渲染器将进度限制在 0 到 100，输出百分比保留一位小数：

```text
[██████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 进度   12.0%
[██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 进度   21.0%
```

以上为渲染器验证输出，不是真实设备刷写日志。

输出行为由 `Console.IsOutputRedirected` 决定：

| 场景 | 行为 |
| --- | --- |
| 交互控制台 | 用回车刷新同一行，每次进度变化均可更新 |
| 管道重定向，包括平台的 QProcess | 按 `progress / 10 * 10` 分档，仅在进入不同档位时打印一行；100 单独处理 |

因此管道输出大约每 10% 更新一次，但打印的是当次实际百分比，并不保证恰好是
10、20、30。例如验证输入 `0, 1, 9, 12, 15, 21, 28, 99, 100`，实际输出
`0.0%, 12.0%, 21.0%, 99.0%, 100.0%`。

当前命令行实现没有 JSON 进度模式或查询进度命令。
`--verbose` 只增加内部下载状态机日志，不改变进度渲染器的分档策略。
如果将来要求逐 1% 更新，需要修改 CLI 的重定向输出策略。

## 实际支持的参数

`CommandLine.md` 是简要说明，以下以实际程序的帮助和实现为依据。

模式作为第一个位置参数，支持 `can-download`、`doip-download`。
两种模式都要求 `--project` 和 `--application`。

| YAML 键 / CLI 参数 | 适用范围 | 含义与默认值 |
| --- | --- | --- |
| `project` | 通用 | 项目名称；CLI 支持完整名称或唯一的部分名称，模板建议使用完整名称 |
| `application` | 通用 | Application 文件，必选；由任务输入注入 |
| `flash-driver` | 通用 | Flash Driver 文件，可选；由任务输入注入 |
| `calibration` | 通用 | Calibration 文件，可选；由任务输入注入 |
| `force` | 通用 | 布尔开关，发送项目配置的强制会话请求 |
| `timeout` | 通用 | 刷写循环总超时，默认 1800 秒 |
| `stall-timeout` | 通用 | 内部进度无变化超时，默认 60 秒 |
| `verbose` | 通用 | 布尔开关，输出内部状态机日志 |
| `driver` | CAN / CAN FD | 驱动子目录名，未指定时使用工具保存的选择 |
| `channel` | CAN / CAN FD | 通道索引，从 0 开始，默认 0 |
| `baud` | CAN / CAN FD | 仲裁域波特率，默认使用项目配置 |
| `fd-baud` | CAN FD | 数据域波特率，默认使用项目配置 |
| `fd` | CAN / CAN FD | 布尔开关，强制启用 CAN FD；项目配置也可以自动启用 |
| `entity` | DoIP | 实体 IPv4 地址，默认使用项目配置 |
| `multicast` | DoIP | 广播或组播地址，默认 `255.255.255.255` |
| `source` | DoIP | 测试端逻辑地址，十六进制，默认使用项目配置 |
| `target` | DoIP | ECU 物理地址，十六进制，默认使用项目配置 |
| `target-functional` | DoIP | ECU 功能地址，十六进制，默认使用项目配置 |
| `version` | DoIP | 协议版本，十六进制，默认使用项目配置 |
| `route-timeout` | DoIP | 路由激活超时，默认 2000 毫秒 |

本次插件的三类固件输入均仅支持 `.hex`，文件选择筛选和执行前校验保持一致。
CLI 直接读取固件文件，三类固件无需解压。

CLI 对 `force`、`fd`、`verbose` 使用“参数是否存在”判断。
因此 YAML 值为 `false` 时必须省略对应开关，不能传入 `--force=false` 等写法。
CLI 对部分非法数值会回退到默认值，插件应在启动前严格校验并给出错误。

实际查询到的项目名称：

```text
AVATR_BDM_E15_V04
FLZCU_Chery_E03_V02(RSA4096)
FLZCU_Chery_E03_V03(RSA4096)
FRZCU_Chery_E03_V02(RSA4096)
FRZCU_Chery_E03_V03(RSA4096)
Geely_ZCUD_SS21_V01
Geely_ZCUP_SS21_V01
```

## YAML 与离线输入方案

离线表单保留现有四个输入：

| 属性 ID | 输入 | 必填 |
| --- | --- | --- |
| `CONFIG_PACKAGE` | 仅包含一份 YAML 的 ZIP | 是 |
| `APP_FILE` | Application `.hex` 固件文件 | 是 |
| `FLASH_DRIVER` | Flash Driver `.hex` 固件文件 | 否 |
| `CALIBRATION` | Calibration `.hex` 固件文件 | 否 |

建议不限定 YAML 文件名，在解压目录中查找唯一的 `.yaml` 或 `.yml` 文件。
缺失或存在多份配置时明确报错。

CAN 模板：

```yaml
mode: can-download
project: "FLZCU_Chery_E03_V02(RSA4096)"
driver: "PEAK PCAN"
channel: 0
baud: 500000
fd-baud: 2000000
force: false
verbose: false
timeout: 1800
stall-timeout: 60
```

DoIP 模板：

```yaml
mode: doip-download
project: "AVATR_BDM_E15_V04"
entity: "192.168.69.8"
source: "0E80"
target: "0002"
multicast: "255.255.255.255"
route-timeout: 2000
force: false
verbose: false
timeout: 1800
stall-timeout: 60
```

模式和普通 CLI 参数保存在配置 YAML 中；三类固件路径以离线任务输入为唯一来源。
执行前合成完整配置，补入 `application`、`flash-driver`、`calibration`，保存为
任务产物，避免模板依赖某台工位的固定路径。

采用可随插件打包并在 QuickJS 中运行的成熟 YAML 解析库，限制为单个顶层键值对象，
校验重复键、未知字段、类型、取值范围及模式适用性。
十六进制值要求字符串，保留 `"0002"` 等前导零。

## 执行与展示方案

1. 校验设备配置中的 CLI 路径及四个任务输入。
2. 安全解压配置包到任务工作区，解析并校验 YAML。
3. 合并固件路径，构造独立参数数组，使用 `@atech/cli.start()` 启动。
   工作目录设为 `executable://`，使用工具目录内的依赖和驱动。
4. 通过 `cli.read()` 增量读取输出，缓冲半行，以完整行识别进度条。
   进度匹配限定为进度条格式，避免把“停滞超时，当前进度 xx%”等日志误认作更新。
   同时保留 stdout、stderr 日志及原始输出。
5. 将真实百分比传给 `task.progress()`，沿用共享任务快照更新客户端。
   对 stdout 的约 10% 更新间隔直接展示，不生成虚假中间进度。
6. 补充执行详情阶段模型的百分比字段，在 GUI 与 TUI 的“刷写”行同时展示。
   运行中读取当前阶段快照，终态读取已保存的阶段结果。
7. 在进程结束后继续读取尾部输出，以正常退出且退出码为 0 判定成功。
   收到 100% 文本不代表成功，仍需等待退出结果。
8. 取消、宿主超时、失败和正常完成都执行进程终结与句柄释放，保存执行配置和日志。

超时使用两个层次：CLI 内部停滞超时由其真实进度变化判断；宿主控制整个进程的
生命周期预算。不能用“stdout 一段时间没有新行”代替 CLI 内部停滞判断，因为
重定向输出经过分档。CLI 的 `timeout` 从连接完成后的刷写循环开始计算，宿主预算
还需覆盖输入准备、连接和退出清理。

| CLI 退出码 | 客户端处理 |
| --- | --- |
| `0` | 正常退出时标记成功 |
| `1` | 参数、文件、连接或刷写失败，展示诊断日志 |
| `2` | 总超时、内部进度停滞或被停止；结合日志说明原因 |
| `64` | 未知指令或命令格式错误 |

自检沿用平台现有的可执行文件校验；准备刷写时可以通过 `list-projects` 校验当前
工具中的项目是否存在，帮助查询及项目查询不触发刷写。

## 执行顺序与代码落点

按以下顺序实施，每一步完成对应验证后再进入下一步。

| 顺序 | 工作内容 | 主要代码落点 | 完成条件 |
| --- | --- | --- | --- |
| 1 | 完成 YAML 配置文件、配置 ZIP 示例及插件输入约定 | CAN / DoIP YAML 模板、样例 ZIP、`src/adapter/atech_bootload_adapter/PackageInfo.json` | 两份 YAML 文件和各自仅含一份配置的 ZIP 示例已完成；GUI、TUI 生成一个 EXE 配置项和四个离线输入，三类固件均仅接受 `.hex` |
| 2 | 实现 YAML 解析和参数生成 | 插件 `scripts/bootload/config.js` 及随插件打包的 YAML 依赖 | 按第一步已完成的配置文件实现解析；两种模式均能生成准确的参数数组，错误配置在启动进程前失败 |
| 3 | 实现刷写进程生命周期 | 插件 `scripts/entry.js`、`scripts/bootload/runner.js`、`StepConfig.groovy` | 正确启动、采集、结算、取消、超时及释放进程；所有终结路径均保存诊断 |
| 4 | 打通阶段进度快照 | `TaskService`、`TaskManager`、`TaskExecutionView`、`TaskStageListModel` | 进度按节点、阶段及清理标识正确归属；终态保留该阶段的最终进度 |
| 5 | 完成两个前端展示 | GUI 的 `TaskExecutionDetails.qml` / `TaskExecutionStageRow.qml`，TUI 的 `TasksPage.cpp` 及相关后端快照 | 两个前端的刷写阶段均显示同一百分比、状态和诊断信息 |
| 6 | 完成自动验证和交付资料 | `test/`、`test/CMakeLists.txt`、配置模板和本文档 | 插件、进程、模型及 TUI 验证通过，产出可导入插件和操作说明 |

### 第一步：完成 YAML 配置文件及输入约定

首先完成 CAN、DoIP 两份合法 YAML 配置文件，固定 `mode` 为第一行，并定义各字段
名称、类型、默认值和校验规则。CAN 配置显式指定驱动；DoIP 的逻辑地址字段使用
带引号的十六进制字符串。三类固件路径在执行时由离线表单注入。

将两份配置分别压缩成样例 ZIP，每个 ZIP 内只包含一份 YAML，附上使用说明。
YAML 文件与配置 ZIP 示例在本步骤完成，作为第二步解析模块的输入依据。

保留 `CLI_PATH`、`CONFIG_PACKAGE`、`APP_FILE`、`FLASH_DRIVER`、`CALIBRATION`
五个现有属性 ID，完善中英文名称与文件筛选。Application 必选，Flash Driver、
Calibration 可选，三类固件筛选均为 `*.hex`，执行前也校验文件扩展名。
为 CLI 权限增加明确的可执行文件 ID，供脚本使用 `cli.resolveExecutable()` 解析。
普通刷写使用管道采集输出，`AllowTerminal` 设置为 `false`。

设备路径持久化沿用现有机制；四个任务文件沿用离线工作区复制和输入 URI 机制。

### 第二步：实现 YAML 解析和参数生成

按照第一步已完成的 YAML 文件和字段规则，实现配置模块，负责解压后定位唯一配置、
读取 YAML、应用默认值、校验字段和构造参数数组。
YAML 依赖随插件交付，记录依赖版本、来源和许可。

布尔开关只在值为 `true` 时加入参数；地址字段保持十六进制字符串。
固件路径由任务输入解析到本机路径后注入，避免配置与表单存在两个路径来源。
校验 ZIP 内配置文件数量、未知字段、重复键、模式冲突和非法值，确保错误配置在
启动刷写前失败。

### 第三步：实现进程执行模块

沿用一个“刷写”业务阶段及 `post.always` 清理入口。该业务阶段内完成准备、项目
查询校验、刷写和结果归档，阶段进度专门表示 CLI 提供的真实刷写百分比。

进程使用 `cli.start()` 启动，循环通过 `cli.read()` 采集 stdout 和 stderr，
结合 `cli.isRunning()` 判断退出。每次轮询协作处理取消与执行期限，避免忙循环。
退出后再读取尾部输出并调用 `cli.wait()` 获取结果，最终 `cli.release()`。
不将 `cli.wait()` 的短超时当作轮询手段，因为其超时会结束进程。

输出处理必须覆盖中文编码、多字节字符跨块、半行及回车换行。
进度解析仅接受进度条记录，按已有约 10% 分档节奏更新 `task.progress()`。
普通诊断进入任务日志，原始 stdout、stderr 和合成后的完整 YAML 保存为产物。

CLI 超时与宿主阶段预算统一校验，预算覆盖配置准备、连接、刷写及退出清理。
无法在宿主预算内完成的配置在启动刷写前报错。
取消或异常时由运行模块终止进程，清理入口再次调用时保持幂等。

### 第四步：完善共享阶段进度

在共享阶段快照中提供 `progress`，已知进度范围为 0 到 100，未知值为 -1。
使用节点 ID、阶段 ID 和清理标识定位对应阶段，保证清理阶段不会覆盖刷写阶段。

运行时的进度沿用现有独立进度通道和快照刷新机制，结束后由阶段结果提供最终值。
阶段完成事件补齐必要的最终进度，支持主阶段结束、清理尚未完成时的展示。
GUI 模型增加 `ProgressRole`；TUI 读取同一组阶段字段及合成规则。

调度器通过 `stageProgressChanged` 传递阶段原始百分比，任务服务将其保存在
`activeStage.progress`，阶段结束时写入完成事件。节点累计进度和整体进度沿用各自的
汇总规则；阶段切换或清理阶段报告较低百分比时，两套进度仍保持正确语义。

### 第五步：接入两个前端

设备配置与离线输入表单由清单驱动，复用已有页面。
任务详情中的“刷写”阶段显示百分比及进度条，日志继续使用原事件列表。
无有效进度时使用等待状态，终态保留进度并显示实际执行结果。
失败时即使最后收到 100% 也显示失败状态。

### 第六步：验证与交付

先使用受控 CLI 夹具完成自动功能验证，覆盖成功、失败、超时、取消和分片输出，
再构建应用及测试目标，运行模型回归和 TUI 完整功能测试。
新增测试目标显式列出生产源码，并同步测试构建依赖。

交付内容包括插件源码、生成的可导入 `.cictplugin`、两份 YAML 模板、样例配置 ZIP、
离线操作说明与验证结果。生成插件包与样例 ZIP 放在构建或交付目录，源码仓库只保留
其源配置和生成说明。
GUI 视觉验收由用户完成；真实 CAN / DoIP 工位联调分别核对连接、刷写结果和进度。

## 实现验证计划

- 第一步完成的 CAN / DoIP YAML 文件及各自配置 ZIP 可作为有效输入使用。
- 插件编译、打包及清单校验；设备配置一项、离线输入四项，三类固件仅接受 `.hex`，
  文件选择筛选和执行前校验一致。
- CAN / DoIP 参数映射，布尔开关，十六进制前导零，中文、空格和括号路径。
- ZIP 缺失配置、多份配置及非法 YAML；模式冲突和非法字段在启动前失败。
- 使用受控 CLI 夹具验证分片输出、回车换行、分档进度、尾部输出、错误诊断。
- 验证收到 100% 后非零退出仍失败，以及超时、取消和进程资源释放。
- 验证运行中及结束后阶段百分比的数据同步；完成 TUI 内存渲染、动作契约和
  真实 PTY 测试。
- GUI 视觉效果由用户验证；真实 CAN / DoIP 刷写需在具备工具依赖和设备的工位联调。

## 实施与验证结果

上述六步已完成代码实现和自动验证。YAML 模板位于
`src/adapter/atech_bootload_adapter/docs/examples/`；配置 ZIP 和可导入插件位于
`build/delivery/atech-bootload/`。操作说明见
[ATECH BootLoad 离线刷写](usage.md)。

验证环境：Windows 11、MSVC、Qt 6.11.2、Python 3.12；验证日期：2026-10-19。

| 验证项 | 结果及证据 |
| --- | --- |
| 客户端与测试目标构建 | 通过，含 QML 编译；`build-final.log`、`build-runtime-final.log` |
| 配置与插件交付 | 两份配置 ZIP 各仅含对应 YAML；插件清单与全部打包脚本均核对通过 |
| 插件编译器回归 | 1 项 CTest 通过；`compiler-results.log` |
| 刷写、模型与完整 TUI 回归 | 38 项 CTest 全部通过；`regression-final.log` |
| 公共运行时补充回归 | 7 个功能用例通过，含初始化和结束共 9 项零失败；`runtime-regression-final.log` |
| 真实 Windows 终端交互 | 已注册的 COM TUI ConPTY 集成测试通过，覆盖启动、输入、导航和终端恢复 |
| QtTest 日志复核 | TUI 内存测试、阶段视图、阶段模型、共享后端均取得完整的零失败日志 |

以上日志保存在交付目录。刷写回归使用受控 CLI 夹具，实际执行两种模式并验证
Application、Flash Driver、Calibration 三类 HEX 路径、中文和空格路径、分片 UTF-8、
CR/LF、尾行采集和 `0 → 12 → 21 → 100` 进度。失败夹具在输出 100% 后返回 1，
任务仍判失败。超时和取消后再次启动进程，确认句柄已释放。

配置校验覆盖重复键、未知字段、跨模式字段、非法类型、数值范围、十六进制前导零、
ZIP 缺失或存在多份 YAML、混入额外文件以及非 HEX 固件。
阶段模型回归覆盖主阶段进度、清理阶段隔离和终态重新加载。

Windows 下部分 QtTest 运行不输出标准流，刷写测试入口改为读取文件日志，并同时
校验退出码、通过数量及完成标记，避免将空输出误判为成功。端到端测试的节点预算
为 60 秒，覆盖两次进程启动；生产刷写阶段预算仍为配置方案中的 3000 秒。
现有 ConPTY 测试中残留的合并冲突标记已清理。
公共运行时测试使用受控 CLI 同步两块输出，避免依赖 shell 和输出时序；离线工作区
清理测试在删除前关闭读取文件，使 Windows 与其他平台使用相同的验证条件。

GUI 视觉效果未进行自动检查；真实 ECU 的 CAN / DoIP 连接、固件内容和实际刷写结果
仍需在工位由用户验收。受控夹具通过不代表已完成真实设备刷写。
