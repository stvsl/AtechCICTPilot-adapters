import * as task from "@atech/task";
import * as taskCase from "@atech/task/case";
import * as fs from "@atech/fs";

import * as cli from "@atech/cli";

import {createExecutionPlan, prepareTestSetupLayout} from "./vcardas/project.js";
import {NativeTools} from "./vcardas/native.js";
import {VcardasSession} from "./vcardas/session.js";

let plan = null;
let native = null;
let session = null;
let activeTarget = null;
const results = new Map();
const packedOutputs = new Map();

function publishJson(id, uri, value, name, group = "VCarDAS") {
    fs.writeText(uri, JSON.stringify(value, null, 2));
    task.publish(id, uri, name, "application/json", group);
}

function reportResults() {
    const cases = plan ? plan.targets.map((target) => {
        const value = results.get(target.name);
        return {caseId: target.name, name: target.name,
            result: value ? value.result : "none",
            durationMs: value ? value.durationMs : 0,
            message: value ? value.message : "未执行（前序失败、取消或尚未开始）"};
    }) : [];
    if (cases.length) {
        task.reportResult({total: cases.length,
            passed: cases.filter((item) => item.result === "passed").length,
            failed: cases.filter((item) => item.result === "failed").length,
            cases});
        for (const value of cases) {
            const current = results.get(value.caseId);
            if (current && current.finished) {
                taskCase.finish(value.caseId, {configId: "vcardas",
                    result: value.result, durationMs: value.durationMs, message: value.message});
            }
        }
    }
    publishJson("vcardas-results", "artifact://module-results.json",
        {targets: cases, snapshots: [...results.values()]}, "各目标执行结果");
}

function saveSnapshot(name, snapshot, startedAt) {
    const previous = results.get(name);
    const completed = snapshot.IsFinal === true;
    results.set(name, {name, snapshot,
        result: completed && snapshot.Result === "Passed" && snapshot.EndReason === "Completed"
            && snapshot.Executed === snapshot.Total && snapshot.Failed === 0
            && snapshot.Passed === snapshot.Total
            ? "passed" : completed ? "failed" : "none",
        durationMs: previous && previous.finished ? previous.durationMs : Date.now() - startedAt,
        finished: completed,
        message: `${snapshot.Result || snapshot.State || "运行中"} / ${snapshot.EndReason || ""}`});
    reportResults();
}

export function prepare() {
    results.clear();
    packedOutputs.clear();
    const rootUri = "workspace://project";
    task.info("解压工程，完整校验全部目标、CAPL、DLL、profile.ini 和打包依赖");
    fs.extractArchive(task.requirement("CONFIG_PACKAGE"), rootUri);
    plan = createExecutionPlan(rootUri,
        task.requirement("APP_FILE"), task.requirement("DRIVER_FILE"));
    prepareTestSetupLayout(plan.projectUri);
    taskCase.publish({configId: "vcardas", name: "VCarDAS 刷写目标",
        nodes: plan.targets.map((target) => ({nodeId: target.name, name: target.name, type: "case"}))});
    publishJson("vcardas-execution-plan", "artifact://execution-plan.json",
        plan, "VCarDAS 刷写目标清单");
    reportResults();
    task.info(`本次按名称排序串行执行：${plan.targets.map((target) => target.name).join(", ")}`);
    task.info("任务工程副本已设置为仅显示测试配置页面");
}

export function preparePacking() {
    if (!plan) { throw new Error("尚未生成完整执行计划"); }
    native = new NativeTools();
    native.preparePacking(plan);
    for (let index = 0; index < plan.targets.length; ++index) {
        task.addStage({stageId: `pack_${index + 1}`, name: `打包 ${plan.targets[index].name}`,
            exportName: "packTarget", timeoutMs: 390000, arguments: [index]});
    }
}

export function packTarget(index) {
    const target = plan.targets[index];
    task.info(`执行工程随附的打包脚本：${target.commandUri}`);
    const result = native.pack(target);
    packedOutputs.set(target.name, result.outputs);
    task.info(`${target.name} 本轮 HEX、镜像、签名、profile 和分片检查通过`);
}

export function loadFixedDirectory() {
    if (plan.targets.some((target) => !packedOutputs.has(target.name))) {
        throw new Error("尚未完成全部目标的工程打包");
    }
    native.acquire();
    const loaded = native.load(plan, packedOutputs);
    publishJson("vcardas-loaded", "artifact://fixed-directory.json", loaded, "固定目录加载记录");
}

