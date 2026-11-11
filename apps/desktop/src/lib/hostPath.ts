// A path on a host, as one string: the key of `dirtyFiles` and `fsVersion`.

export const hostPath = (host: string, path: string) => `${host}|${path}`;

/** The path of a `hostPath` key on `host`, or null for another host's key. */
export function pathOn(host: string, key: string): string | null {
  const prefix = hostPath(host, "");
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}
