# AtechCICTPilot 适配器

本仓库保存 AtechCICTPilot 客户端的内置适配器插件：插件清单、受限 Groovy 工作流、
JavaScript / Python 脚本、随包依赖与插件文档。主程序把本仓库作为 git 子模块挂载在
`src/adapter`，目录名和文件路径与主程序中的 `src/adapter` 完全一致，构建、测试和
文档引用无需改写路径。

- 主程序：[stvsl/AtechCICTPilot](https://github.com/stvsl/AtechCICTPilot)（私有）
- 挂载点：`src/adapter`
- 默认分支：`master`

## 职责边界

本仓库只保存插件自身的内容。插件编译、打包、运行时、工作台与公共契约由主程序维护：

| 能力 | 主程序位置 |
| --- | --- |
| 清单与工作流 C++ 契约 | `src/service/plugin/PluginJson.h` |
| 清单 / 工作流 Schema | `docs/schemas/` |
| 编译与打包工具 | `tools/compile_plugin.py`、`tools/plugin_package_version.py`、`tools/build_configurator.py` |
| 适配器插件工作台 | `tools/adapter_scaffold/` |
| 插件运行时模块与权限 | `docs/runtime/` |
| 公共开发约定与站点文档 | `docs/development/plugin-development.md` |

## 插件目录

| 插件 | PackageId | 主要用途 |
| --- | --- | --- |
| [ATECH BootLoad](atech_bootload_adapter/README.md) | `atech_bootload_adapter` | 调用厂商 CLI 进行 CAN / DoIP 离线刷写 |
| [CANoe 测试](canoe_test_adapter/README.md) | `canoe_test_adapter` | VTEST / 通信测试、报告生成与发布 |
| [CANoe Flash](canoe_flash_adapter/README.md) | `canoe_flash_adapter` | 调用工程中的刷写模块并验证软件版本 |
| [ExcelModifyTest](excel_modify_test_adapter/README.md) | `ExcelModifyTest` | 验证随包 JavaScript 库定点修改 XLSX |
| [动态阶段测试](dynamic_stage_test_adapter/README.md) | `dynamic_stage_test_plugin` | 验证阶段在运行时逐个创建后继阶段及失败收尾 |
| [Hello World](hello_world_adapter/README.md) | `hello_world_adapter` | 验证多阶段执行、日志、进度、产物与清理 |
| [VCarEA 测试](vcarea_test_adapter/README.md) | `vcarea_test_adapter` | Connector 配置发现、MQTT Plan 执行与报告下载 |
| [VCarDAS BOOT 刷写（开发中）](vcardas_bootloader_adapter/README.md) | `vcardas_bootloader_adapter` | 根据 App/Driver 文件匹配刷写目标并编排测试模块 |

每个插件目录都遵循同一布局，并独立维护 README 和含实际内容的 `docs/`：

```text
<目录>/
├── README.md             插件定位、依赖、快速开始与文档入口
├── docs/                 使用契约、工程格式、示例、维护指南与历史调研
├── PackageInfo.json      清单、权限、输入与设备属性
├── StepConfig.groovy     受限 Groovy 工作流源文件
└── scripts/              入口模块、业务脚本与随包依赖
```

目录名与 `PackageId` 可以不同，构建目标使用清单中的 `PackageId`，例如
`excel_modify_test_adapter` 对应 `plugin_ExcelModifyTest`。主程序只会发现同时存在
`PackageInfo.json` 与 `StepConfig.groovy` 的目录，不完整的实验目录会被跳过。

`plugin_version_status.md` 是插件构建轮次的唯一持久账本：每个 `PackageId + 基础版本`
的轮次在这里递增，由主程序 `tools/plugin_package_version.py` 在跨进程锁内更新。
构建产生新轮次后，需要把该文件同插件改动一起在本仓库提交，不要删除历史或手工改轮次。

## 获取

主程序以子模块方式引用本仓库：

```sh
git clone --recurse-submodules https://github.com/stvsl/AtechCICTPilot.git
# 已有工作区补拉插件
git submodule update --init src/adapter
```

也可以单独克隆本仓库，用于阅读和编辑插件内容：

```sh
git clone https://github.com/stvsl/AtechCICTPilot-adapters.git
```

单独克隆只能阅读和编辑插件；构建、打包与测试必须在主程序仓库内进行，因为编译器和
运行时由主程序提供。

## 构建与验证

在主程序仓库根目录执行，下列命令中的 `src/adapter/...` 即本仓库：

```sh
cmake --preset=dev-fast
cmake --build --preset=dev-fast --target plugin_<PackageId>
```

单独编译某个插件：

```sh
python tools/compile_plugin.py --source src/adapter/hello_world_adapter --out build/manual
```

插件的专项测试命令写在各插件文档中。版本轮次、归档命名、调试包与账本规则的完整约定见
[插件开发约定](https://github.com/stvsl/AtechCICTPilot/blob/master/docs/development/plugin-development.md)。
各插件文档中的“仓库根目录”均指主程序仓库根目录。

## 修改流程

1. 在主程序的 `src/adapter`（即本仓库工作树）中修改插件，必要时用主程序的工作台
   生成新插件的 README 与 `docs/` 骨架。
2. 在本仓库提交并推送插件改动，包括构建产生的 `plugin_version_status.md` 更新。
3. 回到主程序提交子模块指针：`git add src/adapter && git commit -m "chore(adapter): 更新适配器子模块"`。

提交信息沿用主程序的 Conventional Commit 风格（`feat:`、`fix:`、`refactor:`、`chore:` 等），
每次提交只处理一个主题；修改插件行为时同步更新该插件的 README 与 `docs/`。

## 文档

- [插件开发约定](https://github.com/stvsl/AtechCICTPilot/blob/master/docs/development/plugin-development.md)：布局、编译、版本轮次与验证要求。
- [运行时文档](https://github.com/stvsl/AtechCICTPilot/blob/master/docs/runtime/README.md)：脚本可用的模块、权限模型与执行契约。
- [适配器插件工作台](https://github.com/stvsl/AtechCICTPilot/blob/master/tools/adapter_scaffold/README.md)：创建、查看、校验与构建插件。

插件文档引用主程序的公共文档时使用 GitHub 绝对链接，因此在本仓库单页浏览时也能跳转。

## 仓库约定

- 只提交插件源文件；不要提交 `build/` 产物、生成的 `workflow.json` 或 `.cictplugin` 插件包。
- `StepConfig.groovy` 是工作流唯一源文件，生成物由构建产生。
- 真实设备或厂商软件相关的验证边界要写进插件文档，区分受控夹具验证与现场验证。
