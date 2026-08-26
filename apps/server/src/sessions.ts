import type { WebSocket } from "ws";
import type { DeviceInfo } from "@flowbridge/protocol";

/**
 * FlowBridge treats a successful pairing as PERMANENT — like pairing a
 * Bluetooth device — instead of a short-lived "session" that expires after
 * a few minutes of trouble. The pairing code a user scans/enters ONCE
 * becomes a durable shared key that both devices remember locally forever
 * (see localStorage on the web app, chrome.storage.local on the extension)
 * and silently replay on every future reconnect via "pair:resume". There
 * is no repeat QR scan and no forced re-pair, ever, unless the user
 * explicitly forgets/unpairs on their own device.
 *
 * Nothing is ever persisted to DISK here either way — everything below is
 * an in-memory Map, exactly as before, for privacy (see docs/SECURITY.md).
 * If this process restarts (crash, redeploy, or a free host spinning down
 * after inactivity) it forgets every room instantly — but that is now
 * invisible to the user: whichever device reconnects first simply
 * recreates an (empty, waiting) room under the SAME code it already has
 * saved, and the other device's own automatic retry — which keeps
 * retrying on an interval, not just once — finds that room and completes
 * the pairing again with zero taps on either screen.
 */

export const PAIRING_TTL_MS = 5 * 60 * 1000; // a brand-new, never-scanned code expires in 5 min
export const ABANDONED_ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000; // hygiene only: wipe a claimed room after 30 days of total silence from BOTH sides

export interface Room {
  code: string;
  sockets: Map<string, WebSocket>; // deviceId -> socket (may be temporarily empty for either/both devices)
  devices: Map<string, DeviceInfo>;
  lastActivity: number;
  createdAt: number;
  claimed: boolean; // true once a second, distinct device has joined at least once
  // "fresh": created via a brand-new pair:hello, shown as a QR/code nobody has
  //   memorized yet — expires quickly (PAIRING_TTL_MS) if never claimed.
  // "resumed": re-created because the server had forgotten a previously-claimed
  //   code (e.g. restart) — the device presenting it already has it saved
  //   permanently, so we wait patiently (ABANDONED_ROOM_TTL_MS) for the peer.
  origin: "fresh" | "resumed";
}

export type ResumeResult = { kind: "resumed"; room: Room; peer: DeviceInfo } | { kind: "waiting"; room: Room };

function randomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity
  const part = () =>
    Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  return `${part()}-${part()}`;
}

export class SessionStore {
  private rooms = new Map<string, Room>(); // code -> room (both "waiting for 2nd device" and "fully paired" rooms live here)

  /** Host starts a brand-new pairing: generates a fresh, never-before-used code. */
  createPairing(host: WebSocket, hostDevice: DeviceInfo): Room {
    let code = randomCode();
    while (this.rooms.has(code)) code = randomCode();
    const room: Room = {
      code,
      sockets: new Map([[hostDevice.deviceId, host]]),
      devices: new Map([[hostDevice.deviceId, hostDevice]]),
      lastActivity: Date.now(),
      createdAt: Date.now(),
      claimed: false,
      origin: "fresh",
    };
    this.rooms.set(code, room);
    return room;
  }

  /** First-time claim of a code shown/scanned from the other device. */
  claimPairing(code: string, guest: WebSocket, guestDevice: DeviceInfo): Room | null {
    const room = this.rooms.get(code);
    if (!room) return null;
    if (!room.claimed && room.origin === "fresh" && Date.now() - room.createdAt > PAIRING_TTL_MS) {
      this.rooms.delete(code);
      return null;
    }
    if (room.devices.has(guestDevice.deviceId)) return null; // can't pair a device with itself
    if (room.devices.size >= 2) return null; // already fully paired with someone else

    room.sockets.set(guestDevice.deviceId, guest);
    room.devices.set(guestDevice.deviceId, guestDevice);
    room.claimed = true;
    room.lastActivity = Date.now();
    return room;
  }

  /**
   * A device asks to resume a code it already has saved permanently. This
   * NEVER hard-fails: either the room is still around (instant reconnect)
   * or we transparently recreate it and wait for the peer to also retry
   * the same saved code, which it will, on its own.
   */
  resumeOrCreate(code: string, device: DeviceInfo, ws: WebSocket): ResumeResult {
    let room = this.rooms.get(code);

    if (!room) {
      room = {
        code,
        sockets: new Map([[device.deviceId, ws]]),
        devices: new Map([[device.deviceId, device]]),
        lastActivity: Date.now(),
        createdAt: Date.now(),
        claimed: false,
        origin: "resumed",
      };
      this.rooms.set(code, room);
      return { kind: "waiting", room };
    }

    room.lastActivity = Date.now();

    // Already-known member reconnecting: just reattach its socket.
    if (room.devices.has(device.deviceId)) {
      room.sockets.set(device.deviceId, ws);
      room.devices.set(device.deviceId, device); // refresh label etc.
      const peerId = [...room.devices.keys()].find((id) => id !== device.deviceId);
      if (peerId && room.devices.get(peerId)) {
        return { kind: "resumed", room, peer: room.devices.get(peerId)! };
      }
      return { kind: "waiting", room };
    }

    // A NEW deviceId presenting a code we already have a waiting slot for
    // — this is the peer coming back and completing the pairing again.
    if (room.devices.size < 2) {
      room.sockets.set(device.deviceId, ws);
      room.devices.set(device.deviceId, device);
      room.claimed = true;
      const peerId = [...room.devices.keys()].find((id) => id !== device.deviceId)!;
      return { kind: "resumed", room, peer: room.devices.get(peerId)! };
    }

    // Room already fully occupied by two OTHER devices — extremely
    // unlikely. Don't dead-end the caller with an error; just wait.
    return { kind: "waiting", room };
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  /** A device's socket closed. The room (and its device roster) is kept forever — see class docs. */
  removeSocket(room: Room, deviceId: string): void {
    room.sockets.delete(deviceId);
  }

  otherSocket(room: Room, selfDeviceId: string): WebSocket | undefined {
    for (const [deviceId, sock] of room.sockets) {
      if (deviceId !== selfDeviceId) return sock;
    }
    return undefined;
  }

  touch(room: Room): void {
    room.lastActivity = Date.now();
  }

  /** Periodic hygiene sweep: expired never-claimed codes + truly abandoned rooms. Call on an interval. */
  sweep(): void {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const neverClaimedInTime = !room.claimed && room.origin === "fresh" && now - room.createdAt > PAIRING_TTL_MS;
      const abandonedTooLong = now - room.lastActivity > ABANDONED_ROOM_TTL_MS;
      if (neverClaimedInTime || abandonedTooLong) {
        for (const sock of room.sockets.values()) {
          try {
            sock.close(4000, "session-expired");
          } catch {
            /* noop */
          }
        }
        this.rooms.delete(code);
      }
    }
  }
}
