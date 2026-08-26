import {
  ChunkAssembler,
  base64ToBytes,
  bytesToBase64,
  getChunk,
  planChunks,
  sha256Hex,
  textToUtf8Bytes,
  utf8BytesToText,
} from "./chunking.js";
import type {
  AckMissingMessage,
  FileChunkMessage,
  FileEndMessage,
  FileStartMessage,
  FlowMessage,
  TextChunkMessage,
  TextEndMessage,
  TextStartMessage,
} from "./messages.js";

export type SendFn = (msg: FlowMessage) => void;

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Streams a large text string out as text:start / text:chunk* / text:end.
 * Never holds more than one chunk's worth of base64 string in flight beyond
 * the original UTF-8 buffer, and never sends the whole thing as one message.
 */
export async function sendText(
  text: string,
  originId: string,
  send: SendFn,
  chunkSizeBytes?: number
): Promise<string> {
  const bytes = textToUtf8Bytes(text);
  const hash = await sha256Hex(bytes);
  const plan = planChunks(bytes.length, chunkSizeBytes);
  const transferId = uuid();

  const start: TextStartMessage = {
    type: "text:start",
    messageId: uuid(),
    originId,
    ts: Date.now(),
    transferId,
    contentHash: hash,
    totalLength: bytes.length,
    chunkCount: plan.chunkCount,
    chunkSizeBytes: plan.chunkSizeBytes,
    encoding: "utf-8",
    newline: "auto",
  };
  send(start);

  for (let i = 0; i < plan.chunkCount; i++) {
    const chunk = getChunk(bytes, i, plan.chunkSizeBytes);
    const msg: TextChunkMessage = {
      type: "text:chunk",
      messageId: uuid(),
      originId,
      ts: Date.now(),
      transferId,
      index: i,
      data: bytesToBase64(chunk),
    };
    send(msg);
  }

  const end: TextEndMessage = {
    type: "text:end",
    messageId: uuid(),
    originId,
    ts: Date.now(),
    transferId,
  };
  send(end);

  return transferId;
}

/** Streams a File/Blob out as file:start / file:chunk* / file:end. */
export async function sendFile(
  file: Blob & { name?: string },
  originId: string,
  send: SendFn,
  chunkSizeBytes?: number,
  onProgress?: (sent: number, total: number) => void
): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const hash = await sha256Hex(buf);
  const plan = planChunks(buf.length, chunkSizeBytes);
  const transferId = uuid();
  const fileName = (file as any).name ?? "file.bin";
  const mimeType = (file as any).type || "application/octet-stream";

  const start: FileStartMessage = {
    type: "file:start",
    messageId: uuid(),
    originId,
    ts: Date.now(),
    transferId,
    fileName,
    fileSize: buf.length,
    mimeType,
    contentHash: hash,
    chunkCount: plan.chunkCount,
    chunkSizeBytes: plan.chunkSizeBytes,
  };
  send(start);

  for (let i = 0; i < plan.chunkCount; i++) {
    const chunk = getChunk(buf, i, plan.chunkSizeBytes);
    const msg: FileChunkMessage = {
      type: "file:chunk",
      messageId: uuid(),
      originId,
      ts: Date.now(),
      transferId,
      index: i,
      data: bytesToBase64(chunk),
    };
    send(msg);
    onProgress?.(Math.min((i + 1) * plan.chunkSizeBytes, buf.length), buf.length);
  }

  const end: FileEndMessage = {
    type: "file:end",
    messageId: uuid(),
    originId,
    ts: Date.now(),
    transferId,
  };
  send(end);

  return transferId;
}

interface InFlightText {
  assembler: ChunkAssembler;
  contentHash: string;
  originId: string;
}

interface InFlightFile {
  assembler: ChunkAssembler;
  contentHash: string;
  fileName: string;
  mimeType: string;
  originId: string;
}

// Retry tuning for chunk-loss recovery. Chunks most commonly go missing when
// the transport is torn down mid-transfer (P2P<->relay handover, a
// reconnect while the tab was backgrounded, etc.) — see FlowConnection's
// outbox, which fixes the "sent while fully disconnected" half of this;
// this handles the "sent but the channel died right as it arrived" half.
const RETRY_DELAYS_MS = [700, 1500, 3000, 5000, 8000];

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
export class TransferReceiver {
  private texts = new Map<string, InFlightText>();
  private files = new Map<string, InFlightFile>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private retryAttempts = new Map<string, number>();

