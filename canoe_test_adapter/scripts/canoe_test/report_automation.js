import { cliResultText } from "./report_files.js";

function errorMessage(error) {
    return error && error.message ? String(error.message) : String(error);
}

/*
 * Report Viewer 在 CANoe 刚完成报告写入时可能短暂返回 104，部分版本只在
 * 输出中暴露 IncompatibleReportException。进程崩溃和其他错误不应重试。
 */
export function isTransientReportViewerFailure(result) {
    if (result === null || result === undefined || result.crashed === true) {
        return false;
    }
    if (Number(result.exitCode) === 104) {
        return true;
    }
    return cliResultText(result).toLowerCase()
        .includes("incompatiblereportexception");
}

function abortIfRequired(error, abortOnError) {
    if (typeof abortOnError === "function") {
        abortOnError(error);
    }
}

/*
 * XML 和 HTML 可以共用 CANoe 原生 XML。只有请求原生 VTESTReport 或 PDF 时，
 * 才先生成 VTESTReport，再由 Report Viewer 派生其他格式。
 */
export function nativeReportFormat(reportTypes) {
    const selected = Array.isArray(reportTypes) ? reportTypes : [];
    return selected.includes("vtestreport") || selected.includes("PDF") ? 1 : 2;
}

/*
 * 通信测试报告由 CANoe 工程自身管理。VTEST 模式启用 TestConfiguration
 * 的联合报告，并让 CANoe 在测试结束时按选定格式自动写入。
 */
export function configureNativeReport({
    mode,
    requested,
    testConfigurationReport,
    format,
    abortOnError = null
} = {}) {
    if (!requested || mode === "communication") {
        return false;
    }
    if (testConfigurationReport === null
            || testConfigurationReport === undefined) {
        throw new Error("CANoe TestConfiguration report is unavailable");
    }
    try {
        testConfigurationReport.set("UseJointReport", true);
        // eReportFormat：cReportFormatVTestReport=1，cReportFormatXml=2。
        testConfigurationReport.set("ReportFormat", format);
    } catch (error) {
        abortIfRequired(error, abortOnError);
        throw error;
    }
    return true;
}

/*
 * TestConfiguration.Report 没有主动生成方法。VTEST 和通信测试都必须等待
 * CANoe 在测试结束后完成报告写入。
 */
export async function waitForNativeReportOutputs({
    requested,
    waitForDiscovery,
    abortOnError = null,
    recordError = null
} = {}) {
    if (!requested) {
        return [];
    }
    if (typeof waitForDiscovery !== "function") {
        throw new TypeError("Native report discovery callback is required");
    }

    try {
        const waited = await waitForDiscovery();
        return Array.isArray(waited) ? waited : [];
    } catch (error) {
        abortIfRequired(error, abortOnError);
        if (typeof recordError === "function") {
            recordError(errorMessage(error));
        }
        return [];
    }
}
