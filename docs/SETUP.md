# Setup & Deployment

## Which app goes on which device?

- **Windows/Mac laptop → install the Chrome/Edge extension** (`apps/extension`,
  §4 below), not just the website in a normal tab. This matters: the
  extension writes incoming text straight to your **system clipboard** via
  a background "offscreen document," which works even while Chrome is
  minimized or a different app has focus — so a `Ctrl+V` in VS Code (or
  anywhere else) picks it up immediately, without ever opening the browser
  tab. A plain browser tab **cannot** do this: `navigator.clipboard`
  requires the tab to actually have focus, by browser design (it's a
  security restriction, not a bug here) — so if you just open the website
  in a normal tab and minimize it, the write silently fails until you
  click back into that tab.
- **Android phone → the web app / PWA** (`apps/web`, §2 below). Phones
  don't support installing this kind of browser extension, and modern
  Android itself (10+) blocks background clipboard access for any app,
  website or native — so on the phone side, bringing the app to the
  foreground for a moment really is the only way, on any tool, not just
  this one.

## 1. Local development

```bash
npm install
npm run build:protocol     # build the shared package once
npm run dev:server         # signaling/relay server on :8787
npm run dev:web            # Vite dev server on :5173 (open on your phone
                            # via your laptop's LAN IP, e.g. http://192.168.x.x:5173,
                            # for a real local test)
```

For the extension in dev mode:
```bash
npm run build:extension    # or: cd apps/extension && npm run dev (watch mode)
```
Then load `apps/extension/dist` as an unpacked extension (step 3 below).

## 2. Netlify deployment (web app / PWA)

The repo root already has a `netlify.toml`:

```toml
[build]
  command = "npm install && npm run build:protocol && npm run build:web"
  publish = "apps/web/dist"
```

Steps:
1. Push this repo to GitHub/GitLab/Bitbucket, or drag-and-drop deploy the
   zip on Netlify's "Deploy manually" screen.
2. In Netlify → Site settings → Environment variables, add:
   `VITE_SIGNALING_URL = wss://<your-signaling-server-domain>`
3. Deploy. Netlify will run the build command above and publish
   `apps/web/dist`.
4. Open the resulting `https://<your-site>.netlify.app` URL on your Android
   phone → menu → "Add to Home screen" to install it as a PWA.

**Without an env var set**, the app falls back to `ws://localhost:8787`,
which will not work from your phone — you must set `VITE_SIGNALING_URL` to
your deployed signaling server before it's usable end-to-end.

## 3. Signaling/relay server deployment — Render (free, no credit card)

The server is a plain Node.js process (`apps/server`) with **one**
dependency (`ws`) and no database.

