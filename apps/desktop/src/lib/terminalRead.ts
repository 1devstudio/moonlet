// An agent reads a terminal of its own session once the user allows it (X31).

import { agentLabel } from "./agents";
import type { ReadRequest } from "./protocol";
import { sanitize } from "./sanitize";

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The modal's title and message for a read request. Titles and commands
 * come from programs in the terminal: they stay one short line. */
export function readPrompt(req: ReadRequest, sessionName: string): { title: string; message: string } {
  const agent = agentLabel(req.agent);
  const command = sanitize(req.command, 60);
  const what = command
    ? `the output of ${command} (${req.exit === undefined ? "" : `exit ${req.exit}, `}${plural(req.lines, "line")})`
    : `the last ${req.lines === 1 ? "line" : plural(req.lines, "line")}`;
  return {
    title: `Let ${agent} read a terminal?`,
    message: `${capital(agent)} in ${sanitize(sessionName, 60)} wants ${what} ${command ? "from" : "of"} terminal ${sanitize(req.title, 60)}.`,
  };
}

/** Requests waiting for the user, per host, oldest first. */
export type ReadQueue = Record<string, ReadRequest[]>;

/** The request the window asks about now: the oldest one of the session in
 * view. None while another confirm is open; it comes back once that closes. */
export function shownRead(
  reads: ReadQueue,
  selected: { host: string; session: string } | null,
  confirmOpen: boolean,
): { host: string; request: ReadRequest } | null {
  if (!selected || confirmOpen) return null;
  const request = reads[selected.host]?.find((r) => r.session_id === selected.session);
  return request ? { host: selected.host, request } : null;
}

/** A session waits for the user while one of its reads does. */
export function readWaits(reads: ReadQueue, host: string, session: string): boolean {
  return !!reads[host]?.some((r) => r.session_id === session);
}

/** The ⋯ menu item that withdraws "Allow for the rest of this session". */
export function grantMenuLabel(grants: Record<string, string[]>, host: string, session: string): string | null {
  return grants[host]?.includes(session) ? "Ask before the agent reads terminals" : null;
}
