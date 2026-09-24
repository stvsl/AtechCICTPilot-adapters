import * as fs from "@atech/fs";
import * as task from "@atech/task";

import {
    TOPICS,
    busyRejectionMessage,
    busyRetryInterval,
    createRequest,
    publishJson,
    receiveMessage,
    reportBusyRetry,
    reportTimeout,
    request,
    responseFromMessage,
    routeProtocolMessage,
    subscribe,
    unsubscribe,
} from "./protocol.js";
import {sha256Hex} from "./sha256.js";

// TODO: 接口文档没有规定报告包上限，以下限制用于避免无界内存占用。
const MAX_REPORT_PACKETS = 100000;
const MAX_REPORT_BYTES = 512 * 1024 * 1024;
const RECEIVE_POLL_INTERVAL_MS = 250;

/** 旧版报告格式对应的产物媒体类型。 */
const REPORT_MEDIA_TYPES = Object.freeze({
    html: "text/html",
    pdf: "application/pdf",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
});

function readUInt32(bytes, offset, littleEndian) {
    if (offset + 4 > bytes.length) {
        return -1;
    }
    if (littleEndian) {
        return (bytes[offset]
            | (bytes[offset + 1] << 8)
            | (bytes[offset + 2] << 16)
            | (bytes[offset + 3] << 24)) >>> 0;
    }
    return ((bytes[offset] << 24)
        | (bytes[offset + 1] << 16)
        | (bytes[offset + 2] << 8)
        | bytes[offset + 3]) >>> 0;
}

function parsePacket(payload, expectedBytes, expectedPackets) {
    const bytes = payload instanceof Uint8Array
        ? payload : new Uint8Array(payload);
    if (bytes.length < 8) {
        throw new Error("VCarEA 报告数据包短于 8 字节包头");
    }
    // 实测字节序为小端（index + length 均为 int32 小端）；长度不成立时
    // 再兼容大端，防御其他版本实现差异。
    const payloadLength = bytes.length - 8;
    const validHeader = (index, length) =>
        index >= 0 && index <= expectedPackets
        && length === payloadLength
        && (expectedBytes <= 0 || length <= expectedBytes);
    const littleEndian = {
        index: readUInt32(bytes, 0, true),
        length: readUInt32(bytes, 4, true),
    };
    const bigEndian = {
        index: readUInt32(bytes, 0, false),
        length: readUInt32(bytes, 4, false),
    };
    const header = validHeader(littleEndian.index, littleEndian.length)
        ? littleEndian : bigEndian;
    if (!validHeader(header.index, header.length)) {
        throw new Error("VCarEA 报告数据包的索引或长度无效");
    }
    return {index: header.index, data: bytes.slice(8)};
}

function reportMetadata(response) {
    if (!response.Data || typeof response.Data !== "object") {
        throw new Error("报告下载应答缺少 Data 对象");
    }
    const data = response.Data;
    const topic = String(data.ReportPushTopic || "").trim();
    const voucher = String(data.PushVoucher || "").trim();
    const packetCount = Number(data.PushPackCount);
    const byteCount = Number(data.ReportBytesSize);
    const format = Number(data.FileFormatType);
    if (topic === "" || voucher === ""
            || !Number.isInteger(packetCount) || packetCount < 1
            || packetCount > MAX_REPORT_PACKETS
            || !Number.isInteger(byteCount) || byteCount < 0
            || byteCount > MAX_REPORT_BYTES || format !== 0) {
        throw new Error("报告下载应答包含无效的推送元数据");
    }
    return {
        topic,
        voucher,
        packetCount,
        byteCount,
        // 实测 FileHashCode 为组包 ZIP 的 SHA-256，用于下载完整性校验。
        fileHashCode: String(data.FileHashCode || ""),
    };
}

