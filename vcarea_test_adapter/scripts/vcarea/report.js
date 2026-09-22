import * as fs from "@atech/fs";
import * as task from "@atech/task";

import {
    TOPICS,
    createRequest,
    publishJson,
    receiveMessage,
    reportTimeout,
    responseFromMessage,
    routeProtocolMessage,
    subscribe,
    unsubscribe,
} from "./protocol.js";

// TODO: 接口文档没有规定报告包上限，以下限制用于避免无界内存占用。
const MAX_REPORT_PACKETS = 100000;
const MAX_REPORT_BYTES = 512 * 1024 * 1024;
const RECEIVE_POLL_INTERVAL_MS = 250;

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
    // TODO: 文档只声明两个 int 字段，未规定字节序；先按常见的小端解析，
    // 长度不成立时再兼容大端。
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
        // TODO: 文档未定义 FileHashCode 的算法，暂只记录而不做本地校验。
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
 * 按文档中的 Download -> Push -> 二进制分包流程下载报告。
 * 文档明确 FileFormatType=0 且仅支持 ZIP，因此这里不进行格式转换。
 */
export function downloadReport(reportPath, reportIndex) {
    const index = Number(reportIndex);
    if (!Number.isInteger(index) || index < 1) {
        throw new Error("VCarEA 报告序号必须是正整数");
    }
    const artifactUri = `artifact://vcarea-test/report-${index}.zip`;
    const downloadRequest = createRequest({ReportPath: reportPath});
    publishJson(TOPICS.reportDownloadRequest, downloadRequest);
    const downloadResponse = waitForDownloadResponse(
        downloadRequest.ID, reportTimeout());
    const metadata = reportMetadata(downloadResponse);
    subscribe(metadata.topic, 1);

    const packets = Object.create(null);
    let receivedPacketCount = 0;
    const pushRequest = createRequest({PushVoucher: metadata.voucher});
    const deadline = Date.now() + reportTimeout();
    let pushAcknowledged = false;
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
        fs.writeBytes(artifactUri, report);
        task.publish(
            `VCAREA_REPORT:zip:${index}`,
            artifactUri,
            `VCarEA 测试报告 ${index}`,
            "application/zip");
        task.info(`已下载 VCarEA ZIP 报告（${report.length} 字节）`);
        return {
            ArtifactUri: artifactUri,
            Bytes: report.length,
            Packets: metadata.packetCount,
            FileHashCode: metadata.fileHashCode,
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

function waitForDownloadResponse(requestId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        task.checkCancelled();
        const message = receiveMessage(Math.max(
            1, Math.min(RECEIVE_POLL_INTERVAL_MS, deadline - Date.now())));
        if (message === null || message === undefined) {
            continue;
        }
        if (routeProtocolMessage(message)) {
            continue;
        }
        const response = responseFromMessage(
            message, TOPICS.reportDownloadResponse, requestId);
        if (response !== null) {
            return response;
        }
    }
    throw new Error(`等待 VCarEA 报告下载应答超时（${requestId}）`);
}
