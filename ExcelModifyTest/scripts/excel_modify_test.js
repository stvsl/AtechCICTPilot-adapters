import * as fs from "@atech/fs";
import * as task from "@atech/task";
import { modifyCfgDriverFile } from "./xlsx.js";

function currentTimestamp() {
    // 写入带时区的本地时间文本，不让 Excel 把原路径字段误判为数值日期。
    const now = new Date();
    const pad = function (value) { return String(value).padStart(2, "0"); };
    const offset = -now.getTimezoneOffset();
    return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate())
        + "T" + pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds())
        + (offset >= 0 ? "+" : "-") + pad(Math.floor(Math.abs(offset) / 60))
        + ":" + pad(Math.abs(offset) % 60);
}

export function modifyWorkbook(inputUri) {
    // 默认由工作流读取随插件打包的实际副本；测试可在节点选项中指定隔离输入。
    const sourceUri = task.option("InputUri", inputUri);
    if (typeof sourceUri !== "string" || !sourceUri.endsWith(".xlsx")) {
        throw new Error("ExcelModifyTest: 请输入有效的 XLSX 虚拟 URI");
    }
    if (fs.stat(sourceUri).size > 16 * 1024 * 1024) {
        throw new Error("ExcelModifyTest: 工作簿超过 16 MiB 上限");
    }
    task.checkCancelled();
    const timestamp = currentTimestamp();
    task.info("使用插件自带的 fflate / xmldom 修改 FlashPath.CfgDriverFile");
    const result = modifyCfgDriverFile(fs.readBytes(sourceUri), timestamp);
    task.checkCancelled();
    task.progress(80);
    const outputUri = "artifact://BootloaderTest.xlsx";
    const reportUri = "artifact://ExcelModifyTest-result.json";
    // 只读插件模板保持不变，成功生成完整字节后再通过宿主原子写入产物。
    fs.writeBytes(outputUri, result.bytes, false);
    fs.writeText(reportUri, JSON.stringify(result.report, null, 2) + "\n", false);
    task.publish("EXCEL_MODIFIED", outputUri, "BootloaderTest.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    task.publish("EXCEL_MODIFY_RESULT", reportUri, "ExcelModifyTest 修改记录", "application/json");
    task.info("已更新 " + result.report.sheet + "!" + result.report.valueCell + " = " + timestamp);
    task.progress(100);
    return result.report;
}
