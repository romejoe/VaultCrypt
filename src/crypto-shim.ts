// Shim for Node.js `crypto` module in browser/mobile environments.
// kdbxweb imports this module but uses Web Crypto API (globalThis.crypto.subtle)
// as its primary crypto engine — these Node.js-style exports are unreachable
// fallbacks that exist only to satisfy the static import at module load time.

export function randomBytes(size: number): Uint8Array {
    const buf = new Uint8Array(size);
    globalThis.crypto.getRandomValues(buf);
    return buf;
}

const notSupported = (): never => {
    throw new Error('Node.js crypto not available in this environment');
};

export const createHash = notSupported;
export const createHmac = notSupported;
export const createCipheriv = notSupported;
export const createDecipheriv = notSupported;

export default { randomBytes, createHash, createHmac, createCipheriv, createDecipheriv };
