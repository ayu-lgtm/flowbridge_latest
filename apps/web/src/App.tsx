import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceInfo, ConnectionStatus, TransportKind, SessionInfo } from "@flowbridge/protocol";
import { FlowConnection } from "@flowbridge/protocol";
import { getDevice } from "./lib/device";
import { ClipboardWatcher } from "./lib/clipboard";
import { useTransferManager } from "./lib/useTransferManager";
import { generateQrDataUrl, buildPairDeepLink, startQrScanner, type ScannerHandle } from "./lib/qr";

// Configure via .env: VITE_SIGNALING_URL=wss://your-server.example.com
const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || "ws://localhost:8787";

// localStorage (not sessionStorage) is deliberate: pairing is meant to be
// PERMANENT, like pairing a Bluetooth device — it must survive a full
// browser/tab close and reopen, a phone restart, or the tab being killed
// by the OS under memory pressure while backgrounded. sessionStorage would
// silently drop the pairing in exactly those cases, forcing a brand-new
// QR scan every time — which was the #1 source of "keeps asking me to
// pair again" complaints. The only way this pairing goes away now is the
// user explicitly choosing "Forget this device" (see disconnect()).
const SESSION_KEY = "flowbridge.pairedSession";
const THEME_KEY = "flowbridge.theme";

function getInitialTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* localStorage unavailable — fall through to system preference */
  }
  // No explicit user choice yet: default to the OS-level preference rather
  // than always-dark, since "everything is black" was the #1 UI complaint —
  // most people expect a light UI unless their system says otherwise.
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

function saveSession(info: SessionInfo | null) {
  if (!info) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }
  localStorage.setItem(SESSION_KEY, JSON.stringify(info));
}

