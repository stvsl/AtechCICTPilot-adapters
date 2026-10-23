import * as task from "@atech/task";
import * as cli from "@atech/cli";
import * as fs from "@atech/fs";
import {prepareConfiguration, commandArguments} from "./bootload/config.js";
import {executeCommand, cleanupProcess} from "./bootload/runner.js";

export async function run() {
    fs.mkdir("artifact://bootload");
    try {
        task.info("正在读取配置与固件");
        const config = prepareConfiguration();
        const executable = cli.resolveExecutable("bootload");
        const projects = await executeCommand(executable, ["list-projects"], "projects", 30000);
        if (!projects.split(/[\r\n]+/).map((line) => line.trim()).includes(config.project)) {
            throw new Error(`CLI 未注册刷写项目：${config.project}，请核对配置与工具版本`);
        }
        task.info(`开始 ${config.mode} 刷写：${config.project}`);
        await executeCommand(executable, commandArguments(config), "flash",
            (config.timeout + 120) * 1000, true);
        task.info("CLI 正常退出，刷写完成");
    } catch (error) {
        fs.writeText("artifact://bootload/error.json", JSON.stringify({
            message: String(error.message || error), code: error.code || "FLASH_ERROR"
        }, null, 2));
        task.publish("BOOTLOAD_ERROR", "artifact://bootload/error.json",
            "刷写错误诊断", "application/json");
        throw error;
    }
}

export function cleanup() {
    cleanupProcess();
    task.info("刷写进程清理完成");
}
