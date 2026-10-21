# ATECH BootLoad 离线刷写

插件 ID：`atech_bootload_adapter`。本次实现覆盖离线刷写和客户端进度，GUI 与 TUI
共用执行后端。工具接口按 ATECH BootLoad Tools / CLI **v1.0.0.1** 验证。

## 使用步骤

1. 在适配器管理中导入构建生成的 `atech_bootload_adapter-*.cictplugin` 并启用。
2. 在能力的设备属性中选择 `ATECH BootLoad CLI.exe`。设备配置只有这一个文件项。
   保留厂商工具的完整目录，包括 `ATECH BootLoad Tools.exe`、依赖程序集和驱动目录。
   插件以 CLI 所在目录作为工作目录。
3. 修改下面的 CAN 或 DoIP YAML 模板，并压缩成一个真实 ZIP，ZIP 内只放一份
   `.yaml` 或 `.yml` 文件。可以保留目录层级，不要放说明文件或其他配置。
4. 打开离线执行，选择 ATECH BootLoad 能力，填写任务信息和输入，提交任务。
5. 在任务详情的“刷写”阶段查看百分比、状态和日志；任务结束后查看发布产物。

GUI 使用现有文件选择器；TUI 在能力页配置 EXE，在离线执行向导中填写相同文件路径。

| 离线输入 | 必选 | 文件要求 |
| --- | --- | --- |
| 配置参数包 `CONFIG_PACKAGE` | 是 | 仅含一份 YAML 的 `.zip` |
| Application `APP_FILE` | 是 | `.hex`、`.vbf`、`.s19`、`.mot`、`.sre`、`.mbf`、`.srec` 固件 |
| Flash Driver `FLASH_DRIVER` | 否 | `.hex`、`.vbf`、`.s19`、`.mot`、`.sre`、`.mbf`、`.srec` 固件；未选则不传参数 |
| Calibration `CALIBRATION` | 否 | `.hex`、`.vbf`、`.s19`、`.mot`、`.sre`、`.mbf`、`.srec` 固件；未选则不传参数 |

固件路径来自离线表单，任务执行时转换为本机路径，不能再写入输入 YAML。
支持路径中的中文、空格和括号；参数按独立字符串传给进程，无须自行添加命令行引号。

## YAML 配置

模板：[CAN](examples/can-download.yaml)、
[DoIP](examples/doip-download.yaml)。第一项是 `mode`，后续字段为 CLI
参数名去掉 `--`，例如 `--project "FLZCU_Chery_E03_V02(RSA4096)"` 对应
`project: "FLZCU_Chery_E03_V02(RSA4096)"`。

配置使用 UTF-8、单文档、平面映射，最大 64 KiB。重复键、未知字段、跨模式字段、
非法值及 YAML 中的固件路径字段均在启动刷写前报错。

| 字段 | 类型 / 取值 | 默认值 |
| --- | --- | --- |
| `mode` | `can-download` / `doip-download`，必须是第一个字段 | 必填 |
| `project` | CLI `list-projects` 返回的完整项目名称 | 必填 |
| `force`、`verbose` | YAML 布尔值 `true` / `false` | `false` |
| `timeout` | 整数秒，1～2700 | 1800 |
| `stall-timeout` | 整数秒，1～`timeout` | 60 |
| CAN `driver` | 驱动目录名，例如 `PEAK PCAN` | 必填 |
| CAN `channel` | 非负 32 位整数 | 0 |
| CAN `baud` | 正 32 位整数，bit/s | 500000 |
| CAN `fd-baud` | 正 32 位整数，bit/s | 不传，使用 CLI 默认值 |
| CAN `fd` | YAML 布尔值 | `false` |
| DoIP `entity` | IPv4 地址 | 必填 |
| DoIP `source` / `target` | **带引号**的 1～4 位十六进制字符串，可带 `0x` | `"0E80"` / `"0002"` |
| DoIP `target-functional` | 同上 | 不传，使用 CLI 默认值 |
| DoIP `version` | **带引号**的 1～2 位十六进制字符串 | 不传，使用 CLI 默认值 |
| DoIP `multicast` | IPv4 地址 | `"255.255.255.255"` |
| DoIP `route-timeout` | 正 32 位整数，毫秒 | 2000 |