**Render's free web-service tier needs no credit card at all** — this is
why it's the recommendation here over Fly.io (Fly now requires a card on
file even for its free allowance). The one real trade-off: Render's free
tier spins the process down after ~15 minutes with no traffic, and the
*next* request after that takes roughly 30-60s to wake it back up (a "cold
start"). Earlier versions of this app made that trade-off painful, because
a cold start (or any restart) wiped the in-memory pairing and forced a
brand-new QR scan. **That's fixed now** (see `apps/server/src/sessions.ts`):
pairing is permanent and keyed by the same code both devices already
remember locally, so a cold start now just means "reconnect banner for up
to a minute," never "scan a new QR code."

### Option A — Blueprint (one click, recommended)

This repo includes `render.yaml` at the root.

1. Push this repo to GitHub (a plain public or private repo both work).
2. Go to [dashboard.render.com](https://dashboard.render.com) → sign up
   with GitHub (no card requested) → **New** → **Blueprint**.
3. Pick your repo. Render reads `render.yaml` and shows one service,
   `flowbridge-relay`, on the **Free** plan → **Apply**.
4. Wait for the first build/deploy (a few minutes). Your relay URL will be
   `wss://flowbridge-relay-<random>.onrender.com` (Render gives you TLS
   automatically — check the exact hostname on the service's dashboard
   page).

### Option B — Manual "New Web Service" (if you'd rather not use a Blueprint)

1. On the Render dashboard → **New** → **Web Service** → connect this repo.
2. **Runtime:** Docker. **Dockerfile path:** `apps/server/Dockerfile`.
   **Docker build context directory:** `.` (repo root — the Dockerfile
   needs the sibling `packages/protocol` workspace too).
3. **Plan:** Free.
4. **Health check path:** `/health`.
5. Create → wait for the build to finish.

Check it's alive any time: `https://<your-service>.onrender.com/health` →
`{"ok":true}`.

### Optional: reduce cold starts

Render's free tier will still sleep after 15 minutes of *zero* requests.
An external ping every ~10 minutes keeps it awake far more often, and both
of these are free and need no card:
- [UptimeRobot](https://uptimerobot.com) free plan → add an HTTP(s)
  monitor for `https://<your-service>.onrender.com/health` every 5-10 min.
- Or a scheduled GitHub Actions workflow in your own repo that just
  `curl`s that same URL on a cron.

This is a nice-to-have, not a requirement — even with zero keep-alive,
the worst case is a "reconnecting…" banner for under a minute, never a
lost pairing.

**Alternatives**, if you'd rather not use Render:
- **Fly.io** — a genuinely always-on free VM, but now requires a credit
  card on file even to stay on the free allowance. This repo still ships
  `apps/server/fly.toml` if you go this route:
  ```bash
  curl -L https://fly.io/install.sh | sh
  fly auth signup
  fly launch --config apps/server/fly.toml --dockerfile apps/server/Dockerfile --no-deploy
  fly deploy --config apps/server/fly.toml --dockerfile apps/server/Dockerfile
  ```
- **A cheap always-on VPS** (Hetzner/DigitalOcean/Contabo, ~$4-6/mo) +
  Caddy for automatic HTTPS/WSS — most predictable, nothing ever sleeps.
- **Railway** — usage-based free trial credits, budget ~$1-5/mo after they
  run out.

Whichever host, the public URL **must** use `wss://` (TLS) — plain `ws://`
is blocked by browsers calling it from an `https://` PWA (mixed-content)
and isn't secure over a corporate network anyway.

## 4. Chrome/Edge extension installation (Windows laptop)

```bash
npm run build:protocol
npm run build:extension
```

This produces `apps/extension/dist/`. Then:

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** → select the `apps/extension/dist` folder.
4. Pin the FlowBridge icon to your toolbar.
5. Click it → **"Signaling server settings"** → paste the
   `wss://<your-signaling-server-domain>` you configured for Netlify above,
   and also the `https://<your-netlify-site>.netlify.app` web app URL (used
   to build the QR code's deep link) → Save.

> Corporate note: "Load unpacked" / Developer mode may itself be restricted
> by your organization's Chrome policy (`ExtensionInstallSources` /
> `DeveloperToolsAvailability`). If it's blocked, you do **not** have a way
> to install this extension without administrator/IT approval — that is a
> deliberate, expected outcome of corporate device management, not
> something this project attempts to work around. Ask IT to allow the
> extension via your organization's approved extension allowlist, or to
> publish it internally via the Chrome Web Store's private/enterprise
> distribution.

## 5. Pairing instructions

**Fastest way (QR code):**
1. On the laptop, open the extension popup → **"Show pairing code"**. A QR
   code and a fallback text code (e.g. `82K9-XP4Q`) both appear.
2. On the phone, open the FlowBridge PWA → tap **"Scan QR code"** (or just
   point your phone's regular camera app at the laptop screen — most
   Android phones recognize the QR and offer to open the link directly,
   which lands you in FlowBridge already paired, no typing at all).
3. Either device can be the one that shows the code — tap "Show pairing
   code / QR" on whichever device is more convenient to read from, and
   scan with the other.

**Manual fallback:** if camera access isn't available, type the 8-character
code shown under the QR into the other device's "Enter code" box. There's
also a **"Share link instead"** button next to the code (on devices that
support the native share sheet) — useful if you'd rather send the pairing
link via WhatsApp/Telegram/etc. than scan or type anything.

Both sides show **Connected** within a few seconds, along with whether
the link is **Direct (P2P)** or **Relay** (see architecture doc — relay
is expected and fine on restrictive networks).

Copy text on either device; it should appear on the other automatically
(or via "Check clipboard now" / manual paste box if auto-read is
blocked by a permission prompt).

Pairing codes only expire after 5 minutes **if nobody ever claims them**
(i.e. you generated a QR and never scanned it anywhere). Once a second
device actually claims the code, that code becomes a **permanent** shared
key — like pairing a Bluetooth device — and this is not affected by the
`PAIRING_TTL_MS` value in the server config:

- The connection sends a small heartbeat every 20s so it survives the
  idle-websocket timeouts that corporate proxies and mobile OSes often
  impose — you should no longer see it drop just from sitting idle for a
  few minutes.
- If the connection drops for ANY reason — laptop sleep, phone screen
  lock, switching apps, a wifi blip, the free relay server spinning down
  and cold-starting, or even a full server redeploy — both sides
  **automatically resume the same pairing** the moment they're both back
  online, with no re-scanning, ever. You'll briefly see a "Reconnecting…"
  banner instead of the full pairing screen; on a cold-started free
  server this can take up to about a minute, but it will not ask you to
  pair again.
- The pairing is saved to disk locally (`localStorage` in the web app,
  `chrome.storage.local` in the extension), so it survives fully closing
  the tab/browser/laptop, restarting your phone, and the relay server
  itself restarting or being redeployed. It is only forgotten when you
  explicitly tap **"Forget this device"** on either side.

## 6. Corporate-network limitations (read this before relying on it)

- **WebRTC P2P may simply not work** on a Zscaler-proxied or heavily
  firewalled corporate network — this is expected. FlowBridge automatically
  detects this within ~6 seconds and falls back to the WSS relay path,
  which only needs standard outbound HTTPS/WSS (443) connectivity to your
  signaling server's domain — the same kind of connectivity a normal HTTPS
  website needs.
- If **outbound WebSocket/443 to your signaling server's domain is itself
  blocked** by DLP/proxy policy, FlowBridge cannot connect at all, and the
  UI will show a clear "connection unavailable" state rather than silently
  hanging or attempting a workaround. There is no bypass built in — if
  your corporate policy blocks it, you need IT to allowlist the domain, or
  the tool genuinely cannot be used on that network.
- If **Developer mode / unpacked extensions are disabled by policy**, you
  cannot install the extension without IT publishing it through your
  org's approved channel (see §4 above).
- If **`navigator.clipboard` is disabled by an enterprise policy**
  (`DefaultClipboardSetting` or similar), automatic clipboard read/write
  will fail; the manual "Send text" textarea/paste box remains available
  in both the web app and the extension popup as the documented fallback.

## 7. Required browser permissions

**Extension (`manifest.json`):**
- `clipboardRead` / `clipboardWrite` — read/write the Windows clipboard
  from the offscreen document.
- `offscreen` — create the hidden document that holds the WebRTC/WebSocket
  connection (MV3 service workers can't hold long-lived connections
  reliably).
- `storage` — persist your device ID and signaling server URL locally.
- `downloads` — save received files to your normal Downloads folder.
- `host_permissions: wss://*/*` — allowed to open a WSS connection to your
  configured signaling server.

**Web app (PWA):** the standard `navigator.clipboard` permission (prompted
by the browser on first use), and camera access (prompted only when you
tap "Scan a code" — used for in-app QR scanning; if you decline it or it's
unavailable, manual code entry and the "Share link" button both still work).

## 8. Large-file limitations

- Chunk size is 48 KiB per message, chosen to stay safely under
  WebRTC DataChannel and WebSocket per-message limits after base64
  inflation.
- The receiver holds the full reassembled file **in memory** (as a
  `Uint8Array`/`Blob`) before it's downloadable — there's no disk-streaming
  in this version. This is fine up to at least several hundred MB in a
  modern browser tab; multi-GB files would need a streaming-to-disk
  rewrite (e.g. via the File System Access API) — flagged here rather than
  silently limited.
- There's no resumable-across-restart transfer in this version — if the
  connection drops mid-transfer, the current transfer is abandoned and
  should be retried from the start once reconnected. Missing-chunk
  re-request plumbing (`text:ack-missing` / `file:ack-missing`) is present
  in the protocol so you can extend the receiver to request just the
  missing pieces instead of a full restart.
