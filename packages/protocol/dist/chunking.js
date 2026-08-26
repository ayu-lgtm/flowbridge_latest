/**
 * Chunking + checksum utilities shared by web app, extension, and server.
 * Everything here uses standard Web APIs (TextEncoder, crypto.subtle,
 * Blob/ArrayBuffer) so the same code runs unmodified in a browser tab, a
 * Manifest V3 offscreen document, and Node.js 20+ (which implements both).
 *
 * Default chunk size is 48 KiB pre-base64, which keeps each JSON envelope
 * comfortably under typical WebSocket/DataChannel message limits (DataChannel
 * default max message size can be as low as 64 KiB-256 KiB depending on
 * browser/negotiation) after base64 inflates it by ~33%.
 */
export const DEFAULT_CHUNK_SIZE_BYTES = 48 * 1024;
export function bytesToBase64(bytes) {
    // Chunk the conversion itself to avoid call-stack blowups on huge arrays
    // when using String.fromCharCode(...bytes) on very large inputs.
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        const slice = bytes.subarray(i, i + CHUNK);
        binary += String.fromCharCode(...slice);
    }
    if (typeof btoa === "function")
        return btoa(binary);
    // Node fallback
    return Buffer.from(bytes).toString("base64");
}
export function base64ToBytes(b64) {
    if (typeof atob === "function") {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++)
            bytes[i] = binary.charCodeAt(i);
        return bytes;
    }
    return new Uint8Array(Buffer.from(b64, "base64"));
}
export async function sha256Hex(data) {
    const subtle = (globalThis.crypto && globalThis.crypto.subtle) || undefined;
    if (subtle) {
        const digest = await subtle.digest("SHA-256", data.buffer);
        return Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    }
    // Node fallback (should not normally be hit since Node 20 exposes
    // globalThis.crypto.subtle, but kept for older runtimes)
    const nodeCrypto = await import("node:crypto");
    return nodeCrypto.createHash("sha256").update(data).digest("hex");
}
export function textToUtf8Bytes(text) {
    return new TextEncoder().encode(text);
}
export function utf8BytesToText(bytes) {
    // fatal:false keeps this resilient to a chunk boundary landing mid
    // multi-byte sequence being retried; we only decode after all chunks are
    // reassembled into one contiguous buffer, so boundaries are never an issue
    // at decode time.
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
export function planChunks(totalBytes, chunkSizeBytes = DEFAULT_CHUNK_SIZE_BYTES) {
    const chunkCount = Math.max(1, Math.ceil(totalBytes / chunkSizeBytes));
    return { chunkCount, chunkSizeBytes, totalBytes };
}
export function getChunk(bytes, index, chunkSizeBytes) {
    const start = index * chunkSizeBytes;
    const end = Math.min(start + chunkSizeBytes, bytes.length);
    return bytes.subarray(start, end);
}
/**
 * Reassembles chunks into one buffer. Chunks may arrive out of order (e.g.
 * after a retry round); this writes each chunk at its correct byte offset
 * regardless of arrival order, so nothing is lost or shifted.
 */
export class ChunkAssembler {
    constructor(totalBytes, chunkSizeBytes, chunkCount) {
        this.totalBytes = totalBytes;
        this.chunkSizeBytes = chunkSizeBytes;
        this.chunkCount = chunkCount;
        this.buffer = new Uint8Array(totalBytes);
        this.received = new Uint8Array(chunkCount);
    }
    addChunk(index, data) {
        if (index < 0 || index >= this.chunkCount)
            return;
        const offset = index * this.chunkSizeBytes;
        this.buffer.set(data, offset);
        this.received[index] = 1;
    }
    isComplete() {
        for (let i = 0; i < this.received.length; i++) {
            if (this.received[i] === 0)
                return false;
        }
        return true;
    }
    missingIndices() {
        const missing = [];
        for (let i = 0; i < this.received.length; i++) {
            if (this.received[i] === 0)
                missing.push(i);
        }
        return missing;
    }
    progress() {
        let received = 0;
        for (let i = 0; i < this.received.length; i++)
            received += this.received[i];
        return { received, total: this.chunkCount };
    }
    getBuffer() {
        return this.buffer;
    }
}
