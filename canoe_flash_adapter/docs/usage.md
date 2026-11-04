# CANoe Flash 工程与执行

## 任务与设备配置

| 输入 | 必填 | 内容 |
| --- | --- | --- |
| `CANOE_PROJECT` | 是 | `.zip` 工程，ZIP 根目录直接包含 `canoe-project.json` |
| `SOFTWARE_PACKAGE` | 是 | `.bin`、`.s7`、`.s19`、`.hex` 或 `.elf` 固件 |
| `FLASH_PARAMETERS` | 否 | 刷写参数 JSON |

设备属性 `CANOE_VERSION` 必填；`CANOE_INSTALL_DIR` 可在自动发现安装目录失败时
指定。`NEW_CANOE_WHEN_START` 为可选布尔值，`CANOE_PROJECT_DIR` 为必填的
任务工作区根目录属性；实际脚本工作区为 `workspace://canoe-project`。

GUI 与 TUI 使用同一组清单属性。实例选择的节点选项与默认行为以
[scripts/canoe_flash.js](../scripts/canoe_flash.js) 的 `canoeStartMode()` 为准；
清理只关闭本次拥有的进程，显式设置 `QuitAttachedInstance` 时也会退出附加实例。

### 启动与 COM 注册

新建实例模式先关闭当前 Automation 实例，再比较 `CANoe.Application` 的
`LocalServer32` 与 `CANOE_VERSION` 对应的 `Exec64/CANoe64.exe`。注册缺失或路径不
一致时，适配器通过 UAC 运行同一安装中的 `Exec64/RegisterComponents.exe`；该工具
不带参数时注册其所属 CANoe 安装。只有退出码为 0，且重新读取的注册路径与目标完全
一致，才以 `-embedding` 启动 CANoe 并连接 Automation。

注册已匹配时不会出现 UAC。用户取消、注册工具失败/超时/非零退出，或注册后仍指向
错误版本，都会立即终止，不再等待 Automation 连接。成功切换后不会在任务结束时恢复
旧注册。附加模式不关闭实例、不切换注册，但连接后仍核对实际主版本。

## 工程描述符

描述符必须位于 ZIP 根目录。示例：

```json
{
  "ContractVersion": "1.0",
  "Configuration": "project/flash.cfg",
  "InputDirectory": "Input",
  "SystemVariableFile": "project/flash.vsysvar",
  "FlashModule": "FlashDownLoad",
  "FlashTimeoutMs": 1800000,
  "Artifacts": []
}
```

`Configuration` 指向工程内的配置，文件头主版本不得高于 `CANOE_VERSION`。
`InputDirectory` 缺省为 `Input`，适配器将固件复制到该目录。
`SystemVariableFile` 可选；缺省时在 `SystemVariableDirectory` 指定的目录或工程根
递归查找首个 `.vsysvar`。`FlashModule` 缺省为 `FlashDownLoad`，应位于工程首个
`TestEnvironment` 中。

路径字段和附加产物必须使用安全相对路径，不能包含反斜杠、盘符、绝对路径、
空路径段、`.` 或 `..`。

参数 JSON 可以直接提供变量，也可以将变量放在 `sysVariables`、`SysVariables`、
`variables` 或 `Variables` 对象中。脚本按变量名称修改 `.vsysvar` 中对应的
`startValue`；未提供 `fileName` 时使用固件文件名。`ExpectedVersion` 用于最终
软件版本核对，描述符中的同名字段优先；两处均缺省时取去扩展名后的固件名最后一个 `_` 后的部分。

## 阶段与判断

| 阶段导出 | 行为 |
| --- | --- |
| `prepare` | 解压、校验契约与配置版本、复制固件并修改系统变量 |
| `launch` / `connect` | 附加实例，或切换 COM 注册后启动目标进程；连接并核对实例主版本 |
| `validateContract` | 打开配置、定位并启用刷写模块、注册固件 UserFile |
| `startMeasurement` | 确认工程就绪并启动 Measurement |
| `flash` | 运行模块、轮询状态和进度、校验报告版本与 Verdict |
| `collectArtifacts` | 发布声明的附加文件和工程内报告 |
| `cleanup` | `post.always` 停止模块与测量，按所有权退出进程并释放句柄 |

`flash` 阶段只有在报告中提取到的软件版本与期望值一致，且可用 Verdict 表示通过时
才成功。刷写逻辑和诊断通信由工程测试模块完成。

产物复制到 `artifact://canoe/<工程相对路径>`，报告使用 `REPORT_URI`，
其余使用 `ARTIFACT:<相对路径>`。缺失的声明文件告警。
当前工作流将 `collectArtifacts` 放在主阶段中；前序失败时会跳过它，但仍尝试
`cleanup`。这项边界应在排查失败任务时一并考虑。

## 维护与验证

入口：[canoe_flash.js](../scripts/canoe_flash.js)、
[会话实现](../scripts/canoe_flash/session.js)、[工作流](../StepConfig.groovy)。
版本扩展见[本插件版本指南](version-support.md)。

```sh
ctest --preset=dev-fast -R 'AtechCICTPilot_(plugin_compiler|canoe_project_version|runtime_interface)'
```

实际 CANoe / ECU 刷写、COM 注册切换、UAC 交互、报告内容和 GUI 操作须在具备工程、
授权和硬件的工位验证。
