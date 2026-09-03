/* MQTT 载荷是 UTF-8 JSON；插件显式编码，避免依赖 QuickJS 的可选 Web API。 */
export function encodeUtf8(value) {
    const text = String(value);
    const bytes = [];
    for (let index = 0; index < text.length; ++index) {
        let codePoint = text.codePointAt(index);
        if (codePoint > 0xffff) {
            ++index;
        }
        if (codePoint <= 0x7f) {
            bytes.push(codePoint);
        } else if (codePoint <= 0x7ff) {
            bytes.push(0xc0 | (codePoint >> 6),
                       0x80 | (codePoint & 0x3f));
        } else if (codePoint <= 0xffff) {
            bytes.push(0xe0 | (codePoint >> 12),
                       0x80 | ((codePoint >> 6) & 0x3f),
                       0x80 | (codePoint & 0x3f));
        } else {
            bytes.push(0xf0 | (codePoint >> 18),
                       0x80 | ((codePoint >> 12) & 0x3f),
                       0x80 | ((codePoint >> 6) & 0x3f),
                       0x80 | (codePoint & 0x3f));
        }
    }
    return new Uint8Array(bytes);
}

export function decodeUtf8(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let text = "";
    for (let index = 0; index < bytes.length;) {
        const first = bytes[index++];
        let codePoint = 0xfffd;
        let continuationCount = 0;
        if (first <= 0x7f) {
            codePoint = first;
        } else if (first >= 0xc2 && first <= 0xdf) {
            codePoint = first & 0x1f;
            continuationCount = 1;
        } else if (first >= 0xe0 && first <= 0xef) {
            codePoint = first & 0x0f;
            continuationCount = 2;
        } else if (first >= 0xf0 && first <= 0xf4) {
            codePoint = first & 0x07;
            continuationCount = 3;
        }
        if (continuationCount > 0) {
            let valid = true;
            for (let count = 0; count < continuationCount; ++count) {
                if (index >= bytes.length
                        || (bytes[index] & 0xc0) !== 0x80) {
                    valid = false;
                    break;
                }
                codePoint = (codePoint << 6) | (bytes[index++] & 0x3f);
            }
            if (!valid || codePoint > 0x10ffff
                    || (codePoint >= 0xd800 && codePoint <= 0xdfff)
                    || (continuationCount === 2 && codePoint < 0x800)
                    || (continuationCount === 3 && codePoint < 0x10000)) {
                codePoint = 0xfffd;
            }
        }
        text += String.fromCodePoint(codePoint);
    }
    return text;
}

export function jsonBytes(value) {
    return encodeUtf8(JSON.stringify(value));
}

export function parseJsonBytes(value, description = "MQTT message") {
    let parsed;
    try {
        parsed = JSON.parse(decodeUtf8(value));
    } catch (error) {
        throw new Error(`${description} is not valid UTF-8 JSON: ${error.message}`);
    }
    if (parsed === null || typeof parsed !== "object") {
        throw new Error(`${description} must contain a JSON object`);
    }
    return parsed;
}

export function bytesLength(value) {
    return value instanceof Uint8Array ? value.length : new Uint8Array(value).length;
}

export function concatBytes(parts, totalLength = 0) {
    const length = totalLength > 0
        ? totalLength
        : parts.reduce((total, part) => total + bytesLength(part), 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        const bytes = part instanceof Uint8Array ? part : new Uint8Array(part);
        result.set(bytes, offset);
        offset += bytes.length;
    }
    return result;
}
