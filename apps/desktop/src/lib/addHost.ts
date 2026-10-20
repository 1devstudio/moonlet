// What the user put in the Add host dialog (X57): a pairing link, which
// names the host and its addresses, or a code typed from the host's screen.

import { SHORT_CODE, parsePairLink } from "./pairLink";

export type AddHostInput =
  | { kind: "link"; name: string; addrs: string[]; code: string }
  | { kind: "code"; code: string }
  | { kind: "invalid"; message: string }
  | { kind: "empty" };

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
  if (SHORT_CODE.test(code)) return { kind: "code", code };
  return { kind: "invalid", message: "This is not a pairing link or code." };
}

/** `7KQ2MX9PDA` as `7KQ2M-X9PDA`, easier to read and type; an older code as it is. */
export function displayCode(code: string): string {
  return SHORT_CODE.test(code) ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

/** Whether Add can pair: a link, or a code with a name; for SSH, an alias. */
export function addHostReady(form: { ssh: true; alias: string } | { ssh?: false; text: string; name: string }): boolean {
  if (form.ssh) return !!form.alias.trim();
  const input = readAddHostInput(form.text);
  return input.kind === "link" || (input.kind === "code" && !!form.name.trim());
}
