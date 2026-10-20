# 使用与验收

## 输入

所有输入均可省略；GUI、TUI 与平台任务使用相同清单和脚本校验。

| 输入 | 范围与默认值 | 用途 |
| --- | --- | --- |
| `STAGE_COUNT` | 1–100，默认 3 | 实际运行中生成的阶段数量 |
| `STAGE_DELAY_MS` | 0–10000，默认 500 | 每个动态阶段的等待时间，便于观察和暂停 |
| `FAIL_AT_STAGE` | 0–`STAGE_COUNT`，默认 0 | 在指定阶段抛出异常；0 禁用 |

宿主将输入保存为隔离资源，脚本通过 `task.requirement()` 与 `fs.readText()` 读取。
后端测试也可用同名 `task.option()` 提供值，需求输入优先。非整数、越界和不一致的
参数会导致引导阶段失败，同时执行报告发布与清理。

## 生成顺序与 API

默认执行顺序为：

```text
seed_stages → dynamic_1 → dynamic_2 → dynamic_3 → verify_stages
→ publish_report（收尾）→ cleanup（收尾）
```

`StepConfig.groovy` 中不存在 `dynamic_*` 声明。引导阶段调用一次：

```js
task.addStage({
    stageId: "dynamic_1",
    name: "动态阶段 1/3",
    exportName: "executeDynamicStage",
    timeoutMs: 5500,
    arguments: [1, { previous: 0, marker: "动态实参" }]
});
```

`exportName` 指向同一个入口模块导出的函数。实参为 JSON 值，在阶段执行时按顺序
传给函数。`executeDynamicStage()` 根据当前完成数量决定是否继续创建后继阶段。

同一阶段连续创建 A、B 时顺序为“当前阶段 → A → B → 原后继阶段”；A 又创建 C 时，
顺序变为“当前阶段 → A → C → B → 原后继阶段”。创建立即生效，当前阶段结束后才执行。
ID 与全部静态阶段、收尾阶段及已创建阶段不能重复；普通阶段总数上限为 1000。
模块初始化和收尾阶段不能创建阶段。

## GUI / TUI 验收

1. 导入插件，全部输入留空后提交，确认三个动态阶段依次出现在任务详情中。
2. 设置 `STAGE_COUNT=5`、`STAGE_DELAY_MS=1000`，观察动态阶段逐个创建。
   暂停后阶段停止推进，继续后沿用原流程；重新开始后重新生成流程。
3. 设置 `FAIL_AT_STAGE=2`，确认 `dynamic_2` 失败、静态验证不执行，两个收尾阶段
   仍成功；报告保留已生成 `[1, 2]`、已完成 `[1]`，`verified=false`。
4. 设置较长等待，在动态阶段运行时取消，确认没有继续创建后继阶段，报告和清理
   仍执行。再次打开任务或重启客户端后，已创建阶段与实际状态保持可查询。

报告发布 ID 为 `DYNAMIC_STAGE_REPORT`，URI 为
`artifact://dynamic-stage-report.json`，包含配置、创建顺序、开始顺序、完成顺序及
最终验证标记。失败、取消、超时也会发布部分报告；工作区临时状态由最后的收尾阶段删除。
重新开始会原子替换上一轮报告，任务执行日志继续保留各轮事件。

## 自动验证

```sh
cmake --build --preset=dev-fast --target AtechCICTPilot_exe \
  AtechCICTPilot_runtime_interface_test AtechCICTPilot_tui_test
ctest --preset=dev-fast -R 'AtechCICTPilot_(dynamic_stage|tui_)'
```

运行时回归使用真实 QuickJS / CPython，验证递归创建、连续插入、参数传递、重复 ID、
输入限制、超时、取消和失败收尾。真实 PTY 回归经 TUI 导入并执行正式插件，校验
终端阶段展示、持久化顺序及实际报告。GUI 视觉效果由用户人工验证。
