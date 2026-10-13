// Per-row details loaded when a row shows: a session's diff stat and PR, a
// project's base branch. Kept for a minute; events do not cover them.

import { useEffect, useState } from "react";
import { rpc } from "@desktop/lib/daemon";
import { type BaseStatus, type GitStatus, M, type Project, type PullRequest, type Session } from "@desktop/lib/protocol";

const TTL = 60_000;
const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

function load<T>(key: string, f: () => Promise<T>, force = false): Promise<T> {
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.value as T);
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = f()
    .then((value) => {
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function useLoaded<T>(key: string | null, f: () => Promise<T>): [T | null, () => void] {
  const [value, setValue] = useState<T | null>(() => (key ? ((cache.get(key)?.value as T) ?? null) : null));
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!key) return;
    let live = true;
    load(key, f, tick > 0)
      .then((v) => live && setValue(v))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  return [value, () => setTick((t) => t + 1)];
}

export const useGitStatus = (host: string, s: Session | undefined, against: "base" | "head" = "base") =>
  useLoaded<GitStatus>(s ? `git:${host}:${s.id}:${against}` : null, () => rpc(host, M.gitStatus, { path: s!.path, ...(against === "base" ? { base: s!.base } : {}) }));

export const usePr = (host: string, s: Session | undefined) => useLoaded<PullRequest | null>(s ? `pr:${host}:${s.id}` : null, () => rpc(host, M.prStatus, { path: s!.path }));

export const useBase = (host: string, p: Project) =>
  useLoaded<BaseStatus | null>(`base:${host}:${p.id}`, () => rpc(host, M.gitBaseStatus, { path: p.path, branch: p.base_branch, fetch: false }));

/** True once `el` has come near the screen; rows load their details then. */
export function useSeen(): [(el: HTMLElement | null) => void, boolean] {
  const [seen, setSeen] = useState(false);
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!el || seen) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [el, seen]);
  return [setEl, seen];
}

/** Drops cached details of a session after the phone changed it. */
export function forget(prefix: string) {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}
