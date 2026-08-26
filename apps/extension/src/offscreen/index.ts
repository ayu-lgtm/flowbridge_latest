import {
  FlowConnection,
  LoopGuard,
  TransferReceiver,
  TransferSender,
  buildAckMissing,
  type ConnectionStatus,
  type FlowMessage,
  type SessionInfo,
  type TransportKind,
} from "@flowbridge/protocol";
import { getDevice } from "../shared/device";
import { getServerUrl } from "../shared/config";
import { storageGet, storageRemove, storageSet } from "../shared/storage";
import { POLL_INTERVAL_MS, readClipboard, writeClipboard } from "./clipboard";

/**
 * Session persistence (extension side).
 *
 * The offscreen document is where the live connection actually lives, but
 * it is NOT guaranteed to survive forever: Chrome can and does recreate it
 * (browser restart, extension update/reload, the service worker waking up
 * fresh, occasional memory-pressure teardown). Every time that happens this
 * script re-runs from scratch and — without this — would have completely
 * forgotten which device it was paired with, forcing a brand new QR
 * scan/code entry even though the server-side session (see
 * apps/server/src/sessions.ts) is often still alive and resumable.
 *
 * chrome.storage.local (not .session) is used deliberately: unlike the web
 * app's sessionStorage-scoped-to-a-tab, we WANT this to survive the
 * offscreen document itself being torn down and recreated, since that is
 * the normal lifecycle here, not an edge case.
 */
const SESSION_KEY = "flowbridge.session";

async function saveSession(info: SessionInfo | null): Promise<void> {
  if (!info) {
    await storageRemove(SESSION_KEY);
    return;
  }
  await storageSet({ [SESSION_KEY]: info });
}

async function loadSession(): Promise<SessionInfo | null> {
  const res = await storageGet<Record<string, SessionInfo>>([SESSION_KEY]);
  return (res[SESSION_KEY] as SessionInfo) ?? null;
}

interface RuntimeState {
  status: ConnectionStatus;
  transport: TransportKind;
  code: string | null;
  peerLabel: string | null;
  error: string | null;
  lastReceivedChars: number | null;
  receivedFiles: Array<{ transferId: string; fileName: string; size: number; ts: number }>;
  activeTransfers: Array<{
    transferId: string;
    kind: "text" | "file";
    direction: "sending" | "receiving";
    label: string;
    pct: number;
    status: "in-progress" | "done" | "error";
  }>;
}

const state: RuntimeState = {
  status: "idle",
  transport: "none",
  code: null,
  peerLabel: null,
  error: null,
  lastReceivedChars: null,
  receivedFiles: [],
  activeTransfers: [],
};

const receiver = new TransferReceiver();
const sender = new TransferSender();
const loopGuard = new LoopGuard();
let connection: FlowConnection | null = null;
let lastClipboardHash = "";
let pollTimer: number | null = null;

// In-memory store of received file bytes so the popup can trigger a save
// via chrome.downloads without round-tripping large binary through
// extension messaging more than once.
const fileBlobs = new Map<string, Blob>();

function broadcastState() {
  chrome.runtime.sendMessage({ source: "offscreen", type: "status", payload: state }).catch(() => {});
}

async function simpleHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function upsertTransfer(t: RuntimeState["activeTransfers"][number]) {
  const idx = state.activeTransfers.findIndex((x) => x.transferId === t.transferId);
  if (idx >= 0) state.activeTransfers[idx] = t;
  else state.activeTransfers.unshift(t);
  state.activeTransfers = state.activeTransfers.slice(0, 20);
}

receiver.onProgress = (transferId, kind, received, total) => {
  const existing = state.activeTransfers.find((x) => x.transferId === transferId);
  upsertTransfer({
    transferId,
    kind,
    direction: "receiving",
    label: existing?.label ?? (kind === "text" ? "Clipboard text" : "File"),
    pct: total ? Math.round((received / total) * 100) : 0,
    status: "in-progress",
  });
  broadcastState();
};

receiver.onTextComplete = async (text, meta) => {
  loopGuard.registerIncoming(meta.transferId);
  const ok = await writeClipboard(text);
  lastClipboardHash = await simpleHash(text);
  state.lastReceivedChars = text.length;
  upsertTransfer({
    transferId: meta.transferId,
    kind: "text",
    direction: "receiving",
    label: "Clipboard text",
    pct: 100,
    status: ok ? "done" : "error",
  });
  broadcastState();
};

receiver.onFileComplete = (bytes, meta) => {
  const blob = new Blob([bytes.slice().buffer], { type: meta.mimeType || "application/octet-stream" });
  fileBlobs.set(meta.transferId, blob);
  state.receivedFiles.unshift({
    transferId: meta.transferId,
    fileName: meta.fileName,
    size: blob.size,
    ts: Date.now(),
  });
  upsertTransfer({
    transferId: meta.transferId,
    kind: "file",
    direction: "receiving",
    label: meta.fileName,
    pct: 100,
    status: "done",
  });
  broadcastState();
};

receiver.onIntegrityFailure = (transferId, kind) => {
  upsertTransfer({
    transferId,
    kind,
    direction: "receiving",
    label: "Transfer",
    pct: 0,
    status: "error",
  });
  broadcastState();
};