  onTextComplete?: (text: string, meta: { transferId: string; originId: string }) => void;
  onFileComplete?: (
    bytes: Uint8Array,
    meta: { transferId: string; fileName: string; mimeType: string; originId: string }
  ) => void;
  onIntegrityFailure?: (transferId: string, kind: "text" | "file") => void;
  onProgress?: (transferId: string, kind: "text" | "file", received: number, total: number) => void;
  /** Ask the caller to send a text:ack-missing / file:ack-missing message for these indices. */
  onRequestMissing?: (transferId: string, kind: "text" | "file", missingIndices: number[]) => void;
  /** All retries exhausted — the transfer could not be completed. Caller should surface this to the user. */
  onTransferStalled?: (transferId: string, kind: "text" | "file") => void;

  handle(msg: FlowMessage): void {
    switch (msg.type) {
      case "text:start": {
        this.texts.set(msg.transferId, {
          assembler: new ChunkAssembler(msg.totalLength, msg.chunkSizeBytes, msg.chunkCount),
          contentHash: msg.contentHash,
          originId: msg.originId,
        });
        this.retryAttempts.delete(msg.transferId);
        break;
      }
      case "text:chunk": {
        const t = this.texts.get(msg.transferId);
        if (!t) return;
        t.assembler.addChunk(msg.index, base64ToBytes(msg.data));
        const p = t.assembler.progress();
        this.onProgress?.(msg.transferId, "text", p.received, p.total);
        break;
      }
      case "text:end": {
        const t = this.texts.get(msg.transferId);
        if (!t) return;
        this.finishText(msg.transferId, t);
        break;
      }
      case "file:start": {
        this.files.set(msg.transferId, {
          assembler: new ChunkAssembler(msg.fileSize, msg.chunkSizeBytes, msg.chunkCount),
          contentHash: msg.contentHash,
          fileName: msg.fileName,
          mimeType: msg.mimeType,
          originId: msg.originId,
        });
        this.retryAttempts.delete(msg.transferId);
        break;
      }
      case "file:chunk": {
        const f = this.files.get(msg.transferId);
        if (!f) return;
        f.assembler.addChunk(msg.index, base64ToBytes(msg.data));
        const p = f.assembler.progress();
        this.onProgress?.(msg.transferId, "file", p.received, p.total);
        break;
      }
      case "file:end": {
        const f = this.files.get(msg.transferId);
        if (!f) return;
        this.finishFile(msg.transferId, f);
        break;
      }
      default:
        break;
    }
  }

  /** Call after text:end / file:end if you want to request retransmission of missing chunks. */
  getMissingText(transferId: string): number[] | null {
    const t = this.texts.get(transferId);
    return t ? t.assembler.missingIndices() : null;
  }
  getMissingFile(transferId: string): number[] | null {
    const f = this.files.get(transferId);
    return f ? f.assembler.missingIndices() : null;
  }

