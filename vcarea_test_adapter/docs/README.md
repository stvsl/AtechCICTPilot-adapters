# VCarEA 测试适配器

适配器保留旧版 Connector SDK 启动与连接配置查询流程，并通过
`EA外部调用接口.md` 声明的 MQTT 3.1.1 接口打开工程、配置测试环境、
执行 Case，最后下载 VCarEA 生成的 ZIP 报告。

## 依赖

- 插件运行时必须提供 `@atech/dllnet` 及 `dllnet_worker.exe`。
- VCarEA 安装目录必须包含 `KY.VCar.Central.Connector.Sdk.dll`；中心服务路径按
  `CentralServices\\VCarEA.Central.Service.exe` 解析。
- Connector 连接或 key 查询失败会终止流程，不会绕过旧版配置发现阶段。
- `docs/` 下的排障辅助脚本需要 pythonnet：Python 3.12 请使用 pip 安装的
  `pythonnet>=3.0.3`；VCarEA 自带 site-packages（3.0.1）仅适配 Python <= 3.11。

## 执行阶段

| 阶段 | 导出函数 | 说明 |
| --- | --- | --- |
| 准备 VCarEA 测试工程 | `prepare` | 解压工程 ZIP，定位唯一的 `.hlt` 文件，解析 Case 筛选条件和报告格式 |
| 启动 VCarEA | `launch` | 默认启动 `VCarEA.exe` 并等待指定 Connector key 就绪；仅在 `AttachExisting=true` 时复用已有实例 |
| 获取 MQTT 连接配置 | `readMqttConfig` | 调用 `TryGetConnectionInfo`，发布旧版 `MQTT_CONFIG` 产物，并把实际连接参数交给 MQTT 阶段 |
| 连接 EA MQTT 服务 | `connect` | 使用 Connector 返回的 broker 参数连接，重试接入握手直至 VCarEA 返回登记成功 |
| 打开工程并配置测试环境 | `configure` | 打开工程，探测后台初始化完成，配置 TCF/TBF，查询待执行 Case |
| 启动并等待实验环境就绪 | `startMeasurement` | 启动实验环境（启动应答即就绪，实测同步加载 XIL 环境）；随后对执行端口接口做一次有界观察并记录，不作为失败判据 |
| 执行测试用例 | `execute` | 逐个打开、执行并等待 `Run/Stop` 或 `Case/Stop` 事件后关闭选中的 Case，采集执行应答及报告事件 |
| 收集测试报告 | `collectArtifacts` | 按 `Report/Download -> Report/Push` 流程下载 ZIP（校验 SHA-256），按需从 ZIP 中提取 html/pdf/xlsx，并发布 JSON 执行摘要 |
| 清理 | `cleanup` | 停止活动 Case，关闭 Case、实验环境和工程，断开 MQTT，并停止本次插件启动的 VCarEA |

## 任务输入

| 输入 | 说明 |
| --- | --- |
| `VCAR_EA_PROJECT` | 必填的 VCarEA 工程 ZIP；解压后必须且只能包含一个 `.hlt` 文件 |
| `TEST_CASE_IDS` | 可选的 `.json`/`.txt` 文件；按 Case 相对路径、文件名或无扩展名名称筛选，留空时执行接口返回的全部 Case |
| `VCAR_EA_REPORT_TYPE` | 必填；保留旧版 `html`、`pdf`、`xlsx`，并提供原生 `zip`。接口固定推送 ZIP（实测内含 html/pdf/xlsx/sqlite），旧版格式从 ZIP 中提取，ZIP 本体一并保留 |

## 工位属性

| 属性 | 说明 |
| --- | --- |
| `VCAR_EA_SOFTWARE_PATH` | `VCarEA.exe` 路径；为空时使用 `C:\\KunyiSoftwares\\VCarEA\\VCarEA.exe` |
| `VCAR_EA_WORK_DIR` | 旧版 VCarEA 工作目录字段，继续保留在清单中 |
| `VCAR_EA_DEVICE_CONFIG_PATH` | 旧版设备配置 ZIP 字段，继续保留在清单中 |