function loadSession(): SessionInfo | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as SessionInfo) : null;
  } catch {
    return null;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export default function App() {
  const device = useRef<DeviceInfo>(getDevice());
  const connectionRef = useRef<FlowConnection | null>(null);
  const clipboardRef = useRef<ClipboardWatcher | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [transport, setTransport] = useState<TransportKind>("none");
  const [code, setCode] = useState<string>("");
  const [joinCode, setJoinCode] = useState("");
  const [peer, setPeer] = useState<DeviceInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualText, setManualText] = useState("");
  const [clipboardPermission, setClipboardPermission] = useState<"unknown" | "granted" | "denied">(
    "unknown"
  );
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => getInitialTheme());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<ScannerHandle | null>(null);
  const autoJoinedRef = useRef(false);
  // Holds text whose automatic clipboard write failed (tab wasn't focused
  // at the moment it arrived) until it can be retried — see
  // onClipboardTextReceived / retryPendingWrite below.
  const pendingWriteRef = useRef<string | null>(null);

  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && !!navigator.share);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore persistence failures (private browsing etc.) */
    }
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));

  const onClipboardTextReceived = useCallback(async (text: string) => {
    const ok = await clipboardRef.current?.writeText(text);
    setClipboardPermission(ok ? "granted" : "denied");
    // The write most commonly fails because the tab was minimized/behind
    // another window at the exact moment the text arrived — writeText()
    // requires document focus, just like readText() does. Previously that
    // failure was silent and the text was gone for good unless the sender
    // sent it again. Now: remember it, and the moment this tab regains
    // focus (see the visibilitychange/focus listener below), retry the
    // write automatically — no click needed. The "Copy received text"
    // button in the UI is the guaranteed manual fallback either way.
    pendingWriteRef.current = ok ? null : text;
  }, []);

  const retryPendingWrite = useCallback(async () => {
    const text = pendingWriteRef.current;
    if (!text) return;
    const ok = await clipboardRef.current?.writeText(text);
    if (ok) {
      pendingWriteRef.current = null;
      setClipboardPermission("granted");
    }
  }, []);

  const { handleIncoming, sendText, sendFile, lastReceivedChars, lastReceivedText, receivedFiles, activeTransfers } =
    useTransferManager(connectionRef.current, device.current.deviceId, onClipboardTextReceived);

  useEffect(() => {
    const conn = new FlowConnection(SIGNALING_URL, device.current, {
      onStatus: (s, t) => {
        setStatus(s);
        setTransport(t);
      },
      onCode: (c) => setCode(c),
      onPeer: (p) => setPeer(p),
      onMessage: handleIncoming,
      onError: (m) => setError(m),
      onSession: (info) => saveSession(info),
    });
    connectionRef.current = conn;

    const watcher = new ClipboardWatcher((text) => {
      sendText(text);
    });
    clipboardRef.current = watcher;
    watcher.start();

    // The moment this tab is actually visible/focused again, retry any
    // clipboard write that failed earlier because the tab was minimized
    // or behind another window when the text first arrived — turns "open
    // the browser tab, find the text, copy it out manually" into "click
    // into the browser (even briefly), it's already on your clipboard."
    const handleFocusRetry = () => {
      if (document.visibilityState === "visible") retryPendingWrite();
    };
    document.addEventListener("visibilitychange", handleFocusRetry);
    window.addEventListener("focus", handleFocusRetry);

    // If this tab already had a live pairing (page reload, not a fresh
    // visit — sessionStorage only survives within the same tab), silently
    // reconnect to it instead of showing the "scan/pair" screen again.
    const saved = loadSession();
    if (saved) {
      setStatus("connecting");
      setPeer(saved.peer);
      conn.resumeSession(saved.sessionId, saved.peer, saved.isOfferer);
    }

    return () => {
      watcher.stop();
      document.removeEventListener("visibilitychange", handleFocusRetry);
      window.removeEventListener("focus", handleFocusRetry);
      // destroy(), not close(): a component unmount (tab close, React
      // remount, hot reload) must NOT erase the saved pairing — only an
      // explicit "Forget this device" tap should ever do that.
      conn.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startHost = () => connectionRef.current?.hostPairing();
  const startJoin = (codeToUse?: string) => connectionRef.current?.joinPairing(codeToUse ?? joinCode);

  // Generate a scannable QR whenever we're shown a pairing code, so the
  // other device can just point its camera instead of typing anything.
  useEffect(() => {
    if (!code) {
      setQrDataUrl(null);
      return;
    }
    generateQrDataUrl(code).then(setQrDataUrl);
  }, [code]);

  // If this page was opened via a scanned/tapped QR deep link
  // (?pair=82K9-XP4Q), auto-connect immediately — no typing needed.
  useEffect(() => {
    if (autoJoinedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const linkCode = params.get("pair");
    if (linkCode) {
      autoJoinedRef.current = true;
      setJoinCode(linkCode.toUpperCase());
      // small delay so the FlowConnection instance from the mount effect
      // above is guaranteed to exist
      setTimeout(() => startJoin(linkCode.toUpperCase()), 50);
      // clean the URL so refreshing doesn't re-trigger auto-join
      window.history.replaceState({}, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openScanner = async () => {
    setScanError(null);
    setScanning(true);
  };

  useEffect(() => {
    if (!scanning || !videoRef.current) return;
    let cancelled = false;
    startQrScanner(
      videoRef.current,
      (scannedCode) => {
        if (cancelled) return;
        setScanning(false);
        setJoinCode(scannedCode);
        startJoin(scannedCode);
      },
      (message) => {
        if (cancelled) return;
        setScanError(message);
        setScanning(false);
      }
    ).then((handle) => {
      scannerRef.current = handle;
    });
    return () => {
      cancelled = true;
      scannerRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning]);

  const closeScanner = () => {
    scannerRef.current?.stop();
    setScanning(false);
  };

  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) sendFile(file);
    e.target.value = "";
  };

  const downloadFile = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const connected = status === "connected";
  const isPairingBusy = status === "waiting-for-code" || status === "pairing" || status === "connecting";
  // A dropped socket mid-session (screen lock, wifi blip, laptop sleep) sets
  // status to "disconnected" while we still know who our peer was — that's
  // an automatic-resume-in-progress, not "not paired at all", so it gets
  // its own quiet banner instead of dumping the user back to the full
  // scan/pair screen.
  const isReconnecting = status === "disconnected" && peer !== null;

  const copyCode = () => {
    if (!code) return;
    navigator.clipboard?.writeText(code).then(() => {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 1500);
    });
  };

  const shareLink = () => {
    if (!code) return;
    navigator.share?.({ title: "FlowBridge pairing link", url: buildPairDeepLink(code) }).catch(() => {
      /* user cancelled share sheet — ignore */
    });
  };

  const disconnect = () => {
    connectionRef.current?.close();
    setPeer(null);
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" />
          <h1>FlowBridge</h1>
        </div>
        <div className="header-right">
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
            title={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
          >
            {theme === "light" ? "🌙" : "☀️"}
          </button>
          <span className={`status-pill status-${status}`}>
            {connected ? `${transport === "p2p" ? "Direct link" : "Connected"}` : status === "idle" ? "Not paired" : status.replace(/-/g, " ")}
          </span>
        </div>
      </header>

      {isReconnecting && (
        <section className="pairing-hero">
          <div className="connecting-row">
            <span className="spinner" />
            <p className="muted">Reconnecting to {peer?.label || "your other device"}…</p>
          </div>
          <p className="muted small">
            This happens automatically — no need to scan again. If the relay server has been
            quiet for a while it may need up to a minute to wake back up.
          </p>
          {error && <p className="muted small">{error}</p>}
          <button className="link-button" onClick={disconnect}>
            Forget this device &amp; pair a different one
          </button>
        </section>
      )}

      {!connected && !isPairingBusy && !isReconnecting && (
        <section className="pairing-hero">
          <div className="beam-illustration" aria-hidden="true">
            <span className="beam-device">{device.current.role === "phone" ? "📱" : "💻"}</span>
            <span className="beam-track">
              <span className="beam-dot" />
              <span className="beam-dot" />
              <span className="beam-dot" />
            </span>
            <span className="beam-device">{device.current.role === "phone" ? "💻" : "📱"}</span>
          </div>
          <h2 className="hero-title">Connect your devices</h2>
          <p className="hero-subtitle">No accounts, no typing — just point and connect.</p>

          <div className="tap-choices">
            <button className="tap-choice" onClick={openScanner}>
              <span className="tap-choice-icon">📷</span>
              <span className="tap-choice-label">Scan a code</span>
              <span className="tap-choice-hint">Use this on the device you're holding now</span>
            </button>
            <button className="tap-choice" onClick={startHost}>
              <span className="tap-choice-icon">▦</span>
              <span className="tap-choice-label">Show my code</span>
              <span className="tap-choice-hint">Let the other device scan this one</span>
            </button>
          </div>

          {!showManualEntry ? (
            <button className="link-button" onClick={() => setShowManualEntry(true)}>
              Enter a code manually instead
            </button>
          ) : (
            <div className="join-row">
              <input
                placeholder="82K9-XP4Q"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                maxLength={9}
                autoFocus
              />
              <button onClick={() => startJoin()} disabled={joinCode.trim().length < 8}>
                Connect
              </button>
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </section>
      )}

      {scanning && (
        <div className="scanner-overlay">
          <div className="scanner-box">
            <p className="muted">Point your camera at the code on the other device</p>
            <div className="scanner-frame">
              <video ref={videoRef} playsInline muted className="scanner-video" />
              <span className="scanner-corner tl" />
              <span className="scanner-corner tr" />
              <span className="scanner-corner bl" />
              <span className="scanner-corner br" />
            </div>
            {scanError && <p className="error">{scanError}</p>}
            <button className="secondary" onClick={closeScanner}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {isPairingBusy && (
        <section className="pairing-hero">
          {code && (
            <>
              <p className="hero-subtitle">Scan this with the other device</p>
              <div className="qr-frame">
                {qrDataUrl && <img src={qrDataUrl} alt="Pairing QR code" className="qr-image" />}
              </div>
              <button className="code-chip" onClick={copyCode}>
                <span className="code-text">{code}</span>
                <span className="code-copy">{copiedCode ? "Copied" : "Copy"}</span>
              </button>
              {canShare && (
                <button className="link-button" onClick={shareLink}>
                  Share link instead (WhatsApp, etc.)
                </button>
              )}
              <p className="muted small">
                Tip: your phone's regular camera app can usually scan this too — it'll open
                FlowBridge already connected.
              </p>
            </>
          )}
          {status === "connecting" && (
            <div className="connecting-row">
              <span className="spinner" />
              <p className="muted">Establishing secure connection…</p>
            </div>
          )}
          {code && <p className="muted small">Code expires in 5 minutes.</p>}
          <button className="link-button" onClick={() => connectionRef.current?.close()}>
            Cancel
          </button>
        </section>
      )}

      {connected && (
        <>
          <section className="card">
            <h2>Connected: {peer?.label || "Paired device"}</h2>
            <p className="muted">
              Clipboard: <strong>✓ Synced</strong>
              {clipboardPermission === "denied" && (
                <span className="warn"> — this browser tab wasn't focused when something last arrived</span>
              )}
            </p>
            {lastReceivedChars !== null && (
              <p className="muted">Last received: {lastReceivedChars.toLocaleString()} characters</p>
            )}
            {clipboardPermission === "denied" && lastReceivedText && (
              <div className="pending-write-box">
                <p className="muted small">
                  It couldn't auto-copy to your clipboard because this tab was minimized/unfocused
                  at that moment — it retries automatically the instant you click into this tab, or
                  tap below right now:
                </p>
                <button
                  onClick={async () => {
                    const ok = await clipboardRef.current?.writeText(lastReceivedText);
                    if (ok) setClipboardPermission("granted");
                  }}
                >
                  Copy received text to clipboard
                </button>
              </div>
            )}
            <div className="button-row">
              <button onClick={() => clipboardRef.current?.checkNow()}>Check clipboard now</button>
              <button className="secondary" onClick={disconnect}>
                Forget this device
              </button>
            </div>
            <p className="muted small">
              Pairing is remembered permanently on both devices — closing the app or losing wifi
              won't unpair you. Use "Forget this device" only if you want to pair with someone
              else.
            </p>
          </section>

          <section className="card">
            <h3>Send text manually</h3>
            <p className="muted small">
              Use this if automatic clipboard read is blocked by your browser/OS permissions.
            </p>
            <textarea
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              placeholder="Paste or type text/code here, any length"
              rows={4}
            />
            <div className="button-row">
              <button
                onClick={() => {
                  if (manualText) sendText(manualText);
                  setManualText("");
                }}
                disabled={!manualText}
              >
                Send
              </button>
            </div>
          </section>

          <section className="card">
            <h3>Files</h3>
            <label className="file-picker">
              Send file
              <input type="file" onChange={onFilePicked} hidden />
            </label>

            {Object.values(activeTransfers).length > 0 && (
              <div className="transfers">
                {Object.values(activeTransfers)
                  .sort((a, b) => b.startedAt - a.startedAt)
                  .map((t) => {
                    const pct = t.totalChunks ? Math.round((t.receivedChunks / t.totalChunks) * 100) : 0;
                    return (
                      <div key={t.transferId} className="transfer-row">
                        <div className="transfer-label">
                          {t.direction === "sending" ? "↑" : "↓"} {t.label}
                        </div>
                        <div className="progress-bar">
                          <div className="progress-fill" style={{ width: `${t.status === "done" ? 100 : pct}%` }} />
                        </div>
                        <div className="transfer-status">
                          {t.status === "done" ? "✓ Done" : t.status === "error" ? "✗ Failed" : `${pct}%`}
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}

            {receivedFiles.length > 0 && (
              <div className="received-files">
                <h4>Received files</h4>
                {receivedFiles.map((f) => (
                  <div key={f.transferId} className="file-row">
                    <span>
                      {f.fileName} <span className="muted small">({formatBytes(f.blob.size)})</span>
                    </span>
                    <button onClick={() => downloadFile(f.blob, f.fileName)}>Save</button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
