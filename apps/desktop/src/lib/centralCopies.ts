// The sessions other members run, in the central host's own app (X86). Its
// daemon holds a copy of each (X72); the app lists them from it and opens
// each under its copy host, so its calls go to the member running it.

import { copyHostId } from "./copyHost";
import type { AccountInfo, Session } from "./protocol";

/** The copy hosts to list from this Mac's daemon's `session.list
 * {copies: true}`, each with its session: none unless the daemon is a
 * central host (its account names no central host), and never a session
 * this Mac runs itself. */
export function copyEntries(list: Session[], account: AccountInfo | undefined): Record<string, Session[]> {
  if (!account || account.central !== null) return {};
  return Object.fromEntries(list.filter((s) => s.owner && s.owner.worker !== account.account).map((s) => [copyHostId("local", s.id), [s]]));
}
