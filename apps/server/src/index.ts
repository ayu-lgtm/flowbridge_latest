import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { FlowMessage, DeviceInfo } from "@flowbridge/protocol";
import { SessionStore, PAIRING_TTL_MS, type Room } from "./sessions.js";

const PORT = Number(process.env.PORT) || 8787;
const store = new SessionStore();

/**
 * Fixes a real data-loss bug: when one side's socket briefly drops (a page
 * refresh, a wifi blip, a laptop waking from sleep) its entry is removed
 * from `room.sockets` for the short window until it reconnects via
 * "pair:resume". Anything the OTHER device sends during that exact window
 * used to just vanish — `otherSocket()` returned undefined, the message was
 * never sent anywhere, and the sender's own UI still showed "done" because
 * its own socket/outbox was perfectly fine. This queues that message
 * instead of dropping it, keyed by (room code, the still-offline device's
 * id), and replays it the moment that device's socket reattaches.
 *
 * In-memory only, same as everything else in this server (see sessions.ts)
 * — a restart clears it, which is fine, since a restart also clears the
 * rooms these messages belong to.
 */
const pendingRelay = new Map<string, Map<string, FlowMessage[]>>(); // roomCode -> offlineDeviceId -> queued messages
const MAX_QUEUED_PER_DEVICE = 400; // mirrors the client-side outbox cap in connection.ts

function queueForOfflinePeer(room: Room, offlineDeviceId: string, msg: FlowMessage): void {
  let roomQueue = pendingRelay.get(room.code);
  if (!roomQueue) {
    roomQueue = new Map();
    pendingRelay.set(room.code, roomQueue);
  }
  let queue = roomQueue.get(offlineDeviceId);
  if (!queue) {
    queue = [];
    roomQueue.set(offlineDeviceId, queue);
  }
  queue.push(msg);
  if (queue.length > MAX_QUEUED_PER_DEVICE) {
    queue.shift(); // extremely unlikely — would mean minutes offline while actively receiving
  }
}

function flushQueuedFor(roomCode: string, deviceId: string, ws: WebSocket): void {
  const roomQueue = pendingRelay.get(roomCode);
  if (!roomQueue) return;
  const queue = roomQueue.get(deviceId);
  if (!queue || queue.length === 0) return;
  roomQueue.delete(deviceId);
  for (const m of queue) send(ws, m);
}
const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ server: httpServer });
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_ATTEMPTS = 20;
const pairingAttempts = new Map<string, { count: number; windowStart: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = pairingAttempts.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    pairingAttempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX_ATTEMPTS;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of pairingAttempts) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) pairingAttempts.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

interface ClientState {
  device?: DeviceInfo;
  code?: string;
}

const clientState = new WeakMap<WebSocket, ClientState>();

function send(ws: WebSocket, msg: FlowMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on("connection", (ws, req) => {
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  clientState.set(ws, {});

  ws.on("message", (raw) => {
    let msg: FlowMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const state = clientState.get(ws)!;

    if ((msg.type === "pair:hello" || msg.type === "pair:resume") && isRateLimited(ip)) {
      send(ws, {
        type: "pair:error",
        messageId: msg.messageId,
        originId: "server",
        ts: Date.now(),
        reason: "Too many pairing attempts from this network — please wait a minute and try again.",
      });
      return;
    }

    switch (msg.type) {
      case "pair:hello": {
        state.device = msg.device;

        if (!msg.code) {
          const room = store.createPairing(ws, msg.device);
          state.code = room.code;
          send(ws, {
            type: "pair:code",
            messageId: `${msg.messageId}-code`,
            originId: "server",
            ts: Date.now(),
            code: room.code,
            expiresInMs: PAIRING_TTL_MS,
          });
          return;
        }

        const room = store.claimPairing(msg.code.toUpperCase(), ws, msg.device);
        if (!room) {
          send(ws, {
            type: "pair:error",
            messageId: msg.messageId,
            originId: "server",
            ts: Date.now(),
            reason: "Invalid or expired pairing code.",
          });
          return;
        }
        state.code = room.code;

        const hostDeviceId = [...room.devices.keys()].find((id) => id !== msg.device.deviceId)!;
        const hostSocket = room.sockets.get(hostDeviceId)!;
        const hostDevice = room.devices.get(hostDeviceId)!;

        send(ws, {
          type: "pair:ok",
          messageId: msg.messageId,
          originId: "server",
          ts: Date.now(),
          sessionId: room.code,
          peer: hostDevice,
        });
        send(hostSocket, {
          type: "peer:joined",
          messageId: `${msg.messageId}-joined`,
          originId: "server",
          ts: Date.now(),
          sessionId: room.code,
          peer: msg.device,
        });
        return;
      }

      case "ping": {
        if (state.code) {
          const room = store.getRoom(state.code);
          if (room) store.touch(room);
        }
        send(ws, { type: "pong", messageId: msg.messageId, originId: "server", ts: Date.now() });
        return;
      }

      case "pair:resume": {
        state.device = msg.device;
        const code = msg.sessionId.toUpperCase();
        const result = store.resumeOrCreate(code, msg.device, ws);
        state.code = result.room.code;

        if (result.kind === "resumed") {
          send(ws, {
            type: "pair:resumed",
            messageId: msg.messageId,
            originId: "server",
            ts: Date.now(),
            sessionId: result.room.code,
            peer: result.peer,
          });
          // This device's socket is registered again as of resumeOrCreate()
          // above — deliver anything the peer sent while it was offline,
          // in the order it was sent, before anything new.
          flushQueuedFor(result.room.code, msg.device.deviceId, ws);
          const peerSocket = store.otherSocket(result.room, msg.device.deviceId);
          if (peerSocket) {
            send(peerSocket, {
              type: "peer:joined",
              messageId: `${msg.messageId}-rejoined`,
              originId: "server",
              ts: Date.now(),
              sessionId: result.room.code,
              peer: msg.device,
            });
          }
        } else {
          send(ws, {
            type: "pair:resume-waiting",
            messageId: msg.messageId,
            originId: "server",
            ts: Date.now(),
            sessionId: result.room.code,
          });
        }
        return;
      }

      default: {
        if (!state.code || !state.device) return;
        const room = store.getRoom(state.code);
        if (!room) return;
        store.touch(room);
        const other = store.otherSocket(room, state.device.deviceId);
        if (other) {
          send(other, msg);
        } else {
          // Peer is a known member of this room but has no live socket right
          // now (mid-refresh/reconnect) — queue instead of silently dropping
          // it. Delivered as soon as that device sends "pair:resume" again.
          const peerId = [...room.devices.keys()].find((id) => id !== state.device!.deviceId);
          if (peerId) queueForOfflinePeer(room, peerId, msg);
        }
        return;
      }
    }
  });

  ws.on("close", () => {
    const state = clientState.get(ws);
    if (state?.code && state.device) {
      const room = store.getRoom(state.code);
      if (room) {
        const other = store.otherSocket(room, state.device.deviceId);
        if (other) {
          send(other, {
            type: "peer:left",
            messageId: `left-${Date.now()}`,
            originId: "server",
            ts: Date.now(),
            sessionId: room.code,
          });
        }
        store.removeSocket(room, state.device.deviceId);
      }
    }
  });
});

setInterval(() => store.sweep(), 60_000).unref();

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`FlowBridge signaling/relay server listening on :${PORT}`);
});