// Ghost-text suggestions and history for the shell input editor (T6).

import { rpc } from "./daemon";
import { M } from "./protocol";

/** Remainder of the newest history entry that extends `input`, if any. */
export function suggest(history: readonly string[], input: string): string | null {
  if (!input.trim()) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.length > input.length && h.startsWith(input)) return h.slice(input.length);
  }
  return null;
}

/** The first word of a suggestion remainder (with its leading spaces). */
export function firstWord(rest: string): string {
  const m = /^\s*\S+/.exec(rest);
  return m ? m[0] : rest;
}

export function commonPrefix(items: readonly string[]): string {
  if (!items.length) return "";
  let p = items[0];
  for (const s of items.slice(1)) {
    let i = 0;
    while (i < p.length && i < s.length && p[i] === s[i]) i++;
    p = p.slice(0, i);
  }
  return p;
}

const cache = new Map<string, string[]>();
const loading = new Map<string, Promise<string[]>>();

/** Shell history of a host, loaded once and extended locally as commands run. */
export function historyFor(host: string): Promise<string[]> {
  const hit = cache.get(host);
  if (hit) return Promise.resolve(hit);
  let p = loading.get(host);
  if (!p) {
    p = rpc<string[]>(host, M.shellHistory, {})
      .catch(() => [] as string[])
      .then((h) => {
        cache.set(host, h);
        loading.delete(host);
        return h;
      });
    loading.set(host, p);
  }
  return p;
}

export function rememberCommand(host: string, cmd: string) {
  const h = cache.get(host) ?? [];
  const i = h.lastIndexOf(cmd);
  if (i >= 0) h.splice(i, 1);
  h.push(cmd);
  cache.set(host, h);
}
