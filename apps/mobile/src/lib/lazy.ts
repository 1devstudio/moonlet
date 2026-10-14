// Per-row details loaded when a row shows: a session's diff stat and PR, a
// project's base branch. Kept for a minute; events do not cover them.

import { useEffect, useState } from "react";
import { latestOnly } from "@desktop/lib/prStack";
import { rpc } from "@desktop/lib/daemon";
import { detailsCache } from "./detailsCache";
import { type BaseStatus, type GitStatus, M, type Project, type PullRequest, type Session } from "@desktop/lib/protocol";

const cache = detailsCache(60_000);

function useLoaded<T>(key: string | null, f: () => Promise<T>): [T | null, () => void] {
  const [value, setValue] = useState<T | null>(() => (key ? (cache.peek<T>(key) ?? null) : null));
  const [tick, setTick] = useState(0);
  // A reply for an earlier key (another session, base or HEAD) is dropped.
  const [latest] = useState(latestOnly);
  useEffect(() => {
    if (!key) return;
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
