// Claude Code on remote hosts (X109): asks each host its version, runs
// `claude update` there, and follows the run from that host's events. The
// run is read as X36 reads one on this Mac.

import { create } from "zustand";
import { afterClaudeUpdateExit, afterClaudeUpdateLine, type ClaudeUpdateRun } from "./claudeUpdate";
import { rpc } from "./daemon";
import { NOT_ASKED, type HostClaude } from "./hostClaude";
import { EV, M } from "./protocol";

export const useHostClaude = create<{ hosts: Record<string, HostClaude> }>(() => ({ hosts: {} }));

const now = (id: string) => useHostClaude.getState().hosts[id] ?? NOT_ASKED;
const put = (id: string, patch: (c: HostClaude) => Partial<HostClaude>) =>
  useHostClaude.setState((s) => {
    const c = s.hosts[id] ?? NOT_ASKED;
    return { hosts: { ...s.hosts, [id]: { ...c, ...patch(c) } } };
  });

/** Counts updates started or ended per host, so a check that began before
 * one does not put back the version or the line from before it. */
const runs = new Map<string, number>();
const bump = (id: string) => runs.set(id, (runs.get(id) ?? 0) + 1);

const message = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e));

/** Asks host `id` which Claude Code it runs. A check replaces a result
 * shown, leaves a running update alone, and shows one started elsewhere. */
export async function checkHostClaude(id: string, latest: string | null): Promise<void> {
  const seen = runs.get(id);
  put(id, () => ({ checking: true }));
  let answer: { version: string | null; updating: boolean } | null;
  try {
    answer = await rpc<{ version: string | null; updating: boolean }>(id, M.claudeVersion);
  } catch {
    answer = null;
  }
  if (runs.get(id) !== seen) return put(id, () => ({ checking: false }));
  put(id, (c) => {
    if (!answer) return { checking: false, unasked: true };
    const installed = answer.version;
    const run =
      c.run.phase === "updating"
        ? c.run
        : answer.updating && installed
          ? ({ phase: "updating", installed, latest: latest ?? installed, step: "check" } as const)
          : ({ phase: "idle" } as const);
    return { checking: false, unasked: false, answered: true, installed, run };
  });
}

/** Runs `claude update` on host `id`; its lines come as events. */
export async function updateHostClaude(id: string, latest: string): Promise<void> {
  const { installed, run } = now(id);
  if (!installed || run.phase === "updating") return;
  bump(id);
  put(id, () => ({ run: { phase: "updating", installed, latest, step: "check" } }));
  let result: ClaudeUpdateRun;
  try {
    result = await rpc<{ ok: boolean; output: string }>(id, M.claudeUpdate);
  } catch (e) {
    result = { error: message(e) };
  }
  await finish(id, result);
}

/** Ends host `id`'s run, from the reply or its `claude.update_done`,
 * whichever comes first, and reads the version it now runs. */
async function finish(id: string, result: ClaudeUpdateRun) {
  const { state } = afterClaudeUpdateExit(now(id).run, result);
  if (state === now(id).run) return;
  bump(id);
  put(id, () => ({ run: state }));
  const seen = runs.get(id);
  const answer = await rpc<{ version: string | null }>(id, M.claudeVersion).catch(() => null);
  if (answer?.version && runs.get(id) === seen) put(id, () => ({ installed: answer.version, answered: true, unasked: false }));
}

/** A remote host's daemon event: its `claude update` lines and end. */
export function hostClaudeEvent(id: string, name: string, data: unknown) {
  // A host Settings never asked has no row to move.
  if (!useHostClaude.getState().hosts[id]) return;
  if (name === EV.claudeUpdateOutput) put(id, (c) => ({ run: afterClaudeUpdateLine(c.run, (data as { line: string }).line) }));
  else if (name === EV.claudeUpdateDone) void finish(id, data as { ok: boolean; output: string });
}
