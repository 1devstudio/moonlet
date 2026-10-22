// This Mac's link to its central host (X41): the status line under "Use this
// Mac for heavy commands", and which host row is the central host.

import { DaemonError } from "./daemon";
import { M, type HostInfo, type LinkInfo } from "./protocol";
import type { StatusLine } from "./settingsPage";

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
    case "refused":
      return { tone: "error", text: `${name} no longer accepts this Mac. Pair it again.` };
    case "error":
      return { tone: "error", text: s.message };
    case "off":
      return { tone: "muted", text: "Not linked" };
  }
}

/** Retry goes with a connection error, and with an update made on the
 * central host; a host that removed this Mac needs pairing again instead,
 * from its row. */
export function linkRetries(link: LinkInfo): boolean {
  return link.state.kind === "error" || link.state.kind === "needs_update";
}

/** How a remote host's link stands against this Mac's central host (X61):
 * this Mac has none, the host has none, it has another, or it has this one,
 * which may have removed it. */
function remoteLink(link: LinkInfo, central: string | null): "no-central" | "unpaired" | "other" | "refused" | "ours" {
  const name = link.central?.name;
  if (!central) return "no-central";
  if (!name) return "unpaired";
  if (name !== central) return "other";
  return link.state.kind === "refused" ? "refused" : "ours";
}

/** The line under a remote host's "Use for heavy commands" (X61), for its
 * link `link` and this Mac's central host `central`. */
export function remoteLinkLine(link: LinkInfo, host: string, central: string | null): StatusLine {
  switch (remoteLink(link, central)) {
    case "no-central":
      return { tone: "muted", text: "Choose a central host first" };
    case "unpaired":
      return { tone: "muted", text: "Not linked" };
    case "other":
      return link.state.kind === "off" ? { tone: "muted", text: "Not linked" } : { tone: "blocked", text: `Linked to ${link.central?.name}, not to ${central}` };
    case "refused":
      return { tone: "error", text: `${central} no longer accepts ${host}` };
    case "ours":
      return linkLine(link);
  }
}

/** The button beside a remote host's line (X61): Retry as for this Mac, or
 * Pair again once this Mac's central host has removed the host. */
export function remoteLinkAction(link: LinkInfo, central: string | null): "retry" | "pair-again" | null {
  const stands = remoteLink(link, central);
  if (stands === "refused") return "pair-again";
  return stands === "ours" && linkRetries(link) ? "retry" : null;
}

/** Whether a remote host's switch is on (X61): it takes heavy commands for
 * this Mac's central host, not for another one. */
export function remoteSwitchOn(link: LinkInfo, central: string | null): boolean {
  const stands = remoteLink(link, central);
  return link.worker.enabled && (stands === "ours" || stands === "refused");
}

/** What turning a remote host's switch on takes (X61): only `link.set` when
 * `host` is paired with this Mac's central host `central`, or else a
 * pairing code for `link.pair` first, after asking `confirm` when that moves
 * the host off another central host. */
export function turnOnNeeds(link: LinkInfo, host: string, central: string): { kind: "enable" } | { kind: "pair"; confirm?: string } {
  switch (remoteLink(link, central)) {
    case "ours":
      return { kind: "enable" };
    case "other":
      return { kind: "pair", confirm: `${host} is linked to ${link.central?.name}. Link it to ${central} instead?` };
    default:
      return { kind: "pair" };
  }
}

/** Pairs a remote host with the central host using `code`, then turns its
 * link on (X61), through `call`, the host's RPC. Once paired, the code is
 * used up, so a failure to turn the link on still counts as paired. */
export async function pairThenLink(
  call: (method: string, params: unknown) => Promise<unknown>,
  central: { name: string; addrs: string[] },
  code: string,
): Promise<{ paired: boolean; error: unknown }> {
  try {
    await call(M.linkPair, { central: { name: central.name, addrs: central.addrs }, code });
  } catch (error) {
    return { paired: false, error };
  }
  try {
    await call(M.linkSet, { worker: { enabled: true } });
    return { paired: true, error: null };
  } catch (error) {
    return { paired: true, error };
  }
}

/** What a failed `link.pair` or `link.set` on a remote host `host` says
 * (X61). A host from before X61 does not know `link.pair` and refuses a
 * paired Mac's `link.set`: it needs an update. */
export function remoteLinkError(e: unknown, host: string): string {
  if (e instanceof DaemonError && (e.code === "unknown_method" || e.code === "forbidden")) return `Update moonlet on ${host}`;
  return e instanceof Error ? e.message : String(e);
}

/** The host row that is the central host: the tailnet host the link goes to.
 * A tailnet host's id is its name on the tailnet, as the link's is. */
export function centralHostId(hosts: HostInfo[], link: LinkInfo | null): string | null {
  const name = link?.central?.name;
  return hosts.find((h) => h.kind === "tailnet" && h.id === name)?.id ?? null;
}

/** The remote hosts with a "Use for heavy commands" switch (X61): connected
 * tailnet hosts, but not the central host, which never links to itself. */
export function heavyHostIds(hosts: HostInfo[], central: string | null): string[] {
  return hosts.filter((h) => h.kind === "tailnet" && h.status === "connected" && h.id !== central).map((h) => h.id);
}

/** Choosing a host makes it the central host; choosing it again clears it. */
export function pickCentral(current: string | null, picked: string): string | null {
  return current === picked ? null : picked;
}

/** A host row's central host button names what clicking it does, so it never
 * reads as a label: make this host the central host, or clear it. */
export function centralHostButton(central: string | null, host: string): { label: string; title: string } {
  return central === host
    ? { label: "Clear central host", title: `${host} is this Mac's central host. Click to clear it.` }
    : { label: "Make central host", title: `Make ${host} this Mac's central host` };
}

/**
 * Follows the link's settings and state: `link.changed` events, and a
 * `link.get` snapshot at the start and each time this Mac's daemon is back.
 * A snapshot asked for before the latest event is older than it, and is
 * dropped. Returns a function that stops following.
 */
export function watchLink(io: {
  get: () => Promise<LinkInfo>;
  onChanged: (cb: (link: LinkInfo) => void) => () => void;
  onReconnected: (cb: () => void) => () => void;
  set: (link: LinkInfo | null) => void;
}): () => void {
  let stopped = false;
  let events = 0;
  const read = () => {
    const asked = events;
    io.get().then(
      (link) => {
        if (!stopped && asked === events) io.set(link);
      },
      () => {
        if (!stopped && asked === events) io.set(null);
      },
    );
  };
  const offChanged = io.onChanged((link) => {
    if (stopped) return;
    events += 1;
    io.set(link);
  });
  const offReconnected = io.onReconnected(() => {
    if (!stopped) read();
  });
  read();
  return () => {
    stopped = true;
    offChanged();
    offReconnected();
  };
}
