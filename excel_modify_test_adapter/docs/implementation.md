# ExcelModifyTest 测试插件

## 用途与实际副本

此插件验证“插件携带自己的 JavaScript 生态库，宿主只提供受控 I/O”的路线，
不新增宿主 Excel 模块，不要求安装 Microsoft Excel、Node.js 或 npm 才能运行。

- 插件清单：[PackageInfo.json](../PackageInfo.json)。
- 工作流：[StepConfig.groovy](../StepConfig.groovy)。
- 实际工作簿副本：[BootloaderTest.xlsx](../scripts/data/BootloaderTest.xlsx)。
- 运行入口：[excel_modify_test.js](../scripts/excel_modify_test.js)。
- 定点修改实现：[xlsx.js](../scripts/xlsx.js)。

工作簿模板原样随插件打包，不依赖下载目录。
工作流默认读取 `plugin://scripts/data/BootloaderTest.xlsx`。
插件根只读，既不会覆盖下载原件，也不会修改插件内模板。

插件按工作簿关系定位名为 `FlashPath` 的子表，查找唯一的
`CfgDriverFile` 字段，并修改紧邻右侧的值单元格。内置模板对应
`B4 → C4`；代码不硬编码行号或工作表 ZIP 文件名。
写入值是实际执行时的本地 ISO 8601 时间文本，含时区偏移，例如
`2026-10-20T09:30:00+08:00`，不是插件编译时的固定时间。

## 为什么不用 ExcelJS 整本读写

内置工作簿含外部链接和打印设置。已用 ExcelJS 4.4.0 对实际副本做普通
load/writeBuffer 回环，发现输出缺少外部链接等部件，因此没有把这种有损
回环作为实现。

本插件自带 fflate 0.8.3 与 @xmldom/xmldom 0.9.12 的 ESM bundle：
ZIP 解析后只替换目标单元格的 XML 片段，所有其它 ZIP 部件的展开字节保持不变，
包括外部链接、命名范围、共享字符串、样式与其它工作表。
压缩容器会重新封装，ZIP 元数据/压缩字节不保证与原文件相同；不会访问外部链接。

供应商代码位于 [vendor](../scripts/vendor/portable-xlsx.mjs)，
以 `.mjs` 发布，避免把上游库当作业务脚本插桩。业务入口与修改逻辑仍为
`.js`，可按现有插件调试流程使用；供应商库内部不提供断点/单步承诺。
依赖版本和许可证与 bundle 一并打包。

## 构建与使用

按仓库现有开发预设执行：

```sh
cmake --preset=dev-fast
cmake --build --preset=dev-fast --target plugin_ExcelModifyTest
```

插件包生成于 `build/dev-fast/plugins/ExcelModifyTest-<版本>.cictplugin`。
GUI 与 TUI 共用同一插件导入及离线执行后端：导入这个插件包，新建离线任务，
添加 `ExcelModifyTest` 节点后执行；不需要选择额外的文件参数。
任务成功后提供以下产物：

- `artifact://BootloaderTest.xlsx`：修改后的完整工作簿。
- `artifact://ExcelModifyTest-result.json`：字段位置、原值、新值、执行时间和修改部件记录。

测试可用节点选项 `InputUri` 覆盖默认输入，仍只接受宿主虚拟 URI。
这只是自动化测试入口，不会绕过宿主目录权限。

## 依赖可重现构建

运行插件不需要 npm；只有更新或重新生成 vendor 时需要 Node.js 与 pnpm。
构建源与锁文件在 [工具目录](https://github.com/stvsl/AtechCICTPilot/blob/master/tools/excel_modify_test_vendor/package.json)：

```sh
pnpm --dir tools/excel_modify_test_vendor install --frozen-lockfile --ignore-scripts
pnpm --dir tools/excel_modify_test_vendor run build
```

不要把整个 node_modules 放进插件包。该目录只用于开发构建，已排除版本管理。

## 保护边界与验收

仅支持普通 XLSX，不支持加密文件、数字签名或 VBA 工作簿。
对缺少工作表、字段不唯一、右侧值单元格缺失、目标参与合并、损坏 XML/ZIP 等情况
直接失败，不猜测或静默修改其它位置。
输入/输出上限为 16 MiB，展开总量 32 MiB、单部件 8 MiB、最多 512 个部件；
XML 不允许 DTD/实体声明。使用同步纯 JS API，不依赖浏览器定时器、Node fs 或 Worker。

回归使用生产 `PluginExecutionThread` 和 QuickJS，以及独立的 ZIP/XML 解析核对，
不以 Node 执行替代插件验证。实际工作簿另用 openpyxl 重新打开，比较全部工作表
及单元格，确认只有目标值改变。TUI 由自动测试验证；GUI 视觉与操作由用户验收。

```sh
cmake --build --preset=dev-fast --target AtechCICTPilot_exe AtechCICTPilot_tui_test AtechCICTPilot_runtime_interface_test
ctest --preset=dev-fast -R 'AtechCICTPilot_(excel_modify|plugin_compiler|tui_)'
```

真实 PTY 回归会通过生产 UI 导入插件、自检、创建并执行离线任务，再读取实际
任务记录和产物核对。现有离线向导存在按钮空文案与键盘焦点问题，因此该回归
在向导中发送 SGR 终端鼠标点击；导入与自检仍使用键盘。它验证完整业务链路，
不代表离线向导的纯键盘可达性已通过，也没有绕过 UI 注入后台任务。
