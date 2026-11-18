// A session's key across hosts, `host/session`: built by `sesKey`, read back
// by `parseSesKey`, the one pair for the format. A session id never has a
// slash; a host id may, so the last one splits them.

export const sesKey = (host: string, id: string) => `${host}/${id}`;

export function parseSesKey(key: string): { host: string; id: string } {
  const at = key.lastIndexOf("/");
  return { host: key.slice(0, at), id: key.slice(at + 1) };
}
