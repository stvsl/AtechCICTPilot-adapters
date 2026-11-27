# CANoe 测试适配器 PackageInfo.json 说明

本文说明 [PackageInfo.json](../PackageInfo.json) 的字段、任务输入、设备配置和
运行时权限，供插件维护者、平台对接人员和测试设备配置人员使用。说明对应当前
源码清单：`ManifestVersion = 2`、`PackageId = canoe_test_adapter`、基础版本
`PackageVersion = 1.0.0`。

清单描述插件“提供什么能力、需要什么输入、允许调用什么工具”；执行阶段由
[StepConfig.groovy](../StepConfig.groovy) 定义，具体行为由
[scripts/canoe_test.js](../scripts/canoe_test.js) 及其子模块实现。修改清单不会自动
改变脚本中的测试逻辑。GUI 与 TUI 共用同一份清单及后端契约。

## 1. 文件结构

| 字段组 | 作用 |
| --- | --- |
| 基本信息 | 标识插件、展示名称、版本、作者、节点和能力名称 |
| `PlatformEngineeringInfo` | 声明平台可关联的工程包类型 |
| `Runtime` | 指定宿主脚本 API 版本和脚本语言 |
| `Permissions` | 声明 COM 对象、可执行文件和提权许可 |
| `CallingRuntime` | 列出清单声明使用的外部调用能力 |
| `SelfExaminationAbility` | 声明是否具备设备自检能力 |
| `RequirementProperty` | 定义每次任务提供的输入 |
| `OnDeviceProperty` | 定义测试设备侧配置 |

JSON 字段名和属性 ID 区分大小写。文件必须是合法 JSON，不能直接加入注释、尾随
逗号或省略号。下文的中文解释应保留在文档中。

## 2. 基本信息

| 字段 | JSON 类型 | 当前值 | 含义 |
| --- | --- | --- | --- |
| `ManifestVersion` | 整数 | `2` | 插件清单格式版本，不是插件发布版本 |
| `PackageId` | 字符串 | `canoe_test_adapter` | 插件唯一标识；构建目标为 `plugin_canoe_test_adapter` |
| `PackageNameCN` | 字符串 | `CANoe 测试适配器` | 中文显示名称 |
| `PackageNameEN` | 字符串 | `CANoe Test Adapter` | 英文显示名称 |
| `PackageVersion` | 字符串 | `1.0.0` | 源清单中的基础版本 |
| `DescriptionCN` | 字符串 | `按压缩包工程清单顺序执行 CANoe 测试并逐工程发布报告` | 中文功能简介 |
| `DescriptionEN` | 字符串 | `Execute CANoe projects in archive order and publish each project report` | 英文功能简介 |
| `Author` | 字符串 | `DOTRUST` | 作者或维护组织 |
| `NodeType` | 字符串 | `Test` | 节点类型，本插件为测试节点 |
| `CapabilityNameCN` | 字符串 | `CANoe 测试` | 中文能力名称 |
| `CapabilityNameEN` | 字符串 | `CANoe Test` | 英文能力名称 |

`PackageVersion`、`Runtime.ApiVersion`、`CANOE_VERSION` 是三个独立概念：分别是
插件基础版本、宿主脚本 API 版本、设备安装的 CANoe 主版本。

