import type { DeviceInfo, FlowMessage } from "./messages.js";
export type TransportKind = "p2p" | "relay" | "none";
export type ConnectionStatus = "idle" | "waiting-for-code" | "pairing" | "connecting" | "connected" | "disconnected" | "error";
export interface SessionInfo {
    sessionId: string;
    peer: DeviceInfo;
    isOfferer: boolean;
}
export interface ConnectionEvents {
    onStatus?: (status: ConnectionStatus, transport: TransportKind) => void;
    onCode?: (code: string, expiresInMs: number) => void;
    onPeer?: (peer: DeviceInfo) => void;
    onMessage?: (msg: FlowMessage) => void;
    onError?: (message: string) => void;
    /**
     * Fired with session details right after pairing succeeds (and again
     * after every successful resume), and with `null` only when the pairing
     * is truly gone — i.e. the user explicitly unpaired via close(). A
     * dropped socket, a server restart, or a "waiting for peer" resume state
     * NEVER fires this with `null`: the app layer persists this to
     * localStorage so the SAME pairing keeps working across full browser
     * restarts and server restarts alike, with no repeat QR scan.
     */
    onSession?: (info: SessionInfo | null) => void;
}
export declare class FlowConnection {
    private ws;
    private pc;
    private dc;
    private device;
    private serverUrl;
    private sessionId;
    private peer;
    private events;
    private transport;
    private isOfferer;
    private reconnectAttempts;
    private manuallyClosed;
    private pendingIce;
    private heartbeatTimer;
    private waitingRetryTimer;
    private reconnectTimer;
    private lastPongAt;
    private slowWakeWarned;
    private lifecycleAttached;
    private outbox;
    private static readonly MAX_OUTBOX;
    private static readonly HEARTBEAT_INTERVAL_MS;
    private static readonly HEARTBEAT_TIMEOUT_MS;
    private static readonly MAX_RECONNECT_DELAY_MS;
    private static readonly SLOW_WAKE_WARNING_AFTER_MS;
    constructor(serverUrl: string, device: DeviceInfo, events: ConnectionEvents);
    /** Start a new pairing as the "host": server issues a short code to show/QR. */
    hostPairing(): void;
    /** Join an existing pairing using the code shown on the other device. */
    joinPairing(code: string): void;
    /** Rejoin a pairing we already completed once (saved locally). Safe to call any time the app starts. */
    resumeSession(sessionId: string, peer: DeviceInfo, isOfferer: boolean): void;
    /** Explicit, user-initiated unpair. This is the ONLY path that should ever clear the saved pairing. */
    close(): void;
    /** Release lifecycle listeners. Call when the owning component unmounts (does NOT clear the pairing). */
    destroy(): void;
    /**
     * Send a protocol message over whichever transport is currently live.
     * If neither the DataChannel nor the signaling socket is open right now,
     * the message is queued (not dropped) and replayed automatically as soon
     * as we're back to "connected" — see flushOutbox().
     */
    send(msg: FlowMessage): void;
    private enqueue;
    private flushOutbox;
    getTransport(): TransportKind;
    private setStatus;
    private wsSend;
    private connectSignaling;
    private startHeartbeat;
    private stopHeartbeat;
    private sendResume;
    /** Server acknowledged our code but the peer hasn't reconnected yet — keep politely retrying, don't error out. */
    private startWaitingRetry;
    private stopWaitingRetry;
    private scheduleReconnect;
    /** Jump the reconnect queue right now instead of waiting out the backoff timer. Used on tab focus/online/pageshow. */
    private forceReconnectNow;
    /**
     * Mobile browsers throttle/suspend a background tab's JS timers, so a
     * dropped socket while backgrounded is often only noticed (and
     * reconnected) once the OS lets this tab run again. These listeners make
     * that moment — coming back to the app — trigger an IMMEDIATE reconnect
     * attempt instead of waiting out whatever backoff delay was already
     * queued, which is what made switching apps and coming back feel flaky.
     */
    private attachLifecycleListeners;
    private detachLifecycleListeners;
    private handleWake;
    private handleSignalingMessage;
    private startP2p;
    private handleRemoteOffer;
    private attachDataChannel;
}
