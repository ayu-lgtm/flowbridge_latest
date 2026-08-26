import { storageGet, storageSet } from "./storage";

const KEY = "flowbridge.serverUrl";
const DEFAULT_URL = "wss://your-signaling-server.example.com";

const WEB_APP_KEY = "flowbridge.webAppUrl";
const DEFAULT_WEB_APP_URL = "https://your-flowbridge-app.netlify.app";

export async function getServerUrl(): Promise<string> {
  const res = await storageGet<Record<string, string>>([KEY]);
  return res[KEY] || DEFAULT_URL;
}

/**
 * True until the user has actually pasted their deployed server's wss://
 * URL into "Signaling server settings". Left unset, the extension used to
 * silently try (and fail) to connect to the literal placeholder domain
 * `your-signaling-server.example.com`, which shows up to the user as an
 * unexplained connection error with no hint of what to do about it. The
 * popup now checks this first and shows a clear setup screen instead.
 */
export async function isServerConfigured(): Promise<boolean> {
  const url = await getServerUrl();
  return url !== DEFAULT_URL && url.trim().length > 0;
}

export async function setServerUrl(url: string): Promise<void> {
  await storageSet({ [KEY]: url });
}

/** The deployed URL of the Android web app — used to build the pairing QR deep link. */
export async function getWebAppUrl(): Promise<string> {
  const res = await storageGet<Record<string, string>>([WEB_APP_KEY]);
  return res[WEB_APP_KEY] || DEFAULT_WEB_APP_URL;
}

export async function setWebAppUrl(url: string): Promise<void> {
  await storageSet({ [WEB_APP_KEY]: url });
}