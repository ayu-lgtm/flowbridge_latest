/**
 * Thin wrapper around chrome.storage.local / chrome.storage.session.
 *
 * Why this exists: immediately after a *fresh* execution context starts —
 * a freshly (re)created offscreen document, or a service worker that has
 * just woken up — a script can begin running before Chrome has finished
 * injecting the extension API bindings. `chrome` itself exists at that
 * point, but `chrome.storage` can still be `undefined` for a handful of
 * milliseconds, which throws:
 *   TypeError: Cannot read properties of undefined (reading 'local')
 * This is a documented Chromium timing quirk, not a missing "storage"
 * permission (that's declared correctly in manifest.json) — see
 * https://groups.google.com/a/chromium.org/g/chromium-extensions/c/cbERJLSL11A
 *
 * offscreen/index.ts calls chrome.storage.local synchronously as soon as
 * the document is created (via getDevice()/getServerUrl() inside the
 * top-level ensureConnection() call), which is exactly the moment this
 * race is most likely to bite. Rather than removing that eager call (the
 * whole point is to resume a session as soon as possible), we make the
 * storage access itself resilient: wait briefly for the binding to appear,
 * then proceed normally.
 */

const MAX_WAIT_MS = 2000;
const RETRY_DELAY_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForArea(
  area: "local" | "session",
): Promise<chrome.storage.StorageArea> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (!chrome.storage?.[area]) {
    if (Date.now() > deadline) {
      throw new Error(
        `chrome.storage.${area} did not become available in time`,
      );
    }
    await sleep(RETRY_DELAY_MS);
  }
  return chrome.storage[area];
}

export async function storageGet<T = Record<string, unknown>>(
  keys: string[],
  area: "local" | "session" = "local",
): Promise<T> {
  const store = await waitForArea(area);
  return store.get(keys) as Promise<T>;
}

export async function storageSet(
  items: Record<string, unknown>,
  area: "local" | "session" = "local",
): Promise<void> {
  const store = await waitForArea(area);
  return store.set(items);
}

export async function storageRemove(
  keys: string | string[],
  area: "local" | "session" = "local",
): Promise<void> {
  const store = await waitForArea(area);
  return store.remove(keys);
}