设置 CAN FD 时显式添加 `fd: true`。单独设置 `fd-baud` 不会启用 CAN FD。
布尔值为 `false` 时省略对应参数；CLI 根据参数是否存在启用开关，不能传 `--force=false`。
DoIP 地址必须使用字符串，例如 `target: "0002"`，避免 YAML 将其转换为数字并丢失前导零。

插件先以 30 秒期限执行 `list-projects`，校验项目名称后才启动刷写。
刷写阶段预算为 3000 秒；CLI 总超时最大 2700 秒，另加 120 秒作为宿主进程期限，
给准备、连接、归档和退出清理留出余量。CLI 的超时计时从其内部刷写循环开始。
进度停滞由 CLI 自身的 `stall-timeout` 判断，不根据 stdout 静默时间推断。

## 进度与结果

CLI 没有 JSON 进度接口。插件按原始字节拼齐 stdout 的完整行，优先识别 UTF-8，
否则按系统本地代码页解码（中文 Windows 通常为 CP936），再读取进度条的实际百分比。
进度条方块被代码页替换为 `?` 时也能识别。重定向输出约每跨过 10% 输出一次，
因此界面以该节奏更新；首次进度输出前显示等待状态。多字节字符、跨块半行、CR/LF
及退出后的末行均支持。stderr 和普通日志中的百分号不参与进度计算。
进度日志统一显示为 `刷写进度：12.0%`，原始方块进度条保留在输出归档中。

此版插件使用客户端运行时的 `cli.decodeText()`，部署时须同时更新客户端与插件包。

进程正常退出且退出码为 0 才成功；即使收到 100%，后续非零退出仍显示失败。
退出码 1 表示参数、文件、设备连接或刷写失败；2 表示超时、停滞或停止；64 表示命令错误。
阶段百分比按节点、阶段和清理标识区分，清理阶段不会覆盖刷写阶段的最终进度。
取消、宿主超时和其他异常均会终止并释放进程；清理入口可重复执行。

发布产物位于任务的 `bootload/` 产物目录：

- `resolved.yaml`：应用默认值并注入实际固件路径后的配置。
- `projects-stdout.log`、`projects-stderr.log`、`projects-diagnostic.json`：项目查询记录。
- `flash-stdout.log`、`flash-stderr.log`、`flash-diagnostic.json`：原始刷写输出和执行诊断。
  `.log` 保留 CLI 的原始编码；查看中文 Windows 输出时，按工具实际编码打开。
- `error.json`：参数校验或执行失败的错误信息；取消由阶段状态和进程诊断记录。

日志每秒保存一次，正常退出与清理阶段补齐尾部输出。外部工具及其子进程由宿主管理，
Windows 下还通过 Job Object 在宿主回收时关闭。

## 生成交付文件

```powershell
python tools/package_bootload_examples.py
python tools/compile_plugin.py --source src/adapter/atech_bootload_adapter --out build/delivery/atech-bootload
```

输出目录 `build/delivery/atech-bootload/` 包含 YAML 副本、两个配置 ZIP；
`plugins/` 中为可导入插件。生成文件不提交到源码仓库。
YAML 解析使用随插件打包的 js-yaml 4.1.1（MIT），来源和许可见插件 `scripts/vendor/`。

自动测试使用受控 CLI，不连接车辆或刷写 ECU。真实 CAN / DoIP 工位刷写和 GUI
视觉效果由具备工具依赖与设备的使用者验证。验证记录见 [CLI 调研记录](cli-research.md)。
