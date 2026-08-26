import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceInfo, ConnectionStatus, TransportKind, SessionInfo } from "@flowbridge/protocol";
import { FlowConnection } from "@flowbridge/protocol";
import { getDevice } from "./lib/device";
import { ClipboardWatcher } from "./lib/clipboard";
import { useTransferManager } from "./lib/useTransferManager";
import { generateQrDataUrl, buildPairDeepLink, startQrScanner, type ScannerHandle } from "./lib/qr";
import { buildFileTree, type FileTreeResult } from "./lib/fileTree";
import { FileTree } from "./components/FileTree";

// Configure via .env: VITE_SIGNALING_URL=wss://your-server.example.com
const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || "ws://localhost:8787";

const SESSION_KEY = "flowbridge.pairedSession";
const THEME_KEY = "flowbridge.theme";

function getInitialTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* localStorage unavailable — fall through to system preference */
  }
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
  const pendingWriteRef = useRef<string | null>(null);

  // The file/zip most recently picked to send — its path tree is built and
  // shown automatically, before/alongside the send, so you can see exactly
  // what's inside a zip without guessing.
  const [filePreview, setFilePreview] = useState<{ name: string; size: number; tree: FileTreeResult } | null>(
    null
  );
  const [filePreviewError, setFilePreviewError] = useState<string | null>(null);
  // Trees for RECEIVED files are built lazily (only when the user asks to
  // see them) since a big incoming zip shouldn't be unzipped in memory
  // unless someone actually wants to look inside it.
  const [receivedTrees, setReceivedTrees] = useState<Record<string, FileTreeResult | "loading" | "error">>({});

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

    const handleFocusRetry = () => {
      if (document.visibilityState === "visible") retryPendingWrite();
    };
    document.addEventListener("visibilitychange", handleFocusRetry);
    window.addEventListener("focus", handleFocusRetry);

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
      conn.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startHost = () => connectionRef.current?.hostPairing();
  const startJoin = (codeToUse?: string) => connectionRef.current?.joinPairing(codeToUse ?? joinCode);

  useEffect(() => {
    if (!code) {
      setQrDataUrl(null);
      return;
    }
    generateQrDataUrl(code).then(setQrDataUrl);
  }, [code]);

  useEffect(() => {
    if (autoJoinedRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const linkCode = params.get("pair");
    if (linkCode) {
      autoJoinedRef.current = true;
      setJoinCode(linkCode.toUpperCase());
      setTimeout(() => startJoin(linkCode.toUpperCase()), 50);
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
    if (!file) return;
    e.target.value = "";
    sendFile(file);

    setFilePreviewError(null);
    setFilePreview(null);
    buildFileTree(file, file.name)
      .then((tree) => setFilePreview({ name: file.name, size: file.size, tree }))
      .catch(() => setFilePreviewError("Couldn't read this file's contents (it may not be a valid zip)."));
  };

  const toggleReceivedTree = (transferId: string, blob: Blob, fileName: string) => {
    setReceivedTrees((prev) => {
      if (prev[transferId]) {
        const { [transferId]: _drop, ...rest } = prev;
        return rest;
      }
      return { ...prev, [transferId]: "loading" };
    });
    if (receivedTrees[transferId]) return;

    buildFileTree(blob, fileName)
      .then((tree) => setReceivedTrees((prev) => ({ ...prev, [transferId]: tree })))
      .catch(() => setReceivedTrees((prev) => ({ ...prev, [transferId]: "error" })));
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

            {filePreviewError && <p className="error">{filePreviewError}</p>}

            {filePreview && (
              <div className="file-preview">
                <div className="file-preview-header">
                  <span className="file-preview-name">
                    {filePreview.tree.isArchive ? "🗜️" : "📄"} {filePreview.name}
                  </span>
                  <span className="muted small">
                    {formatBytes(filePreview.size)}
                    {filePreview.tree.isArchive &&
                      ` — ${filePreview.tree.fileCount} file${filePreview.tree.fileCount === 1 ? "" : "s"} inside`}
                  </span>
                </div>
                <FileTree roots={filePreview.tree.roots} />
              </div>
            )}

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
                {receivedFiles.map((f) => {
                  const isZip = f.fileName.toLowerCase().endsWith(".zip");
                  const treeState = receivedTrees[f.transferId];
                  return (
                    <div key={f.transferId} className="file-row-block">
                      <div className="file-row">
                        <span>
                          {f.fileName} <span className="muted small">({formatBytes(f.blob.size)})</span>
                        </span>
                        <span className="button-row">
                          {isZip && (
                            <button
                              className="secondary"
                              onClick={() => toggleReceivedTree(f.transferId, f.blob, f.fileName)}
                            >
                              {treeState ? "Hide contents" : "View contents"}
                            </button>
                          )}
                          <button onClick={() => downloadFile(f.blob, f.fileName)}>Save</button>
                        </span>
                      </div>
                      {treeState === "loading" && <p className="muted small">Reading archive…</p>}
                      {treeState === "error" && <p className="error">Couldn't read this zip's contents.</p>}
                      {treeState && treeState !== "loading" && treeState !== "error" && (
                        <div className="file-preview">
                          <p className="muted small">
                            {treeState.fileCount} file{treeState.fileCount === 1 ? "" : "s"} —{" "}
                            {formatBytes(treeState.totalSize)} uncompressed
                          </p>
                          <FileTree roots={treeState.roots} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}