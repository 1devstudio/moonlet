// The slash commands Claude Code offers in a project's folder on each host
// (X110), for the new-session Composer, which has no chat to read them from.

import { useEffect } from "react";
import { create } from "zustand";
import { rpc } from "./daemon";
import { M } from "./protocol";

const useCommands = create<{ known: Record<string, string[]> }>(() => ({ known: {} }));

const keyOf = (host: string, project: string, workspace: string | null | undefined) => `${host}\u0000${project}\u0000${workspace ?? ""}`;

/** The newest ask for each key: an older answer that comes later is dropped. */
const asked = new Map<string, number>();
let asks = 0;

/** Claude's slash commands in `project` on `host`, in `workspace`'s Claude
 * profile: the last answer at once, asked again on each mount (the daemon
 * keeps it for minutes). Nothing is asked without a host, as while another
 * agent is picked; a failed ask, as from a daemon before X110, keeps the list. */
export function useClaudeCommands(host: string | undefined, project: string | undefined, workspace: string | null | undefined): string[] {
  const key = host && project ? keyOf(host, project, workspace) : "";
  const commands = useCommands((s) => s.known[key]);
  useEffect(() => {
    if (!host || !project) return;
    const ask = ++asks;
    asked.set(key, ask);
    void rpc<string[]>(host, M.claudeCommands, workspace ? { project_id: project, workspace } : { project_id: project }).then(
      (got) => {
        if (asked.get(key) === ask) useCommands.setState((s) => ({ known: { ...s.known, [key]: got } }));
      },
      () => {},
    );
  }, [host, project, workspace, key]);
  return commands ?? EMPTY;
}

const EMPTY: string[] = [];
