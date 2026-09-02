import * as task from "@atech/task";

import {
    POLL_INTERVAL_MS,
    TEST_EXECUTION_TIMEOUT_MS
} from "./constants.js";
import {
    collectionCount,
    collectionItems,
    executionState,
    normalize,
    optionalProperty,
    propertyOr
} from "./com.js";

function elementsFor(object) {
    return propertyOr(object, ["Elements", "Sequence"], null);
}

function testCaseId(testCase) {
    return String(optionalProperty(testCase, "Id")
        || optionalProperty(testCase, "Name")
        || optionalProperty(testCase, "Caption") || "");
}

function walkTestCases(elements, testModule, module) {
    const cases = [];
    for (const element of collectionItems(elements)) {
        const type = normalize(optionalProperty(element, "Type"));
        const id = testCaseId(element);
        const verdict = optionalProperty(element, "Verdict");
        const children = elementsFor(element);
        const hasChildren = children !== null && children !== undefined
            && collectionCount(children) > 0;
        const isTestCase = type.includes("testcase") || type.includes("test_case")
            || (!hasChildren && verdict !== undefined && id !== "");
        if (isTestCase) {
            cases.push({ testModule, module, id, name: id, object: element });
        }
        if (children !== null && children !== undefined) {
            cases.push(...walkTestCases(children, testModule, module));
        }
    }
    return cases;
}

function appendUnique(items, value) {
    if (!items.includes(value)) {
        items.push(value);
    }
}

function collectTestModules(environment, output) {
    for (const module of collectionItems(optionalProperty(environment, "TestModules"))) {
        appendUnique(output, module);
    }
    for (const item of collectionItems(optionalProperty(environment, "Items"))) {
        const elements = elementsFor(item);
        if (elements !== null && elements !== undefined) {
            appendUnique(output, item);
            continue;
        }
        if (optionalProperty(item, "Items") !== undefined) {
            collectTestModules(item, output);
        }
    }
}

function setEnabled(object, enabled) {
    try {
        object.set("Enabled", enabled);
    } catch (_) {
        // 个别 CANoe 版本由父对象控制启用状态，读取结构后仍可正常执行.
    }
}

function addReportObject(context, report) {
    if (report !== null && report !== undefined
            && !context.test.reportObjects.includes(report)) {
        context.test.reportObjects.push(report);
    }
}

export function selectRequestedCaseIds(requestedIds, availableIds) {
    const available = Object.create(null);
    for (const id of availableIds) {
        if (available[id]) {
            throw new Error(`CANoe TestEnvironment contains a duplicate test case ID: ${id}`);
        }
        available[id] = true;
    }
    if (requestedIds.length === 0) {
        return availableIds.slice();
    }
    for (const id of requestedIds) {
        if (!available[id]) {
            throw new Error(`TEST_CASE_IDS does not match a CANoe test case: ${id}`);
        }
    }
    return requestedIds.slice();
}

export function requireSingleTestEnvironment(environments) {
    if (environments.length !== 1) {
        throw new Error(
            `CANoe project must contain exactly one TestEnvironment, found ${environments.length}`);
    }
    return environments[0];
}

export function configureCommunicationTestEnvironment(context) {
    const environments = collectionItems(context.test.environments);
    const environment = requireSingleTestEnvironment(environments);
    context.test.environment = environment;
    setEnabled(environment, true);
    addReportObject(context, propertyOr(environment, ["Report"], null));

    const modules = [];
    collectTestModules(environment, modules);
    context.test.moduleHandles = modules;
    if (modules.length === 0) {
        throw new Error("CANoe TestEnvironment does not contain a test module");
    }

    const candidates = [];
    for (const module of modules) {
        const moduleName = String(optionalProperty(module, "Name") || "");
        const elements = elementsFor(module);
        if (elements === null || elements === undefined) {
            continue;
        }
        candidates.push(...walkTestCases(elements, moduleName, module));
        addReportObject(context, propertyOr(module, ["Report"], null));
    }
    context.test.caseHandles = candidates.map((candidate) => candidate.object);
    const selectedIds = selectRequestedCaseIds(
        context.requestedIds, candidates.map((candidate) => candidate.id));
    const selectedIdSet = Object.create(null);
    for (const id of selectedIds) {
        selectedIdSet[id] = true;
    }

    const activeModules = [];
    const selectedCases = [];
    for (const module of modules) {
        const moduleCases = candidates.filter((candidate) => candidate.module === module);
        const selectedModuleCases = moduleCases.filter((candidate) =>
            selectedIdSet[candidate.id]);
        for (const candidate of moduleCases) {
            setEnabled(candidate.object, selectedIdSet[candidate.id] === true);
        }
        setEnabled(module, selectedModuleCases.length > 0);
        if (selectedModuleCases.length > 0) {
            activeModules.push(module);
            selectedCases.push(...selectedModuleCases);
        }
    }
    if (selectedCases.length === 0) {
        throw new Error("No CANoe test case has been enabled");
    }
    context.test.modules = activeModules;
    context.test.selectedCases = selectedCases;
}

