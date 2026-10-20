// The `moonlet://pair` link a host shows in Settings (X39, X57) or prints with
// `moonletd pair`, as a QR code or as text to paste. The phone app imports it
// from here.

export interface PairLink {
  /** The host's name. */
  host: string;
  /** `ip:port`s to try, in order. */
  addrs: string[];
  /** The one-time pairing code: 10 characters of Crockford's base32 (X57),
   * or 32 hex digits from a daemon before X57. */
  code: string;
}

/** A pairing code: 10 characters of Crockford's base32, as the daemon makes them (X57). */
export const SHORT_CODE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/** The link's parts, or null for anything that is not a version 1 pairing link. */
export function parsePairLink(text: string): PairLink | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  // `moonlet://pair?…`: WebKit puts "pair" in the host, others in the path.
  const target = url.host || url.pathname.replace(/^\/+/, "");
  if (url.protocol !== "moonlet:" || target !== "pair") return null;
  const q = url.searchParams;
  if (q.get("v") !== "1") return null;
  const code = q.get("code") ?? "";
  const addrs = q.getAll("addr").filter(Boolean);
  const short = SHORT_CODE.test(code);
  if (!(short || /^[0-9a-f]{32}$/.test(code)) || addrs.length === 0) return null;
  return { host: q.get("host") || "Mac", addrs, code };
}
