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
        // 交互式进度帧以百分号结束，不能等下一次 CR 或进程退出才上报。
        if (this.pending[this.pending.length - 1] === 37) {
            this.flushLine(true);
        }
    }

    flushLine(progressOnly = false) {
        if (this.pending.length === 0) {
            return;
        }
        const line = cli.decodeText(new Uint8Array(this.pending));
        if (progressOnly && progressOf(line) === null) {
            return;
        }
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
    // CLI 固定使用 50 格进度条；乱码可使每格变成多个字符，标签也可能损坏。
    // 只依赖进度条结构和行尾数值，排除普通日志、ASCII 文本和额外错误说明。
    const match = /^\[[?\u0080-\uFFFF]{50,256}\][ \t]+[^\s\d%\[\]]{1,16}[ \t]+(\d{1,3}(?:[.,]\d+)?)%[ \t]*$/.exec(line.trim());
    if (!match) {
        return null;
    }
    const value = Number(match[1].replace(",", "."));
    return value >= 0 && value <= 100 ? value : null;
}
