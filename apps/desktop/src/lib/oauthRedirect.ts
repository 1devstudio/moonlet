// MCP sign-in pages (X29): which to open in the browser, and which port the
// browser returns to, so a remote host's agent can be reached over SSH.

import type { McpServer } from "./protocol";

/** The loopback address and port of a sign-in page's `redirect_uri`, or
 *  null when the sign-in finishes elsewhere (a website, claude.ai). */
export function callbackForward(url: string): { bind: "localhost" | "127.0.0.1"; port: number } | null {
  try {
    const redirect = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
    const host = redirect.hostname;
    const port = Number(redirect.port);
    if ((host !== "localhost" && host !== "127.0.0.1") || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
    return { bind: host, port };
  } catch {
    return null;
  }
}

/** Sign-in pages that appeared since the last call; `opened` remembers
 *  them. Only http(s) pages are ever opened. */
export function pagesToOpen(servers: McpServer[], opened: Set<string>): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  for (const s of servers) {
    const url = s.status === "authing" ? s.auth_url : null;
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const key = `${s.name}\n${url}`;
    if (opened.has(key)) continue;
    opened.add(key);
    out.push({ name: s.name, url });
  }
  return out;
}
