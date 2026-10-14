// Phone-only abilities (camera, Face ID, haptics). The macOS build of the
// app, used for development, has none of them: each call says so or
// does nothing.

export const onPhone = import.meta.env.TAURI_ENV_PLATFORM === "ios" || import.meta.env.TAURI_ENV_PLATFORM === "android";

/** Scans a QR code with the camera; null when cancelled or unavailable. */
export async function scanQr(): Promise<string | null> {
  if (!onPhone) return null;
  const { scan, Format, requestPermissions } = await import("@tauri-apps/plugin-barcode-scanner");
  if ((await requestPermissions()) !== "granted") return null;
  try {
    return (await scan({ formats: [Format.QRCode], windowed: false })).content;
  } catch {
    return null;
  }
}

/** Asks for Face ID (or the passcode); true when the user passed. */
export async function confirmWithFaceId(reason: string): Promise<boolean> {
  if (!onPhone) return true;
  const { authenticate } = await import("@tauri-apps/plugin-biometric");
  try {
    await authenticate(reason, { allowDeviceCredential: true, cancelTitle: "Cancel" });
    return true;
  } catch {
    return false;
  }
}

export async function tap(kind: "light" | "success" | "warning" = "light") {
  if (!onPhone) return;
  const h = await import("@tauri-apps/plugin-haptics");
  await (kind === "light" ? h.impactFeedback("light") : h.notificationFeedback(kind)).catch(() => {});
}

/** The name the Mac lists this phone under. */
export const deviceName = () => (onPhone ? "iPhone" : "Phone (dev build)");
