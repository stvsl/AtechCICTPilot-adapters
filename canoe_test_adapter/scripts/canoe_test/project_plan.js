function safeRelativeConfigurationPath(value, field) {
    if (typeof value !== "string") {
        throw new Error(field + " must be a relative .cfg path");
    }
    const path = value.trim();
    if (path === "" || path.includes("\\") || path.startsWith("/")
            || path.includes(":")
            || path.split("/").some((part) =>
                part === "" || part === "." || part === "..")
            || !path.toLowerCase().endsWith(".cfg")) {
        throw new Error(field + " must be a safe relative .cfg path");
    }
    return path;
}

function comparePath(left, right) {
    const leftKey = left.toLowerCase();
    const rightKey = right.toLowerCase();
    if (leftKey < rightKey) {
        return -1;
    }
    if (leftKey > rightKey) {
        return 1;
    }
    return left < right ? -1 : left > right ? 1 : 0;
}

export function sortConfigurationPaths(paths) {
    if (!Array.isArray(paths)) {
        throw new Error("CANoe configuration paths must be an array");
    }
    return paths.map((path, index) =>
        safeRelativeConfigurationPath(path, "Configuration[" + index + "]"))
        .sort(comparePath);
}

export function parseTestCaseConfiguration(text) {
    let entries;
    try {
        entries = JSON.parse(String(text));
    } catch (error) {
        throw new Error("TEST_CASES is not valid JSON: " + error.message);
    }
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error("TEST_CASES must be a non-empty JSON array");
    }

    const plans = [];
    const byConfiguration = new Map();
    entries.forEach((entry, index) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error("TEST_CASES[" + index + "] must be an object");
        }
        const configuration = safeRelativeConfigurationPath(
            entry.Configuration, "TEST_CASES[" + index + "].Configuration");
        if (!Array.isArray(entry.TestCaseNames)
                || entry.TestCaseNames.length === 0) {
            throw new Error("TEST_CASES[" + index
                + "].TestCaseNames must be a non-empty array");
        }
        const key = configuration.toLowerCase();
        let plan = byConfiguration.get(key);
        if (plan === undefined) {
            plan = {configuration, testCaseNames: []};
            byConfiguration.set(key, plan);
            plans.push(plan);
        }
        for (const rawName of entry.TestCaseNames) {
            if (typeof rawName !== "string" || rawName.trim() === "") {
                throw new Error("TEST_CASES[" + index
                    + "].TestCaseNames entries must be non-empty strings");
            }
            const name = rawName.trim();
            if (!plan.testCaseNames.includes(name)) {
                plan.testCaseNames.push(name);
            }
        }
    });
    return plans;
}

export function selectCompatibleConfigurations(manifest, systemVersion) {
    if (!Array.isArray(manifest) || manifest.length === 0) {
        throw new Error("canoe.json must contain a non-empty JSON array");
    }
    const targetVersion = Number(String(systemVersion).trim());
    if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) {
        throw new Error("CANOE_VERSION must be a positive integer");
    }

    const compatible = [];
    manifest.forEach((entry, index) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error("canoe.json[" + index + "] must be an object");
        }
        const versionText = String(entry.CanoeVersion === undefined
            || entry.CanoeVersion === null ? "" : entry.CanoeVersion).trim();
        if (!/^[1-9][0-9]*$/.test(versionText)) {
            throw new Error("canoe.json[" + index
                + "].CanoeVersion must be a positive integer string");
        }
        const version = Number(versionText);
        if (!Number.isSafeInteger(version)) {
            throw new Error("canoe.json[" + index + "].CanoeVersion is too large");
        }
        if (!Array.isArray(entry.Configuration) || entry.Configuration.length === 0) {
            throw new Error("canoe.json[" + index
                + "].Configuration must be a non-empty array");
        }
        const configurations = entry.Configuration.map((path, pathIndex) =>
            safeRelativeConfigurationPath(path,
                "canoe.json[" + index + "].Configuration[" + pathIndex + "]"));
        if (version <= targetVersion) {
            compatible.push({version, configurations, index});
        }
    });

    if (compatible.length === 0) {
        throw new Error("canoe.json has no configuration compatible with CANOE_VERSION "
            + targetVersion);
    }
    const highestVersion = Math.max(...compatible.map((entry) => entry.version));
    return compatible.filter((entry) => entry.version === highestVersion)
        .sort((left, right) => left.index - right.index)
        .flatMap((entry) => entry.configurations);
}

export function validateConfigurationPaths(paths, availablePaths) {
    const available = new Map(availablePaths.map((path) =>
        [path.toLowerCase(), path]));
    const seen = new Set();
    return paths.map((path) => {
        const safePath = safeRelativeConfigurationPath(path, "Configuration");
        const key = safePath.toLowerCase();
        const actualPath = available.get(key);
        if (actualPath === undefined) {
            throw new Error("CANoe configuration is missing: " + safePath);
        }
        if (seen.has(key)) {
            throw new Error("CANoe configuration is listed more than once: " + safePath);
        }
        seen.add(key);
        return actualPath;
    });
}
