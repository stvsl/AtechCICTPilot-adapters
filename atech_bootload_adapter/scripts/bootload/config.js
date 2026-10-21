import * as fs from "@atech/fs";
import * as task from "@atech/task";
import {load, dump, CORE_SCHEMA} from "../vendor/js-yaml.js";

const COMMON = ["project", "force", "verbose", "timeout", "stall-timeout"];
const CAN = ["driver", "channel", "baud", "fd-baud", "fd"];
const DOIP = ["entity", "source", "target", "target-functional", "version",
    "multicast", "route-timeout"];
const FIRMWARE = {APP_FILE: "application", FLASH_DRIVER: "flash-driver",
    CALIBRATION: "calibration"};

function text(value, key) {
    if (typeof value !== "string" || value.trim() === ""
            || value.startsWith("-") || /[\x00-\x1f]/.test(value)) {
        throw new Error(`配置 ${key} 必须是非空字符串，且不能以 - 开头或包含控制字符`);
    }
    return value;
}

function integer(value, key, minimum, maximum = 2147483647) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`配置 ${key} 必须是 ${minimum}～${maximum} 的整数`);
    }
}

function ipv4(value, key) {
    text(value, key);
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)
            || value.split(".").some((part) => Number(part) > 255)) {
        throw new Error(`配置 ${key} 必须是 IPv4 地址`);
    }
}

export function parseConfiguration(source) {
    const parsed = load(source, {schema: CORE_SCHEMA, filename: "bootload.yaml"});
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
            || Object.keys(parsed)[0] !== "mode") {
        throw new Error("YAML 必须是以 mode 为第一个字段的平面配置");
    }
    if (!["can-download", "doip-download"].includes(parsed.mode)) {
        throw new Error("mode 仅支持 can-download 或 doip-download");
    }
    const can = parsed.mode === "can-download";
    const allowed = ["mode", ...COMMON, ...(can ? CAN : DOIP)];
    for (const key of Object.keys(parsed)) {
        if (!allowed.includes(key)) {
            throw new Error(`未知或不适用于 ${parsed.mode} 的配置字段：${key}`);
        }
    }
    const config = {mode: parsed.mode, project: text(parsed.project, "project"),
        force: false, verbose: false, timeout: 1800, "stall-timeout": 60,
        ...(can ? {channel: 0, baud: 500000, fd: false}
            : {source: "0E80", target: "0002", multicast: "255.255.255.255",
                "route-timeout": 2000}), ...parsed};
    for (const key of ["force", "verbose", ...(can ? ["fd"] : [])]) {
        if (typeof config[key] !== "boolean") {
            throw new Error(`配置 ${key} 必须是 true 或 false`);
        }
    }
    // 为准备、连接、查询项目和清理留出宿主阶段预算，CLI 自行判断进度停滞。
    integer(config.timeout, "timeout", 1, 2700);
    integer(config["stall-timeout"], "stall-timeout", 1, config.timeout);
    if (can) {
        text(config.driver, "driver");
        integer(config.channel, "channel", 0);
        integer(config.baud, "baud", 1);
        if (config["fd-baud"] !== undefined) {
            integer(config["fd-baud"], "fd-baud", 1);
        }
    } else {
        ipv4(config.entity, "entity");
        ipv4(config.multicast, "multicast");
        integer(config["route-timeout"], "route-timeout", 1);
        for (const key of ["source", "target", "target-functional", "version"]) {
            if (config[key] === undefined) {
                continue;
            }
            const value = config[key];
            const digits = key === "version" ? 2 : 4;
            if (typeof value !== "string"
                    || !(new RegExp(`^(?:0[xX])?[0-9a-fA-F]{1,${digits}}$`)).test(value)) {
                throw new Error(`配置 ${key} 必须是带引号的十六进制字符串（最多 ${digits} 位）`);
            }
        }
    }
    return config;
}

function requirement(key, optional = false) {
    try {
        return task.requirement(key);
    } catch (error) {
        if (optional && error.code === "NOT_FOUND") {
            return "";
        }
        throw error;
    }
}

export function prepareConfiguration() {
    const packageUri = requirement("CONFIG_PACKAGE");
    if (typeof packageUri !== "string" || !/\.zip$/i.test(packageUri)) {
        throw new Error("配置参数包必须是 ZIP 文件");
    }
    const directory = "temp://bootload-config";
    if (fs.exists(directory)) {
        fs.remove(directory, true);
    }
    fs.extractArchive(packageUri, directory);
    const files = fs.list(directory, true).filter((entry) => entry.type === "file");
    if (files.length !== 1 || !/\.ya?ml$/i.test(files[0].name)) {
        throw new Error("配置 ZIP 内必须只包含一份 .yaml 或 .yml 文件");
    }
    if (files[0].size > 64 * 1024) {
        throw new Error("YAML 配置不能超过 64 KiB");
    }
    const config = parseConfiguration(fs.readText(files[0].uri));
    for (const [input, option] of Object.entries(FIRMWARE)) {
        const value = requirement(input, input !== "APP_FILE");
        if ((value === "" || value === null || value === undefined
                || (Array.isArray(value) && value.length === 0))
                && input !== "APP_FILE") {
            continue;
        }
        const multiple = input !== "FLASH_DRIVER";
        if (multiple && (!Array.isArray(value) || value.length === 0)) {
            throw new Error(`${input} 必须至少选择一个固件文件`);
        }
        const uris = multiple ? value : [value];
        const paths = uris.map((uri) => {
            if (typeof uri !== "string"
                    || !/\.(?:hex|vbf|s19|mot|sre|mbf|srec)$/i.test(uri)
                    || fs.stat(uri).type !== "file") {
                throw new Error(`${input} 必须是 .hex、.vbf、.s19、.mot、.sre、.mbf 或 .srec 固件文件`);
            }
            return fs.nativePath(uri);
        });
        config[option] = multiple ? paths : paths[0];
    }
    fs.mkdir("artifact://bootload");
    fs.writeText("artifact://bootload/resolved.yaml", dump(config, {
        schema: CORE_SCHEMA, forceQuotes: true, quotingType: '"', lineWidth: -1
    }));
    task.publish("BOOTLOAD_CONFIG", "artifact://bootload/resolved.yaml",
        "实际刷写配置", "application/yaml");
    return config;
}

export function commandArguments(config) {
    const result = [config.mode];
    for (const key of [...COMMON, ...(config.mode === "can-download" ? CAN : DOIP),
        ...Object.values(FIRMWARE)]) {
        const value = config[key];
        if (value === undefined || value === false
                || (Array.isArray(value) && value.length === 0)) {
            continue;
        }
        result.push(`--${key}`);
        if (value !== true) {
            // 多文件选项只出现一次，各路径独立传参，保留选择顺序和路径内空格。
            result.push(...(Array.isArray(value) ? value : [String(value)]));
        }
    }
    return result;
}
