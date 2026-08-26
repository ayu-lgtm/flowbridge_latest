/**
 * Clipboard watching strategy (browser tab, not extension):
 *
 * There is no "clipboardchange" event in the standard Clipboard API, so a
 * page cannot be truly notified the instant the OS clipboard changes. The
 * least wasteful approach — and the one Chrome/Android actually allows
 * without spamming clipboardRead prompts — is to check the clipboard only
 * on meaningful trigger points:
 *   - the tab/PWA regains focus (`visibilitychange` -> visible, `focus`)
 *   - the page is restored from the back/forward cache after an app switch
 *     (`pageshow` with event.persisted) — some mobile browsers use bfcache
 *     instead of firing focus/visibilitychange reliably when you switch
 *     back from another app
 *   - the user explicitly taps "Check clipboard now"
 * This avoids setInterval polling entirely. It matches real usage: you
 * switch away from FlowBridge, copy something in another app, then switch
 * back — that switch-back is exactly the `visibilitychange`/`pageshow`
 * event.
 *
 * Writing to the clipboard on the web app (as opposed to the extension)
 * requires a user gesture in most browsers, so `writeText` is only ever
 * called from a click handler (the "Copy" button), never automatically.
 *
 * FOCUS RACE (the actual bug behind "switching apps blocks clipboard"):
 * `navigator.clipboard.readText()` throws NotAllowedError unless the
 * document currently has focus. On Android/iOS Chrome, the
 * `visibilitychange`/`focus` events for "I switched back to this tab" can
 * fire a beat BEFORE the OS actually hands focus back to the page — so a
 * readText() called immediately from that event handler intermittently
 * fails with a permission error, even though the user is looking right at
 * the tab. The previous version treated that failure as "permission
 * denied, give up silently," which is exactly what looked like "clipboard
 * gets blocked after switching apps." The fix: wait for document.hasFocus()
 * to actually be true (short poll, a few hundred ms) before attempting the
 * read, and retry once more after a brief delay if the first attempt still
 * gets a focus-related error.
 *
 * Safety-net poll: `visibilitychange` only fires when the tab itself is
 * hidden/shown (e.g. switching browser tabs, minimizing), and `focus`/
 * `blur` are meant to cover "switched to a different OS-level app while
 * this browser window stayed open" — but in practice that focus/blur pair
 * is not 100% reliable across every OS/browser combo (some window
 * managers, some Android multi-window modes, some PWA shells don't fire
 * it consistently). When that happens the page silently stops noticing
 * clipboard changes even though it still looks "open". A slow interval
 * poll — only while the tab is actually visible, so it costs nothing when
 * backgrounded — closes that gap without going back to a tight loop.
 */
const SAFETY_POLL_INTERVAL_MS = 4000;
const FOCUS_WAIT_STEP_MS = 100;
const FOCUS_WAIT_MAX_MS = 1500;
const RETRY_AFTER_MS = 300;

export type ClipboardChangeHandler = (text: string) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits (briefly) for the document to actually regain focus before we try reading the clipboard. */
async function waitForFocus(maxMs: number): Promise<boolean> {
  if (typeof document === "undefined" || document.hasFocus()) return true;
  let waited = 0;
  while (waited < maxMs) {
    await sleep(FOCUS_WAIT_STEP_MS);
    waited += FOCUS_WAIT_STEP_MS;
    if (document.hasFocus()) return true;
  }
  return document.hasFocus();
}

export class ClipboardWatcher {
  private lastSeenHash = "";
  private onChange: ClipboardChangeHandler;
  private active = false;
  private safetyPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(onChange: ClipboardChangeHandler) {
    this.onChange = onChange;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    document.addEventListener("visibilitychange", this.handleVisibility);
    window.addEventListener("focus", this.checkNow);
    // Covers the mobile bfcache-restore case where visibilitychange/focus
    // don't fire consistently after switching back from another app.
    window.addEventListener("pageshow", this.handlePageShow);
    this.syncSafetyPoll();
  }

  stop(): void {
    this.active = false;
    document.removeEventListener("visibilitychange", this.handleVisibility);
    window.removeEventListener("focus", this.checkNow);
    window.removeEventListener("pageshow", this.handlePageShow);
    if (this.safetyPollTimer) clearInterval(this.safetyPollTimer);
    this.safetyPollTimer = null;
  }

  /** Runs the low-frequency fallback poll only while the tab is visible. */
  private syncSafetyPoll(): void {
    if (this.safetyPollTimer) {
      clearInterval(this.safetyPollTimer);
      this.safetyPollTimer = null;
    }
    if (!this.active || document.visibilityState !== "visible") return;
    this.safetyPollTimer = setInterval(this.checkNow, SAFETY_POLL_INTERVAL_MS);
  }

  private handleVisibility = () => {
    if (document.visibilityState === "visible") this.checkNow();
    this.syncSafetyPoll();
  };

  private handlePageShow = (ev: PageTransitionEvent) => {
    if (ev.persisted) this.checkNow();
  };

  checkNow = async (): Promise<void> => {
    const text = await this.readWithRetry();
    if (!text) return;
    const hash = await simpleHash(text);
    if (hash === this.lastSeenHash) return;
    this.lastSeenHash = hash;
    this.onChange(text);
  };

  /**
   * Reads the clipboard, first waiting briefly for real focus (the actual
   * fix for the "blocked right after switching apps" bug), and retrying
   * once more if the first attempt still fails — that covers the small
   * remaining timing window some Android/iOS browsers have between
   * "visibilitychange fired" and "focus is really back".
   */
  private async readWithRetry(): Promise<string | null> {
    await waitForFocus(FOCUS_WAIT_MAX_MS);
    const first = await this.tryRead();
    if (first !== null) return first;
    await sleep(RETRY_AFTER_MS);
    await waitForFocus(FOCUS_WAIT_MAX_MS);
    return this.tryRead();
  }

  private async tryRead(): Promise<string | null> {
    try {
      // Requires the Clipboard-Read permission; on Android Chrome this is
      // granted automatically for the focused, HTTPS, top-level document
      // without an extra prompt in most cases. If it's denied, we simply
      // skip silently — the UI's manual "Paste to send" textbox is the
      // documented fallback (see App.tsx).
      const text = await navigator.clipboard.readText();
      return text || null;
    } catch {
      // Permission denied, focus lost again mid-read, or clipboard
      // empty/non-text — the caller decides whether to retry.
      return null;
    }
  }

  /** Call after WE write to the clipboard so our own write isn't re-reported as a "change". */
  markWritten(text: string): void {
    simpleHash(text).then((h) => {
      this.lastSeenHash = h;
    });
  }

  async writeText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      this.markWritten(text);
      return true;
    } catch {
      return false;
    }
  }
}

async function simpleHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