export function openTool() {
    native.checkGuard();
    session = new VcardasSession(native);
    const executable = cli.resolveExecutable("VCARDAS_EXECUTABLE");
    session.connect(executable);
    publishJson("vcardas-session", "artifact://session.json", session.identity, "工具进程身份");
    session.openProject(fs.nativePath(plan.projectUri));
}

export function configureModules() {
    session.prepareModules(plan.targets.map((target) => ({...target,
        // CAPL 和 DLL 使用工作副本；CAPL 内容不变，数据仍从固定目录读取。
        scriptPath: fs.nativePath(target.scriptUri), dllPath: fs.nativePath(target.dllUri),
        onCompile: (compiled) => publishJson(`compile-${target.name}`,
            `artifact://compile-${target.name}.json`, compiled,
            `${target.name} 编译诊断`, `VCarDAS/${target.name}/编译`)
    })));
    for (let index = 0; index < plan.targets.length; ++index) {
        task.addStage({stageId: `configure_${index + 1}`, name: `配置与编译 ${plan.targets[index].name}`,
            exportName: "configureTarget", timeoutMs: 780000, arguments: [index]});
    }
    task.addStage({stageId: "select_modules", name: "确定单轮执行范围",
        exportName: "selectModules", timeoutMs: 120000});
}

export function configureTarget(index) {
    session.configureTarget(index);
}

export function selectModules() {
    session.selectModules();
    for (let index = 0; index < plan.targets.length; ++index) {
        task.addStage({stageId: `run_${index + 1}`, name: `执行 ${plan.targets[index].name}（一轮）`,
            exportName: "runTarget", timeoutMs: 2280000, arguments: [index]});
    }
}

export function runTarget(index) {
    const target = plan.targets[index];
    const startedAt = Date.now();
    task.checkpoint();
    try {
        taskCase.start(target.name, {configId: "vcardas"});
        activeTarget = {name: target.name, startedAt};
        results.set(target.name, {name: target.name, result: "none", finished: false,
            durationMs: 0, message: "运行中"});
        if (index === 0) { session.startMeasurement(); }
        session.run(target, (snapshot) => {
            saveSnapshot(target.name, snapshot, startedAt);
            task.progress(100 * snapshot.Executed / Math.max(1, snapshot.Total));
        });
        activeTarget = null;
    } catch (error) {
        const current = results.get(target.name);
        results.set(target.name, {...current, name: target.name, result: "failed",
            durationMs: Date.now() - startedAt, finished: true,
            message: String(error.message || error).substring(0, 4096)});
        reportResults();
        activeTarget = null;
        throw error;
    }
    task.checkpoint();
}

export function collectResults() {
    reportResults();
    if (plan.targets.some((target) => !results.get(target.name)
            || results.get(target.name).result !== "passed")) {
        throw new Error("部分目标没有通过本轮刷写测试");
    }
    task.progress(100);
}

export function cleanup() {
    const errors = [];
    // VM 硬中断可能跳过 JS catch；在独立收尾上下文补齐目标终态，避免界面永久运行中。
    if (activeTarget) {
        const current = results.get(activeTarget.name);
        if (!current || !current.finished) {
            results.set(activeTarget.name, {...current, name: activeTarget.name,
                result: "failed", finished: true, durationMs: Date.now() - activeTarget.startedAt,
                message: "执行中断，详见任务错误及本轮收尾快照"});
        }
        activeTarget = null;
    }
    try {
        if (session) {
            session.cleanup((name, snapshot) => {
                const current = results.get(name);
                // 保持原失败原因，另外保存收尾查询得到的本轮快照和可用报告。
                if (current) { current.cleanupSnapshot = snapshot; }
                if (snapshot.ReportState === "Ready" && snapshot.ReportPath) {
                    native.collect(plan.targets.find((target) => target.name === name), snapshot.ReportPath);
                }
            });
        }
    } catch (error) { errors.push(String(error.message || error)); }
    finally {
        session = null;
        if (native) {
            try { native.release(); }
            catch (error) { errors.push(String(error.message || error)); }
        }
        native = null;
        reportResults();
        publishJson("vcardas-cleanup", "artifact://cleanup.json",
            {success: errors.length === 0, errors, fixedDirectoryRetained: true}, "停止测量与软件退出记录");
    }
    if (errors.length) { throw new Error(errors.join("；")); }
}
