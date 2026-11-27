// A Claude profile's usage limits on a host (X115), for the sidebar footer.

import { useEffect, useState } from "react";
import { rpc } from "./daemon";
import { M, type ClaudeUsage } from "./protocol";

/** How often the footer asks again while it shows. */
export const POLL_MS = 5 * 60_000;

/** Asks `host` for the usage limits of `workspace`'s Claude profile now and
 * every 5 minutes, and `refresh` asks Claude afresh; each answer goes to
 * `onUsage`. A failed ask, as from a daemon before X115, gives nothing, and
 * an answer that comes after a newer ask's is dropped. */
export function watchClaudeUsage(host: string, workspace: string | null | undefined, onUsage: (u: ClaudeUsage | null) => void): { refresh: () => void; stop: () => void } {
  let latest = 0;
  let stopped = false;
  const ask = (refresh: boolean) => {
    const n = ++latest;
    void rpc<ClaudeUsage | null>(host, M.claudeUsage, { ...(workspace ? { workspace } : {}), refresh }).then(
      (u) => {
        if (!stopped && n === latest) onUsage(u);
      },
      () => {},
    );
  };
  ask(false);
  const t = setInterval(() => ask(false), POLL_MS);
  return {
    refresh: () => ask(true),
    stop: () => {
      stopped = true;
      clearInterval(t);
    },
  };
}

/** The footer's view of [`watchClaudeUsage`]: asked again on mount and when
 * the host or workspace changes. */
export function useClaudeUsage(host: string | undefined, workspace: string | null | undefined): { usage: ClaudeUsage | null; refresh: () => void } {
  const key = host ? `${host}\u0000${workspace ?? ""}` : "";
  const [got, setGot] = useState<{ key: string; usage: ClaudeUsage | null } | null>(null);
  const [refresh, setRefresh] = useState<() => void>(() => () => {});
  useEffect(() => {
    if (!host) return;
    const w = watchClaudeUsage(host, workspace, (usage) => setGot({ key, usage }));
    setRefresh(() => w.refresh);
    return w.stop;
  }, [host, workspace, key]);
  return { usage: got?.key === key ? got.usage : null, refresh };
}
