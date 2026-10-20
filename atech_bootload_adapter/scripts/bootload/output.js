// 按字节流解码，保留跨读取块的 UTF-8 字符和未结束行；stdout、stderr 各用一个实例。
export class OutputCollector {
    constructor(onLine) {
        this.decoder = new TextDecoder("utf-8");
        this.pending = "";
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
        this.lines(this.decoder.decode(bytes, {stream: true}));
    }

    lines(text) {
        const lines = (this.pending + text).split(/[\r\n]/);
        this.pending = lines.pop();
        for (const line of lines) {
            if (line.trim() !== "") {
                this.onLine(line);
            }
        }
        // 原始日志始终完整保留；无换行的异常输出按块显示，限制内存中的单行长度。
        if (this.pending.length > 32768) {
            this.onLine(this.pending);
            this.pending = "";
        }
    }

    finish() {
        this.lines(this.decoder.decode());
        if (this.pending !== "") {
            this.onLine(this.pending);
            this.pending = "";
        }
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
        return new TextDecoder().decode(this.bytes());
    }
}

export function progressOf(line) {
    // 只识别 CLI 的 50 格进度条，错误日志中的百分号不能触发进度更新。
    const match = /^\[[█░]{50}\]\s*进度\s+(\d{1,3}(?:[.,]\d+)?)%\s*$/.exec(line.trim());
    if (!match) {
        return null;
    }
    const value = Number(match[1].replace(",", "."));
    return value >= 0 && value <= 100 ? value : null;
}