  /** Stop all pending retry timers (e.g. on connection loss/teardown) without discarding partial data. */
  dispose(): void {
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private scheduleRetry(transferId: string, kind: "text" | "file") {
    const existing = this.retryTimers.get(transferId);
    if (existing) clearTimeout(existing);

    const attempt = this.retryAttempts.get(transferId) ?? 0;
    if (attempt >= RETRY_DELAYS_MS.length) {
      this.retryTimers.delete(transferId);
      if (kind === "text") this.texts.delete(transferId);
      else this.files.delete(transferId);
      this.onTransferStalled?.(transferId, kind);
      return;
    }

    const delay = RETRY_DELAYS_MS[attempt];
    this.retryAttempts.set(transferId, attempt + 1);
    const timer = setTimeout(() => {
      this.retryTimers.delete(transferId);
      const missing =
        kind === "text" ? this.getMissingText(transferId) : this.getMissingFile(transferId);
      if (!missing) return; // completed or dropped in the meantime
      if (missing.length === 0) return; // arrived on its own via a later chunk
      this.onRequestMissing?.(transferId, kind, missing);
      this.scheduleRetry(transferId, kind); // keep retrying until complete or exhausted
    }, delay);
    this.retryTimers.set(transferId, timer);
  }

  private clearRetry(transferId: string) {
    const timer = this.retryTimers.get(transferId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(transferId);
    this.retryAttempts.delete(transferId);
  }

  private async finishText(transferId: string, t: InFlightText): Promise<void> {
    if (!t.assembler.isComplete()) {
      // Don't just wait silently — actively ask the sender to resend what's
      // missing, on a short backoff, instead of leaving the transfer stuck
      // "in progress" forever (this was the silent-data-loss bug).
      this.scheduleRetry(transferId, "text");
      return;
    }
    this.clearRetry(transferId);
    const buf = t.assembler.getBuffer();
    const hash = await sha256Hex(buf);
    if (hash !== t.contentHash) {
      this.onIntegrityFailure?.(transferId, "text");
      return;
    }
    const text = utf8BytesToText(buf);
    this.texts.delete(transferId);
    this.onTextComplete?.(text, { transferId, originId: t.originId });
  }

  private async finishFile(transferId: string, f: InFlightFile): Promise<void> {
    if (!f.assembler.isComplete()) {
      this.scheduleRetry(transferId, "file");
      return;
    }
    this.clearRetry(transferId);
    const buf = f.assembler.getBuffer();
    const hash = await sha256Hex(buf);
    if (hash !== f.contentHash) {
      this.onIntegrityFailure?.(transferId, "file");
      return;
    }
    this.files.delete(transferId);
    this.onFileComplete?.(buf, {
      transferId,
      fileName: f.fileName,
      mimeType: f.mimeType,
      originId: f.originId,
    });
  }
}

interface CachedChunks {
  kind: "text" | "file";
  originId: string;
  chunks: Map<number, string>; // index -> base64 payload, as originally sent
  createdAt: number;
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
export class TransferSender {
  private cache = new Map<string, CachedChunks>();
  private static CACHE_TTL_MS = 5 * 60_000;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Guard against unbounded memory growth if a transfer's ack-missing
    // never arrives (peer went away entirely) — evict old entries.
    if (typeof setInterval !== "undefined") {
      this.sweepTimer = setInterval(() => this.sweep(), 60_000);
      (this.sweepTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.cache.clear();
  }

  async sendText(text: string, originId: string, send: SendFn, chunkSizeBytes?: number): Promise<string> {
    const chunks = new Map<number, string>();
    const transferId = await sendText(text, originId, this.tap(send, chunks), chunkSizeBytes);
    this.cache.set(transferId, { kind: "text", originId, chunks, createdAt: Date.now() });
    return transferId;
  }

  async sendFile(
    file: Blob & { name?: string },
    originId: string,
    send: SendFn,
    chunkSizeBytes?: number,
    onProgress?: (sent: number, total: number) => void
  ): Promise<string> {
    const chunks = new Map<number, string>();
    const transferId = await sendFile(file, originId, this.tap(send, chunks), chunkSizeBytes, onProgress);
    this.cache.set(transferId, { kind: "file", originId, chunks, createdAt: Date.now() });
    return transferId;
  }

  /** Feed every inbound FlowMessage through here too; it only reacts to ack-missing messages. */
  handleIncoming(msg: FlowMessage, send: SendFn): void {
    if (msg.type !== "text:ack-missing" && msg.type !== "file:ack-missing") return;
    const ack = msg as AckMissingMessage;
    const entry = this.cache.get(ack.transferId);
    if (!entry) return; // we no longer have this transfer cached — nothing we can do
    for (const index of ack.missingIndices) {
      const data = entry.chunks.get(index);
      if (data === undefined) continue;
      if (entry.kind === "text") {
        const chunk: TextChunkMessage = {
          type: "text:chunk",
          messageId: `resend-${ack.transferId}-${index}-${Date.now()}`,
          originId: entry.originId,
          ts: Date.now(),
          transferId: ack.transferId,
          index,
          data,
        };
        send(chunk);
      } else {
        const chunk: FileChunkMessage = {
          type: "file:chunk",
          messageId: `resend-${ack.transferId}-${index}-${Date.now()}`,
          originId: entry.originId,
          ts: Date.now(),
          transferId: ack.transferId,
          index,
          data,
        };
        send(chunk);
      }
    }
    // Re-send the end marker too, in case that (rather than a chunk) was
    // what got dropped, or the resent chunks complete the assembly.
    const end: FileEndMessage | TextEndMessage = {
      type: entry.kind === "text" ? "text:end" : "file:end",
      messageId: `resend-end-${ack.transferId}-${Date.now()}`,
      originId: entry.originId,
      ts: Date.now(),
      transferId: ack.transferId,
    } as FileEndMessage | TextEndMessage;
    send(end);
  }

  private tap(send: SendFn, chunks: Map<number, string>): SendFn {
    return (msg: FlowMessage) => {
      if (msg.type === "text:chunk" || msg.type === "file:chunk") {
        chunks.set(msg.index, msg.data);
      }
      send(msg);
    };
  }

  private sweep(): void {
    const cutoff = Date.now() - TransferSender.CACHE_TTL_MS;
    for (const [id, entry] of this.cache) {
      if (entry.createdAt < cutoff) this.cache.delete(id);
    }
  }
}

/** Build a text:ack-missing / file:ack-missing message to request retransmission. */
export function buildAckMissing(
  transferId: string,
  kind: "text" | "file",
  missingIndices: number[],
  originId: string
): AckMissingMessage {
  return {
    type: kind === "text" ? "text:ack-missing" : "file:ack-missing",
    messageId: `ack-${transferId}-${Date.now()}`,
    originId,
    ts: Date.now(),
    transferId,
    missingIndices,
  };
}
