// Claude profiles in the app (X33): labels for the profile select, the
// sidebar footer and the confirm before a workspace switches accounts.

import type { ProfileAccount, ProfileInfo, Section, Session, TerminalInfo, Workspace } from "./protocol";

/** The profile select's value for the default profile (`~/.claude`). */
export const DEFAULT_PROFILE = "";
/** The profile select's value for "New profile…". */
export const NEW_PROFILE = "new";

/** `/Users/jane/.claude-work` → `~/.claude-work`. */
export function tildePath(path: string, home: string | null): string {
  return home && (path === home || path.startsWith(home + "/")) ? "~" + path.slice(home.length) : path;
}

export interface ProfileOption {
  /** A profile id, `""` for the default, `new` for New profile…. */
  value: string;
  label: string;
}

export function profileOptions(profiles: ProfileInfo[], home: string | null): ProfileOption[] {
  return [
    { value: DEFAULT_PROFILE, label: "Default — ~/.claude" },
    ...profiles.map((p) => ({ value: p.id, label: `${p.name} — ${tildePath(p.path, home)}` })),
    { value: NEW_PROFILE, label: "New profile…" },
  ];
}

const profileOf = (ws: Workspace, profiles: ProfileInfo[]) => profiles.find((p) => p.id === ws.claude_profile);

/** The workspace's profile name; a deleted one reads as the default. */
export function profileName(ws: Workspace, profiles: ProfileInfo[]): string {
  return profileOf(ws, profiles)?.name ?? "Default";
}

/** Who an account is: "jane@x.com · Acme". */
export function accountLabel(a: ProfileAccount): string {
  return [a.email, a.org_name].filter(Boolean).join(" · ") || "an account";
}

/** `null` until `claude auth status` has answered. */
export function accountState(a: ProfileAccount | null | undefined): "checking" | "signed-in" | "signed-out" {
  return !a ? "checking" : a.logged_in ? "signed-in" : "signed-out";
}

/** The sidebar footer: which account the workspace's agents use.
 * `defaultAccount`: the default profile's, when known. */
export function footerLabel(ws: Workspace, profiles: ProfileInfo[], home: string | null, defaultAccount: ProfileAccount | null): { text: string; warn: boolean; title: string } {
  const p = profileOf(ws, profiles);
  const account = p ? p.account : defaultAccount;
  const folder = p ? tildePath(p.path, home) : "~/.claude";
  const signedOut = accountState(account) === "signed-out";
  return {
    text: `Claude · ${p?.name ?? "Default"}${signedOut ? " · not signed in" : ""}`,
    warn: signedOut,
    title: account?.logged_in ? `${accountLabel(account)} · ${folder}` : folder,
  };
}

/** The daemon's folder for a new profile named `name`: `~/.claude-<slug>`
 * (the daemon adds -2, -3… when it is taken). Same slug as `git::slug`. */
export function defaultFolder(name: string): string {
  let out = "";
  for (const c of name.toLowerCase()) {
    if (/[a-z0-9]/.test(c)) out += c;
    else if (out && !out.endsWith("-")) out += "-";
  }
  out = out.replace(/-+$/, "").slice(0, 48);
  return `~/.claude-${out || "task"}`;
}

/** The confirm before sessions with `agents` running Claude agents move from
 * profile `from` to `to` (ids; `null` is the default), or null when nothing
 * changes for them. */
export function switchConfirm(from: string | null, to: string | null, agents: number, profiles: ProfileInfo[]): string | null {
  if ((from ?? null) === (to ?? null)) return null;
  return profileChangeConfirm(agents, profiles.find((p) => p.id === to)?.name ?? "Default");
}

/** The confirm before forgetting a profile. */
export function removeProfileConfirm(p: ProfileInfo, workspaces: Workspace[], home: string | null): string {
  const using = workspaces.filter((w) => w.claude_profile === p.id).map((w) => w.name);
  return `Forget ${p.name}? ${using.length ? `${using.join(", ")} will use the default profile. ` : ""}The folder ${tildePath(p.path, home)} and its sign-in stay on disk.`;
}

/** How many of `sessionIds` run a Claude agent right now: they switch
 * accounts when the profile changes (Codex and custom agents do not). */
export function runningClaudeAgents(sessions: Session[], terminals: TerminalInfo[], sessionIds: string[]): number {
  return sessions.filter(
    (s) => !s.archived && sessionIds.includes(s.id) && terminals.some((t) => t.session_id === s.id && t.kind === "agent" && t.agent === "claude" && !t.exit),
  ).length;
}

/** The sessions of workspace `from` that move with section `sectionId`:
 * those of projects no other section of `from` holds (the daemon's rule). */
export function movingSessions(from: Workspace, sections: Section[], sessions: Session[], sectionId: string): string[] {
  const moving = sections.find((s) => s.id === sectionId)?.project_ids ?? [];
  const kept = new Set(from.section_ids.filter((id) => id !== sectionId).flatMap((id) => sections.find((s) => s.id === id)?.project_ids ?? []));
  return sessions.filter((s) => s.workspace_id === from.id && moving.includes(s.project_id) && !kept.has(s.project_id)).map((s) => s.id);
}

/** The confirm before a workspace with running agents switches profiles,
 * or null when nothing runs. */
export function profileChangeConfirm(agents: number, to: string): string | null {
  if (!agents) return null;
  const which = agents === 1 ? "1 session in this workspace has an agent" : `${agents} sessions in this workspace have agents`;
  return `${which}. A running agent keeps its account until it restarts, then signs in with ${to} and starts a new conversation.`;
}
