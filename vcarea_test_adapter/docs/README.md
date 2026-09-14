# VCarEA 测试适配器

启动昆易 VCarEA 宿主，并通过其 Connector SDK 查询宿主已创建的 MQTT 连接服务配置。
查找安装目录、可执行文件与 Connector SDK 程序集的逻辑集中在
`scripts/vcarea/vcarea_utils.js`。

## 执行阶段

| 阶段             | 导出函数         | 说明                                                                                                                              |
| ---------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 启动VCarEA       | `launch`         | 解析安装布局并启动 `VCarEA.exe`；宿主已在运行时直接复用；随后轮询连接服务直到就绪                                                 |
| 获取MQTT连接配置 | `readMqttConfig` | 通过 Connector SDK 的 `ConnectorServiceClient` 查询连接服务，写出 `workspace://vcarea/mqtt-config.json` 并发布 `MQTT_CONFIG` 产物 |
| 清理             | `cleanup`        | 释放 SDK 句柄，并按选项决定是否终止插件启动的 VCarEA 进程                                                                         |

## 依赖

- 插件运行时必须提供 .NET 程序集加载能力（`@atech/dllnet`）及其 worker
  （`workers/dllnet_worker.exe`）；缺失时阶段直接失败并给出安装布局诊断。
- 连接配置由 VCarEA 宿主进程创建，需 `VCarEA.Central.Service.exe` 处于运行状态。
- Connector SDK 查询失败（含 `Connect` 失败或 key 不存在）会直接报错，不做降级。

## 节点选项

| 选项                   | 默认值   | 说明                                               |
| ---------------------- | -------- | -------------------------------------------------- |
| `ConnectionKey`        | `VCarEA` | 连接服务唯一标识，可选 `VCarEA`、`VCarEA.Executor` |
| `CloseVcareaOnCleanup` | `false`  | 清理阶段是否终止由本插件启动的 VCarEA 进程         |

## 工位属性

| 属性                    | 说明                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `VCAR_EA_SOFTWARE_PATH` | `VCarEA.exe` 路径；为空时使用默认安装目录 `C:\KunyiSoftwares\VCarEA`。指向已安装目录或 `CentralServices` 等子目录时会自动回退到安装根目录 |
| `VCAR_EA_WORK_DIR`      | VCarEA 工作目录，供后续工程、报告阶段使用                                                                                                 |

## 失败排查

- `加载 Connector SDK 失败`：确认安装目录中存在
  `KY.VCar.Central.Connector.Sdk.dll`，且运行时的 .NET worker 已部署。
- `连接中心服务失败`：确认 `VCarEA.Central.Service.exe` 已随宿主启动。
- `连接服务 [key] 尚未创建`：宿主未创建该 key，确认 VCarEA 已启动并启用了对应服务。
