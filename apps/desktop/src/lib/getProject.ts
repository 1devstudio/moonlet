// Getting a project this host does not have (X70): what the Get <name>
// dialog says while the host's daemon looks the origin up, clones it, or
// checks a folder the user located.

import type { ProjectIdentity, RepoInfo } from "./protocol";

/** The dialog's title. */
export const getProjectTitle = (name: string, host: string) => `Get ${name} on ${host}`;

/** The folder name a clone starts with: the origin's last path segment. */
export const originName = (origin: string) => origin.split("/").pop() ?? origin;

/** The card's line once the daemon reached the origin. */
export const foundLine = (info: Pick<RepoInfo, "default_branch">) => (info.default_branch ? `Found · ${info.default_branch}` : "Found");

/** The red box when no address of the origin answered. `error` is the daemon's: one `<address>: <reason>` line per address tried. */
export function cantReach(host: string, origin: string, error: string): { title: string; body: string; details: string[] } {
  const details = error.split("\n").filter((l) => l.trim());
  const tried = details.map((l) => /^(\S+): /.exec(l)?.[1]).filter((u): u is string => !!u && /^(git@|ssh:\/\/|https:\/\/)/.test(u));
  // "This Mac" opens a sentence; mid-sentence it is "this Mac".
  const check = `Check that ${host === "This Mac" ? "this Mac" : host} can read the repository, with an SSH key or a signed-in credential helper, then retry.`;
  return { title: `${host} can't reach ${origin}`, body: tried.length ? `${host} tried ${tried.join(" and ")}. ${check}` : check, details };
}

/** What the dialog says for a project without a remote. */
export const noOrigin = (name: string, host: string) => `${name} has no remote, so ${host} can't clone it. Push it to a remote from the Mac that has it, or locate a copy here.`;

const sameProject = (a: ProjectIdentity, b: ProjectIdentity) => !!a.root && a.root === b.root && (a.origin ?? null) === (b.origin ?? null);

/** Whether the folder the user located, whose identity is `found`, is a copy of the project `want`, as the daemon checks it again when it is added. */
export function copyCheck(found: ProjectIdentity, want: ProjectIdentity, folder: string, name: string): { ok: boolean; text: string } {
  if (sameProject(found, want)) return { ok: true, text: want.origin ? `This is a clone of ${want.origin}.` : `This is a copy of ${name}.` };
  const why = (() => {
    if (!found.root) return "is not a git repository.";
    if (found.root !== want.root || (!found.origin && !want.origin)) return "holds another repository.";
    if (found.origin && want.origin) return `has the same history but its origin is ${found.origin}, not ${want.origin}.`;
    if (want.origin) return `has the same history but no origin; the project's is ${want.origin}.`;
    return `has the same history but its origin is ${found.origin}; the project has none.`;
  })();
  return { ok: false, text: `${folder} ${why}` };
}

/** A host whose daemon predates X70 asks for a GitHub repository where the dialog gives an origin. */
export const isTooOld = (e: { code?: string; message: string }) => e.code === "invalid_params" && e.message.includes("missing field `repo`");
