function text(value) {
    return value === undefined || value === null ? "" : String(value);
}

function normalizedUri(uri) {
    return text(uri).trim().toLowerCase();
}

function modifiedAtValue(value) {
    if (value instanceof Date) {
        const milliseconds = value.getTime();
        return Number.isFinite(milliseconds) ? String(milliseconds) : "";
    }
    return text(value);
}

function normalizedEntry(entry) {
    if (entry === null || entry === undefined
            || (entry.type !== undefined && entry.type !== "file")) {
        return null;
    }
    const uri = text(entry.uri).trim();
    const size = Number(entry.size);
    if (uri === "" || !Number.isFinite(size) || size < 0) {
        return null;
    }
    return {
        uri,
        size,
        modifiedAt: modifiedAtValue(entry.modifiedAt)
    };
}

export function isNativeReportUri(uri) {
    const lower = normalizedUri(uri);
    return lower.endsWith(".vtestreport") || lower.endsWith(".xml");
}

function isLikelyNativeReportUri(uri) {
    const lower = normalizedUri(uri);
    return lower.endsWith(".vtestreport")
        || (lower.endsWith(".xml")
            && (lower.includes("/report") || lower.includes("report.")));
}

function sameReportFileState(left, right) {
    const first = normalizedEntry(left);
    const second = normalizedEntry(right);
    return first !== null && second !== null
        && normalizedUri(first.uri) === normalizedUri(second.uri)
        && first.size === second.size
        && first.modifiedAt === second.modifiedAt;
}

function decodeUtf8Bytes(bytes) {
    let output = "";
    let index = 0;
    while (index < bytes.length) {
        const first = Number(bytes[index]) & 0xff;
        let codePoint = 0;
        let length = 0;
        if (first <= 0x7f) {
            codePoint = first;
            length = 1;
        } else if (first >= 0xc2 && first <= 0xdf) {
            codePoint = first & 0x1f;
            length = 2;
        } else if (first >= 0xe0 && first <= 0xef) {
            codePoint = first & 0x0f;
            length = 3;
        } else if (first >= 0xf0 && first <= 0xf4) {
            codePoint = first & 0x07;
            length = 4;
        } else {
            output += "\ufffd";
            ++index;
            continue;
        }

        if (index + length > bytes.length) {
            output += "\ufffd";
            ++index;
            continue;
        }
        let valid = true;
        for (let offset = 1; offset < length; ++offset) {
            const continuation = Number(bytes[index + offset]) & 0xff;
            if ((continuation & 0xc0) !== 0x80) {
                valid = false;
                break;
            }
            codePoint = (codePoint << 6) | (continuation & 0x3f);
        }
        if ((length === 3 && codePoint < 0x800)
                || (length === 4 && codePoint < 0x10000)
                || (codePoint >= 0xd800 && codePoint <= 0xdfff)
                || codePoint > 0x10ffff) {
            valid = false;
        }
        if (!valid) {
            output += "\ufffd";
            ++index;
            continue;
        }
        if (codePoint <= 0xffff) {
            output += String.fromCharCode(codePoint);
        } else {
            const high = Math.floor((codePoint - 0x10000) / 0x400) + 0xd800;
            const low = ((codePoint - 0x10000) % 0x400) + 0xdc00;
            output += String.fromCharCode(high, low);
        }
        index += length;
    }
    return output;
}

export function decodeCliText(value) {
    if (value === undefined || value === null) {
        return "";
    }
    if (typeof value === "string") {
        return value.trim();
    }
    if (typeof TextDecoder === "function") {
        try {
            return new TextDecoder().decode(value).trim();
        } catch (_) {
            // 继续使用内置解码器，兼容未实现 TextDecoder 的 QuickJS 构建。
        }
    }
    if (typeof value.length === "number") {
        try {
            return decodeUtf8Bytes(value).trim();
        } catch (_) {
            // 非字节数组对象仍回退到普通字符串表示。
        }
    }
    return text(value).trim();
}

/*
 * CANoe 可能先保留上一次报告路径，再异步删除并重建同名文件。跟踪器只接收
 * 相对基线有变化、非空且连续多个完整快照一致的报告，避免消费旧文件或半成品。
 */
export class ReportFileTracker {
    constructor(baseline = [], stableObservations = 3) {
        this.baseline = new Map();
        for (const candidate of baseline) {
            const entry = normalizedEntry(candidate);
            if (entry !== null && isNativeReportUri(entry.uri)) {
                this.baseline.set(normalizedUri(entry.uri), entry);
            }
        }
        const observations = Number(stableObservations);
        this.requiredStableObservations = Number.isFinite(observations)
            ? Math.max(2, Math.floor(observations)) : 3;
        this.previousSignature = "";
        this.stableObservationCount = 0;
    }

    observe(entries = [], preferredUris = []) {
        const preferred = new Map();
        preferredUris.forEach((uri, index) => {
            const key = normalizedUri(uri);
            if (key !== "" && !preferred.has(key)) {
                preferred.set(key, index);
            }
        });

        const candidates = new Map();
        for (const candidate of entries) {
            const entry = normalizedEntry(candidate);
            if (entry === null || entry.size === 0 || !isNativeReportUri(entry.uri)) {
                continue;
            }
            const key = normalizedUri(entry.uri);
            if (!preferred.has(key) && !isLikelyNativeReportUri(entry.uri)) {
                continue;
            }
            const baselineEntry = this.baseline.get(key);
            if (baselineEntry !== undefined
                    && sameReportFileState(entry, baselineEntry)) {
                continue;
            }
            candidates.set(key, entry);
        }

        const canonical = Array.from(candidates.entries())
            .sort((left, right) => left[0].localeCompare(right[0]));
        const signature = canonical.map(([key, entry]) =>
            `${key}\u0000${entry.size}\u0000${entry.modifiedAt}`).join("\u0001");
        if (signature === "") {
            this.stableObservationCount = 0;
        } else if (signature === this.previousSignature) {
            ++this.stableObservationCount;
        } else {
            this.stableObservationCount = 1;
        }
        this.previousSignature = signature;
        if (this.stableObservationCount < this.requiredStableObservations) {
            return [];
        }

        return canonical.map(([, entry]) => entry).sort((left, right) => {
            const leftRank = preferred.has(normalizedUri(left.uri))
                ? preferred.get(normalizedUri(left.uri)) : Number.MAX_SAFE_INTEGER;
            const rightRank = preferred.has(normalizedUri(right.uri))
                ? preferred.get(normalizedUri(right.uri)) : Number.MAX_SAFE_INTEGER;
            return leftRank === rightRank
                ? left.uri.localeCompare(right.uri) : leftRank - rightRank;
        });
    }
}
