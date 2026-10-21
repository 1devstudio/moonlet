// Settings › Phones (X39, X43): phone access over Tailscale, pairing and the
// paired phones, as the section shows them.

import type { DeviceKind, MobileDevice, MobileStatus } from "./protocol";

/** The line under the switch. */
export function mobileLine(st: MobileStatus): string {
  if (!st.enabled) return "Off";
  if (!st.tailscale) return "Tailscale is not running on this Mac";
  if (st.listening.length === 0) return "Starting…";
  return `Listening on ${st.listening.join(", ")}`;
}

/** "just now", "5 min ago", "2 h ago", "3 days ago". */
export function ago(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  const days = Math.floor(ms / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** A paired phone's second line: "paired 3 days ago · last seen 2 h ago". */
export function deviceLine(d: MobileDevice, now: number): string {
  const seen = d.connected ? "connected" : d.last_seen === null ? "not seen since" : `last seen ${ago(now - d.last_seen)}`;
  return `paired ${ago(now - d.created_at)} · ${seen}`;
}

/** "Expires in 4:59" under the QR code. */
export function countdown(expiresAt: number, now: number): string {
  const s = Math.ceil((expiresAt - now) / 1000);
  if (s <= 0) return "Expired";
  return `Expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Why a pairing code stopped working (`mobile.pair_ended`). */
export function pairEndedText(reason: string): string {
  switch (reason) {
    case "too_many_attempts":
      return "Too many wrong attempts. Start again.";
    case "expired":
      return "The code expired. Start again.";
    default:
      return "Pairing was cancelled.";
  }
}

/** The paired devices of one kind (X57); a device from before X57 is a phone. */
export function devicesOfKind(st: MobileStatus, kind: DeviceKind): MobileDevice[] {
  return st.devices.filter((d) => (d.kind ?? "phone") === kind);
}
