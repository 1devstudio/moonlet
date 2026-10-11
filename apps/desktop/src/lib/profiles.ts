// Claude profiles in the app (X33): labels for the profile select, the
// sidebar footer and the confirm before a workspace switches accounts.

import type { ProfileInfo, Workspace } from "./protocol";

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
    { value: "", label: "Default — ~/.claude" },
    ...profiles.map((p) => ({ value: p.id, label: `${p.name} — ${tildePath(p.path, home)}` })),
    { value: "new", label: "New profile…" },
  ];
}

const profileOf = (ws: Workspace, profiles: ProfileInfo[]) => profiles.find((p) => p.id === ws.claude_profile);

/** The workspace's profile name; a deleted one reads as the default. */
export function profileName(ws: Workspace, profiles: ProfileInfo[]): string {
  return profileOf(ws, profiles)?.name ?? "Default";
}

/** The sidebar footer: which account the workspace's agents use. */
export function footerLabel(ws: Workspace, profiles: ProfileInfo[], home: string | null): { text: string; warn: boolean; title: string } {
  const p = profileOf(ws, profiles);
  const folder = p ? tildePath(p.path, home) : "~/.claude";
  const signedOut = p?.account?.logged_in === false;
  const who = p?.account?.logged_in ? [p.account.email, p.account.org_name].filter(Boolean) : [];
  return {
    text: `Claude · ${p?.name ?? "Default"}${signedOut ? " · not signed in" : ""}`,
    warn: signedOut,
    title: [...who, folder].join(" · "),
  };
}

/** The confirm before a workspace with running agents switches profiles,
 * or null when nothing runs. */
export function profileChangeConfirm(agents: number, to: string): string | null {
  if (!agents) return null;
  const which = agents === 1 ? "1 session in this workspace has an agent" : `${agents} sessions in this workspace have agents`;
  return `${which}. A running agent keeps its account until it restarts, then signs in with ${to} and starts a new conversation.`;
}
