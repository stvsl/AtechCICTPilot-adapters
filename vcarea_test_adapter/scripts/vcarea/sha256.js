/* 纯 JavaScript SHA-256（FIPS 180-4）实现。
 *
 * QuickJS 运行时不提供 crypto/hash 能力，而 VCarEA 报告下载应答包含
 * FileHashCode（实测为组包 ZIP 的 SHA-256）；实现最小可用的 SHA-256，
 * 供报告完整性校验使用。
 */

/** SHA-256 轮常量（FIPS 180-4 4.2.2）。 */
const K = Object.freeze([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value, count) {
    return ((value >>> count) | (value << (32 - count))) >>> 0;
}

/** 计算字节序列的 SHA-256 小写十六进制摘要。 */
export function sha256Hex(bytes) {
    const data = bytes instanceof Uint8Array
        ? bytes : new Uint8Array(bytes);
    // 填充：附加 0x80 与 64 位大端比特长度，补齐到 64 字节块。
    const total = Math.ceil((data.length + 9) / 64) * 64;
    const buffer = new Uint8Array(total);
    buffer.set(data);
    buffer[data.length] = 0x80;
    const view = new DataView(buffer.buffer);
    const bitLength = data.length * 8;
    view.setUint32(total - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(total - 4, bitLength % 0x100000000);

    const state = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const schedule = new Uint32Array(64);

    for (let offset = 0; offset < total; offset += 64) {
        for (let index = 0; index < 16; ++index) {
            schedule[index] = view.getUint32(offset + index * 4);
        }
        for (let index = 16; index < 64; ++index) {
            const x = schedule[index - 15];
            const y = schedule[index - 2];
            const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
            const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
            schedule[index] = (schedule[index - 16] + s0
                + schedule[index - 7] + s1) >>> 0;
        }
        let a = state[0];
        let b = state[1];
        let c = state[2];
        let d = state[3];
        let e = state[4];
        let f = state[5];
        let g = state[6];
        let h = state[7];
        for (let index = 0; index < 64; ++index) {
            const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + s1 + ch + K[index] + schedule[index]) >>> 0;
            const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (s0 + maj) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }
        state[0] = (state[0] + a) >>> 0;
        state[1] = (state[1] + b) >>> 0;
        state[2] = (state[2] + c) >>> 0;
        state[3] = (state[3] + d) >>> 0;
        state[4] = (state[4] + e) >>> 0;
        state[5] = (state[5] + f) >>> 0;
        state[6] = (state[6] + g) >>> 0;
        state[7] = (state[7] + h) >>> 0;
    }
    let digest = "";
    for (const value of state) {
        digest += value.toString(16).padStart(8, "0");
    }
    return digest;
}
