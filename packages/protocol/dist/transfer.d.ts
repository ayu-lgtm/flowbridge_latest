import type { AckMissingMessage, FlowMessage } from "./messages.js";
export type SendFn = (msg: FlowMessage) => void;
/**
 * Streams a large text string out as text:start / text:chunk* / text:end.
 * Never holds more than one chunk's worth of base64 string in flight beyond
 * the original UTF-8 buffer, and never sends the whole thing as one message.
 */
export declare function sendText(text: string, originId: string, send: SendFn, chunkSizeBytes?: number): Promise<string>;
/** Streams a File/Blob out as file:start / file:chunk* / file:end. */
export declare function sendFile(file: Blob & {
    name?: string;
}, originId: string, send: SendFn, chunkSizeBytes?: number, onProgress?: (sent: number, total: number) => void): Promise<string>;
/**
 * Receiver-side state machine. Feed it every inbound FlowMessage; it calls
 * back when a text or file transfer completes (after checksum verification)
 * or fails integrity, and reports live progress for the UI.
 *
 * If a `text:end`/`file:end` arrives but chunks are still missing (dropped
 * mid-transfer), this does NOT just sit there forever: it asks the caller to
 * request retransmission (`onRequestMissing`) on a short backoff schedule,
 * and only gives up (`onTransferStalled`) after several attempts.
 */
export declare class TransferReceiver {
    private texts;
    private files;
    private retryTimers;
    private retryAttempts;
    onTextComplete?: (text: string, meta: {
        transferId: string;
        originId: string;
    }) => void;
    onFileComplete?: (bytes: Uint8Array, meta: {
        transferId: string;
        fileName: string;
        mimeType: string;
        originId: string;
    }) => void;
    onIntegrityFailure?: (transferId: string, kind: "text" | "file") => void;
    onProgress?: (transferId: string, kind: "text" | "file", received: number, total: number) => void;
    /** Ask the caller to send a text:ack-missing / file:ack-missing message for these indices. */
    onRequestMissing?: (transferId: string, kind: "text" | "file", missingIndices: number[]) => void;
    /** All retries exhausted — the transfer could not be completed. Caller should surface this to the user. */
    onTransferStalled?: (transferId: string, kind: "text" | "file") => void;
    handle(msg: FlowMessage): void;
    /** Call after text:end / file:end if you want to request retransmission of missing chunks. */
    getMissingText(transferId: string): number[] | null;
    getMissingFile(transferId: string): number[] | null;
    /** Stop all pending retry timers (e.g. on connection loss/teardown) without discarding partial data. */
    dispose(): void;
    private scheduleRetry;
    private clearRetry;
    private finishText;
    private finishFile;
}
/**
 * Sender-side companion to TransferReceiver. Wraps sendText/sendFile so
 * every chunk it emits is also kept in a short-lived cache, and handles
 * incoming `text:ack-missing` / `file:ack-missing` requests by resending
 * exactly the requested chunks from that cache. Without this, the
 * `onRequestMissing` callback on the receiving end had nothing to talk to —
 * the missing-chunk protocol messages existed but nothing ever answered
 * them, so a dropped chunk meant the transfer never finished.
 */
export declare class TransferSender {
    private cache;
    private static CACHE_TTL_MS;
    private sweepTimer;
    constructor();
    dispose(): void;
    sendText(text: string, originId: string, send: SendFn, chunkSizeBytes?: number): Promise<string>;
    sendFile(file: Blob & {
        name?: string;
    }, originId: string, send: SendFn, chunkSizeBytes?: number, onProgress?: (sent: number, total: number) => void): Promise<string>;
    /** Feed every inbound FlowMessage through here too; it only reacts to ack-missing messages. */
    handleIncoming(msg: FlowMessage, send: SendFn): void;
    private tap;
    private sweep;
}
/** Build a text:ack-missing / file:ack-missing message to request retransmission. */
export declare function buildAckMissing(transferId: string, kind: "text" | "file", missingIndices: number[], originId: string): AckMissingMessage;
