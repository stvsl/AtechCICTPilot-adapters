# CANoe 测试工程包

本文适用于当前 `canoe_test_adapter`。工程描述符使用 `ContractVersion: "1.0"`，
支持 VTEST、通信测试和复用工程原生测试设置。完整执行细节见[执行说明](execution.md)。

## 工程布局与描述符

ZIP 可包含一层工程目录。脚本优先查找根目录或子目录中的 `canoe-project.json`，
以描述符所在目录作为工程根；未找到描述符时，递归查找唯一 `.cfg`，并使用该工程
已有的测试设置。存在多个 `.cfg` 且无描述符时无法确定入口，会在准备阶段失败。

```text
canoe-project.zip
└── project/
    ├── canoe-project.json
    ├── configuration.cfg
    ├── tests/
    │   └── sample.vtuexe
    └── report/
```

VTEST 描述符示例：

```json
{
  "ContractVersion": "1.0",
  "Configuration": "configuration.cfg",
  "TestScripts": ["tests/sample.vtuexe"],
  "TestConfiguration": "CICT Test Configuration",
  "Artifacts": []
}
```

通信测试可将 `TestScripts` 改为 `.tse` / `.xml` 测试文件。
同一描述符不能混合 VTEST 与通信脚本。脚本条目也可使用带 `Path`、可选 `Type`
和 `Name` 的对象；`Scripts` 是 `TestScripts` 的备用字段名。
省略脚本列表或使用空数组时，适配器优先检测工程中的 `TestEnvironment`，再检测
`TestConfiguration`，复用已有配置。

所有 `Configuration`、测试脚本和 `Artifacts` 路径均相对描述符目录，使用 `/`；
禁止绝对路径、盘符、反斜杠、空路径段、`.` 和 `..`。
工程 `.cfg` 文件头的主版本不得高于设备属性 `CANOE_VERSION`。

| 字段 | 约束与用途 |
| --- | --- |
| `ContractVersion` | 必填，`"1.0"` |
| `Configuration` | 描述符模式必填，工程内 `.cfg` 相对路径 |
| `TestScripts` | 可选；测试文件数组，缺省时复用工程配置 |
| `TestConfiguration` | VTEST 配置名，默认 `CICT Test Configuration` |
| `TestCaseIds` | 可选；外部用例输入为空时使用的 ID 数组 |
| `Artifacts` | 可选；额外发布的相对文件路径，缺失文件告警 |

各项等待与报告超时参数见[执行说明的工程字段表](execution.md)。

## 用例筛选

`TEST_CASE_IDS` 可选，支持 `.json` / `.txt` 文件。文本按换行、逗号或分号拆分；
JSON 支持字符串数组，以及包含 `ids`、`testCaseIds`、`TestCaseIds` 或 `cases`
数组的对象。例如：

```json
["TG0_TC1_SC01", "TG0_TC1_SC02"]
```

外部输入为空时使用描述符的 `TestCaseIds`；仍为空则执行发现到的全部用例。
配置阶段禁用未匹配的用例，没有匹配项时失败。

## 实例与报告

`NEW_CANOE_WHEN_START` 决定新建还是附加 CANoe。版本、安装目录发现与实例
所有权见[执行说明](execution.md)，维护新版本见[版本支持指南](version-support.md)。

`CANOE_REPORT_TYPE` 为必填多选，ID 精确使用 `vtestreport`、`XML`、`HTML`、`PDF`。
适配器总会记录汇总结果，报告收集位于 `post.always` 的清理之前；具体格式、发布 ID
和失败时的部分产物规则见执行说明。GUI 与 TUI 使用同一工程输入和报告选择契约。