`EA外部调用接口.md` 没有工作目录或设备配置 ZIP 的加载接口，因此后两个字段
只会被记录到执行摘要，不会擅自发送给 EA。

## 协议与假设

- `readMqttConfig` 使用旧版 Connector SDK 返回的 Host、Port、UserName、
  Password 和 KeepAliveSeconds。实测 VCarEA 1.8.4.0826 的 broker 端口与凭据
  每次启动随机（例如 `127.0.0.1:23804` + GUID 用户名/密码）；文档中的
  `127.0.0.1:11883` / `VCarAPI` 是过期默认值，仅作为协议模块初始值。
- 报告事件由宿主转发到主 broker，主题带 `KY/` 前缀（订阅
  `KY/VCar/EA/TestReport/#`）。实测 1.8.4.0826 只转发 `Run/Stop` 与
  `Case/Stop`（不转发 Start/Step 事件）；`Case/Stop` 载荷包含 `RunID` 与
  失败计数，`Run/Stop` 的 `ID` 即 `RunID`。单个 Case 完成判据为收到任一
  停止事件后再保留 `ReportEventSettleMs` 收尾窗口。
- 文档没有实验环境状态查询接口：`Environment` 启动应答（实测约 12 秒，
  期间同步加载 XIL 环境）即为环境就绪判据；`KY/VCar/EA/Execution/MqttPort`
  接口在 1.8.4.0826 完全不产生应答（执行期间同样如此），适配器只做一次
  有界观察并记录结果，不作为失败判据。执行期间宿主会另起“执行器 broker”
  （动态端口与凭据，执行结束即关闭），适配器不连接该 broker。
- 工程打开应答可能早于 VCarEA 后台恢复 TBF 和工程树构造；适配器按
  `ProjectReadyProbeIntervalMs` 轮询工程配置列表，探测到测试配置与测试台配置
  同时可见才继续（不再按固定时长盲等），超过 `ProjectReadyTimeoutMs` 才报错；
  配置请求仍对“当前项目未找到配置路径”的瞬态应答做有界重试。配置请求
  始终使用任务工程目录中枚举到的真实路径大小写，避免 VCarEA 工程树匹配失败；
  实测配置列表返回的是绝对路径（以打开工程时传入的目录为前缀）。
- 实测 VCarEA 1.8.4.0826 同一时刻只处理一个业务接口：并发请求会被立即拒绝
  （`Code=1`、消息“其他接口正在工作，请稍后重试！”），且该拒绝应答**不复用请求
  ID**（宿主重新生成 GUID），按 ID 匹配会把拒绝当成无关消息而一直等到超时。
  适配器按状态代码与消息文本识别忙拒绝，每隔 `BusyRetryIntervalMs` 重发同一
  请求，直到收到真正的业务应答或超出本次请求超时；仍然被拒时以“接口忙”
  失败（而不是误导性的“无应答”）。打开工程应答后宿主仍在后台恢复（实测窗口
  最长约 33 秒），期间所有业务请求都会被这样拒绝，这是“打开工程并配置测试
  环境”阶段最典型的等待场景。
- TBF 配置请求本身会同步加载实验环境，实测耗时 16~24 秒，属正常行为。
- “打开工程并配置测试环境”阶段的单次请求使用 `ConfigureResponseTimeoutMs`：
  打开工程应答实测 5~35 秒（宿主把后台恢复计入应答时间时更久），需覆盖
  后台恢复窗口、忙拒绝重发与 TBF 环境加载。
- 文档没有规定多份 TCF/TBF 的选择方式；当前按接口返回顺序选择第一份并输出警告。
- 接口固定以 `FileFormatType=0`（ZIP）推送报告：下载应答的 `ReportPushTopic`
  为动态主题（实测 `KY/VCar/Report/Push/File/<voucher>`），数据包为小端序
  `[int32 index][int32 length][data]`；ZIP 内实测包含 html、pdf、xlsx 与
  sqlite 数据库。选择旧版格式时适配器从 ZIP 中提取对应文件（ZIP 本体保留），
  提取失败时仅告警并保留 ZIP。
