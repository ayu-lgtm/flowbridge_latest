export const POLL_INTERVAL_MS = 1500;

const NATIVE_HOST_ID = "com.flowbridge.clipboard";

function nativeRead(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST_ID, { type: "read" }, (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) return resolve(null);
        resolve(typeof resp.text === "string" ? resp.text : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function nativeWrite(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST_ID, { type: "write", text }, (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) return resolve(false);
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

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
  const native = await nativeRead();
  if (native !== null) return native;
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
  if (await nativeWrite(text)) return true;
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