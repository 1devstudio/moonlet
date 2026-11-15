// The models Claude Code offers on each host, per workspace's Claude profile
// (X105), for the new-session Composer, which has no chat to read them from.

import { useEffect } from "react";
import { create } from "zustand";
import { rpc } from "./daemon";
import { M, type ClaudeModel } from "./protocol";

const useModels = create<{ known: Record<string, ClaudeModel[]> }>(() => ({ known: {} }));

const keyOf = (host: string, workspace: string | null | undefined) => `${host}\u0000${workspace ?? ""}`;

/** The models Claude Code offers in `workspace` on `host`: the last answer at
 * once, asked again on each mount; empty when the host cannot say (a daemon
 * from before X105). */
export function useClaudeModels(host: string | undefined, workspace: string | null | undefined): ClaudeModel[] {
  const key = host ? keyOf(host, workspace) : "";
  const models = useModels((s) => s.known[key]);
  useEffect(() => {
    if (!host) return;
    void rpc<ClaudeModel[]>(host, M.claudeModels, workspace ? { workspace } : {})
      .catch(() => [] as ClaudeModel[])
      .then((got) => {
        // An empty answer never hides a list the host gave before.
        if (got.length || !useModels.getState().known[key]) useModels.setState((s) => ({ known: { ...s.known, [key]: got } }));
      });
  }, [host, workspace, key]);
  return models ?? EMPTY;
}

const EMPTY: ClaudeModel[] = [];
