// The models Claude Code offers on each host, per workspace's Claude profile
// (X105), for the new-session Composer, which has no chat to read them from.

import { useEffect } from "react";
import { create } from "zustand";
import { rpc } from "./daemon";
import { M, type ClaudeModel } from "./protocol";

const useModels = create<{ known: Record<string, ClaudeModel[]> }>(() => ({ known: {} }));

const keyOf = (host: string, workspace: string | null | undefined) => `${host}\u0000${workspace ?? ""}`;

/** The newest ask for each key: an older answer that comes later is dropped. */
const asked = new Map<string, number>();
let asks = 0;

/** The models Claude Code offers in `workspace` on `host`: the last answer at
 * once, asked again on each mount. An empty answer replaces the list (the
 * workspace may have moved to a profile that cannot say); a failed ask, as
 * from a daemon before X105, keeps it. */
export function useClaudeModels(host: string | undefined, workspace: string | null | undefined): ClaudeModel[] {
  const key = host ? keyOf(host, workspace) : "";
  const models = useModels((s) => s.known[key]);
  useEffect(() => {
    if (!host) return;
    const ask = ++asks;
    asked.set(key, ask);
    void rpc<ClaudeModel[]>(host, M.claudeModels, workspace ? { workspace } : {}).then(
      (got) => {
        if (asked.get(key) === ask) useModels.setState((s) => ({ known: { ...s.known, [key]: got } }));
      },
      () => {},
    );
  }, [host, workspace, key]);
  return models ?? EMPTY;
}

const EMPTY: ClaudeModel[] = [];
