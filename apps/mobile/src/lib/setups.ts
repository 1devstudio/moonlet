// Answering a copy's setup from the phone (X60, X62): the call that runs or
// skips it, and what a refusal says.

import { DaemonError } from "@desktop/lib/daemon";
import { M } from "@desktop/lib/protocol";
import { errorText } from "./busy";

/** Run names the exact command shown, which the Mac refuses once it changed. */
export function setupAnswer(copy: string, command: string, run: boolean): { method: string; params: object } {
  return run ? { method: M.syncRunSetup, params: { copy, command } } : { method: M.syncSkipSetup, params: { copy } };
}

/** What the card says when the Mac refused: `setup_changed` carries the
 * current command, which nothing ran. */
export function setupError(e: unknown, hostLabel: string): string {
  if (e instanceof DaemonError && e.code === "setup_changed") return `The setup changed on ${hostLabel} meanwhile, to: ${e.message}. Nothing ran; check the new command before running it.`;
  if (e instanceof DaemonError && e.code === "no_setup") return "This copy has no setup script any more.";
  return errorText(e);
}
