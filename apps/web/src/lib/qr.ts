import QRCode from "qrcode";
import jsQR from "jsqr";

/**
 * The QR code encodes a deep link back into this same web app:
 *   https://<this-app>/?pair=82K9-XP4Q
 * This means on many phones, simply opening the PHONE'S NATIVE camera app
 * and pointing it at the laptop's QR code is enough — Android shows a
 * notification to open the link, which lands directly on this app with the
 * code pre-filled and auto-connects. No separate "scanner app" needed.
 *
 * The in-app scanner (using the phone's camera via getUserMedia + jsQR) is
 * offered as a one-tap alternative for people who'd rather stay inside the
 * FlowBridge app than switch to the camera app.
 */

export function buildPairDeepLink(code: string): string {
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set("pair", code);
  return url.toString();
}

export async function generateQrDataUrl(code: string): Promise<string> {
  const link = buildPairDeepLink(code);
  return QRCode.toDataURL(link, {
    margin: 1,
    width: 220,
    color: { dark: "#0f172a", light: "#ffffff" },
  });
}

export function extractCodeFromScan(text: string): string | null {
  // Accept either a bare code ("82K9-XP4Q") or our deep link
  // ("https://.../?pair=82K9-XP4Q") — whichever the QR happened to encode.
  try {
    const url = new URL(text);
    const fromParam = url.searchParams.get("pair");
    if (fromParam) return fromParam.toUpperCase();
  } catch {
    /* not a URL, fall through to treat it as a raw code */
  }
  const cleaned = text.trim().toUpperCase();
  if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(cleaned)) return cleaned;
  return null;
}

export interface ScannerHandle {
  stop: () => void;
}

/**
 * Opens the device camera and continuously scans frames for a QR code.
 * Calls onResult once with the decoded pairing code and stops itself.
 * Uses requestAnimationFrame (tied to actual video frame availability),
 * not a fixed-interval poll, so it's efficient and stops instantly.
 */
export async function startQrScanner(
  videoEl: HTMLVideoElement,
  onResult: (code: string) => void,
  onError: (message: string) => void
): Promise<ScannerHandle> {
  let stopped = false;
  let stream: MediaStream | null = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
  } catch {
    onError("Camera permission denied or unavailable. You can still type the code manually.");
    return { stop: () => {} };
  }

  videoEl.srcObject = stream;
  await videoEl.play();

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const tick = () => {
    if (stopped) return;
    if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA && ctx) {
      canvas.width = videoEl.videoWidth;
      canvas.height = videoEl.videoHeight;
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(imageData.data, imageData.width, imageData.height);
      if (result?.data) {
        const code = extractCodeFromScan(result.data);
        if (code) {
          stopScanner();
          onResult(code);
          return;
        }
      }
    }
    requestAnimationFrame(tick);
  };

  function stopScanner() {
    stopped = true;
    stream?.getTracks().forEach((t) => t.stop());
  }

  requestAnimationFrame(tick);
  return { stop: stopScanner };
}