当前构建规则将基础版本与四位构建轮次组合成完整包版本，例如 `1.0.0_0001`。
源码中仍填写 `1.0.0`，不要手工附加构建轮次。构建账本、内容摘要和版本递增规则见
[插件开发约定](https://github.com/stvsl/AtechCICTPilot/blob/master/docs/development/plugin-development.md)。

## 3. 平台工程包声明

`PlatformEngineeringInfo` 是对象数组，当前声明两个工程包标识：

| `EngineeringPackageId` | `EngineeringPackageNameCN` | `EngineeringPackageNameEN` |
| --- | --- | --- |
| `CANOE_TEST_PACKAGE_TEST_MODEL` | `CANoE Test Model 工程` | `CANoE Test Model Package` |
| `CANOE_TEST_PACKAGE_TEST_UNIT` | `CANoE Test Unit 工程` | `CANoE Test Unit Package` |

这些 ID 与任务输入 `CANOE_PROJECT.platform.tags` 对应，用于平台工程资源匹配。
它们不是 ZIP 文件名，也不决定脚本打开哪个 `.cfg`；工程计划仍由输入文件内容决定。

## 4. 脚本运行时

```json
{
    "Runtime": {
        "ApiVersion": "1.0",
        "Language": "javascript"
    }
}
```

- `ApiVersion` 为字符串 `"1.0"`，指定宿主运行时 API 契约。
- `Language` 为 `"javascript"`，本插件使用宿主嵌入的 JavaScript 引擎。
- 脚本入口和导出函数写在工作流中，`Runtime` 本身不指定入口文件。

## 5. 运行时权限

### 5.1 COM 权限

| 字段 | 当前值 | 作用 |
| --- | --- | --- |
| `Permissions.COM.ProgIds` | `["CANoe.Application"]` | 声明允许操作的 CANoe Automation ProgID |
| `Permissions.COM.AllowActiveObject` | `true` | 允许访问当前活动的 COM 实例 |

附加现有 CANoe 实例需要活动对象权限。该权限只是允许访问，不代表启动时一定
附加；实际启动方式由设备属性 `NEW_CANOE_WHEN_START` 决定。

### 5.2 CLI 可执行文件

`Permissions.CLI.Executables` 声明四个工具。脚本通过稳定的 `Id` 解析可执行文件，
宿主按 `WindowsInstalledProduct` 发现安装目录并拼接相对路径。

| `Id` | `DisplayNameTemplate` | `RelativePath` | 目录回退属性 | 用途 |
| --- | --- | --- | --- | --- |
| `CANOE_EXECUTABLE` | `Vector CANoe {version}` | `Exec64/CANoe64.exe` | `CANOE_INSTALL_DIR` | 启动目标 CANoe |
| `CANOE_COM_REGISTRAR` | `Vector CANoe {version}` | `Exec64/RegisterComponents.exe` | `CANOE_INSTALL_DIR` | 注册目标安装的 COM 组件 |
| `CANOE_SABCMD` | `Vector CANoe {version}` | `Exec64/sabcmd.exe` | `CANOE_INSTALL_DIR` | 报告转换 |
| `CANOE_REPORT_VIEWER` | `Vector CANoe Test Report Viewer {version}` | `ReportViewerCli.exe` | `CANOE_REPORT_VIEWER_DIR` | 报告查看器命令行转换 |

四个工具都使用 `VersionDeviceProperty = CANOE_VERSION`。例如设备版本为 `19` 时，
CANoe 安装显示名称模板展开为 `Vector CANoe 19`。这里的 `{version}` 取设备属性，
不取插件的 `PackageVersion`。

`WindowsInstalledProduct` 内各字段含义如下：

| 字段 | JSON 类型 | 说明 |
| --- | --- | --- |
| `DisplayNameTemplate` | 字符串 | Windows 已安装产品显示名称模板，包含一个 `{version}` 占位符 |
| `VersionDeviceProperty` | 字符串 | 提供版本值的设备属性 ID，本插件为 `CANOE_VERSION` |
| `RelativePath` | 字符串 | 相对于产品安装根目录的工具路径 |
| `PathDeviceProperty` | 字符串 | 自动发现失败时读取的设备安装根目录属性 |
| `AllowDisplayNameSuffix` | 布尔值 | 是否接受模板展开名称后的额外后缀；报告查看器显式设为 `true`，其余工具省略，默认为 `false` |

`CANOE_COM_REGISTRAR` 在工具对象上额外设置 `AllowElevation = true`，允许脚本
请求 Windows 管理员权限。其余三个工具未设置该字段，默认为 `false`。
`Permissions.CLI.AllowTerminal = false` 表示没有授权终端能力。

启动新实例时，脚本先核对 `CANoe.Application` 的 COM 注册是否指向所选安装；
不一致时通过注册工具请求 UAC，成功后重新核对。取消 UAC 或注册失败会终止任务，
清理时不会恢复先前的 COM 注册。附加现有实例不会修改 COM 注册。完整流程见
[执行说明](execution.md)。

### 5.3 调用能力与自检标记

`CallingRuntime = ["COM", "CLI"]` 声明本插件使用 COM 和 CLI 能力；具体授权
对象及工具由 `Permissions` 描述。

`SelfExaminationAbility = true` 声明插件具备自检能力。它不是“设备已通过自检”的
结果，也不在清单中定义具体自检步骤。

## 6. 任务输入 RequirementProperty

这些属性由每次任务提供，与设备安装配置分开维护。

| `id` | 显示名称 | `type` | 必填 | `fileExtension` / 可选值 | `platform.type` | `platform.tags` |
| --- | --- | --- | --- | --- | --- | --- |
| `CANOE_PROJECT` | CANoe 工程文件 | `file` | 是 | `.zip` | `EngineeringPackage` | 两个工程包 ID，见第 3 节 |
| `TEST_CASES` | 测试用例名称配置 | `file` | 否 | `.json|.txt` | `CaseSelection` | 空数组 |
| `CANOE_REPORT_TYPE` | CANoe 测试报告类型 | `enum_multi` | 是 | `vtestreport`、`XML`、`HTML`、`PDF` | `Original` | 空数组 |

### 6.1 CANOE_PROJECT

必填 ZIP 文件，包含一个或多个 CANoe `.cfg` 工程及其依赖资源，可附带 `canoe.json`
工程清单。这里应提供工程压缩包，而不是直接提供 `.cfg`。

工程执行计划依次采用：`TEST_CASES` 中的工程与用例、唯一 `canoe.json` 中的最高
兼容版本组、递归扫描并排序的 `.cfg` 文件。具体路径约束和示例见
[工程包说明](project-package.md)。

### 6.2 TEST_CASES

可选 UTF-8 JSON 或文本文件，用于指定配置路径及测试用例名称。
`fileExtension = ".json|.txt"` 中的 `|` 表示允许两种扩展名。

未提供时执行工程中现有的启用项；提供时优先采用该文件指定的工程和用例，
同一工程的重复条目合并后执行一次。文件内容格式见
[指定测试用例](project-package.md#指定测试用例)。

### 6.3 CANOE_REPORT_TYPE

必填多选，至少选择一种报告类型。选项对象的 `id` 是脚本接收的值，
`nameCN` / `nameEN` 仅用于显示。

| 选项 `id` | 中文显示名称 | 含义 |
| --- | --- | --- |
| `vtestreport` | CANoe 原生 VTESTReport | CANoe 原生 `.vtestreport` 报告 |
| `XML` | CANoe XML 报告 | XML 报告 |
| `HTML` | CANoe HTML 报告 | HTML 报告 |
| `PDF` | CANoe Report Viewer PDF 报告 | PDF 报告 |

`vtestreport` 为小写，其余三个 ID 为大写，不要用显示名称代替。清单未声明默认
选项；不能因 `required = true` 就假定自动选择全部格式。报告转换还需要相应工具
可用，声明权限并不代表机器已安装这些工具。

每个工程结束后分别收集和发布所选报告；最终结果及报告目录见
[报告和结果](project-package.md#报告和结果)。

## 7. 设备配置 OnDeviceProperty

这些属性描述运行插件的测试设备环境。

| `id` | 显示名称 | `type` | 必填 | 配置说明 |
| --- | --- | --- | --- | --- |
| `CANOE_VERSION` | CANoe 版本 | `enum` | 是 | 单选主版本：`15`、`16`、`17`、`18`、`19`、`20`；选项 ID 均为字符串 |
| `CANOE_PROJECT_DIR` | 任务工作区根目录 | `directory` | 是 | 必填任务工作区根目录；当前脚本未读取，见下文 |
| `CANOE_INSTALL_DIR` | CANoe 安装目录（自动发现失败时指定） | `directory` | 否 | CANoe 产品安装根目录，其下应有 `Exec64/` |
| `CANOE_REPORT_VIEWER_DIR` | 报告查看器安装目录（自动发现失败时指定） | `directory` | 否 | Report Viewer 安装根目录，其下应有 `ReportViewerCli.exe` |
| `NEW_CANOE_WHEN_START` | 启动时新建 CANoe 实例 | `boolean` | 是 | `true` 启动新实例；`false` 附加当前活动实例 |

清单中的 `required` 只规定是否必填，不提供默认值。`NEW_CANOE_WHEN_START` 必须
明确配置；布尔值 `false` 是有效选择，不代表缺少输入。

`CANOE_PROJECT_DIR` 当前仅在清单中声明，生产脚本没有读取该属性。工程解压到
宿主工作区的 `workspace://canoe-test/project`，具体工程根目录由工程规划结果
确定。填写该属性不会改变当前脚本的工程解压位置。

`CANOE_VERSION` 是插件当前允许选择的主版本范围，不代表任意工程、硬件或授权
组合都已通过实机验证。脚本还会核验实例实际版本和 `.cfg` 文件头版本，要求工程
主版本不高于设备版本。支持版本的维护方法见[版本指南](version-support.md)。

两个安装目录属性应填写产品根目录的绝对路径，不要填写 `.exe` 文件路径，也不要把
`CANOE_INSTALL_DIR` 指向 `Exec64`，否则相对路径拼接后会多出一层 `Exec64`。

新建实例时会关闭当前活动 Automation 实例，按所选版本启动并在最终清理时退出
插件拥有的进程。附加模式要求存在活动实例且版本匹配，默认保留该进程；实际测试
仍会打开任务工程并操作 Measurement。启动、附加与清理边界见
[执行说明](execution.md#启动与-com-注册)。

## 8. 属性对象的公共字段

`RequirementProperty` 和 `OnDeviceProperty` 的元素使用以下公共字段：

| 字段 | 作用 |
| --- | --- |
| `id` | 稳定属性标识，供脚本、工作流和平台引用 |
| `nameCN` / `nameEN` | 中文 / 英文显示名称 |
| `type` | 决定输入类型；本清单使用 `file`、`enum_multi`、`enum`、`directory`、`boolean` |
| `required` | 布尔值，声明该输入是否必填 |
| `fileExtension` | 文件类型允许的扩展名，多种扩展名用 `|` 分隔 |
| `values` | 枚举选项数组，每个选项含 `id`、`nameCN`、`nameEN` |
| `platform` | 平台来源映射；`type` 为来源类型，`tags` 为关联标签数组 |

`enum` 为单选，`enum_multi` 为多选。`platform` 只出现在本清单的任务输入中，
设备属性未配置该字段。不要把枚举显示名称写入 `values[].id`，也不要把
`platform.tags` 当作工程执行顺序。

## 9. 配置示例

以下是属性取值示例，便于在 GUI / TUI 或平台配置界面逐项填写；它们不是完整任务
包 JSON，也不是对 `PackageInfo.json` 的替换。路径和文件名仅为示例，应使用设备
上的实际安装目录及实际任务文件。

设备侧示例：

| 属性 | 示例值 |
| --- | --- |
| `CANOE_VERSION` | `"19"` |
| `NEW_CANOE_WHEN_START` | `true` |
| `CANOE_INSTALL_DIR` | 自动发现成功时不填；需要回退时填写 CANoe 安装根目录 |
| `CANOE_REPORT_VIEWER_DIR` | 自动发现成功时不填；需要回退时填写报告查看器安装根目录 |

任务侧示例：

| 属性 | 示例值 |
| --- | --- |
| `CANOE_PROJECT` | `canoe-project.zip` 文件 |
| `TEST_CASES` | 可选 `cases.json` 或 `cases.txt` 文件 |
| `CANOE_REPORT_TYPE` | 同时选择 `vtestreport` 和 `HTML` |

这组配置表示：在 CANoe 19 环境中新建实例，依工程计划执行任务，并逐工程发布
原生报告与 HTML 报告。若 COM 注册需切换，运行期间还需要批准 Windows UAC。

## 10. 修改与校验

维护清单时应同步检查以下关联：

1. 修改 `PackageId` 后核对插件构建目标、平台引用和调试配置。
2. 修改工程包 ID 时同步维护 `PlatformEngineeringInfo` 与
   `CANOE_PROJECT.platform.tags`。
3. 修改属性 ID 时同步检查工作流、入口脚本及其子模块对输入的读取。
4. 修改报告选项时同步维护 `canoe_test.js` 中报告类型常量、允许值和顺序。
5. 修改支持版本、工具 ID 或安装路径时，同步检查会话模块、报告转换和版本测试。
6. 修改契约后同步更新本文及相应工程包 / 执行文档。

结构约束以 [PluginJson.h](https://github.com/stvsl/AtechCICTPilot/blob/master/src/service/plugin/PluginJson.h) 为源头，
[plugin-manifest.schema.json](https://github.com/stvsl/AtechCICTPilot/blob/master/docs/schemas/plugin-manifest.schema.json)
由 C++ 契约生成，不要为适配清单而手工修改生成 Schema。公共规则见
[JSON 契约说明](https://github.com/stvsl/AtechCICTPilot/blob/master/docs/development/json-contracts.md)。

在仓库根目录构建本插件：

```sh
cmake --preset=dev-fast
cmake --build --preset=dev-fast --target plugin_canoe_test_adapter
```

构建会执行清单契约校验、编译工作流并生成插件包。打包成功可能更新源码中的
构建版本账本；产物路径和版本规则见[插件开发约定](https://github.com/stvsl/AtechCICTPilot/blob/master/docs/development/plugin-development.md)。
不要手工修改生成的 `workflow.json` 和 `.cictplugin` 文件。
