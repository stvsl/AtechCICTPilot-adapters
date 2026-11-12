/*
 * 用例树模块：把模拟用例组织成宿主测试详情页可渲染的多层级结构。
 *
 * 本插件刻意模拟"多 config"场景：CANoe 工程在真实适配器中会按 .cfg 分成
 * 多个执行配置，这里用 TEST_CONFIG_COUNT 个配置演示同一任务下多棵用例树
 * 的并存与分组展示。每个 config 内部再分"通信层 / 应用层"两个层级，层级
 * 之下才是用例，用来验证多层级嵌套与层级合并（单链层级会被宿主合并）。
 *
 * 用例状态与耗时通过 taskCase.finish 上报，宿主据此维护统计；结构只发布
 * 一次，执行阶段只做逐用例更新，因此长任务的执行日志不会因整树重发而膨胀。
 */
import * as taskCase from "@atech/task/case";

import { testCaseId } from "./workload.js";

/*
 * 把用例区间均分给 configCount 个配置。
 *
 * 返回每项的 [firstCase, lastCase] 闭区间。余数交给最后一个 config，
 * 保证全部用例都有归属且没有重叠。
 */
function caseRanges(caseCount, configCount) {
    const ranges = [];
    const perConfig = Math.ceil(caseCount / configCount);
    for (let index = 0; index < configCount; ++index) {
        const firstCase = index * perConfig + 1;
        const lastCase = Math.min(caseCount, firstCase + perConfig - 1);
        ranges.push({ firstCase, lastCase });
    }
    return ranges;
}

/** 固定的 config 标识与显示名；序号补零便于在界面里稳定排序。 */
function configurationOf(index) {
    const ordinal = String(index + 1).padStart(2, "0");
    return {
        configId: `CONFIG_${ordinal}`,
        name: `模拟工程配置 ${ordinal}`
    };
}

/*
 * 为单个 config 生成两层结构：通信层与应用层各承担一半用例。
 *
 * 层级节点的 nodeId 在任务内唯一（带 config 前缀），用例节点直接用全局
 * 用例 ID，因此宿主更新某条用例时不需要知道它属于哪个层级。
 */
function buildConfigTree(configuration, range) {
    const communicationCases = [];
    const applicationCases = [];
    for (let index = range.firstCase; index <= range.lastCase; ++index) {
        const caseNode = {
            nodeId: testCaseId(index),
            name: testCaseId(index),
            type: "case"
        };
        // 交替分配，让两个层级都有通过和失败的用例，便于观察聚合结论。
        if ((index - range.firstCase) % 2 === 0) {
            communicationCases.push(caseNode);
        } else {
            applicationCases.push(caseNode);
        }
    }
    return {
        configId: configuration.configId,
        name: configuration.name,
        nodes: [
            {
                nodeId: `${configuration.configId}_COMMUNICATION`,
                name: "通信层",
                type: "group",
                children: communicationCases
            },
            {
                nodeId: `${configuration.configId}_APPLICATION`,
                name: "应用层",
                type: "group",
                children: applicationCases
            }
        ]
    };
}

/*
 * 发布全部 config 的用例树。
 *
 * 在参数校验阶段调用：此时用例总数已知，但一个用例都还没执行，宿主因此
 * 能在测试详情页立刻显示"待执行"的完整用例清单，而不是等执行完才出现。
 * 返回每条用例所属的 config，执行阶段据此更新状态。
 */
export function publishCaseTrees(caseCount, configCount) {
    const ranges = caseRanges(caseCount, configCount);
    const caseConfig = new Map();
    ranges.forEach((range, index) => {
        const configuration = configurationOf(index);
        if (range.firstCase > range.lastCase) {
            return;
        }
        taskCase.publish(buildConfigTree(configuration, range));
        for (let caseIndex = range.firstCase; caseIndex <= range.lastCase;
             ++caseIndex) {
            caseConfig.set(testCaseId(caseIndex), configuration.configId);
        }
    });
    return caseConfig;
}
