import * as cli from "@atech/cli";
import * as fs from "@atech/fs";
import * as task from "@atech/task";

// 固定目录只能经显式授权的本机辅助脚本访问，不交给任务 URI 解析器。
export class NativeTools {
    constructor() {
        this.guard = null;
        this.sequence = 0;
        this.executable = null;
    }

    request(action, value = {}, timeoutMs = 30000, background = false) {
        if (this.executable === null) {
            this.executable = cli.resolveExecutable("VCARDAS_HELPER");
        }
        const requestUri = `temp://vcardas-native-${++this.sequence}.json`;
        fs.writeText(requestUri, JSON.stringify(value));
        const request = {
            executable: this.executable,
            arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA",
                "-ExecutionPolicy", "Bypass", "-File",
                fs.nativePath("plugin://scripts/vcardas/native.ps1"),
                "-Action", action, "-RequestFile", fs.nativePath(requestUri)],
            workingDirectoryUri: "workspace://",
            timeoutMs: background ? 0 : timeoutMs
        };
        if (background) {
            return cli.start(request);
        }
        const result = cli.run(request);
        if (result.crashed || result.exitCode !== 0) {
            throw new Error(`本机辅助操作 ${action} 失败：`
                + cli.decodeText(result.standardError || new Uint8Array()));
        }
        try {
            return JSON.parse(cli.decodeText(result.standardOutput));
        } catch (_) {
            throw new Error(`本机辅助操作 ${action} 返回了无效 JSON`);
        }
    }

    acquire() {
        const readyUri = "temp://vcardas-guard-ready.json";
        if (fs.exists(readyUri)) {
            fs.remove(readyUri);
        }
        this.guard = this.request("guard", {readyPath: fs.nativePath(readyUri)}, 0, true);
        const deadline = Date.now() + 15000;
        while (!fs.exists(readyUri)) {
            this.checkGuard();
            if (Date.now() >= deadline) {
                throw new Error("等待固定刷写目录独占锁超时");
            }
            task.delay(100);
        }
    }

    checkGuard() {
        if (!this.guard || !cli.isRunning(this.guard.handle)) {
            throw new Error("固定刷写目录未取得独占锁或锁进程已退出，可能有其他任务正在刷写");
        }
    }

    preparePacking(plan) {
        const group = (value) => ({
            imagePath: fs.nativePath(value.image.uri), imageName: value.image.name,
            signaturePath: fs.nativePath(value.signature.uri), signatureName: value.signature.name
        });
        return this.request("preparePacking", {targets: plan.targets.map((target) => ({
            name: target.name, source: fs.nativePath(target.uri),
            app: group(target.app), driver: group(target.driver)
        }))}, 120000);
    }

    load(plan, packedOutputs) {
        this.checkGuard();
        return this.request("load", {targets: plan.targets.map((target) => ({
            name: target.name, source: fs.nativePath(target.uri),
            outputs: packedOutputs.get(target.name)
        }))}, 120000);
    }

    pack(target) {
        const outputUri = `artifact://packing/${target.name}`;
        fs.mkdir(outputUri);
        let result;
        try {
            result = this.request("pack", {command: fs.nativePath(target.commandUri),
                output: fs.nativePath(outputUri)}, 360000);
        } finally {
            // CMD 非零退出、漏产物、取消时均保留已经写下的日志。
            for (const entry of fs.list(outputUri)) {
                if (entry.type === "file") {
                    task.publish(`packing-${target.name}-${entry.name}`, entry.uri,
                        `${target.name} ${entry.name}`, "text/plain", `VCarDAS/${target.name}/打包`);
                }
            }
        }
        return result;
    }

    find(executable) {
        return this.request("find", {executable});
    }

    inspect(processId, requireEmpty = false) {
        return this.request("process", {processId, requireEmpty});
    }

    start(executable) {
        return cli.start({executable, arguments: ["--unattended"],
            workingDirectoryUri: "executable://", timeoutMs: 0});
    }

    running(process) {
        return cli.isRunning(process.handle);
    }

    finish(process) {
        if (process) {
            if (cli.isRunning(process.handle)) {
                cli.terminate(process.handle, 3000);
            }
            cli.release(process.handle);
        }
    }

    collect(target, reportPath) {
        const outputUri = `artifact://reports/${target.name}`;
        fs.mkdir(outputUri);
        this.request("collect", {source: reportPath, output: fs.nativePath(outputUri)}, 60000);
        for (const entry of fs.list(outputUri, true)) {
            if (entry.type === "file") {
                const relative = entry.uri.substring(outputUri.length + 1);
                task.publish(`report-${target.name}-${relative}`, entry.uri,
                    `${target.name} ${relative}`, /\.html?$/i.test(entry.name)
                        ? "text/html" : "application/octet-stream", `VCarDAS/${target.name}/报告`);
            }
        }
    }

    waitExited(identity) {
        return this.request("waitExit", {processId: identity.pid,
            startedAt: identity.startedAt}, 35000);
    }

    release() {
        const guard = this.guard;
        this.guard = null;
        this.finish(guard);
    }
}
