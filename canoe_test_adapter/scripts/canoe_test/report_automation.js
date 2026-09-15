function errorMessage(error) {
    return error && error.message ? String(error.message) : String(error);
}

function abortIfRequired(error, abortOnError) {
    if (typeof abortOnError === "function") {
        abortOnError(error);
    }
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
