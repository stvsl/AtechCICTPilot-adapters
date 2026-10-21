import * as cli from "@atech/cli";
import * as fs from "@atech/fs";
import * as task from "@atech/task";
import {OutputCollector, progressOf} from "./output.js";

let activeProcess = null;
let activeFinalizer = null;

export function cleanupProcess() {
    if (activeFinalizer !== null) {
        // VM 的强制中断可能跳过 finally；清理阶段会忽略取消，再次完成归档和释放。
        activeFinalizer(false, "执行被取消或被宿主中断");
    }
}

export async function executeCommand(executable, arguments_, id, timeoutMs,
    reportProgress = false) {
    const startedAt = Date.now();
    let lastProgress = -1;
    let result = null;
    let failure = "";
    let acceptProgress = reportProgress;
    const stdout = new OutputCollector((line) => {
        const progress = acceptProgress ? progressOf(line) : null;
        if (progress !== null && progress !== lastProgress) {
            lastProgress = progress;
            task.progress(progress);
        }
        // 原始进度条可能已被外部工具替换成问号；界面只显示清晰的实际百分比。
        task.info(progress === null ? line.substring(0, 4096)
            : `刷写进度：${progress.toFixed(1)}%`);
    });
    const stderr = new OutputCollector((line) => task.warning(line.substring(0, 4096)));
    const collect = () => {
        const output = cli.read(activeProcess);
        stdout.read(output.standardOutput);
        stderr.read(output.standardError);
    };
    const save = () => {
        fs.writeBytes(`artifact://bootload/${id}-stdout.log`, stdout.bytes());
        fs.writeBytes(`artifact://bootload/${id}-stderr.log`, stderr.bytes());
    };
    const finalize = (allowProgress, interruption = "") => {
        acceptProgress = allowProgress;
        try {
            if (activeProcess !== null) {
                cli.terminate(activeProcess, 1000);
                collect();
            }
            stdout.finish();
            stderr.finish();
            save();
            const diagnostic = {executable, arguments: arguments_,
                startedAt, durationMs: Date.now() - startedAt, lastProgress,
                result: result && {exitCode: result.exitCode, crashed: result.crashed},
                failure: failure || interruption};
            fs.writeText(`artifact://bootload/${id}-diagnostic.json`,
                JSON.stringify(diagnostic, null, 2));
            for (const stream of ["stdout", "stderr", "diagnostic"]) {
                const extension = stream === "diagnostic" ? "json" : "log";
                task.publish(`BOOTLOAD_${id}_${stream}`,
                    `artifact://bootload/${id}-${stream}.${extension}`,
                    `${id} ${stream}`, stream === "diagnostic"
                        ? "application/json" : "text/plain");
            }
        } finally {
            if (activeProcess !== null) {
                cli.terminate(activeProcess, 1000);
                cli.release(activeProcess);
                activeProcess = null;
            }
        }
        activeFinalizer = null;
    };
    activeFinalizer = finalize;
    try {
        activeProcess = cli.start({executable, arguments: arguments_,
            workingDirectoryUri: "executable://", timeoutMs});
        let savedAt = 0;
        while (true) {
            collect();
            if (Date.now() - savedAt >= 1000) {
                save();
                savedAt = Date.now();
            }
            task.checkCancelled();
            if (!cli.isRunning(activeProcess)) {
                break;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                throw new Error(`CLI ${id} 超过宿主执行期限 ${timeoutMs / 1000} 秒`);
            }
            await task.delay(100);
        }
        // wait 仅在退出后取结果，不能用短超时 wait 轮询，否则会终止 CLI。
        result = cli.wait(activeProcess);
        collect();
        if (result.crashed || result.exitCode !== 0) {
            const reasons = {1: "参数、文件、设备连接或刷写失败",
                2: "CLI 超时、进度停滞或被停止", 64: "命令格式错误"};
            throw new Error(`CLI ${id} 失败（退出码 ${result.exitCode}）：`
                + (result.crashed ? "进程异常退出" : reasons[result.exitCode] || "执行失败"));
        }
    } catch (error) {
        failure = String(error.message || error);
        throw error;
    } finally {
        finalize(reportProgress);
    }
    return stdout.text();
}
