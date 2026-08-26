import { getServerUrl, setServerUrl, getWebAppUrl, setWebAppUrl, isServerConfigured } from "../shared/config";
import QRCode from "qrcode";

interface RuntimeState {
  status: string;
  transport: string;
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

const app = document.getElementById("app")!;
const statusPill = document.getElementById("statusPill")!;

function callOffscreen<T = any>(msg: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage({ target: "offscreen", ...msg });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function render(state: RuntimeState) {
  statusPill.textContent = state.status;
  statusPill.className = "pill" + (state.status === "connected" ? " connected" : state.status === "error" ? " error" : "");

  if (state.status === "connected") {
    app.innerHTML = `
      <div class="card">
        <div><strong>Connected: ${state.peerLabel ?? "Paired device"}</strong></div>
        <div class="muted">Transport: ${state.transport === "p2p" ? "Direct (P2P)" : "Relay"}</div>
        <div class="muted">Clipboard: ✓ Synced</div>
        ${state.lastReceivedChars !== null ? `<div class="muted">Last received: ${state.lastReceivedChars.toLocaleString()} characters</div>` : ""}
        <button id="checkClipboard" class="secondary">Check clipboard now</button>
      </div>
      <div class="card">
        <div class="muted">Send text manually</div>
        <textarea id="manualText" rows="3" placeholder="Paste text/code here"></textarea>
        <button id="sendTextBtn">Send</button>
      </div>
      <div class="card">
        <div class="muted">Files</div>
        <input type="file" id="filePicker" />
        <div id="transfers"></div>
        <div id="files"></div>
      </div>
    `;
    renderTransfers(state);
    renderFiles(state);

    document.getElementById("checkClipboard")?.addEventListener("click", () => callOffscreen({ type: "check-clipboard-now" }));
    document.getElementById("sendTextBtn")?.addEventListener("click", async () => {
      const ta = document.getElementById("manualText") as HTMLTextAreaElement;
      if (ta.value) {
        await callOffscreen({ type: "send-text", text: ta.value });
        ta.value = "";
      }
    });
    document.getElementById("filePicker")?.addEventListener("change", async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      const buf = await file.arrayBuffer();
      await callOffscreen({ type: "send-file", fileBuffer: buf, fileName: file.name, fileType: file.type });
      input.value = "";
    });
    return;
  }

  // A dropped socket that's actively auto-resuming to a KNOWN peer (screen
  // lock, wifi blip, laptop sleep, or the free relay server waking back up
  // after being idle) is not "not paired" — showing the fresh-pairing
  // screen here is exactly what made this look like "have to re-pair
  // constantly". Show a quiet reconnecting state instead; it clears itself
  // automatically once "connected" comes back.
  if ((state.status === "disconnected" || state.status === "connecting") && state.peerLabel) {
    app.innerHTML = `
      <div class="card">
        <div class="muted">Reconnecting to ${state.peerLabel}…</div>
        <div class="muted" style="font-size:12px;margin-top:6px;">
          Automatic — no need to pair again. If the relay server was idle this can take up to a
          minute to wake back up.
        </div>
      </div>
    `;
    return;
  }

  if (state.status === "waiting-for-code" && state.code) {
    app.innerHTML = `
      <div class="card">
        <div class="muted">Scan this with your phone's camera, or enter the code manually:</div>
        <img id="qrImg" class="qr-image" alt="Pairing QR code" />
        <div class="code">${state.code}</div>
        <div class="muted">Code expires in 5 minutes.</div>
      </div>
    `;
    getWebAppUrl().then(async (webAppUrl) => {
      const link = `${webAppUrl.replace(/\/$/, "")}/?pair=${state.code}`;
      const dataUrl = await QRCode.toDataURL(link, { margin: 1, width: 200 });
      const img = document.getElementById("qrImg") as HTMLImageElement | null;
      if (img) img.src = dataUrl;
    });
    return;
  }

  if (state.status === "connecting" || state.status === "pairing") {
    app.innerHTML = `<div class="card"><div class="muted">Establishing secure connection…</div></div>`;
    return;
  }

  // idle / disconnected / error -> pairing entry screen
  app.innerHTML = `
    <div class="card">
      <div class="muted">Pair with your Android phone</div>
      <button id="hostBtn">Show pairing code</button>
      <div class="muted" style="text-align:center;margin:6px 0;">or</div>
      <input id="joinCode" placeholder="Enter code e.g. 82K9-XP4Q" maxlength="9" />
      <button id="joinBtn" class="secondary">Connect</button>
      ${state.error ? `<div class="muted" style="color:#f87171">${state.error}</div>` : ""}
    </div>
    <div class="card">
      <a class="link" id="settingsLink">Signaling server settings</a>
      <div id="settingsBox" style="display:none;margin-top:8px;">
        <input id="serverUrl" placeholder="wss://your-server.example.com" />
        <input id="webAppUrl" placeholder="https://your-app.netlify.app" style="margin-top:6px;" />
        <button id="saveServerBtn" class="secondary">Save</button>
      </div>
    </div>
  `;
  document.getElementById("hostBtn")?.addEventListener("click", () => callOffscreen({ type: "host-pairing" }));
  document.getElementById("joinBtn")?.addEventListener("click", () => {
    const code = (document.getElementById("joinCode") as HTMLInputElement).value;
    if (code.trim().length >= 8) callOffscreen({ type: "join-pairing", code });
  });
  document.getElementById("settingsLink")?.addEventListener("click", async () => {
    const box = document.getElementById("settingsBox")!;
    box.style.display = box.style.display === "none" ? "block" : "none";
    (document.getElementById("serverUrl") as HTMLInputElement).value = await getServerUrl();
    (document.getElementById("webAppUrl") as HTMLInputElement).value = await getWebAppUrl();
  });
  document.getElementById("saveServerBtn")?.addEventListener("click", async () => {
    const url = (document.getElementById("serverUrl") as HTMLInputElement).value.trim();
    const webUrl = (document.getElementById("webAppUrl") as HTMLInputElement).value.trim();
    if (url) await setServerUrl(url);
    if (webUrl) await setWebAppUrl(webUrl);
    const btn = document.getElementById("saveServerBtn")!;
    btn.textContent = "Saved ✓";
    setTimeout(() => (btn.textContent = "Save"), 1200);
  });
}

function renderTransfers(state: RuntimeState) {
  const el = document.getElementById("transfers");
  if (!el) return;
  const active = state.activeTransfers.filter((t) => t.status === "in-progress");
  el.innerHTML = active
    .map(
      (t) => `
      <div class="transfer-item">
        <div>${t.direction === "sending" ? "↑" : "↓"} ${t.label} — ${t.pct}%</div>
        <div class="progress-bar"><div class="progress-fill" style="width:${t.pct}%"></div></div>
      </div>`
    )
    .join("");
}

function renderFiles(state: RuntimeState) {
  const el = document.getElementById("files");
  if (!el) return;
  el.innerHTML = state.receivedFiles
    .map(
      (f) => `
      <div class="row">
        <span>${f.fileName} (${formatBytes(f.size)})</span>
        <button class="secondary" style="width:auto" data-save="${f.transferId}">Save</button>
      </div>`
    )
    .join("");
  el.querySelectorAll<HTMLButtonElement>("[data-save]").forEach((btn) => {
    btn.addEventListener("click", () => callOffscreen({ type: "save-file", transferId: btn.dataset.save }));
  });
}

function renderSetupScreen() {
  app.innerHTML = `
    <div class="card">
      <div><strong>One-time setup needed</strong></div>
      <div class="muted" style="margin:6px 0 10px;">
        This extension needs the address of your FlowBridge signaling server before it can pair —
        it's the same server your web app / phone connects to.
        Without this, pairing silently fails with a connection error.
      </div>
      <input id="setupServerUrl" placeholder="wss://your-server.example.com" />
      <div class="muted" style="margin-top:8px;">Optional, only used to build the QR code:</div>
      <input id="setupWebAppUrl" placeholder="https://your-flowbridge-app.example.com" style="margin-top:6px;" />
      <button id="setupSaveBtn">Save & continue</button>
      <div id="setupErr" class="muted" style="color:#f87171;margin-top:6px;"></div>
    </div>
  `;
  document.getElementById("setupSaveBtn")?.addEventListener("click", async () => {
    const url = (document.getElementById("setupServerUrl") as HTMLInputElement).value.trim();
    const webUrl = (document.getElementById("setupWebAppUrl") as HTMLInputElement).value.trim();
    const errEl = document.getElementById("setupErr")!;
    if (!/^wss?:\/\/.+/.test(url)) {
      errEl.textContent = "Enter a valid address starting with wss:// (or ws:// for local testing).";
      return;
    }
    await setServerUrl(url);
    if (webUrl) await setWebAppUrl(webUrl);
    errEl.textContent = "";
    init();
  });
}

async function init() {
  if (!(await isServerConfigured())) {
    renderSetupScreen();
    return;
  }
  const state = await callOffscreen<RuntimeState>({ type: "get-state" });
  if (state) render(state);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.source === "offscreen" && message?.type === "status") {
    render(message.payload as RuntimeState);
  }
});

init();
