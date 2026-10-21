import * as cli from "@atech/cli";

// 先按字节拼接完整行，再识别 UTF-8 或系统代码页，避免跨块中文被提前替换。
export class OutputCollector {
    constructor(onLine) {
        this.pending = [];
        this.chunks = [];
        this.size = 0;
        this.onLine = onLine;
    }

    read(bytes) {
        if (bytes.length === 0) {
            return;
        }
        this.chunks.push(bytes);
        this.size += bytes.length;
        for (const byte of bytes) {
            if (byte === 13 || byte === 10) {
                this.flushLine();
            } else if (this.pending.length < 32768) {
                // 异常长行只限制界面预览；原始字节始终完整归档。
                this.pending.push(byte);
            }
        }
    }

    flushLine() {
        if (this.pending.length === 0) {
            return;
        }
        const line = cli.decodeText(new Uint8Array(this.pending));
        this.pending = [];
        if (line.trim() !== "") {
            this.onLine(line);
        }
    }

    finish() {
        this.flushLine();
    }

    bytes() {
        const bytes = new Uint8Array(this.size);
        let offset = 0;
        for (const chunk of this.chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        return bytes;
    }

    text() {
        return cli.decodeText(this.bytes());
    }
}

export function progressOf(line) {
    // 本地代码页可能把进度条方块替换为问号；仍严格匹配标签和行尾百分比。
    const match = /^\[[^\]\r\n]{1,256}\]\s*进度\s+(\d{1,3}(?:[.,]\d+)?)%\s*$/.exec(line.trim());
    if (!match) {
        return null;
    }
    const value = Number(match[1].replace(",", "."));
    return value >= 0 && value <= 100 ? value : null;
}
