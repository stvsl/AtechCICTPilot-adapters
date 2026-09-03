import * as fs from "@atech/fs";
import * as task from "@atech/task";

import {
    MAX_REPORT_BYTES,
    MAX_REPORT_PACKETS,
    TOPICS
} from "./constants.js";
import { concatBytes, bytesLength } from "./codec.js";
import {
    receiveMessage,
    reportTimeout,
    request,
    subscribe,
    unsubscribe
} from "./mqtt.js";

function readUInt32(bytes, offset, littleEndian) {
    if (offset + 4 > bytes.length) {
        return -1;
    }
    return littleEndian
        ? (bytes[offset]
            | (bytes[offset + 1] << 8)
            | (bytes[offset + 2] << 16)
            | (bytes[offset + 3] << 24)) >>> 0
        : ((bytes[offset] << 24)
            | (bytes[offset + 1] << 16)
            | (bytes[offset + 2] << 8)
            | bytes[offset + 3]) >>> 0;
}

function parsePacket(payload, expectedBytes, expectedPackets) {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    if (bytes.length < 8) {
        throw new Error("EA report packet is shorter than its 8-byte header");
    }
    let index = readUInt32(bytes, 0, true);
    let length = readUInt32(bytes, 4, true);
    if (length > bytes.length - 8 || (expectedBytes > 0 && length > expectedBytes)) {
        index = readUInt32(bytes, 0, false);
        length = readUInt32(bytes, 4, false);
    }
    if (index < 0 || index > expectedPackets || length < 0
            || length !== bytes.length - 8) {
        throw new Error("EA report packet has an invalid index or data length");
    }
    return {index, data: bytes.slice(8)};
}

function reportMetadata(response) {
    if (!response.Data || typeof response.Data !== "object") {
        throw new Error("EA report download response has no Data object");
    }
    const data = response.Data;
    const topic = String(data.ReportPushTopic || "");
    const voucher = String(data.PushVoucher || "");
    const packetCount = Number(data.PushPackCount);
    const byteCount = Number(data.ReportBytesSize);
    if (!topic || !voucher || !Number.isInteger(packetCount)
            || packetCount < 1 || packetCount > MAX_REPORT_PACKETS
            || !Number.isInteger(byteCount) || byteCount < 0
            || byteCount > MAX_REPORT_BYTES) {
        throw new Error("EA report download response contains invalid metadata");
    }
    return {topic, voucher, packetCount, byteCount};
}

function packetForIndex(packets, index) {
    const key = String(index);
    return Object.prototype.hasOwnProperty.call(packets, key)
        ? packets[key] : null;
}

function assemblePackets(packets, packetCount, byteCount) {
    const indexes = Object.keys(packets).map((value) => Number(value)).sort((a, b) => a - b);
    if (indexes.length !== packetCount) {
        throw new Error(`EA report packet count mismatch: ${indexes.length}/${packetCount}`);
    }
    const start = indexes[0];
    if ((start !== 0 && start !== 1)
            || indexes.some((index, offset) => index !== start + offset)) {
        throw new Error("EA report packet indexes are not contiguous");
    }
    const parts = indexes.map((index) => packetForIndex(packets, index));
    const result = concatBytes(parts);
    if (result.length !== byteCount) {
        throw new Error(`EA report byte count mismatch: ${result.length}/${byteCount}`);
    }
    return result;
}

export function downloadReport(context) {
    if (!context.reportPath) {
        task.warning("VCarEA did not return a report path; report download skipped");
        return;
    }
    const download = request(
        TOPICS.reportDownloadRequest,
        TOPICS.reportDownloadResponse,
        {ReportPath: context.reportPath});
    const metadata = reportMetadata(download);
    context.reportDownload = metadata;
    subscribe(metadata.topic, 1);
    const packets = Object.create(null);
    const deadline = Date.now() + reportTimeout();
    try {
        request(TOPICS.reportPushRequest,
                TOPICS.reportPushResponse,
                {PushVoucher: metadata.voucher});
        while (Object.keys(packets).length < metadata.packetCount) {
            task.checkCancelled();
            if (Date.now() >= deadline) {
                throw new Error("Timed out waiting for VCarEA report packets");
            }
            const message = receiveMessage(Math.max(1, Math.min(250, deadline - Date.now())));
            if (message === null || message === undefined) {
                continue;
            }
            if (message.topic !== metadata.topic) {
                continue;
            }
            const packet = parsePacket(message.payload,
                                       metadata.byteCount,
                                       metadata.packetCount);
            if (!Object.prototype.hasOwnProperty.call(packets, String(packet.index))) {
                packets[String(packet.index)] = packet.data;
            }
        }
        const reportBytes = assemblePackets(packets,
                                            metadata.packetCount,
                                            metadata.byteCount);
        context.reportBytes = reportBytes;
        context.reportArtifactUri = "artifact://vcar-ea/report.zip";
        fs.writeBytes(context.reportArtifactUri, reportBytes);
        task.publish("EA_REPORT",
                     context.reportArtifactUri,
                     "VCarEA execution report",
                     "application/zip");
        task.info(`Downloaded VCarEA report (${bytesLength(reportBytes)} bytes)`);
    } finally {
        unsubscribe(metadata.topic);
    }
}
