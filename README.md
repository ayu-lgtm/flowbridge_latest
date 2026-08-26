# FlowBridge

Android ↔ Windows corporate-laptop clipboard & file bridge.
Two-way clipboard sync + chunked large text/file transfer, peer-to-peer over
WebRTC DataChannel with an encrypted WebSocket relay fallback for restrictive
corporate networks (Zscaler/proxy environments where WebRTC ICE cannot
establish a direct path).

See `/docs/ARCHITECTURE.md` for the full design and `/docs/SETUP.md` for
install, deploy and pairing instructions.

## Packages

- `packages/protocol` — shared TypeScript: message types, chunking, SHA-256
  checksums, loop-prevention metadata. Used by web app, extension, and server.
- `apps/server` — Node.js WebSocket signaling server. Also acts as an
  end-to-end-encrypted relay of opaque ciphertext chunks when direct P2P
  fails. Nothing is ever written to disk; everything lives in memory with a
  TTL and is deleted on pairing-session end or timeout.
- `apps/web` — React + Vite + TypeScript PWA. This is what you open on the
  Android phone (installable to home screen). Also loadable on desktop for
  testing.
- `apps/extension` — Chrome/Edge Manifest V3 extension for the Windows
  laptop. Popup UI + background service worker + offscreen document (needed
  because MV3 service workers cannot touch the clipboard or hold a
  WebRTC/DOM connection directly).

## Quick start (local dev)

```bash
npm install
npm run dev:server   # signaling + relay, defaults to :8787
npm run dev:web      # Vite dev server, defaults to :5173
```

Then load `apps/extension` as an unpacked extension in Chrome/Edge
(`chrome://extensions` → Developer mode → Load unpacked → select
`apps/extension/dist` after building it — see docs/SETUP.md).
