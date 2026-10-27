// A session's Jobs tab on the phone (X62, X63): which tabs a session has,
// and what a job's footer offers. The rows and lines are the desktop's
// (`@desktop/lib/jobs`).

import { waitingNote } from "@desktop/lib/cloudMachines";
import type { Job } from "@desktop/lib/protocol";
import type { SessionTab } from "./app";

/** The session's tabs: Jobs only while it has jobs. */
export function sessionTabs(jobs: Job[]): SessionTab[] {
  const tabs: SessionTab[] = ["chat", "terminal", "changes", "pr"];
  return jobs.length ? [...tabs, "jobs"] : tabs;
}

/** What a job's footer offers: a note above it, **Run on <host> now** for a
 * job waiting for a cloud machine, and **Stop** with the line beside it.
 * Null once the job ended. */
export function jobFooter(job: Job, session: string, hostLabel: string): { note: string | null; runHere: string | null; stop: string } | null {
  const s = job.state;
  if (s.kind === "waiting") return { note: waitingNote(session, hostLabel), runHere: `Run on ${hostLabel} now`, stop: "" };
  if (s.kind === "running" || s.kind === "bringing_back") return { note: null, runHere: null, stop: "Changes made so far still come back." };
  return null;
}