function verdictIsAvailable(verdict) {
    const value = normalize(verdict);
    return value !== "" && value !== "cverdictnotavailable"
        && value !== "notavailable" && value !== "not available";
}

function verdictPassed(verdict) {
    const value = normalize(verdict);
    return value === "passed" || value === "pass" || value === "cverdictpassed"
        || value === "0";
}

export function completedVerdicts(context, modules) {
    const selectedIds = Object.create(null);
    for (const candidate of context.test.selectedCases) {
        selectedIds[candidate.id] = true;
    }
    const results = [];
    for (const module of modules) {
        const moduleName = String(optionalProperty(module, "Name") || "");
        const elements = elementsFor(module);
        if (elements === null || elements === undefined) {
            continue;
        }
        for (const candidate of walkTestCases(elements, moduleName, module)) {
            if (!selectedIds[candidate.id]) {
                continue;
            }
            const verdict = optionalProperty(candidate.object, "Verdict");
            if (!verdictIsAvailable(verdict)) {
                continue;
            }
            results.push({
                testModule: candidate.testModule,
                id: candidate.id,
                name: candidate.name,
                verdict: String(verdict),
                passed: verdictPassed(verdict)
            });
        }
    }
    return results;
}

function moduleRunning(module) {
    return executionState(module, true).running;
}

function selectedCaseCount(context, module) {
    return context.test.selectedCases.filter((candidate) =>
        candidate.module === module).length;
}

function completedCaseCount(context, module) {
    const selectedIds = Object.create(null);
    for (const candidate of context.test.selectedCases) {
        if (candidate.module === module) {
            selectedIds[candidate.id] = true;
        }
    }
    return context.test.results.filter((result) => selectedIds[result.id]).length;
}

export async function executeCommunicationTests(context, recordResults) {
    const started = Date.now();
    const moduleErrors = [];
    context.test.started = true;
    for (const module of context.test.modules) {
        const expected = selectedCaseCount(context, module);
        try {
            try {
                module.set("ExecuteRepeatedly", false);
            } catch (_) {
                // 不支持该属性的 CANoe 版本仍按其默认单次执行语义运行.
            }
            module.call("Start");
            while (moduleRunning(module)
                    || completedCaseCount(context, module) < expected) {
                task.checkCancelled();
                recordResults(completedVerdicts(context, [module]));
                task.progress(Math.min(90, 20 + context.test.results.length * 5));
                if (Date.now() - started >= TEST_EXECUTION_TIMEOUT_MS) {
                    throw new Error(
                        "Timed out waiting for CANoe communication test module");
                }
                await task.delay(POLL_INTERVAL_MS);
            }
        } catch (error) {
            recordResults(completedVerdicts(context, [module]));
            if (task.isCancelled()) {
                throw error;
            }
            const moduleName = String(optionalProperty(module, "Name") || "");
            const label = moduleName || "unnamed CANoe test module";
            const message = error && error.message ? error.message : String(error);
            moduleErrors.push(`${label}: ${message}`);
            task.error(`CANoe test module failed: ${label}: ${message}`);
            try {
                module.call("Stop");
            } catch (_) {
                // 异常模块可能已自行结束，停止失败不应妨碍剩余模块执行.
            }
        } finally {
            recordResults(completedVerdicts(context, [module]));
        }
    }
    if (moduleErrors.length > 0) {
        throw new Error(moduleErrors.join("; "));
    }
}

export function stopCommunicationTests(context) {
    if (!context.test.started) {
        return;
    }
    for (const module of context.test.modules) {
        try {
            module.call("Stop");
        } catch (error) {
            task.warning(`Unable to stop CANoe test module: ${error.message}`);
        }
    }
}