// A transfer that arrived incomplete (chunks dropped mid-reconnect, most
// commonly right when the browser/tab was backgrounded or switched) now
// actively asks the sender to resend exactly what's missing instead of
// silently hanging forever — this was the source of "copy-paste doesn't
// work properly" reports after a reconnect.
receiver.onRequestMissing = async (transferId, kind, missingIndices) => {
  if (!connection) return;
  const device = await getDevice();
  connection.send(buildAckMissing(transferId, kind, missingIndices, device.deviceId));
};

receiver.onTransferStalled = (transferId, kind) => {
  upsertTransfer({
    transferId,
    kind,
    direction: "receiving",
    label: "Transfer",
    pct: 0,
    status: "error",
  });
  broadcastState();
};

async function ensureConnection(): Promise<FlowConnection> {
  if (connection) return connection;
  const device = await getDevice();
  const url = await getServerUrl();
  connection = new FlowConnection(url, device, {
    onStatus: (s, t) => {
      state.status = s;
      state.transport = t;
      broadcastState();
      // Restart clipboard polling on ANY path that reaches "connected" —
      // fresh pairing, a resumed session, or a P2P<->relay transport
      // flip — not just the original host/join click. startClipboardPolling
      // is idempotent (guarded by pollTimer), so this is always safe.
      if (s === "connected") startClipboardPolling();
    },
    onCode: (c) => {
      state.code = c;
      broadcastState();
    },
    onPeer: (p) => {
      state.peerLabel = p.label;
      broadcastState();
    },
    onMessage: (msg: FlowMessage) => {
      receiver.handle(msg);
      sender.handleIncoming(msg, (m) => connection!.send(m));
    },
    onError: (m) => {
      state.error = m;
      broadcastState();
    },
    onSession: (info) => {
      saveSession(info);
    },
  });

  // If this offscreen document is a fresh instance (recreated after the
  // previous one was torn down) but we already had a live pairing, resume
  // it silently instead of sitting idle waiting for a new QR scan.
  const saved = await loadSession();
  if (saved) {
    state.status = "connecting";
    state.peerLabel = saved.peer.label;
    broadcastState();
    connection.resumeSession(saved.sessionId, saved.peer, saved.isOfferer);
  }

  return connection;
}

async function startClipboardPolling() {
  if (pollTimer !== null) return;
  const device = await getDevice();
  pollTimer = self.setInterval(async () => {
    if (!connection || state.status !== "connected") return;
    const text = await readClipboard();
    if (!text) return;
    const hash = await simpleHash(text);
    if (hash === lastClipboardHash) return;
    if (loopGuard.shouldSuppress(hash)) {
      lastClipboardHash = hash;
      return;
    }
    lastClipboardHash = hash;
    const transferId = crypto.randomUUID();
    upsertTransfer({
      transferId,
      kind: "text",
      direction: "sending",
      label: "Clipboard text",
      pct: 0,
      status: "in-progress",
    });
    broadcastState();
    await sender.sendText(text, device.deviceId, (m) => connection!.send(m));
    upsertTransfer({
      transferId,
      kind: "text",
      direction: "sending",
      label: "Clipboard text",
      pct: 100,
      status: "done",
    });
    broadcastState();
  }, POLL_INTERVAL_MS);
}

// ---- message handling from popup ----------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  (async () => {
    const conn = await ensureConnection();
    switch (message.type) {
      case "get-state":
        sendResponse(state);
        break;
      case "host-pairing":
        conn.hostPairing();
        startClipboardPolling();
        sendResponse({ ok: true });
        break;
      case "join-pairing":
        conn.joinPairing(message.code);
        startClipboardPolling();
        sendResponse({ ok: true });
        break;
      case "send-text": {
        const device = await getDevice();
        await sender.sendText(message.text, device.deviceId, (m) => conn.send(m));
        sendResponse({ ok: true });
        break;
      }
      case "send-file": {
        const device = await getDevice();
        // ArrayBuffer (not Blob) is used for the popup->offscreen hop:
        // ArrayBuffer structured-clones reliably across
        // chrome.runtime.sendMessage in all supported Chrome/Edge versions.
        const blob = new Blob([message.fileBuffer as ArrayBuffer]);
        const transferId = crypto.randomUUID();
        upsertTransfer({
          transferId,
          kind: "file",
          direction: "sending",
          label: message.fileName,
          pct: 0,
          status: "in-progress",
        });
        broadcastState();
        const namedBlob = Object.assign(blob, { name: message.fileName, type: message.fileType });
        await sender.sendFile(namedBlob, device.deviceId, (m) => conn.send(m), undefined, (sent, total) => {
          upsertTransfer({
            transferId,
            kind: "file",
            direction: "sending",
            label: message.fileName,
            pct: total ? Math.round((sent / total) * 100) : 0,
            status: "in-progress",
          });
          broadcastState();
        });
        upsertTransfer({
          transferId,
          kind: "file",
          direction: "sending",
          label: message.fileName,
          pct: 100,
          status: "done",
        });
        broadcastState();
        sendResponse({ ok: true });
        break;
      }
      case "save-file": {
        const blob = fileBlobs.get(message.transferId);
        if (blob) {
          const url = URL.createObjectURL(blob);
          const entry = state.receivedFiles.find((f) => f.transferId === message.transferId);
          chrome.downloads.download({ url, filename: entry?.fileName ?? "flowbridge-file", saveAs: false });
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
        }
        sendResponse({ ok: true });
        break;
      }
      case "check-clipboard-now": {
        const text = await readClipboard();
        sendResponse({ ok: true, hasText: !!text });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message type" });
    }
  })();

  return true; // keep sendResponse channel open for async work
});

ensureConnection();