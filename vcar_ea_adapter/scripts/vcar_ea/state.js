let executionContext = null;

export function resetExecutionContext(values) {
    executionContext = {
        projectPath: values.projectPath,
        casePath: values.casePath,
        planPath: values.planPath,
        testConfigurationPath: values.testConfigurationPath,
        testbenchConfigurationPath: values.testbenchConfigurationPath,
        executionMode: values.executionMode,
        clientId: values.clientId,
        handle: null,
        subscriptions: [],
        projectOpened: false,
        environmentStarted: false,
        accessRegistered: false,
        inventory: {Configurations: [], Cases: [], Plans: []},
        executionResponse: null,
        reportPath: "",
        reportDownload: null,
        reportBytes: null,
        reportArtifactUri: "",
        summaryArtifactUri: ""
    };
    return executionContext;
}

export function requireExecutionContext() {
    if (executionContext === null) {
        throw new Error("VCarEA task has not been prepared");
    }
    return executionContext;
}

export function currentExecutionContext() {
    return executionContext;
}

export function clearExecutionContext() {
    executionContext = null;
}
