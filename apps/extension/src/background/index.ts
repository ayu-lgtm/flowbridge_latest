/**
 * MV3 background service worker.
 *
 * Service workers are non-persistent (Chrome can kill them at any time), so
 * they CANNOT hold a long-lived WebSocket or RTCPeerConnection reliably.
 * The actual connection lives in an offscreen document (a hidden DOM page,
 * see src/offscreen/index.ts) which is kept alive via the "WEB_RTC" and
 * "CLIPBOARD" offscreen reasons. This background script's job is just:
 *   1. Ensure the offscreen document exists.
 *   2. Relay messages between the popup UI and the offscreen document
 *      (chrome.runtime.sendMessage doesn't reach documents directly in all
 *      cases, so we route everything through this hub).
 *   3. Keep small bits of state (last status) in chrome.storage.session so
 *      a freshly opened popup can show something immediately.
 */

import { storageGet, storageSet } from "../shared/storage";

const OFFSCREEN_URL = "offscreen.html";

async function ensureOffscreenDocument(): Promise<void> {
  const existing = await chrome.runtime.getContexts?.({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing && existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.WEB_RTC, chrome.offscreen.Reason.CLIPBOARD],
    justification:
      "Maintains the encrypted peer connection to the paired phone and reads/writes the system clipboard for sync.",
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreenDocument();
  ensureKeepaliveAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenDocument();
  ensureKeepaliveAlarm();
});
// Service worker may be woken by a message before onInstalled/onStartup
// fires in this session; make sure the offscreen doc exists on first use.
ensureOffscreenDocument();
ensureKeepaliveAlarm();

/**
 * Self-healing keepalive.
 *
 * The offscreen document is where the live WebSocket/WebRTC connection and
 * clipboard polling actually run (see src/offscreen/index.ts). It is
 * normally long-lived, but if Chrome ever tears it down without this
 * service worker noticing (memory pressure, a crash, etc.), nothing would
 * otherwise re-create it until the user manually opens the popup — which
 * looks exactly like "the connection randomly dies every few minutes".
 * A recurring alarm (service workers can't use setInterval reliably, since
 * they can be suspended between ticks — chrome.alarms is the MV3-correct
 * way to get a recurring wakeup) checks and recreates it periodically.
 * Chrome enforces a 1-minute minimum period for alarms.
 */
const KEEPALIVE_ALARM = "flowbridge-keepalive";

function ensureKeepaliveAlarm(): void {
  chrome.alarms.get(KEEPALIVE_ALARM, (existing) => {
    if (existing) return;
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) ensureOffscreenDocument();
});

// Relay: popup -> offscreen
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") {
    ensureOffscreenDocument().then(() => {
      chrome.runtime.sendMessage(message).catch(() => {});
    });
    return false;
  }
  if (message?.target === "background" && message?.type === "get-last-status") {
    storageGet(["lastStatus"], "session").then((res) => {
      sendResponse((res as { lastStatus?: unknown }).lastStatus ?? null);
    });
    return true; // async response
  }
  return false;
});

// Relay: offscreen -> popup (and persist last known status for popup reopen)
chrome.runtime.onMessage.addListener((message) => {
  if (message?.source === "offscreen" && message?.type === "status") {
    storageSet({ lastStatus: message.payload }, "session").catch(() => {});
  }
});

