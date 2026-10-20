// What the user put in the Add host dialog (X57): a pairing link, which
// names the host and its addresses, or a code typed from the host's screen.

import { parsePairLink } from "./pairLink";

export type AddHostInput =
  | { kind: "link"; name: string; addrs: string[]; code: string }
  | { kind: "code"; code: string }
  | { kind: "invalid"; message: string }
  | { kind: "empty" };

/** Crockford's base32, as the daemon makes codes. */
const CODE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/** A typed code as the daemon reads it: uppercase, no spaces or dashes,
 * O as 0, and I and L as 1. */
export function normalizeCode(typed: string): string {
  return typed
    .replace(/[\s-]/g, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function readAddHostInput(text: string): AddHostInput {
  if (!text.trim()) return { kind: "empty" };
  const link = parsePairLink(text);
  if (link) return { kind: "link", name: link.host, addrs: link.addrs, code: link.code };
  const code = normalizeCode(text);
  if (CODE.test(code)) return { kind: "code", code };
  return { kind: "invalid", message: "This is not a pairing link or code." };
}
