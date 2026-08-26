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
export declare const DEFAULT_CHUNK_SIZE_BYTES: number;
export declare function bytesToBase64(bytes: Uint8Array): string;
export declare function base64ToBytes(b64: string): Uint8Array;
export declare function sha256Hex(data: Uint8Array): Promise<string>;
export declare function textToUtf8Bytes(text: string): Uint8Array;
export declare function utf8BytesToText(bytes: Uint8Array): string;
export interface ChunkPlan {
    chunkCount: number;
    chunkSizeBytes: number;
    totalBytes: number;
}
export declare function planChunks(totalBytes: number, chunkSizeBytes?: number): ChunkPlan;
export declare function getChunk(bytes: Uint8Array, index: number, chunkSizeBytes: number): Uint8Array;
/**
 * Reassembles chunks into one buffer. Chunks may arrive out of order (e.g.
 * after a retry round); this writes each chunk at its correct byte offset
 * regardless of arrival order, so nothing is lost or shifted.
 */
export declare class ChunkAssembler {
    private buffer;
    private received;
    private chunkSizeBytes;
    chunkCount: number;
    totalBytes: number;
    constructor(totalBytes: number, chunkSizeBytes: number, chunkCount: number);
    addChunk(index: number, data: Uint8Array): void;
    isComplete(): boolean;
    missingIndices(): number[];
    progress(): {
        received: number;
        total: number;
    };
    getBuffer(): Uint8Array;
}
