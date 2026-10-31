// Settings › Machines › Sign-ins (X75): a tool's sign-in run on every
// member, each browser opening on this Mac.

import { signInHostId } from "./copyHost";
import type { SignIn } from "./protocol";

/** Whether a member is signed in with an entry, as the daemons say. */
export interface SignInState {
  member: string;
  name: string;
  state: string;
}

/** The mark and its tooltip for a member's state. */
export function stateMark(state: string): { mark: string; label: string } {
  switch (state) {
    case "signed_in":
      return { mark: "✓", label: "Signed in" };
    case "signed_out":
      return { mark: "✕", label: "Not signed in" };
    case "needs_approval":
      return { mark: "?", label: "Approve its commands there first" };
    default:
      return { mark: "–", label: "Away" };
  }
}

/** The members Sign in on every member signs in on: those not signed in. */
export const needSignIn = (states: SignInState[]) => states.filter((s) => s.state === "signed_out").map((s) => s.member);

/** `entries` with a new one, or what it lacks. */
export function addEntry(entries: SignIn[], e: { name: string; login: string; check: string }, id: string): { entries: SignIn[] } | { error: string } {
  const entry = { id, name: e.name.trim(), login: e.login.trim(), check: e.check.trim() };
  if (!entry.name || !entry.login || !entry.check) return { error: "A sign-in needs a name, a sign-in command and a check command." };
  return { entries: [...entries, entry] };
}

/** The line over a sign-in's terminal on this Mac: what to do while it
 * runs, why it stopped when it failed, none once it succeeded (the window
 * closes then). */
export function runningLine(exit: { code?: number | null; signal?: number | null } | undefined): string | null {
  if (!exit) return "Finish signing in in your browser. This window closes when the sign-in is done.";
  if (exit.code === 0) return null;
  return `The sign-in stopped with exit code ${exit.code ?? exit.signal}. Its output is below.`;
}

type Exit = { code?: number | null; signal?: number | null };

/** A sign-in's terminal, as `signins.running` names it: this Mac's own,
 * or another member's that this Mac's Sign in on every member started,
 * with that member, and once it ended, its exit. */
export interface SignInRun {
  terminal: number;
  name: string;
  member?: string;
  member_name?: string;
  /** Followed through the central host; otherwise the central host's own. */
  relayed?: boolean;
  exit?: Exit;
}

/** The host the Sign in window follows `run`'s terminal on: this Mac's;
 * another member's through the central host named `central` (null when
 * this Mac is the central host); or the central host's own. Null when the
 * app does not reach the central host, among its `tailnetHosts`. */
export function runHost(run: SignInRun, central: string | null, tailnetHosts: string[]): string | null {
  if (!run.member) return "local";
  if (central === null) return signInHostId("local", run.member);
  if (!tailnetHosts.includes(central)) return null;
  return run.relayed ? signInHostId(central, run.member) : central;
}

export const runTitle = (run: SignInRun) => (run.member_name ? `Sign in: ${run.name} on ${run.member_name}` : `Sign in: ${run.name}`);

/** The Sign in window's run after a `signins.running`: a new sign-in
 * replaces it, and the end of the one shown completes it. */
export function nextRun(shown: SignInRun | null, e: SignInRun): SignInRun | null {
  if (!e.exit) return e;
  if (shown && shown.terminal === e.terminal && shown.member === e.member) return { ...shown, exit: e.exit };
  return shown;
}

/** How `run` ended: this Mac's own by its terminal's exit `local`, another
 * member's by what its daemon reported. */
export const runExit = (run: SignInRun, local: Exit | undefined): Exit | undefined => (run.member ? run.exit : local);
