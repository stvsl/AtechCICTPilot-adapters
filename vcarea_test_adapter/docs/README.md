# VCarEA 测试适配器

适配器保留旧版 Connector SDK 启动与连接配置查询流程，并通过
`EA外部调用接口.md` 声明的 MQTT 3.1.1 接口打开工程、配置测试环境、
执行 Case，最后下载 VCarEA 生成的 ZIP 报告。

## 依赖

- 插件运行时必须提供 `@atech/dllnet` 及 `dllnet_worker.exe`。
- VCarEA 安装目录必须包含 `KY.VCar.Central.Connector.Sdk.dll`；中心服务路径按
  `CentralServices\\VCarEA.Central.Service.exe` 解析。
- Connector 连接或 key 查询失败会终止流程，不会绕过旧版配置发现阶段。

## 执行阶段

| 阶段 | 导出函数 | 说明 |
| --- | --- | --- |
| 准备 VCarEA 测试工程 | `prepare` | 解压工程 ZIP，定位唯一的 `.hlt` 文件，解析 Case 筛选条件和报告格式 |
| 启动 VCarEA | `launch` | 默认启动 `VCarEA.exe` 并等待指定 Connector key 就绪；仅在 `AttachExisting=true` 时复用已有实例 |
| 获取 MQTT 连接配置 | `readMqttConfig` | 调用 `TryGetConnectionInfo`，发布旧版 `MQTT_CONFIG` 产物，并把实际连接参数交给 MQTT 阶段 |
| 连接 EA MQTT 服务 | `connect` | 使用 Connector 返回的 broker 参数连接，通过 Ping 等待 EA 就绪，并登记 API 客户端 |
| 打开工程并配置测试环境 | `configure` | 打开工程，查询并配置 TCF/TBF，查询待执行 Case |
| 启动并等待实验环境就绪 | `startMeasurement` | 启动实验环境，并通过执行端口查询确认业务接口仍可响应 |
| 执行测试用例 | `execute` | 逐个打开、执行和关闭选中的 Case，采集执行应答及报告事件 |
| 收集测试报告 | `collectArtifacts` | 按 `Report/Download -> Report/Push` 流程下载 ZIP，并发布 JSON 执行摘要 |
| 清理 | `cleanup` | 停止活动 Case，关闭 Case、实验环境和工程，断开 MQTT，并停止本次插件启动的 VCarEA |

## 任务输入

| 输入 | 说明 |
| --- | --- |
| `VCAR_EA_PROJECT` | 必填的 VCarEA 工程 ZIP；解压后必须且只能包含一个 `.hlt` 文件 |
| `TEST_CASE_IDS` | 可选的 `.json`/`.txt` 文件；按 Case 相对路径、文件名或无扩展名名称筛选，留空时执行接口返回的全部 Case |
| `VCAR_EA_REPORT_TYPE` | 必填；保留旧版 `html`、`pdf`、`xlsx`，并提供原生 `zip`。接口文档当前只能实际下载 ZIP |

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
  Password 和 KeepAliveSeconds；文档中的 `127.0.0.1:11883` 参数仅作为协议模块初始值。
- 文档没有实验环境状态查询接口，因此环境启动应答成功、等待 1000 ms 且执行端口查询成功后视为就绪。
- 文档没有说明 `ExecutionMqttPort` 是否对应独立报告 broker，也未提供该连接的认证规则；当前在 Connector 返回的主连接（文档示例端口为 `11883`）上订阅报告事件。
- 文档没有规定多份 TCF/TBF 的选择方式；当前按接口返回顺序选择第一份并输出警告。
- 文档只定义 ZIP 报告。选择旧版 HTML、PDF 或 XLSX 时会记录兼容提示并发布
  原生 ZIP，不会把 ZIP 冒充其他格式；需要厂商提供正式转换工具或 API 才能生成对应格式。
- 文档没有规定各类超时、轮询间隔、报告大小上限和包头字节序；代码中的假设值均以 `TODO` 标注。

## 常用节点选项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `ConnectionKey` | `VCarEA` | Connector 服务 key；也可使用 `VCarEA.Executor` |
| `AttachExisting` | `false` | 为 `false` 时始终调用 `VCarEA.exe`，避免把残留的 Connector 服务误判为 API 宿主；为 `true` 时只复用已有实例，Connector 服务不可用则直接失败 |
| `ConstraintUpdate` | `true` | 打开工程及配置 TCF/TBF 时强制更新 Case |
| `EnvironmentSettleMs` | `1000` | 环境启动应答后的假设稳定等待时间 |
| `ReportEventSettleMs` | `500` | Case 执行应答后的报告事件收尾时间 |
| `ResponseTimeoutMs` | `30000` | 普通 MQTT 应答超时 |
| `ExecutionTimeoutMs` | `1800000` | 单个 Case 执行应答超时 |
| `ReportTimeoutMs` | `600000` | 单份报告下载超时 |
| `CleanupTimeoutMs` | `5000` | 单次清理接口应答超时 |

插件启动的 VCarEA 进程由 CLI 运行时托管，清理阶段会停止该进程；如果 VCarEA
将启动请求交给已有的单实例进程后正常退出，则继续通过 Ping 判断 API 就绪。
使用 `AttachExisting=true` 连接的既有进程不受清理阶段影响。

绿色版 VCarEA 必须以 `VCarEA.exe` 所在目录作为工作目录启动，否则 Gemini 模块和
内置驱动可能无法被发现。VCarEA 自身日志中“未安装 VCarEE 2.0.3+”以及缺少
`C:\ProgramData\ASAM\XIL\Implementation` 的记录不参与适配器就绪判定；适配器
不会创建该目录、扫描注册表或要求安装 VCarEE，而是以 Connector 服务和 MQTT Ping
应答作为启动成功依据。

## 产物

- `MQTT_CONFIG`：旧版流程保留的 Connector MQTT 连接配置 JSON。
- `VCAREA_REPORT:zip:<序号>`：每个成功下载的 VCarEA ZIP 报告。
- `VCAREA_EXECUTION_RESULT`：包含工程、Case 状态、接口应答、报告事件、下载结果和采集错误的 JSON 摘要。
