// Row details (X40): a session's diff stat and PR, a project's base
// branch, loaded when a row shows and kept for a minute (detailsCache.ts):
// the daemon sends no events about them.

import { useEffect, useState } from "react";
import { latestOnly } from "@desktop/lib/prStack";
import { rpc } from "@desktop/lib/daemon";
import { detailsCache } from "./detailsCache";
import { type BaseStatus, type GitStatus, M, type Project, type PullRequest, type Session } from "@desktop/lib/protocol";

const cache = detailsCache(60_000);

/** The value, or undefined until the first answer. */
function useLoaded<T>(key: string | null, f: () => Promise<T>): [T | undefined, () => void] {
  const [value, setValue] = useState<T | undefined>(() => (key ? cache.peek<T>(key) : undefined));
  const [tick, setTick] = useState(0);
  // A reply for an earlier key (another session, base or HEAD) is dropped.
  const [latest] = useState(latestOnly);
  useEffect(() => {
    if (!key) return;
    // Another key (a session, base or HEAD): never show the last one's value.
    setValue(cache.peek<T>(key));
    const isLatest = latest.start();
    cache
      .load(key, f, tick > 0)
      .then((v) => isLatest() && setValue(v))
      .catch(() => {});
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
export const forget = (prefix: string) => cache.forget(prefix);

/** The PRs and diff stats of `sessions` on `host`, as each loads, for a board's rows (X76). */
export function useSessionsDetails(host: string | null, sessions: Session[]): { prs: Record<string, PullRequest | null | undefined>; git: Record<string, GitStatus | undefined> } {
  const [, setTick] = useState(0);
  // Read again once the cache lets them go (a minute), while the board shows.
  const [round, setRound] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setRound((r) => r + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const ids = sessions.map((s) => s.id).join(",");
  useEffect(() => {
    if (!host) return;
    let live = true;
    const bump = () => live && setTick((t) => t + 1);
    for (const s of sessions) {
      if (s.archived) continue;
      cache.load(`pr:${host}:${s.id}`, () => rpc(host, M.prStatus, { path: s.path })).then(bump, () => {});
      cache.load(`git:${host}:${s.id}:base`, () => rpc(host, M.gitStatus, { path: s.path, base: s.base })).then(bump, () => {});
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, ids, round]);
  if (!host) return { prs: {}, git: {} };
  return {
    prs: Object.fromEntries(sessions.map((s) => [s.id, cache.peek<PullRequest | null>(`pr:${host}:${s.id}`)])),
    git: Object.fromEntries(sessions.map((s) => [s.id, cache.peek<GitStatus>(`git:${host}:${s.id}:base`)])),
  };
}
