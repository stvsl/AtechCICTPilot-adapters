let executionContext = null;

export function resetExecutionContext(project, requestedIds) {
    executionContext = {
        project,
        requestedIds,
        session: {
            application: null,
            measurement: null,
            configuration: null,
            process: null,
            ownsProcess: false,
            attached: false,
            measurementRunning: false
        },
        test: {
            setup: null,
            environments: null,
            environment: null,
            modules: [],
            moduleHandles: [],
            selectedCases: [],
            caseHandles: [],
            results: [],
            resultKeys: Object.create(null),
            reportObjects: [],
            started: false
        },
        execution: {
            error: "",
            artifactErrors: []
        },
        publication: {
            summaryWritten: false,
            summaryPublished: false,
            artifactUris: Object.create(null)
        }
    };
    return executionContext;
}

export function requireExecutionContext() {
    if (executionContext === null) {
        throw new Error("CANoe test project has not been prepared");
    }
    return executionContext;
}

export function currentExecutionContext() {
    return executionContext;
}

export function clearExecutionContext() {
    executionContext = null;
}
