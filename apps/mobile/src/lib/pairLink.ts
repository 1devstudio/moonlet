// The `moonlet://pair` link a Mac shows in Settings › Mobile (X39), as a QR
// code or as text to paste.

export interface PairLink {
  /** The Mac's name. */
  host: string;
  /** `ip:port`s to try, in order. */
  addrs: string[];
  /** The one-time pairing code, 32 hex digits. */
  code: string;
}

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
  if (!/^[0-9a-f]{32}$/.test(code) || addrs.length === 0) return null;
  return { host: q.get("host") || "Mac", addrs, code };
}
