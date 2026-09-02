import * as fs from "@atech/fs";
import * as task from "@atech/task";

import { POLL_INTERVAL_MS } from "./constants.js";

export function debug(message) {
    task.info(`[CANoe debug] ${message}`);
}

export function normalize(value) {
    return String(value === undefined || value === null ? "" : value)
        .trim().toLowerCase();
}

export function errorMessage(error) {
    return error && error.message ? String(error.message) : String(error);
}

export function optionalProperty(object, name) {
    if (object === null || object === undefined) {
        return undefined;
    }
    try {
        return object.get(name);
    } catch (_) {
        return undefined;
    }
}

export function propertyOr(object, names, fallback = undefined) {
    for (const name of names) {
        const value = optionalProperty(object, name);
        if (value !== undefined && value !== null) {
            return value;
        }
    }
    return fallback;
}

export function collectionCount(collection) {
    const count = Number(optionalProperty(collection, "Count"));
    return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
}

export function collectionItem(collection, index) {
    try {
        return collection.item(index + 1);
    } catch (_) {
        return collection.item(index);
    }
}

export function collectionItems(collection) {
    if (Array.isArray(collection)) {
        return collection.slice();
    }
    const items = [];
    for (let index = 0; index < collectionCount(collection); ++index) {
        try {
            items.push(collectionItem(collection, index));
        } catch (_) {
            break;
        }
    }
    return items;
}

export function release(object) {
    if (object === null || object === undefined) {
        return;
    }
    try {
        object.release();
    } catch (_) {
        // COM 包装对象可能由宿主提前释放，重复释放不应遮蔽原始执行结果.
    }
}

export function releaseAll(objects) {
    for (const object of objects) {
        release(object);
    }
}

export async function waitUntil(predicate, timeoutMs, description,
                                 ignoreCancellation = false) {
    const started = Date.now();
    let lastError = "";
    debug(`waiting for ${description}`);
    while (true) {
        if (!ignoreCancellation) {
            task.checkCancelled();
        }
        try {
            if (predicate()) {
                debug(`${description} is ready after ${Date.now() - started} ms`);
                return;
            }
        } catch (error) {
            if (error && error.canoeFatal === true) {
                throw error;
            }
            lastError = errorMessage(error);
        }
        if (Date.now() - started >= timeoutMs) {
            const detail = lastError ? `; last COM error: ${lastError}` : "";
            throw new Error(
                `Timed out waiting for ${description} after ${timeoutMs} ms${detail}`);
        }
        await task.delay(POLL_INTERVAL_MS, ignoreCancellation);
    }
}

export function executionState(object, started = true) {
    if (!started || object === null || object === undefined) {
        return { known: false, running: false };
    }
    let known = false;
    for (const name of ["Running", "Executing", "IsRunning"]) {
        const value = optionalProperty(object, name);
        if (value !== undefined && value !== null) {
            known = true;
            if (value === true) {
                return { known: true, running: true };
            }
        }
    }
    const state = normalize(optionalProperty(object, "State"));
    if (state !== "") {
        known = true;
        return {
            known,
            running: state === "1" || state === "running"
                || state === "executing" || state === "started"
                || state === "active" || state === "cstarting"
        };
    }
    return { known, running: false };
}

export function nativePathToWorkspaceUri(rootUri, nativePath) {
    if (!rootUri || !nativePath) {
        return "";
    }
    const root = fs.nativePath(rootUri).replace(/\\/g, "/").replace(/\/$/, "");
    const candidate = String(nativePath).replace(/\\/g, "/");
    const lowerRoot = root.toLowerCase();
    const lowerCandidate = candidate.toLowerCase();
    if (lowerCandidate !== lowerRoot && !lowerCandidate.startsWith(`${lowerRoot}/`)) {
        return "";
    }
    return `${rootUri}/${candidate.substring(root.length).replace(/^\/+/, "")}`;
}
