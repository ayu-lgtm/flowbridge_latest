import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { FlowMessage, DeviceInfo } from "@flowbridge/protocol";
import { SessionStore, PAIRING_TTL_MS } from "./sessions.js";

const PORT = Number(process.env.PORT) || 8787;
const store = new SessionStore();
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
        if (other) send(other, msg);
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

