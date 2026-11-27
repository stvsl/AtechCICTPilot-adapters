import * as task from "@atech/task";

import {RpcConnection} from "./rpc.js";

function nativePath(value) {
    return String(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function requireObject(value, description) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${description} 返回结构无效`);
    }
    return value;
}

function isTestModule(node) {
    return node.Type === "CaplTest" || node.UsingXmlSetting === true;
}

function subtreeIds(nodes, rootId) {
    const ids = new Set([rootId]);
    for (const node of nodes) {
        if (ids.has(node.parentId)) {
            ids.add(node.Id);
        }
    }
    return ids;
}

export function flattenTree(nodes) {
    if (!Array.isArray(nodes)) { throw new Error("测试配置树不是数组"); }
    const ids = new Set();
    const result = [];
    function visit(values, parentId = null) {
        for (const node of values) {
            requireObject(node, "测试配置节点");
            if (typeof node.Id !== "string" || !node.Id || ids.has(node.Id)
                    || typeof node.Name !== "string" || typeof node.Type !== "string"
                    || !Array.isArray(node.Children)) {
                throw new Error("测试配置树节点缺少标识或重复");
            }
            ids.add(node.Id);
            result.push({...node, parentId});
            visit(node.Children, node.Id);
        }
    }
    visit(nodes);
    return result;
}

function selectedCaseCount(nodes, moduleName) {
    const source = `${moduleName} 的 TestModuleCases`;
    if (!Array.isArray(nodes)) { throw new Error(`${source} 返回的用例树不是数组`); }
    let count = 0;
    function visit(rows, parentEnabled = true, parentSelected = true) {
        for (const row of rows) {
            const {Path: path, Children: children, IsEnable: enabled, IsActive: active} =
                requireObject(row, `${source} 用例节点`);
            if (typeof path !== "string" || !path) {
                throw new Error(`${source} 用例节点缺少有效 Path`);
            }
            const location = `${source} 用例 ${path}`;
            if (children !== null && !Array.isArray(children)) {
                throw new Error(`${location} 的 Children 应为数组或 null`);
            }
            if (typeof enabled !== "boolean") {
                throw new Error(`${location} 的 IsEnable 应为布尔值`);
            }
            if (active !== null && typeof active !== "boolean") {
                throw new Error(`${location} 的 IsActive 应为布尔值或 null`);
            }
            // SDK 可用 null 表示叶子没有子项，以及用例组处于部分勾选状态。
            const available = parentEnabled && enabled;
            const selected = parentSelected && active !== false;
            if (children?.length) {
                visit(children, available, selected);
            } else if (available) {
                if (!selected || active !== true) {
                    throw new Error(`${moduleName} 可用用例没有被选中：${path}`);
                }
                ++count;
            }
        }
    }
    visit(nodes);
    if (count === 0) { throw new Error(`${moduleName} 没有可用的叶子用例`); }
    return count;
}

export class VcardasSession {
    constructor(native, {
        taskApi = task, rpcFactory = () => new RpcConnection(),
        now = () => Date.now(), readyTimeoutMs = 120000, runTimeoutMs = 1800000,
        reportTimeoutMs = 60000, destroyTimeoutMs = 120000, pollMs = 500
    } = {}) {
        this.native = native;
        this.task = taskApi;
        this.rpcFactory = rpcFactory;
        this.now = now;
        this.limits = {readyTimeoutMs, runTimeoutMs, reportTimeoutMs, destroyTimeoutMs, pollMs};
        this.rpc = null;
        this.identity = null;
        this.process = null;
        this.claimed = false;
        this.measurementRequested = false;
        this.inFlight = null;
        this.modules = [];
        this.replacements = [];
        this.executable = "";
    }

    wait(read, accept, timeoutMs, description, cleanup = false) {
        const deadline = this.now() + timeoutMs;
        while (true) {
            if (!cleanup) { this.task.checkCancelled(); this.native.checkGuard(); }
            const result = read();
            if (accept(result)) { return result; }
            if (this.now() >= deadline) { throw new Error(`等待${description}超时`); }
            this.task.delay(Math.min(this.limits.pollMs, deadline - this.now()), cleanup);
        }
    }

    call(method, parameters = [], timeoutMs = 30000, warnings = false) {
        if (!this.identity) { throw new Error(`尚未核验进程身份，不能调用 ${method}`); }
        return this.rpc.call(method, parameters, timeoutMs, warnings);
    }

    verify(status, requireEmpty = false) {
        requireObject(status, "ApplicationStatus");
        if (!Number.isInteger(status.ProcessId) || status.ProcessId <= 0
                || typeof status.Ready !== "boolean") {
            throw new Error("ApplicationStatus 缺少有效 PID 或 Ready");
        }
        if (this.process && status.ProcessId !== this.process.pid) {
            throw new Error("SDK 服务端 PID 与本次启动的进程不一致");
        }
        const actual = this.native.inspect(status.ProcessId, requireEmpty);
        if (actual.pid !== status.ProcessId || !actual.startedAt
                || nativePath(actual.path) !== nativePath(this.executable)
                || (this.identity && (this.identity.pid !== actual.pid
                    || this.identity.startedAt !== actual.startedAt))) {
            throw new Error("SDK 进程身份、启动时间或程序路径不匹配");
        }
        if (requireEmpty && actual.emptyProject !== true) {
            throw new Error("检测到旧工程或无法确认窗口为空，请先手动关闭旧工程");
        }
        return actual;
    }

    connect(executable) {
        this.executable = executable;
        this.rpc = this.rpcFactory();
        let connected = false;
        try { this.rpc.open(1000); connected = true; }
        catch (error) {
            if (!error || !["IO_ERROR", "TIMEOUT"].includes(error.code)) { throw error; }
        }
        if (!connected) {
            const processes = this.native.find(executable);
            if (!Array.isArray(processes) || processes.length > 1
                    || processes.some((item) => nativePath(item.path) !== nativePath(executable))) {
                throw new Error("存在多个工具实例或同名程序路径不符，不能确认目标实例");
            }
            if (processes.length === 0) { this.process = this.native.start(executable); }
        }
        const ready = this.wait(() => {
            if (this.process && !this.native.running(this.process)) {
                throw new Error("本次启动的 VCarDAS 在就绪前退出");
            }
            if (!connected) {
                try { this.rpc.open(1000); connected = true; }
                catch (error) {
                    if (!error || !["IO_ERROR", "TIMEOUT"].includes(error.code)) { throw error; }
                    return null;
                }
            }
            // 只重试连接建立；错误身份和损坏响应不能降级为启动重试。
            const status = this.rpc.call("ApplicationStatus");
            const identity = this.verify(status);
            return status.Ready ? {status, identity} : null;
        }, (value) => value !== null, this.limits.readyTimeoutMs, "VCarDAS 就绪");
        this.identity = ready.identity;
        if (this.call("Running") !== false) {
            throw new Error("已有测量尚未停止，请先手动处理旧工程");
        }
        this.identity = this.verify(ready.status, true);
        // 空窗口检查通过才取得所有权；检查失败不能在收尾时退出用户软件。
        this.claimed = true;
    }

    openProject(projectPath) {
        if (!this.claimed) { throw new Error("未取得空窗口，不能打开工程"); }
        if (this.call("OpenProject", [projectPath], 120000, true) !== true) {
            throw new Error("OpenProject 未确认工程打开成功");
        }
        this.call("TestSetupOpen");
    }

    prepareModules(targets) {
        const before = flattenTree(this.call("TestSetupTree"));
        const environments = before.filter((node) => node.Name === "Test Environment"
            && node.Type === "Folder" && node.parentId === null);
        if (environments.length !== 1) {
            throw new Error("工程中必须存在唯一的 Test Environment 测试环境");
        }

        this.environmentId = environments[0].Id;
        this.existingNodeIds = new Set(before.map((node) => node.Id));
        const targetNames = new Set(targets.map((target) => target.name.toLowerCase()));
        const existingModules = before.filter((node) => isTestModule(node)
            && targetNames.has(node.Name.toLowerCase()));
        const moduleIds = new Set(existingModules.map((node) => node.Id));
        const modulesToDelete = existingModules.filter((node) => !moduleIds.has(node.parentId));
        const deletedIds = new Set(moduleIds);
        const nodesById = new Map(before.map((node) => [node.Id, node]));
        for (const node of before) {
            let parentId = node.parentId;
            while (parentId !== null && !deletedIds.has(node.Id)) {
                if (moduleIds.has(parentId)) {
                    deletedIds.add(node.Id);
                    break;
                }
                parentId = nodesById.get(parentId)?.parentId ?? null;
            }
        }

        for (const node of modulesToDelete) {
            this.call("TestSetupDelete", [node.Id]);
        }

        const after = flattenTree(this.call("TestSetupTree"));
        const afterById = new Map(after.map((node) => [node.Id, node]));
        const preserved = before.filter((node) => !deletedIds.has(node.Id));
        if (after.length !== preserved.length || preserved.some((node) => {
            const current = afterById.get(node.Id);
            return !current || current.Name !== node.Name || current.Type !== node.Type
                || current.parentId !== node.parentId
                || current.IsActive !== node.IsActive
                || current.UsingXmlSetting !== node.UsingXmlSetting;
        }) || after.some((node) => isTestModule(node)
                && targetNames.has(node.Name.toLowerCase()))) {
            throw new Error("删除同名测试模块时其他工程配置发生变化");
        }

        this.replacements = targets.map((target) => ({target}));
    }

    configureTarget(index) {
        const replacement = this.replacements[index];
        if (!replacement || index !== this.modules.length) {
            throw new Error("模块必须按执行计划配置且只能配置一次");
        }
        const {target} = replacement;
        const id = this.call("TestSetupInsertModule", [this.environmentId, target.name, false]);
        if (typeof id !== "string" || !id || this.existingNodeIds.has(id)) {
            throw new Error(`${target.name} 未返回新的模块节点 ID`);
        }
        this.existingNodeIds.add(id);
        this.call("TestModuleConfigure", [id, target.scriptPath, [target.dllPath], false]);
        const idle = this.call("BackgroundWaitIdle", [120], 125000);
        if (!idle || idle.Idle !== true) { throw new Error("编译前后台任务未空闲"); }
        const compiled = this.call("TestModuleCompile", [id], 600000);
        target.onCompile(compiled);
        if (!compiled || compiled.Success !== true || compiled.NodeId !== id) {
            throw new Error(`${target.name} 编译失败，请查看编译诊断`);
        }
        this.call("TestModuleSetCaseActive", [id, "", true]);
        const count = selectedCaseCount(this.call("TestModuleCases", [id]), target.name);
        this.modules.push({id, name: target.name, count});
    }

    selectModules() {
        if (!this.modules.length || this.modules.length !== this.replacements.length) {
            throw new Error("全部模块配置成功后才能确定执行范围");
        }
        const selected = new Set(this.modules.map((module) => module.id));
        const tree = flattenTree(this.call("TestSetupTree"));
        const environmentIds = subtreeIds(tree, this.environmentId);
        const verified = tree.filter((node) =>
            environmentIds.has(node.Id) && isTestModule(node));
        if (this.modules.some((selected) => !verified.some((module) => module.Id === selected.id
                && module.Name === selected.name && module.parentId === this.environmentId))) {
            throw new Error("新建模块未以正确名称出现在目标测试环境中");
        }
        for (const module of verified) {
            this.call("TestSetupSetActive", [module.Id, selected.has(module.Id)]);
        }
        const finalTree = flattenTree(this.call("TestSetupTree"));
        for (const module of finalTree.filter((node) =>
            environmentIds.has(node.Id) && isTestModule(node))) {
            if (module.IsActive !== selected.has(module.Id)) {
                throw new Error(`测试模块勾选范围校验失败：${module.Name}`);
            }
        }
    }

    startMeasurement() {
        this.measurementRequested = true;
        this.call("Start", [], 120000);
        this.wait(() => this.call("Running"), (value) => value === true, 30000, "测量启动");
    }

    validateProgress(snapshot, module) {
        requireObject(snapshot, "TestModuleProgress");
        if (typeof snapshot.RunId !== "string" || !snapshot.RunId || typeof snapshot.IsFinal !== "boolean") {
            throw new Error(`${module.name} 缺少本轮运行标识或终态`);
        }
        for (const key of ["Executed", "Total", "Passed", "Failed"]) {
            if (!Number.isInteger(snapshot[key]) || snapshot[key] < 0) {
                throw new Error(`${module.name} 进度计数无效：${key}`);
            }
        }
        if (snapshot.Total !== module.count || snapshot.Executed > module.count
                || snapshot.Passed + snapshot.Failed > snapshot.Executed) {
            throw new Error(`${module.name} 用例计数与单轮范围不符，拒绝旧循环或重复执行`);
        }
        return snapshot;
    }

    run(target, onSnapshot) {
        const module = this.modules.find((value) => value.name === target.name);
        if (!module || !this.measurementRequested) { throw new Error(`${target.name} 尚未配置或测量未启动`); }
        const previous = this.call("TestModuleProgress", [module.name]);
        const oldRunId = previous && previous.RunId;
        // 先记录启动意图，超时仍由收尾查询并停止，绝不重发 start。
        this.inFlight = {module, oldRunId, runId: null};
        this.call("TestModuleControl", [module.name, "start", 20], 25000);
        const first = this.wait(() => this.call("TestModuleProgress", [module.name]),
            (value) => value && typeof value.RunId === "string" && value.RunId
                && value.RunId !== oldRunId, 25000, `${module.name} 本轮 RunId`);
        this.inFlight.runId = first.RunId;
        const read = () => {
            const snapshot = this.validateProgress(this.call("TestModuleProgress", [module.name]), module);
            if (snapshot.RunId !== this.inFlight.runId) {
                throw new Error(`${module.name} RunId 被其他执行替换，停止后续目标`);
            }
            onSnapshot(snapshot);
            return snapshot;
        };
        let snapshot = this.validateProgress(first, module);
        onSnapshot(snapshot);
        if (!snapshot.IsFinal) {
            snapshot = this.wait(read, (value) => value.IsFinal,
                this.limits.runTimeoutMs, `${module.name} 测试结束`);
        }
        const finalResult = snapshot.Result;
        const deadline = this.now() + this.limits.reportTimeoutMs;
        while (!["Ready", "Failed", "Unavailable"].includes(snapshot.ReportState)) {
            if (this.now() >= deadline) {
                this.task.warning(`${module.name} 本轮测试已结束，等待报告超时`);
                break;
            }
            this.task.delay(this.limits.pollMs);
            snapshot = read();
            if (!snapshot.IsFinal || snapshot.Result !== finalResult) {
                throw new Error(`${module.name} 本轮终态发生不一致变化`);
            }
        }
        if (snapshot.ReportState === "Ready") {
            if (typeof snapshot.ReportPath !== "string" || !snapshot.ReportPath) {
                throw new Error(`${module.name} 本轮报告路径无效`);
            }
            this.native.collect(target, snapshot.ReportPath);
        } else { this.task.warning(`${module.name} 本轮报告不可用：${snapshot.ReportState}`); }
        this.inFlight = null;
        if (snapshot.Result !== "Passed" || snapshot.EndReason !== "Completed"
                || snapshot.Executed !== module.count || snapshot.Failed !== 0
                || snapshot.Passed !== module.count) {
            throw new Error(`${module.name} 测试未通过：${snapshot.Result} / ${snapshot.EndReason}`);
        }
        return snapshot;
    }

    cleanup(onSnapshot = () => {}) {
        const errors = [];
        const attempt = (description, operation) => {
            try { return operation(); }
            catch (error) { errors.push(`${description}：${error.message || error}`); return null; }
        };
        const ensureConnection = () => {
            if (this.rpc.handle === null) {
                try {
                    this.rpc.open(3000);
                    this.verify(this.rpc.call("ApplicationStatus"));
                } catch (error) { this.rpc.close(); throw error; }
            }
        };
        try {
            if (this.claimed) {
                // 新连接隔离迟到响应，再次核验 PID、程序路径和启动时间。
                if (this.rpc) { this.rpc.close(); }
                this.rpc = this.rpcFactory();
                const verified = attempt("重新核验工具进程", () => {
                    this.rpc.open(3000);
                    this.verify(this.rpc.call("ApplicationStatus"));
                    return true;
                });
                if (verified) {
                    if (this.inFlight) {
                        const active = this.inFlight;
                        attempt("停止本轮测试模块", () => {
                            let snapshot = this.call("TestModuleProgress", [active.module.name]);
                            if (snapshot && snapshot.RunId && snapshot.RunId !== active.oldRunId
                                    && (!active.runId || snapshot.RunId === active.runId)) {
                                const runId = snapshot.RunId;
                                onSnapshot(active.module.name, snapshot);
                                if (!snapshot.IsFinal) {
                                    this.call("TestModuleControl", [active.module.name, "stop", 20], 25000);
                                    snapshot = this.call("TestModuleProgress", [active.module.name]);
                                    if (snapshot.RunId !== runId) { throw new Error("停止后的 RunId 已变化"); }
                                    onSnapshot(active.module.name, snapshot);
                                }
                            }
                        });
                    }
                    if (this.measurementRequested) {
                        attempt("停止测量并销毁实验", () => {
                            ensureConnection();
                            this.call("Stop", [], 30000);
                            this.wait(() => this.call("Running"), (value) => value === false,
                                30000, "测量停止", true);
                            let consecutive = 0;
                            this.wait(() => this.call("DeviceExperimentDestroyStatus"), (value) => {
                                consecutive = value && value.State === "Destroyed" ? consecutive + 1 : 0;
                                return consecutive >= 2;
                            }, this.limits.destroyTimeoutMs, "实验连续两次销毁确认", true);
                        });
                    }
                    attempt("关闭本次软件", () => {
                        ensureConnection();
                        const response = this.call("ExitApplication");
                        if (!response || response.ProcessId !== this.identity.pid) {
                            throw new Error("ExitApplication 未返回本次进程 PID");
                        }
                        this.rpc.close();
                        this.native.waitExited(this.identity);
                    });
                }
            }
        } finally {
            if (this.rpc) { this.rpc.close(); }
            attempt("回收本次启动的进程", () => this.native.finish(this.process));
            this.process = null;
            this.claimed = false;
        }
        if (errors.length) { throw new Error(errors.join("；")); }
    }
}
