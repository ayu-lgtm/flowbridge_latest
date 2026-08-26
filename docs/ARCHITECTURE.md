# Architecture

## Components

```
/apps
  /web         React + Vite + TS PWA — runs on the Android phone (and can
               run on desktop for testing). Installable to home screen.
  /extension   Chrome/Edge Manifest V3 extension — runs on the Windows
               laptop. background service worker + offscreen document +
               popup UI.
  /server      Node.js WebSocket signaling server. Also relays opaque
               protocol messages when a direct P2P connection cannot be
               established. Zero persistent storage.
/packages
  /protocol    Shared TypeScript: wire message types, chunking + SHA-256
               checksum utilities, loop-prevention, the FlowConnection
               (signaling + WebRTC + relay) class, and the sender/receiver
               transfer state machines. Imported by web, extension, and
               server so all three speak the exact same protocol.
```

## Connection flow

1. One device (usually the laptop, in the extension popup) taps **"Show
   pairing code"**. It opens a WebSocket to the signaling server and asks
   for a code. The server generates a random 8-character code
   (`82K9-XP4Q` style, ambiguous characters like `0/O/1/I` excluded) and a
   `sessionId`, and holds a *pending pairing slot* in memory for 5 minutes.
2. The other device enters that code. The server matches it to the pending
   slot, creates a `Session` containing both device sockets, and tells both
   sides `pair:ok` / `peer:joined`.
3. The device that just joined becomes the WebRTC **offerer**: it creates an
   `RTCPeerConnection`, opens a `DataChannel`, and sends an SDP offer through
   the signaling server (`signal:offer`). The other device answers
   (`signal:answer`); ICE candidates are exchanged the same way
   (`signal:ice`).
4. **If WebRTC connects within ~6 seconds** (`transport: "p2p"`), all further
   clipboard/file traffic goes directly device-to-device over the encrypted
   DataChannel. The signaling server sees nothing after this point except
   an occasional keepalive.
5. **If WebRTC cannot connect** (common on corporate networks where
   Zscaler/proxy/firewall blocks UDP or STUN) — after the timeout, both
   sides fall back to `transport: "relay"`: the exact same protocol
   messages are simply sent over the already-open, encrypted (WSS)
   signaling WebSocket instead of a DataChannel. The server forwards them
   verbatim between the two sockets without parsing, logging, or storing
   their content. The application layer above (clipboard sync, file
   transfer, chunking, checksums) is 100% identical in both modes — only
   the transport underneath changes.

## Clipboard sync

- **Android (web PWA):** there's no `clipboardchange` event in the standard
  Clipboard API, so the app checks the clipboard on meaningful triggers —
  the tab/PWA regaining focus (`visibilitychange`, `window.focus`) — plus a
  manual "Check clipboard now" button. It never polls in a tight loop.
  Writing to the clipboard requires a user gesture in most mobile browsers,
  so incoming text is written automatically when possible and a manual
  "Copy" fallback is shown if the browser blocks the automatic write.
- **Windows (extension):** MV3 extension pages (unlike regular web pages)
  can read/write the clipboard without a user gesture, given the
  `clipboardRead`/`clipboardWrite` permissions. Since there is still no
  native "clipboard changed" OS event exposed to extensions, the offscreen
  document polls on a deliberate 1.5-second interval (not a tight
  microsecond loop) purely to detect a *change*, and only sends a message
  when the hash actually differs from the last seen value.

## Loop prevention

Every transfer carries a `contentHash` (SHA-256 of the exact bytes). When a
device receives text/content from its peer and writes it into its own
clipboard, it registers that hash in a short-lived (`LoopGuard`) cache
*before* writing. Its own poll/focus-triggered clipboard check will then see
that exact hash and suppress re-broadcasting it — so Phone → Laptop → Phone
never loops. The guard entry expires after a few seconds, so genuinely
re-copying the same text later is not permanently blocked.

## Chunking & integrity

Large text or files are never sent as one message. `packages/protocol`
splits the UTF-8 byte buffer (for text) or `ArrayBuffer` (for files) into
48 KiB chunks, sends `*:start` (metadata + SHA-256 of the *whole* payload +
chunk count) → `*:chunk` × N → `*:end`. The receiver reassembles chunks at
their correct byte offset (so out-of-order arrival is handled), and only
after every chunk has arrived does it re-hash the reassembled buffer and
compare to the hash announced in `*:start`. A mismatch triggers an
integrity-failure event instead of silently accepting corrupted content.

Text is carried as raw UTF-8 bytes end-to-end — never decoded/re-encoded
mid-flight — so indentation, tabs, CRLF vs LF, and Unicode are byte-exact on
arrival. This was verified with a 50,000-line mixed-Unicode/CRLF test
during development (see `/docs/TESTING.md`).

## Security & privacy

- All signaling/relay traffic is WSS (TLS) in production; WebRTC
  DataChannels are natively encrypted (DTLS-SRTP) by the browser — this is
  not optional and cannot be disabled.
- The server never touches disk. Sessions and pending pairing codes are
  in-memory `Map`s with TTLs (5 min for unclaimed codes, 30 min idle
  timeout for active sessions); a process restart wipes everything. A
  dropped socket (sleep/lock/wifi blip) does *not* itself end a session —
  it has a 3-minute grace window to reconnect via `pair:resume` before
  being reaped, and a client-side heartbeat every 20s both keeps the
  socket alive through idle-timing-out proxies and refreshes the idle
  timer, so a session with a tab genuinely open in the foreground doesn't
  hit the 30-minute idle timeout at all.
- No account system, no passwords — pairing is a short-lived random code
  tied to a random `sessionId`.
- The server cannot read file/text content when acting purely as a WebRTC
  signaling relay (SDP/ICE only). When acting as the *data* relay fallback,
  it forwards opaque JSON envelopes without ever parsing their payload
  semantically or writing them anywhere persistent — but note this is **not
  end-to-end encrypted at the application layer**; it relies on TLS
  (WSS) for transport security between each client and the server. See
  `/docs/SECURITY.md` for the full threat-model notes and what this design
  does *not* attempt to do (e.g., it does not and must not bypass any
  corporate security control).
