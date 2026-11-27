import * as fs from "@atech/fs";

function fileName(uri) {
    return uri.substring(uri.lastIndexOf("/") + 1);
}

function parentUri(uri) {
    return uri.substring(0, uri.lastIndexOf("/"));
}

function sourceFileName(uri, propertyId) {
    const name = fileName(uri);
    const parent = parentUri(uri);
    // 离线任务直接执行和导出重载的目录不同，但都会给文件增加六位序号。
    const isSnapshot = parent === `input://${propertyId}_files`
        || parent === `input://${propertyId}/files`;
    return isSnapshot ? name.replace(/^\d{6}_/, "") : name;
}

export function readFirmwareGroups(uris, propertyId) {
    if (propertyId !== "APP_FILE" && propertyId !== "DRIVER_FILE") {
        throw new Error(`不支持的刷写文件类别：${propertyId}`);
    }
    if (!Array.isArray(uris) || uris.length === 0) {
        throw new Error(`${propertyId} 必须提供成组的刷写文件`);
    }

    const groups = new Map();
    for (const uri of uris) {
        if (typeof uri !== "string" || !uri.startsWith("input://")) {
            throw new Error(`${propertyId} 包含无效的任务文件 URI`);
        }
        if (fs.stat(uri).type !== "file") {
            throw new Error(`${propertyId} 输入不是文件：${uri}`);
        }
        const name = sourceFileName(uri, propertyId);
        const dot = name.lastIndexOf(".");
        const extension = name.substring(dot).toLowerCase();
        const supported = extension === ".rsa" || extension === ".hex"
            || (propertyId === "APP_FILE" && extension === ".cbf");
        if (dot <= 0 || !supported) {
            throw new Error(`${propertyId} 不支持的文件类型：${name}`);
        }

        const stem = name.substring(0, dot);
        if (/[\x00-\x1f'"&|^%!<>]/.test(name)) {
            throw new Error(`文件名不能安全传给工程 CMD：${name}`);
        }
        const key = stem.toLowerCase();
        if (!groups.has(key)) {
            groups.set(key, {stem, image: null, signature: null});
        }
        const group = groups.get(key);
        const role = extension === ".rsa" ? "signature" : "image";
        if (group[role] !== null) {
            throw new Error(`${propertyId} 同一组出现重复的包或签名：${stem}`);
        }
        group[role] = {uri, name, extension};
    }

    for (const group of groups.values()) {
        if (group.image === null || group.signature === null) {
            throw new Error(`${propertyId} 文件不成组：${group.stem}，需要同名的包和 .rsa`);
        }
    }
    return [...groups.values()];
}

export function inspectProject(rootUri, appUris, driverUris) {
    const apps = readFirmwareGroups(appUris, "APP_FILE");
    const drivers = readFirmwareGroups(driverUris, "DRIVER_FILE");
    const entries = fs.list(rootUri, true);
    const byUri = new Map(entries.map((entry) => [entry.uri, entry]));
    const targets = [];

    // 依据工程内的实际目录识别目标，不限定 FL、FR 等名称或目标数量。
    for (const entry of entries) {
        if (entry.type !== "directory" || entry.name !== "APP") {
            continue;
        }
        const uri = parentUri(entry.uri);
        const driverDirectory = byUri.get(`${uri}/Flashdriver`);
        if (!driverDirectory || driverDirectory.type !== "directory") {
            continue;
        }
        const name = fileName(uri);
        const appGroups = apps.filter((group) => group.stem.startsWith(name));
        const driverGroups = drivers.filter((group) => group.stem.startsWith(name));
        if (appGroups.length === 0 && driverGroups.length === 0) {
            continue;
        }
        const scripts = entries.filter((item) => item.type === "file"
            && parentUri(item.uri) === `${uri}/capl`
            && item.name.startsWith(name)
            && item.name.toLowerCase().endsWith(".can"));
        const dlls = entries.filter((item) => item.type === "file"
            && parentUri(item.uri) === `${uri}/DLL`
            && item.name.includes(name)
            && item.name.toLowerCase().endsWith(".dll"));
        const command = byUri.get(`${uri}/put_pkg.cmd`);
        targets.push({
            name,
            uri,
            appDirectoryUri: entry.uri,
            driverDirectoryUri: driverDirectory.uri,
            appGroups,
            driverGroups,
            scriptUris: scripts.map((item) => item.uri).sort(),
            dllUris: dlls.map((item) => item.uri).sort(),
            commandUri: command && command.type === "file" ? command.uri : null
        });
    }

    const isMatched = (group, role) => targets.some((target) =>
        target[role].some((candidate) => candidate === group));
    // 保留全部候选，交由执行计划统一检查缺失、多重匹配和多组冲突。
    return {
        projectUris: entries.filter((entry) => entry.type === "file"
            && entry.name.toLowerCase().endsWith(".das"))
            .map((entry) => entry.uri).sort(),
        targets: targets.sort((left, right) => {
            if (left.name !== right.name) {
                return left.name < right.name ? -1 : 1;
            }
            return left.uri < right.uri ? -1 : 1;
        }),
        unmatchedApps: apps.filter((group) => !isMatched(group, "appGroups")),
        unmatchedDrivers: drivers.filter((group) => !isMatched(group, "driverGroups"))
    };
}

function requireSingle(values, description) {
    if (values.length !== 1) {
        throw new Error(`${description} 必须唯一，实际找到 ${values.length} 项`);
    }
    return values[0];
}

export function prepareTestSetupLayout(projectUri) {
    const projectDirectoryUri = projectUri.substring(0, projectUri.lastIndexOf("/"));
    const layoutUri = `${projectDirectoryUri}/Layout.json`;
    const dockLayoutsUri = `${projectDirectoryUri}/DockLayouts`;
    const hasDockLayouts = fs.exists(dockLayoutsUri);

    if (hasDockLayouts) {
        if (fs.stat(dockLayoutsUri).type !== "directory") {
            throw new Error(`工程停靠布局路径不是目录：${dockLayoutsUri}`);
        }
    }

    const emptyId = "00000000-0000-0000-0000-000000000000";
    fs.writeText(layoutUri, JSON.stringify({
        LayoutVersion: 1,
        ActiveTabPersistentId: emptyId,
        Documents: [{
            Order: 0,
            Name: "测试配置",
            MDIWindowInfos: [],
            MDIStyle: 2,
            IsActive: true,
            PersistentId: emptyId
        }]
    }, null, 2));

    if (hasDockLayouts) {
        fs.remove(dockLayoutsUri, true);
    }
}

export function createExecutionPlan(rootUri, appUris, driverUris) {
    const inventory = inspectProject(rootUri, appUris, driverUris);
    const projectUri = requireSingle(inventory.projectUris, "工程包中的 .das 文件");
    if (inventory.unmatchedApps.length > 0 || inventory.unmatchedDrivers.length > 0) {
        const apps = inventory.unmatchedApps.map((group) => group.stem).join(", ");
        const drivers = inventory.unmatchedDrivers.map((group) => group.stem).join(", ");
        throw new Error(`刷写文件没有匹配的目标目录；App: ${apps}；Driver: ${drivers}`);
    }
    if (inventory.targets.length === 0) {
        throw new Error("未匹配到可执行的刷写目标");
    }
    // 每个目标生成打包、编译、执行三个阶段，另有六个公共阶段。
    if (inventory.targets.length > 331) {
        throw new Error("目标数量超过单任务 1000 个阶段上限，请拆分任务");
    }

    const names = new Set();
    const appInputs = new Set();
    const driverInputs = new Set();
    const targets = inventory.targets.map((target) => {
        if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(target.name)
                || target.name.length > 128) {
            throw new Error(`目标名称不符合 SDK 模块及 CMD 路径规则：${target.name}`);
        }
        if (names.has(target.name.toLowerCase())) {
            throw new Error(`工程内存在同名目标目录：${target.name}`);
        }
        names.add(target.name.toLowerCase());
        if (!target.uri.startsWith(`${parentUri(projectUri)}/`)) {
            throw new Error(`目标目录不属于 .das 所在的工程目录：${target.uri}`);
        }
        const app = requireSingle(target.appGroups, `${target.name} 的 App 组`);
        const driver = requireSingle(target.driverGroups, `${target.name} 的 Driver 组`);
        if (appInputs.has(app.image.uri) || driverInputs.has(driver.image.uri)) {
            throw new Error(`文件前缀同时匹配多个目标：${target.name}`);
        }
        appInputs.add(app.image.uri);
        driverInputs.add(driver.image.uri);
        if (!target.commandUri) {
            throw new Error(`${target.name} 缺少 put_pkg.cmd`);
        }
        const profileUri = `${target.uri}/profile.ini`;
        if (!fs.exists(profileUri) || fs.stat(profileUri).type !== "file") {
            throw new Error(`${target.name} 缺少 profile.ini`);
        }
        // 工程脚本按相对位置调用这些工具，必须在改动固定目录前完整检查。
        const toolsUri = `${parentUri(target.uri)}/tools`;
        const command = fs.readText(target.commandUri);
        const dependencies = [...command.matchAll(/\.\.[\\/]tools[\\/]([A-Za-z0-9_.-]+)/gi)]
            .map((match) => match[1]);
        for (const name of new Set(dependencies)) {
            const uri = `${toolsUri}/${name}`;
            if (!fs.exists(uri) || fs.stat(uri).type !== "file") {
                throw new Error(`${target.name} 打包依赖不存在：${uri}`);
            }
        }
        return {
            name: target.name,
            uri: target.uri,
            appDirectoryUri: target.appDirectoryUri,
            driverDirectoryUri: target.driverDirectoryUri,
            app,
            driver,
            profileUri,
            toolsUri: fs.exists(toolsUri) ? toolsUri : null,
            scriptUri: requireSingle(target.scriptUris, `${target.name} 的 CAPL 脚本`),
            dllUri: requireSingle(target.dllUris, `${target.name} 的 DLL`),
            commandUri: target.commandUri
        };
    });
    return {projectUri, targets};
}
