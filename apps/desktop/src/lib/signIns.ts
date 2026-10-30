// Settings › Machines › Sign-ins (X75): a tool's sign-in run on every
// member, each browser opening on this Mac.

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
