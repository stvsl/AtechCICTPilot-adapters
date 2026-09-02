import * as fs from "@atech/fs";

import {
    CONTRACT_VERSION,
    PROJECT_ROOT_URI
} from "./constants.js";

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(uri, field) {
    let value;
    try {
        value = JSON.parse(fs.readText(uri));
    } catch (error) {
        throw new Error(`${field} is not valid JSON: ${error.message}`);
    }
    return value;
}

export function requireSafeRelativePath(value, field) {
    if (typeof value !== "string" || value.length === 0
            || value.includes("\\") || value.startsWith("/")
            || value.includes(":")
            || value.split("/").some((part) => part === "" || part === "."
                || part === "..")) {
        throw new Error(`${field} must be a safe relative path`);
    }
    return value;
}

export function baseName(uri) {
    const parts = String(uri).split("/");
    const name = parts[parts.length - 1];
    if (!name || name === "." || name === "..") {
        throw new Error(`Unable to determine a file name from ${uri}`);
    }
    return name;
}

export function parseProjectDescriptor(value) {
    if (!isPlainObject(value)) {
        throw new Error("canoe-project.json must contain an object");
    }
    const allowedFields = ["ContractVersion", "Configuration", "Artifacts"];
    for (const name of Object.keys(value)) {
        if (!allowedFields.includes(name)) {
            throw new Error(`canoe-project.json contains an unsupported field: ${name}`);
        }
    }
    if (typeof value.ContractVersion !== "string"
            || value.ContractVersion !== CONTRACT_VERSION) {
        throw new Error(
            `Unsupported canoe-project.json contract: ${value.ContractVersion}`);
    }

    const configurationPath = requireSafeRelativePath(
        value.Configuration, "Configuration");
    if (!configurationPath.toLowerCase().endsWith(".cfg")) {
        throw new Error("Configuration must reference a CANoe .cfg file");
    }
    if (value.Artifacts === undefined) {
        throw new Error("canoe-project.json must contain Artifacts");
    }
    const artifactValues = value.Artifacts;
    if (!Array.isArray(artifactValues)) {
        throw new Error("Artifacts must be an array");
    }

    const artifactPaths = [];
    const seenArtifacts = Object.create(null);
    for (const value of artifactValues) {
        const path = requireSafeRelativePath(value, "Artifacts entry");
        const comparisonKey = path.toLowerCase();
        if (seenArtifacts[comparisonKey]) {
            throw new Error(`Artifacts contains a duplicate path: ${path}`);
        }
        seenArtifacts[comparisonKey] = true;
        artifactPaths.push(path);
    }
    if (artifactPaths.some((path) =>
            path.toLowerCase() === "results/test-results.json")) {
        throw new Error("Artifacts must not contain results/test-results.json");
    }

    return {
        contractVersion: CONTRACT_VERSION,
        configurationPath,
        artifactPaths
    };
}

export function parseTestCaseIds(text) {
    let value;
    try {
        value = JSON.parse(String(text));
    } catch (error) {
        throw new Error(`TEST_CASE_IDS is not valid JSON: ${error.message}`);
    }
    if (!Array.isArray(value)) {
        throw new Error("TEST_CASE_IDS must contain a JSON array of IDs");
    }

    const ids = [];
    const seen = Object.create(null);
    for (let index = 0; index < value.length; ++index) {
        if (typeof value[index] !== "string") {
            throw new Error(`TEST_CASE_IDS item ${index + 1} must be a string`);
        }
        const id = value[index].trim();
        if (id.length === 0) {
            throw new Error(`TEST_CASE_IDS item ${index + 1} must not be empty`);
        }
        if (seen[id]) {
            throw new Error(`TEST_CASE_IDS contains a duplicate ID: ${id}`);
        }
        seen[id] = true;
        ids.push(id);
    }
    return ids;
}

export function loadProject(projectPackageUri) {
    fs.extractZip(projectPackageUri, PROJECT_ROOT_URI);
    const descriptorUri = `${PROJECT_ROOT_URI}/canoe-project.json`;
    if (!fs.exists(descriptorUri)) {
        throw new Error("CANOE_PROJECT must contain canoe-project.json at the archive root");
    }

    const descriptor = parseProjectDescriptor(
        readJson(descriptorUri, "canoe-project.json"));
    const configurationUri = `${PROJECT_ROOT_URI}/${descriptor.configurationPath}`;
    if (!fs.exists(configurationUri)) {
        throw new Error(
            `CANoe configuration is missing: ${descriptor.configurationPath}`);
    }
    return {
        rootUri: PROJECT_ROOT_URI,
        descriptor,
        configurationUri
    };
}

export function loadRequestedTestCaseIds(uri) {
    if (!uri) {
        return [];
    }
    if (!fs.exists(uri)) {
        throw new Error("TEST_CASE_IDS input file is missing");
    }
    return parseTestCaseIds(fs.readText(uri));
}
