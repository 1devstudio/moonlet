// This Mac's link to its central host (X41): the status line under "Use this
// Mac for heavy commands", and which host row has the Central host choice.

import type { HostInfo, LinkInfo } from "./protocol";
import type { StatusLine } from "./settingsPage";

/** The daemon's message when the central host removed this Mac's device. */
const refused = (name: string) => `${name} no longer accepts this Mac`;

const time = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** The line under "Use this Mac for heavy commands", one per link state. */
export function linkLine(link: LinkInfo): StatusLine {
  const name = link.central?.name ?? "";
  const s = link.state;
  switch (s.kind) {
    case "connecting":
      return { tone: "blocked", text: `Linking to ${name}…` };
    case "connected":
      return { tone: "done", text: `Linked to ${name} since ${time(s.since)}` };
    case "reconnecting":
      return { tone: "blocked", text: `Reconnecting to ${name}…` };
    case "needs_update":
      return { tone: "error", text: `Update moonlet on ${name}` };
    case "error":
      return { tone: "error", text: s.message === refused(name) ? `${s.message}. Pair it again.` : s.message };
    default:
      return { tone: "muted", text: "Not linked" };
  }
}

/** Retry goes with a connection error; a host that removed this Mac needs
 * pairing again instead, from its row. */
export function linkRetries(link: LinkInfo): boolean {
  return link.state.kind === "error" && link.state.message !== refused(link.central?.name ?? "");
}

/** The host row that is the central host: the tailnet host the link goes to.
 * A tailnet host's id is its name on the tailnet, as the link's is. */
export function centralHostId(hosts: HostInfo[], link: LinkInfo | null): string | null {
  const name = link?.central?.name;
  return hosts.find((h) => h.kind === "tailnet" && h.id === name)?.id ?? null;
}

/** Choosing a host makes it the central host; choosing it again clears it. */
export function pickCentral(current: string | null, picked: string): string | null {
  return current === picked ? null : picked;
}
