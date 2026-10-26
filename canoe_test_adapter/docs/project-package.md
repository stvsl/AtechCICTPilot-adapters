# CANoe 测试工程包

`CANOE_PROJECT` 是 ZIP 压缩包，可包含多个 CANoe `.cfg` 工程。适配器按工程计划
顺序打开配置、运行测试，并在切换到下一工程前收集当前工程报告。

## 工程发现顺序

任务可选提供 `TEST_CASES` 测试用例名称配置文件（`.json` 或 `.txt`）。提供后只执行该
文件列出的配置和测试用例，配置顺序与文件中首次出现的顺序一致。同一配置可以重复
出现，适配器会合并它们的用例名称，并且只打开该工程一次。

未提供 `TEST_CASES` 时，适配器在压缩包中查找唯一的 `canoe.json`：

- 找到时，筛选 `CanoeVersion` 小于或等于设备 `CANOE_VERSION` 的版本组，取其中最高版本；
- 版本组内的 `Configuration` 按 JSON 数组顺序执行；
- 找不到兼容版本组时，在开始 CANoe 执行前报错。

没有 `canoe.json` 时，递归发现压缩包中的全部 `.cfg`，按相对路径排序后执行。
路径比较不区分大小写；大小写相同的路径以原始字符串顺序作为次级排序条件。

`canoe.json` 中的配置路径相对于该 JSON 文件所在目录。路径必须指向压缩包内存在的
`.cfg` 文件，并使用 `/` 分隔；不允许绝对路径、盘符、反斜杠、空路径段、`.` 或 `..`。

```text
canoe-project.zip
├── canoe.json
└── project/
    ├── flash1.cfg
    ├── flash2.cfg
    └── flash3.cfg
```

```json
[
  {
    "Configuration": ["project/flash1.cfg", "project/flash2.cfg"],
    "CanoeVersion": "18"
  },
  {
    "Configuration": ["project/flash1.cfg", "project/flash2.cfg", "project/flash3.cfg"],
    "CanoeVersion": "19"
  }
]
```

例如设备配置 CANoe 19 时选择版本 19 组；设备配置 CANoe 18 时选择版本 18 组；
设备配置 CANoe 17 时不选择上述清单并报不兼容错误。每个 `.cfg` 文件头还会独立核验，
其主版本必须小于或等于设备版本。

## 指定测试用例

用例文件支持 UTF-8 JSON 和纯文本两种格式；平台任务通过 `CANOE_TEST_CASES_JSON`
工程包类型提供该文件，GUI 和 TUI 的文件输入同时接受 `.json` 与 `.txt`。

### 文本格式

每行一个工程，格式为 `<相对 .cfg 路径>:<用例>[,<用例>...]`。空行会被忽略：

```text
project/flash1.cfg:C01CASE,C02CASE
project/flash2.cfg:C012CASE
```

执行时按文件行的出现顺序逐个工程打开 CANoe，只运行该工程冒号后列出的测试用例，
完成报告收集后再进入下一行对应的工程。同一 `.cfg` 出现在多行时，用例名称合并后
只执行一次。

### JSON 格式

JSON 是对象数组，字段名区分大小写。`Configuration` 是相对于压缩包根目录的 `.cfg`
路径，`TestCaseNames` 是 CANoe 中测试用例的名称数组：

```json
[
  {
    "Configuration": "project/flash1.cfg",
    "TestCaseNames": ["C01CASE", "C02CASE"]
  },
  {
    "Configuration": "project/flash2.cfg",
    "TestCaseNames": ["C012CASE"]
  }
]
```

两种格式都要求用例名称非空。每个名称必须匹配 CANoe 工程中的测试用例名称；未找到
名称时该工程记为失败并继续后续工程。`TEST_CASES` 与压缩包中的 `canoe.json` 同时
存在时，`TEST_CASES` 中列出的配置和用例优先作为执行清单。

如果省略 `TEST_CASES`，适配器复用每个 `.cfg` 中现有的 `TestConfiguration` 或
`TestEnvironment`，执行其中启用的测试用例。

## 报告和结果

`CANOE_REPORT_TYPE` 是必填多选项，至少选择 `vtestreport`、`XML`、`HTML`、`PDF` 中的一种。
每个工程结束后，适配器生成并发布该工程所选的报告。产物位于
`artifact://canoe-test/reports/<cfg 文件名（不含扩展名）>/`，例如 `project/flash1.cfg`
对应 `reports/flash1/`。文件夹保留配置原名中的中文、空格和标点；同名配置（不区分大小写）
按执行顺序追加 `-2`、`-3` 等编号，并跳过其他配置原本使用的名称，避免报告互相覆盖。
最终汇总文件为 `artifact://canoe-test/execution-result.json`，包含各工程状态、用例结果、
报告错误和已发布产物。

`NEW_CANOE_WHEN_START` 决定启动新 CANoe 进程或附加现有进程。版本和实例所有权见
[执行说明](execution.md)，支持版本见[版本指南](version-support.md)。GUI 与 TUI 共用相同
的工程和用例文件契约。
