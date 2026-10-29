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
