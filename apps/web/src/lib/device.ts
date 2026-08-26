import type { DeviceInfo } from "@flowbridge/protocol";

const STORAGE_KEY = "flowbridge.device";

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function guessLabel(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "Android Phone";
  if (/Windows/i.test(ua)) return "Windows Laptop";
  return "This Device";
}

export function getDevice(): DeviceInfo {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as DeviceInfo;
    } catch {
      /* fall through and recreate */
    }
  }
  const device: DeviceInfo = {
    deviceId: randomId(),
    role: /Android/i.test(navigator.userAgent) ? "phone" : "laptop",
    label: guessLabel(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(device));
  return device;
}

export function renameDevice(label: string): DeviceInfo {
  const device = getDevice();
  device.label = label;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(device));
  return device;
}