function concatBytes(parts, length) {
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

function assemblePackets(packets, packetCount, byteCount) {
    const indexes = Object.keys(packets)
        .map((value) => Number(value)).sort((left, right) => left - right);
    if (indexes.length !== packetCount) {
        throw new Error(
            `VCarEA 报告包数量不匹配：${indexes.length}/${packetCount}`);
    }
    const first = indexes[0];
    if ((first !== 0 && first !== 1)
            || indexes.some((index, offset) => index !== first + offset)) {
        throw new Error("VCarEA 报告包索引不连续");
    }
    const parts = indexes.map((index) => packets[String(index)]);
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    if (total !== byteCount) {
        throw new Error(`VCarEA 报告字节数不匹配：${total}/${byteCount}`);
    }
    return concatBytes(parts, total);
}

/**
 * 从已下载的 ZIP 报告中提取旧版格式文件（html/pdf/xlsx）并发布为产物。
 *
 * 实测报告接口固定推送 ZIP（FileFormatType=0），但 ZIP 内同时包含
 * html、pdf、xlsx 与 sqlite 数据库；请求旧版格式时提取对应文件，
 * 提取失败时仅告警并保留 ZIP 本体。
 */
function extractLegacyFormats(zipUri, index, requestedTypes) {
    const formats = requestedTypes.filter((type) => type !== "zip");
    const extracted = [];
    if (formats.length === 0) {
        return extracted;
    }
    const extractRoot = `temp://vcarea-report-${index}`;
    try {
        if (fs.exists(extractRoot)) {
            fs.remove(extractRoot, true);
        }
        fs.extractZip(zipUri, extractRoot);
        const entries = fs.list(extractRoot, true).filter((entry) =>
            entry.type === "file");
        for (const format of formats) {
            const suffix = `.${format}`;
            const entry = entries.find((item) =>
                item.name.toLowerCase().endsWith(suffix));
            if (entry === undefined) {
                task.warning(
                    `VCarEA ZIP 报告中未找到 ${format} 文件，保留 ZIP 产物`);
                continue;
            }
            const artifactUri = `artifact://vcarea-test/${entry.name}`;
            fs.writeBytes(artifactUri, fs.readBytes(entry.uri));
            task.publish(
                `VCAREA_REPORT:${format}:${index}`,
                artifactUri,
                `VCarEA 测试报告 ${index}（${format}）`,
                REPORT_MEDIA_TYPES[format] || "application/octet-stream");
            extracted.push({
                Type: format,
                ArtifactUri: artifactUri,
                Name: entry.name,
            });
            task.info(`已从 ZIP 中提取 VCarEA 报告：${entry.name}`);
        }
    } catch (error) {
        task.warning(`解压 VCarEA 报告 ZIP 失败：${error.message}`);
    } finally {
        try {
            if (fs.exists(extractRoot)) {
                fs.remove(extractRoot, true);
            }
        } catch (error) {
            task.warning(`清理报告解压目录失败：${error.message}`);
        }
    }
    return extracted;
}

/**
 * 按 Download -> Push -> 二进制分包流程下载报告。
 *
 * 接口固定以 FileFormatType=0（ZIP）推送，实测 ZIP 内包含 html、pdf、
 * xlsx 与 sqlite 数据库；选择旧版格式时从 ZIP 中提取对应文件并另行发布，
 * ZIP 本体始终保留。
 */
export function downloadReport(reportPath, reportIndex, requestedTypes = []) {
    const index = Number(reportIndex);
    if (!Number.isInteger(index) || index < 1) {
        throw new Error("VCarEA 报告序号必须是正整数");
    }
    const artifactUri = `artifact://vcarea-test/report-${index}.zip`;
    // 下载请求采用通用请求包装：宿主接口忙时自动重发，直到收到应答。
    const downloadResponse = request(
        TOPICS.reportDownloadRequest,
        TOPICS.reportDownloadResponse,
        {ReportPath: reportPath},
        reportTimeout());
    const metadata = reportMetadata(downloadResponse);
    subscribe(metadata.topic, 1);

    const packets = Object.create(null);
    let receivedPacketCount = 0;
    const pushRequest = createRequest({PushVoucher: metadata.voucher});
    const deadline = Date.now() + reportTimeout();
    let pushAcknowledged = false;
    const busyState = {count: 0, reportedAt: 0};
    try {
        // 必须先订阅报告主题再请求推送，避免首包在订阅完成前丢失。
        publishJson(TOPICS.reportPushRequest, pushRequest);
        while (receivedPacketCount < metadata.packetCount || !pushAcknowledged) {
            task.checkCancelled();
            if (Date.now() >= deadline) {
                throw new Error("等待 VCarEA 报告数据包超时");
            }
            const message = receiveMessage(Math.max(
                1, Math.min(RECEIVE_POLL_INTERVAL_MS, deadline - Date.now())));
            if (message === null || message === undefined) {
                continue;
            }
            if (message.topic === TOPICS.reportPushResponse) {
                const busyMessage = busyRejectionMessage(
                    message, TOPICS.reportPushResponse);
                if (busyMessage !== null) {
                    // 宿主同一时刻只处理一个接口：忙拒绝后重发同一推送请求，
                    // 已收到的分包按 index 去重，重复推送也不会污染结果。
                    reportBusyRetry(
                        busyState, TOPICS.reportPushResponse, busyMessage);
                    publishJson(TOPICS.reportPushRequest, pushRequest);
                    task.delay(Math.max(1, Math.min(
                        busyRetryInterval(), deadline - Date.now())));
                    continue;
                }
                const response = responseFromMessage(
                    message, TOPICS.reportPushResponse, pushRequest.ID);
                if (response !== null) {
                    pushAcknowledged = true;
                }
                continue;
            }
            if (routeProtocolMessage(message)) {
                continue;
            }
            if (message.topic !== metadata.topic) {
                continue;
            }
            const packet = parsePacket(
                message.payload, metadata.byteCount, metadata.packetCount);
            const key = String(packet.index);
            if (!Object.prototype.hasOwnProperty.call(packets, key)) {
                packets[key] = packet.data;
                receivedPacketCount += 1;
            }
        }
        const report = assemblePackets(
            packets, metadata.packetCount, metadata.byteCount);
        // 实测 FileHashCode 为组包 ZIP 的 SHA-256；不匹配时告警但不阻断产物。
        const sha256 = sha256Hex(report);
        const hashVerified = metadata.fileHashCode === ""
            ? null
            : sha256.toLowerCase() === metadata.fileHashCode.toLowerCase();
        if (hashVerified === false) {
            task.warning(
                `VCarEA 报告哈希不匹配：期望 ${metadata.fileHashCode}，`
                + `实际 ${sha256}`);
        }
        fs.writeBytes(artifactUri, report);
        task.publish(
            `VCAREA_REPORT:zip:${index}`,
            artifactUri,
            `VCarEA 测试报告 ${index}`,
            "application/zip");
        task.info(`已下载 VCarEA ZIP 报告（${report.length} 字节）`);
        const extracted = extractLegacyFormats(
            artifactUri, index, requestedTypes);
        return {
            ArtifactUri: artifactUri,
            Bytes: report.length,
            Packets: metadata.packetCount,
            FileHashCode: metadata.fileHashCode,
            FileHashVerified: hashVerified,
            Extracted: extracted,
        };
    } finally {
        try {
            unsubscribe(metadata.topic);
        } catch (error) {
            // 连接中断时退订可能失败，最终 cleanup 仍会释放整个 MQTT 会话。
            task.warning(`退订 VCarEA 报告主题失败：${error.message}`);
        }
    }
}
