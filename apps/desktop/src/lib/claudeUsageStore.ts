// A Claude profile's usage limits on a host (X115), for the sidebar footer.

import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "./daemon";
import { M, type ClaudeUsage } from "./protocol";

/** How often the footer asks again while it shows. */
const POLL_MS = 5 * 60_000;

/** The usage limits of `workspace`'s Claude profile on `host`: asked on
 * mount, when the workspace changes and every 5 minutes; `refresh` asks
 * Claude afresh. A failed ask, as from a daemon before X115, keeps the
 * last answer. */
export function useClaudeUsage(host: string | undefined, workspace: string | null | undefined): { usage: ClaudeUsage | null; refresh: () => void } {
  const key = host ? `${host}\u0000${workspace ?? ""}` : "";
  const [got, setGot] = useState<{ key: string; usage: ClaudeUsage | null } | null>(null);
  const latest = useRef(0);
  const ask = useCallback(
    (refresh: boolean) => {
      if (!host) return;
      const n = ++latest.current;
      void rpc<ClaudeUsage | null>(host, M.claudeUsage, { ...(workspace ? { workspace } : {}), refresh }).then(
        (usage) => {
          if (latest.current === n) setGot({ key, usage });
        },
        () => {},
      );
    },
    [host, workspace, key],
  );
  useEffect(() => {
    ask(false);
    const t = window.setInterval(() => ask(false), POLL_MS);
    return () => window.clearInterval(t);
  }, [ask]);
  return { usage: got?.key === key ? got.usage : null, refresh: useCallback(() => ask(true), [ask]) };
}
