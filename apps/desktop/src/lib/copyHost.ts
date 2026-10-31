// A session another member owns, followed through the central host (X72).
// Its "copy host" id names the central host and the session; a call to it
// goes to the central host, which passes it on to the member running the
// session, or answers from its copy while that member is away. Screens use
// a copy host as they use any host.

const SEP = "#copy:";

export function copyHostId(host: string, session: string): string {
  return `${host}${SEP}${session}`;
}

export function parseCopyHost(id: string): { host: string; session: string } | null {
  const i = id.lastIndexOf(SEP);
  if (i <= 0 || i + SEP.length >= id.length) return null;
  return { host: id.slice(0, i), session: id.slice(i + SEP.length) };
}

/** How a call to copy host `id` goes to its central host: the session's
 * terminals by `session.attach` and the relay id `relayOf` gives once
 * attached, anything else as `session.forward`. Null: nothing to send. */
export function routeCall(
  id: string,
  method: string,
  params: unknown,
  relayOf: (terminal: number) => number | undefined,
): { host: string; method: string; params: unknown } | null {
  const copy = parseCopyHost(id);
  if (!copy) return null;
  const p = (params ?? {}) as { id?: number; cols?: number; rows?: number };
  if (method === "terminal.attach") {
    return { host: copy.host, method: "session.attach", params: { session: copy.session, terminal: p.id, cols: p.cols, rows: p.rows } };
  }
  if (method === "terminal.detach") {
    const relay = p.id === undefined ? undefined : relayOf(p.id);
    return relay === undefined ? null : { host: copy.host, method: "session.detach", params: { relay } };
  }
  return { host: copy.host, method: "session.forward", params: { session: copy.session, method, params } };
}

/** A `session.event` from a central host, as the event of the copy host
 * of its session; null for any other event. */
export function unwrapEvent(e: { host: string; name: string; data: unknown }): { host: string; name: string; data: unknown } | null {
  if (e.name !== "session.event") return null;
  const d = e.data as { session?: string; event?: { name?: string; data?: unknown } };
  if (!d?.session || !d.event?.name) return null;
  return { host: copyHostId(e.host, d.session), name: d.event.name, data: d.event.data };
}

/** Relay ids start here (X72): above every host's own terminal ids. */
export const RELAY_MIN = 0x4000_0000;

/** Output for a relay id no screen follows yet: the central host can send
 * it right after the attach reply, before the reply's relay id is known
 * here. Kept, a few hundred pieces at most, until it is. */
export class EarlyOutput {
  private held = new Map<string, { reset: boolean; data: Uint8Array }[]>();

  /** Keeps output for `key` (`<host>:<relay>`); false when `relay` is not
   * a relay id, so there is nothing to wait for. */
  keep(key: string, relay: number, reset: boolean, data: Uint8Array): boolean {
    if (relay < RELAY_MIN) return false;
    const list = this.held.get(key) ?? [];
    if (list.length < 512) list.push({ reset, data: data.slice() });
    this.held.set(key, list);
    return true;
  }

  /** What was kept for `key`, oldest first; once. */
  take(key: string): { reset: boolean; data: Uint8Array }[] {
    const list = this.held.get(key) ?? [];
    this.held.delete(key);
    return list;
  }
}

/** Attaches on their way to a copy host's terminals (X72): a screen that
 * leaves before the reply comes has its relay let go of when it does. */
export class PendingAttaches {
  private pending = new Map<string, boolean>();

  start(key: string) {
    this.pending.set(key, false);
  }

  /** The screen left `key`; true while its attach is still on its way. */
  leave(key: string): boolean {
    if (!this.pending.has(key)) return false;
    this.pending.set(key, true);
    return true;
  }

  /** The attach of `key` answered; true when its screen left meanwhile. */
  done(key: string): boolean {
    const left = this.pending.get(key) === true;
    this.pending.delete(key);
    return left;
  }
}
