import type { DeviceInfo } from "@flowbridge/protocol";
import { storageGet, storageSet } from "./storage";

const KEY = "flowbridge.device";

export async function getDevice(): Promise<DeviceInfo> {
  const res = await storageGet<Record<string, DeviceInfo>>([KEY]);
  if (res[KEY]) return res[KEY] as DeviceInfo;
  const device: DeviceInfo = {
    deviceId: crypto.randomUUID(),
    role: "laptop",
    label: "Windows Laptop",
  };
  await storageSet({ [KEY]: device });
  return device;
}