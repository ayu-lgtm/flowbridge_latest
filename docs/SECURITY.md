# Security & Privacy

## What this project does

- Transfers clipboard text and files between two devices you personally
  pair once with a random code. After that first pairing, the code becomes
  a **permanent** shared secret the two devices remember locally (so you
  never have to re-pair), transmitted over an encrypted connection
  (WebRTC DataChannel with DTLS-SRTP, or WSS/TLS relay fallback).
- Uses only standard, documented browser and Chrome-extension APIs:
  `navigator.clipboard`, the extension `clipboardRead`/`clipboardWrite`
  permissions, `RTCPeerConnection`/`RTCDataChannel`, and `WebSocket`.
- Stores nothing persistently server-side. The signaling/relay server keeps
  session state only in process memory with automatic expiry.

## What this project deliberately does NOT do

- It does not disable, evade, or interact with Zscaler, endpoint
  protection, DLP, or any corporate monitoring software.
- It does not require or use administrator privileges.
- It does not use hidden processes, background persistence outside the
  extension's declared lifecycle, or any technique designed to evade
  detection by IT.
- It does not exfiltrate data anywhere other than the two paired devices
  (and, only in relay fallback mode, transiently through the signaling
  server you deploy and control).
- If your corporate network or Chrome policy blocks outbound WebSocket
  connections, blocks unpacked-extension installation, or blocks
  `navigator.clipboard`, this tool will simply not work in that
  configuration — by design there is no fallback that attempts to route
  around such a restriction.

## Threat model notes

- **Pairing code interception & permanence:** the code is short (8 chars,
  ~39 bits of entropy) and, since first-time pairing, has always been
  guessable in principle by a determined attacker with server access — the
  original 5-minute expiry was the main defense against brute force. The
  code is now a **permanent** secret (see `apps/server/src/sessions.ts`),
  which is what makes re-pairing unnecessary, but it also means a leaked
  or brute-forced code is a standing risk, not a 5-minute one. Two
  mitigations are in place: (1) a per-IP rate limit on pairing attempts
  (`apps/server/src/index.ts`, `RATE_LIMIT_MAX_ATTEMPTS`) makes online
  brute force impractical; (2) the "third device joins an unclaimed slot"
  window — which only reopens if the relay server restarts/redeploys
  while one of your two devices is still offline — is what an attacker
  would need to hit, not an always-open door. If you need a stronger
  guarantee than this, lengthen `randomCode()`'s alphabet/length, and/or
  reduce `ABANDONED_ROOM_TTL_MS` (how long a one-sided "waiting" room is
  kept around after a restart) from its default of 30 days. Treat the
  code like you would a Wi-Fi password, not a one-time PIN: don't post it
  publicly, and tap "Forget this device" on both ends if you ever suspect
  it leaked (this immediately invalidates it for future resumes on this
  server instance).
- **Relay-mode confidentiality:** in P2P mode, the signaling server never
  sees clipboard/file content (only SDP/ICE). In relay fallback mode, the
  server *does* see the JSON envelopes in transit over TLS — it is not
  blind to content the way a true end-to-end-encrypted relay would be. If
  you need confidentiality guarantees even from a malicious/compromised
  relay operator, add an application-layer encryption step (e.g. derive a
  shared key from the pairing code via a key-exchange and AES-GCM-encrypt
  each chunk) before it hits `connection.send()` — the protocol's chunk
  `data` field is already an opaque base64 string, so this is a contained
  change in `packages/protocol/src/transfer.ts`.
- **Who can pair:** anyone who has the code (within the 5-minute window
  for a *fresh, never-claimed* code — see above for the permanent-code
  case) and can reach your signaling server can pair. Treat the code like
  a Wi-Fi password, not a one-time PIN — don't post it publicly.
- **Local storage of the pairing:** once claimed, the code is saved
  indefinitely in the browser's `localStorage` (web app) or
  `chrome.storage.local` (extension) on both devices so they can silently
  reconnect forever. Anyone with access to that browser profile/device can
  read it. This is the same trust level as any "remember this device"
  cookie or saved Wi-Fi password — reasonable for a personal
  laptop-to-phone bridge, not appropriate for a shared/kiosk machine.
- **Server operator trust:** since you (or your organization) deploy and
  control the signaling/relay server, this is generally a lower-risk trust
  boundary than a third-party SaaS — but it's still a trust boundary,
  documented here rather than glossed over.
