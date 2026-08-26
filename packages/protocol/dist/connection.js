const RTC_CONFIG = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
    ],
};
// How long we give WebRTC ICE to connect before falling back to relaying
// every message over the signaling WebSocket instead. Corporate proxies
// (Zscaler etc.) frequently block UDP/STUN entirely, so this fallback is
// not an edge case — it is the expected path on many corporate networks.
const P2P_CONNECT_TIMEOUT_MS = 6000;
export class FlowConnection {
    constructor(serverUrl, device, events) {
        this.ws = null;
        this.pc = null;
        this.dc = null;
        this.sessionId = null; // the permanent pairing code, once known
        this.peer = null;
        this.transport = "none";
        this.isOfferer = false;
        this.reconnectAttempts = 0;
        this.manuallyClosed = false;
        this.pendingIce = [];
        this.heartbeatTimer = null;
        this.waitingRetryTimer = null;
        this.reconnectTimer = null;
        this.lastPongAt = Date.now();
        this.slowWakeWarned = false;
        this.lifecycleAttached = false;
        // Messages that could not go out immediately (mid-reconnect, mid P2P<->relay
        // handover, or a fresh dc/ws that hasn't opened yet) are buffered here
        // instead of being silently dropped. Flushed the moment we're "connected"
        // again over EITHER transport. This is what actually fixes clipboard/file
        // data loss across reconnects: previously `send()` just discarded anything
        // sent while neither channel was open.
        this.outbox = [];
        this.handleWake = () => {
            if (typeof document !== "undefined" && document.visibilityState === "hidden")
                return;
            this.forceReconnectNow();
        };
        this.serverUrl = serverUrl;
        this.device = device;
        this.events = events;
        this.attachLifecycleListeners();
    }
    /** Start a new pairing as the "host": server issues a short code to show/QR. */
    hostPairing() {
        this.manuallyClosed = false;
        this.connectSignaling(() => {
            this.setStatus("waiting-for-code");
            this.wsSend({
                type: "pair:hello",
                messageId: crypto.randomUUID(),
                originId: this.device.deviceId,
                ts: Date.now(),
                code: "",
                device: this.device,
            });
        });
    }
    /** Join an existing pairing using the code shown on the other device. */
    joinPairing(code) {
        this.manuallyClosed = false;
        this.connectSignaling(() => {
            this.setStatus("pairing");
            this.wsSend({
                type: "pair:hello",
                messageId: crypto.randomUUID(),
                originId: this.device.deviceId,
                ts: Date.now(),
                code: code.trim().toUpperCase(),
                device: this.device,
            });
        });
    }
    /** Rejoin a pairing we already completed once (saved locally). Safe to call any time the app starts. */
    resumeSession(sessionId, peer, isOfferer) {
        this.manuallyClosed = false;
        this.sessionId = sessionId;
        this.peer = peer;
        this.isOfferer = isOfferer;
        this.connectSignaling(() => {
            this.setStatus("connecting");
            this.sendResume();
        });
    }
    /** Explicit, user-initiated unpair. This is the ONLY path that should ever clear the saved pairing. */
    close() {
        this.manuallyClosed = true;
        this.stopHeartbeat();
        this.stopWaitingRetry();
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.dc?.close();
        this.pc?.close();
        this.ws?.close();
        this.dc = null;
        this.pc = null;
        this.ws = null;
        this.sessionId = null;
        this.peer = null;
        this.outbox = [];
        this.setStatus("idle");
        this.events.onSession?.(null);
    }
    /** Release lifecycle listeners. Call when the owning component unmounts (does NOT clear the pairing). */
    destroy() {
        this.detachLifecycleListeners();
        this.stopHeartbeat();
        this.stopWaitingRetry();
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.dc?.close();
        this.pc?.close();
        this.ws?.close();
    }
    /**
     * Send a protocol message over whichever transport is currently live.
     * If neither the DataChannel nor the signaling socket is open right now,
     * the message is queued (not dropped) and replayed automatically as soon
     * as we're back to "connected" — see flushOutbox().
     */
    send(msg) {
        if (this.dc && this.dc.readyState === "open") {
            try {
                this.dc.send(JSON.stringify(msg));
                return;
            }
            catch {
                // fall through to queueing below — channel was closing under us
            }
        }
        else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify(msg));
                return;
            }
            catch {
                // fall through to queueing below
            }
        }
        this.enqueue(msg);
    }
    enqueue(msg) {
        this.outbox.push(msg);
        if (this.outbox.length > FlowConnection.MAX_OUTBOX) {
            // Extremely unlikely (would mean minutes of continuous disconnection
            // while actively sending) but better to drop the oldest queued chunk
            // with a warning than to grow unbounded.
            this.outbox.shift();
            // eslint-disable-next-line no-console
            console.warn("FlowConnection: outbox overflow, dropping oldest queued message");
        }
    }
    flushOutbox() {
        if (this.outbox.length === 0)
            return;
        const pending = this.outbox;
        this.outbox = [];
        for (const msg of pending)
            this.send(msg);
    }
    getTransport() {
        return this.transport;
    }
    // ---- internals ----------------------------------------------------
    setStatus(status) {
        this.events.onStatus?.(status, this.transport);
        // Every path that reaches "connected" (fresh P2P open, relay fallback,
        // resumed session) should replay anything queued while we were down.
        if (status === "connected")
            this.flushOutbox();
    }
    wsSend(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }
    connectSignaling(onOpen) {
        const ws = new WebSocket(this.serverUrl);
        this.ws = ws;
        ws.onopen = () => {
            this.reconnectAttempts = 0;
            this.slowWakeWarned = false;
            this.startHeartbeat();
            onOpen();
        };
        ws.onmessage = (ev) => {
            let msg;
            try {
                msg = JSON.parse(ev.data);
            }
            catch {
                return;
            }
            this.handleSignalingMessage(msg);
        };
        ws.onclose = () => {
            this.stopHeartbeat();
            this.stopWaitingRetry();
            if (this.manuallyClosed)
                return;
            this.transport = "none";
            this.setStatus("disconnected");
            this.scheduleReconnect();
        };
        ws.onerror = () => {
            this.events.onError?.("Signaling connection error.");
        };
    }
    startHeartbeat() {
        this.stopHeartbeat();
        this.lastPongAt = Date.now();
        this.heartbeatTimer = setInterval(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
                return;
            // Many corporate proxies / mobile OSes silently kill WebSockets that
            // sit idle for ~60s. This app-level ping keeps the socket alive
            // through those, and doubles as a fast way to detect a connection
            // that LOOKS open but is actually dead (no pong for a while) so we
            // can force a reconnect instead of sitting in limbo.
            if (Date.now() - this.lastPongAt > FlowConnection.HEARTBEAT_TIMEOUT_MS) {
                this.ws.close();
                return;
            }
            this.wsSend({ type: "ping", messageId: crypto.randomUUID(), originId: this.device.deviceId, ts: Date.now() });
        }, FlowConnection.HEARTBEAT_INTERVAL_MS);
    }
    stopHeartbeat() {
        if (this.heartbeatTimer)
            clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }
    sendResume() {
        if (!this.sessionId)
            return;
        this.wsSend({
            type: "pair:resume",
            messageId: crypto.randomUUID(),
            originId: this.device.deviceId,
            ts: Date.now(),
            sessionId: this.sessionId,
            device: this.device,
        });
    }
    /** Server acknowledged our code but the peer hasn't reconnected yet — keep politely retrying, don't error out. */
    startWaitingRetry() {
        if (this.waitingRetryTimer)
            return;
        this.waitingRetryTimer = setInterval(() => {
            if (this.manuallyClosed) {
                this.stopWaitingRetry();
                return;
            }
            this.sendResume();
        }, 5000);
    }
    stopWaitingRetry() {
        if (this.waitingRetryTimer)
            clearInterval(this.waitingRetryTimer);
        this.waitingRetryTimer = null;
    }
    scheduleReconnect() {
        if (this.manuallyClosed || !this.sessionId)
            return;
        this.reconnectAttempts++;
        const delay = Math.min(1000 * 2 ** this.reconnectAttempts, FlowConnection.MAX_RECONNECT_DELAY_MS);
        const elapsed = this.reconnectAttempts * FlowConnection.MAX_RECONNECT_DELAY_MS; // rough lower bound
        if (!this.slowWakeWarned && elapsed >= FlowConnection.SLOW_WAKE_WARNING_AFTER_MS) {
            this.slowWakeWarned = true;
            // Informational only — status stays "disconnected"/reconnecting, we
            // never give up and force the user back to a fresh pairing screen.
            this.events.onError?.("Still trying to reconnect — if the server was asleep this can take up to a minute.");
        }
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            if (this.manuallyClosed)
                return;
            this.connectSignaling(() => {
                this.setStatus("connecting");
                this.sendResume();
            });
        }, delay);
    }
    /** Jump the reconnect queue right now instead of waiting out the backoff timer. Used on tab focus/online/pageshow. */
    forceReconnectNow() {
        if (this.manuallyClosed || !this.sessionId)
            return;
        if (this.ws && this.ws.readyState === WebSocket.OPEN)
            return; // already fine
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectAttempts = 0;
        this.connectSignaling(() => {
            this.setStatus("connecting");
            this.sendResume();
        });
    }
    /**
     * Mobile browsers throttle/suspend a background tab's JS timers, so a
     * dropped socket while backgrounded is often only noticed (and
     * reconnected) once the OS lets this tab run again. These listeners make
     * that moment — coming back to the app — trigger an IMMEDIATE reconnect
     * attempt instead of waiting out whatever backoff delay was already
     * queued, which is what made switching apps and coming back feel flaky.
     */
    attachLifecycleListeners() {
        if (this.lifecycleAttached)
            return;
        if (typeof document === "undefined" || typeof window === "undefined")
            return;
        this.lifecycleAttached = true;
        document.addEventListener("visibilitychange", this.handleWake);
        window.addEventListener("focus", this.handleWake);
        window.addEventListener("online", this.handleWake);
        window.addEventListener("pageshow", this.handleWake);
    }
    detachLifecycleListeners() {
        if (!this.lifecycleAttached)
            return;
        this.lifecycleAttached = false;
        document.removeEventListener("visibilitychange", this.handleWake);
        window.removeEventListener("focus", this.handleWake);
        window.removeEventListener("online", this.handleWake);
        window.removeEventListener("pageshow", this.handleWake);
    }
    handleSignalingMessage(msg) {
        switch (msg.type) {
            case "pair:code": {
                // Fixes a real bug: the host previously never recorded its own
                // sessionId here, so it could show a code but never persist/resume
                // its half of the pairing once the peer joined. The code IS the
                // permanent pairing key, so we track it from the moment it exists.
                this.sessionId = msg.code;
                this.events.onCode?.(msg.code, msg.expiresInMs);
                return;
            }
            case "pair:ok": {
                this.sessionId = msg.sessionId;
                if (msg.peer.deviceId)
                    this.peer = msg.peer;
                this.setStatus("connecting");
                // The device that CLAIMED the code (joiner) is the WebRTC offerer,
                // since it's the one that just learned the peer exists.
                this.isOfferer = !!msg.peer.deviceId;
                if (this.peer) {
                    this.events.onSession?.({ sessionId: this.sessionId, peer: this.peer, isOfferer: this.isOfferer });
                }
                if (this.isOfferer)
                    this.startP2p(true);
                return;
            }
            case "pair:error": {
                this.events.onError?.(msg.reason);
                this.setStatus("error");
                return;
            }
            case "pair:resumed": {
                this.stopWaitingRetry();
                this.reconnectAttempts = 0;
                this.sessionId = msg.sessionId;
                this.peer = msg.peer;
                this.events.onPeer?.(msg.peer);
                this.events.onSession?.({ sessionId: msg.sessionId, peer: msg.peer, isOfferer: this.isOfferer });
                this.transport = "relay";
                this.setStatus("connected");
                // Old peer connection (if any) is stale after a drop — start fresh.
                this.dc?.close();
                this.pc?.close();
                this.dc = null;
                this.pc = null;
                this.startP2p(this.isOfferer);
                return;
            }
            case "pair:resume-waiting": {
                // The server (re)made room for us under our saved code but the
                // peer hasn't shown up yet — e.g. right after a server restart.
                // This is NOT an error: keep the saved pairing, keep showing the
                // quiet "reconnecting" UI, and keep politely re-asking.
                this.sessionId = msg.sessionId;
                this.reconnectAttempts = 0;
                this.setStatus("disconnected");
                if (this.peer) {
                    this.events.onSession?.({ sessionId: this.sessionId, peer: this.peer, isOfferer: this.isOfferer });
                }
                this.startWaitingRetry();
                return;
            }
            case "pair:resume-failed": {
                // Reserved/defensive path — normal operation no longer sends this
                // (see PairResumeWaitingMessage), but if it ever arrives we still
                // must not silently strand the user: surface it without wiping
                // the saved pairing, so a manual retry can still work.
                this.events.onError?.(msg.reason);
                return;
            }
            case "pong": {
                this.lastPongAt = Date.now();
                return;
            }
            case "peer:joined": {
                this.stopWaitingRetry();
                this.peer = msg.peer;
                this.events.onPeer?.(msg.peer);
                if (this.sessionId) {
                    this.events.onSession?.({ sessionId: this.sessionId, peer: msg.peer, isOfferer: this.isOfferer });
                }
                this.setStatus("connecting");
                // Reset any stale peer connection from before the drop, then
                // (re)negotiate. Whichever side originally joined stays the
                // offerer so both ends agree on the same role after a resume.
                this.dc?.close();
                this.pc?.close();
                this.dc = null;
                this.pc = null;
                this.startP2p(this.isOfferer);
                return;
            }
            case "peer:left": {
                this.transport = "none";
                this.setStatus("disconnected");
                this.dc?.close();
                this.pc?.close();
                this.dc = null;
                this.pc = null;
                return;
            }
            case "signal:offer": {
                this.handleRemoteOffer(msg.sdp);
                return;
            }
            case "signal:answer": {
                this.pc?.setRemoteDescription({ type: "answer", sdp: msg.sdp }).catch(() => { });
                return;
            }
            case "signal:ice": {
                if (msg.candidate) {
                    const candidate = {
                        candidate: msg.candidate,
                        sdpMid: msg.sdpMid,
                        sdpMLineIndex: msg.sdpMLineIndex ?? undefined,
                    };
                    if (this.pc?.remoteDescription) {
                        this.pc.addIceCandidate(candidate).catch(() => { });
                    }
                    else {
                        this.pendingIce.push(candidate);
                    }
                }
                return;
            }
            default: {
                // Anything else (text:*, file:*, transfer:*) arriving over the
                // signaling socket means we're on the relay transport.
                if (this.transport !== "p2p")
                    this.transport = "relay";
                this.events.onMessage?.(msg);
                return;
            }
        }
    }
    startP2p(offerer) {
        if (this.pc)
            return; // already attempting
        const pc = new RTCPeerConnection(RTC_CONFIG);
        this.pc = pc;
        pc.onicecandidate = (ev) => {
            if (ev.candidate) {
                this.wsSend({
                    type: "signal:ice",
                    messageId: crypto.randomUUID(),
                    originId: this.device.deviceId,
                    ts: Date.now(),
                    sessionId: this.sessionId,
                    candidate: ev.candidate.candidate,
                    sdpMid: ev.candidate.sdpMid,
                    sdpMLineIndex: ev.candidate.sdpMLineIndex,
                });
            }
        };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === "connected") {
                this.transport = "p2p";
                this.setStatus("connected");
            }
            else if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
                if (this.transport === "p2p") {
                    // Fall back to relay rather than dropping the session.
                    this.transport = "relay";
                    this.setStatus("connected");
                }
            }
        };
        const fallbackTimer = setTimeout(() => {
            if (this.transport !== "p2p") {
                this.transport = "relay";
                this.setStatus("connected");
            }
        }, P2P_CONNECT_TIMEOUT_MS);
        if (offerer) {
            const dc = pc.createDataChannel("flowbridge", { ordered: true });
            this.attachDataChannel(dc);
            pc.createOffer()
                .then((offer) => pc.setLocalDescription(offer).then(() => offer))
                .then((offer) => {
                this.wsSend({
                    type: "signal:offer",
                    messageId: crypto.randomUUID(),
                    originId: this.device.deviceId,
                    ts: Date.now(),
                    sessionId: this.sessionId,
                    sdp: offer.sdp,
                });
            })
                .catch(() => clearTimeout(fallbackTimer));
        }
        else {
            pc.ondatachannel = (ev) => this.attachDataChannel(ev.channel);
        }
    }
    handleRemoteOffer(sdp) {
        if (!this.pc)
            this.startP2p(false);
        const pc = this.pc;
        pc.setRemoteDescription({ type: "offer", sdp })
            .then(async () => {
            for (const c of this.pendingIce.splice(0)) {
                await pc.addIceCandidate(c).catch(() => { });
            }
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.wsSend({
                type: "signal:answer",
                messageId: crypto.randomUUID(),
                originId: this.device.deviceId,
                ts: Date.now(),
                sessionId: this.sessionId,
                sdp: answer.sdp,
            });
        })
            .catch(() => { });
    }
    attachDataChannel(dc) {
        this.dc = dc;
        dc.binaryType = "arraybuffer";
        dc.onopen = () => {
            this.transport = "p2p";
            this.setStatus("connected");
        };
        dc.onclose = () => {
            if (this.transport === "p2p") {
                this.transport = "relay";
                this.setStatus("connected");
            }
        };
        dc.onmessage = (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                this.events.onMessage?.(msg);
            }
            catch {
                /* ignore malformed frame */
            }
        };
    }
}
FlowConnection.MAX_OUTBOX = 400; // ~25MB worst case at default chunk size
FlowConnection.HEARTBEAT_INTERVAL_MS = 20000;
FlowConnection.HEARTBEAT_TIMEOUT_MS = 45000;
// Free hosting tiers (Render's free plan etc.) commonly spin the server
// down after ~15 min idle and take up to ~60s to cold-start again on the
// next request. The backoff below is capped low enough to retry quickly
// at first, but we keep retrying INDEFINITELY (no attempt ceiling) as
// long as the tab/app stays open — a real "keeps disconnecting" bridge
// app should never just give up and dump the user back to a QR screen.
FlowConnection.MAX_RECONNECT_DELAY_MS = 20000;
FlowConnection.SLOW_WAKE_WARNING_AFTER_MS = 45000;