- `FileHashCode` 实测为组包 ZIP 的 SHA-256，适配器本地校验并记录结果
  （不匹配时告警，不阻断产物发布）。
- 文档没有规定各类超时、轮询间隔和报告大小上限；代码中的假设值均以
  `TODO` 标注。停止实验环境接口在环境未运行时返回 `Code=0` 且消息为
  “未启动实验环境”，适配器按幂等结果处理。

## 常用节点选项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `ConnectionKey` | `VCarEA` | Connector 服务 key；也可使用 `VCarEA.Executor` |
| `AttachExisting` | `false` | 为 `false` 时始终调用 `VCarEA.exe`，避免把残留的 Connector 服务误判为 API 宿主；为 `true` 时只复用已有实例，Connector 服务不可用则直接失败 |
| `ConstraintUpdate` | `true` | 打开工程及配置 TCF/TBF 时强制更新 Case |
| `ProjectReadyTimeoutMs` | `120000` | 打开工程应答后等待配置列表出现 TCF/TBF 的总超时 |
| `ProjectReadyProbeIntervalMs` | `500` | 工程就绪探测的轮询间隔（100–10000 ms） |
| `ConfigureResponseTimeoutMs` | `60000` | “打开工程并配置测试环境”阶段单次请求应答超时（打开工程、TCF/TBF 配置、就绪后首次查询共用） |
| `BusyRetryIntervalMs` | `1000` | 宿主返回“其他接口正在工作”忙拒绝后的重发间隔（100–60000 ms） |
| `EnvironmentSettleMs` | `1000` | 环境启动应答后的最小稳定等待；设为 0 时立即做执行端口观察 |
| `ExecutionPortProbeMs` | `3000` | 执行端口查询的一次性探测超时；接口无应答时按未应答记录（1–60000 ms） |
| `ReportEventSettleMs` | `500` | 收到 `Run/Stop` 或 `Case/Stop` 后的收尾窗口上限；窗口结束即认为当前 Case 完成 |
| `AccessReadyTimeoutMs` | `120000` | 等待 VCarEA API 接入就绪的总超时 |
| `AccessResponseTimeoutMs` | `3000` | 单次 API 接入握手的应答超时 |
| `ResponseTimeoutMs` | `30000` | 普通 MQTT 应答超时 |
| `ExecutionTimeoutMs` | `1800000` | 单个 Case 从执行请求到收到停止事件的总超时 |
| `ReportTimeoutMs` | `600000` | 单份报告下载超时 |
| `CleanupTimeoutMs` | `5000` | 单次清理接口应答超时 |

插件启动的 VCarEA 进程由 CLI 运行时托管，清理阶段会停止该进程；如果 VCarEA
将启动请求交给已有的单实例进程后正常退出，则继续连接 MQTT 并等待 API 接入就绪。
使用 `AttachExisting=true` 连接的既有进程不受清理阶段影响。

绿色版 VCarEA 必须以 `VCarEA.exe` 所在目录作为工作目录启动，否则 Gemini 模块和
内置驱动可能无法被发现。VCarEA 自身日志中“未安装 VCarEE 2.0.3+”以及缺少
`C:\ProgramData\ASAM\XIL\Implementation` 的记录不参与适配器就绪判定；适配器
不会创建该目录、扫描注册表或要求安装 VCarEE。Connector 服务可能早于 VCarEA 的
MQTT 业务订阅就绪，因此连接阶段会重复发送接入请求并等待匹配应答；只有登记成功后
才会发送打开工程等业务请求。

## 产物

- `MQTT_CONFIG`：旧版流程保留的 Connector MQTT 连接配置 JSON。
- `VCAREA_REPORT:zip:<序号>`：每个成功下载的 VCarEA ZIP 报告（SHA-256 校验结果记录在执行摘要中）。
- `VCAREA_REPORT:html|pdf|xlsx:<序号>`：任务选择旧版格式时，从 ZIP 中提取的对应文件（仅在 ZIP 内存在该格式时发布）。
- `VCAREA_EXECUTION_RESULT`：包含工程、Case 状态、接口应答、报告事件、下载结果和采集错误的 JSON 摘要。
