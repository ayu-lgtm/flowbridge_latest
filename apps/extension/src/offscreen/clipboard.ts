/**
 * Offscreen documents in Manifest V3 can read/write the system clipboard
 * without a user gesture, provided the extension declares the
 * "clipboardRead"/"clipboardWrite" permissions — this is a capability
 * regular web pages do not have. We still prefer the standard
 * navigator.clipboard async API and fall back to the classic
 * execCommand('paste'/'copy') technique against a hidden textarea, since
 * that fallback is what actually works reliably inside a hidden,
 * never-focused offscreen document in current Chrome versions.
 *
 * Polling note: there is no OS-level "clipboard changed" event exposed to
 * extensions. We poll on an interval, but a *slow, deliberate* one (see
 * POLL_INTERVAL_MS) — not a tight microsecond loop — which keeps CPU/battery
 * impact negligible while still feeling instant to a human copy/paste
 * rhythm.
 */

export const POLL_INTERVAL_MS = 1500;

let hiddenTextarea: HTMLTextAreaElement | null = null;

function getHiddenTextarea(): HTMLTextAreaElement {
  if (hiddenTextarea) return hiddenTextarea;
  const ta = document.createElement("textarea");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  hiddenTextarea = ta;
  return ta;
}

export async function readClipboard(): Promise<string | null> {
  try {
    const text = await navigator.clipboard.readText();
    if (text) return text;
  } catch {
    /* fall through to execCommand fallback */
  }
  try {
    const ta = getHiddenTextarea();
    ta.value = "";
    ta.focus();
    const ok = document.execCommand("paste");
    if (ok && ta.value) return ta.value;
  } catch {
    /* ignore */
  }
  return null;
}

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through */
  }
  try {
    const ta = getHiddenTextarea();
    ta.value = text;
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    return ok;
  } catch {
    return false;
  }
}
