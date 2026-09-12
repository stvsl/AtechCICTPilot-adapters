function errorMessage(error) {
    return error && error.message ? String(error.message) : String(error);
}

function logger(debug) {
    return typeof debug === "function" ? debug : () => {};
}

function abortIfRequired(error, abortOnError) {
    if (typeof abortOnError === "function") {
        abortOnError(error);
    }
}

/*
 * 通信测试报告由 CANoe 工程自身管理。只有 TestConfiguration.Report
 * 具备跨目标版本稳定的格式和主动生成接口，因此这里只接收该明确对象。
 */
export function configureNativeReportAutomation({
    mode,
    requested,
    testConfigurationReport,
    format,
    debug = null,
    abortOnError = null
} = {}) {
    if (!requested || mode === "communication"
            || testConfigurationReport === null
            || testConfigurationReport === undefined) {
        return [];
    }

    const log = logger(debug);
    try {
        testConfigurationReport.set("Enabled", true);
    } catch (error) {
        abortIfRequired(error, abortOnError);
        log(`configure report: unable to enable report: ${errorMessage(error)}`);
    }
    try {
        // eReportFormat：cReportFormatVTestReport=1，cReportFormatXml=2。
        testConfigurationReport.set("ReportFormat", format);
    } catch (error) {
        abortIfRequired(error, abortOnError);
        log(`configure report: ReportFormat is unavailable: ${errorMessage(error)}`);
    }
    return [testConfigurationReport];
}

/*
 * 即使没有可主动生成的报告对象，也必须等待 CANoe 写出工程配置的报告。
 * 这正是通信测试模式的正常路径。
 */
export async function generateNativeReportOutputs({
    requested,
    automationTargets = [],
    discover,
    waitForDiscovery,
    debug = null,
    abortOnError = null,
    recordError = null
} = {}) {
    if (!requested) {
        return [];
    }
    if (typeof discover !== "function" || typeof waitForDiscovery !== "function") {
        throw new TypeError("Native report discovery callbacks are required");
    }

    const log = logger(debug);
    for (const report of automationTargets) {
        try {
            report.call("GenerateReport");
        } catch (error) {
            abortIfRequired(error, abortOnError);
            log(`generate report: waiting for CANoe automatic output: ${errorMessage(error)}`);
        }
    }

    const discovered = discover();
    if (Array.isArray(discovered) && discovered.length > 0) {
        return discovered;
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
