// The workspace switcher (X32): one workspace is shown at a time, picked
// from a menu in the title bar or with ⌃⌘1–9. Pure, so it is unit-tested.

import type { ConfirmOptions } from "./confirmOptions";
import type { AccountInfo, ProfileInfo, Section, Session, Workspace, WorkspaceColor } from "./protocol";
import { profileChangeConfirm, profileName } from "./profiles";
import { workspaceSections } from "./sidebar";

/** The design's swatches, in the order the New workspace dialog shows them. */
export const WORKSPACE_COLORS: { id: WorkspaceColor; label: string; hex: string }[] = [
  { id: "clay", label: "Clay", hex: "#d97757" },
  { id: "blue", label: "Blue", hex: "#6f9fe8" },
  { id: "violet", label: "Violet", hex: "#a98be8" },
  { id: "sand", label: "Sand", hex: "#d9b779" },
  { id: "grey", label: "Grey", hex: "#8c8c8c" },
];

export const colorHex = (c: WorkspaceColor) => WORKSPACE_COLORS.find((x) => x.id === c)?.hex ?? WORKSPACE_COLORS[0].hex;

/** The letter on a workspace's colour square. */
export function workspaceInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

/** One host's data, as the switcher needs it. Hosts come local first. */
export interface HostWorkspaces {
  host: string;
  label: string;
  /** The account the host shares (X68); a host that says none is its own. */
  account?: string;
  workspaces: Workspace[];
  sections: Section[];
  sessions: Session[];
  /** Claude profiles (X33), named at the end of each summary. */
  profiles: ProfileInfo[];
}

/** The account host `h` shares: its own when it says none (X68). */
export const accountOf = (h: { host: string; account?: string }) => h.account ?? h.host;

export interface SwitcherRow {
  host: string;
  /** The host's name above its first row, when several hosts have rows. */
  hostLabel: string | null;
  /** The account the workspace belongs to (X68). */
  account: string;
  /** Every host of that account listing the workspace (X68). */
  hosts: string[];
  ws: Workspace;
  initial: string;
  summary: string;
  /** Which Mac made it, while another of the account's workspaces has its
   * name (X68). */
  from: string | null;
  /** `⌃⌘1` to `⌃⌘9` for the first nine rows. */
  kbd: string | null;
}

/** `1 section`, `2 sections`. */
export const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The switcher menu's rows, in order: hosts as given, workspaces in each.
 * A workspace the members of one account list (X68) shows once, under the
 * first of them, with the sessions of all; a host outside the account keeps
 * its own, whatever their ids. */
export function switcherRows(hosts: HostWorkspaces[]): SwitcherRow[] {
  const seen = new Set<string>();
  const own = hosts.map((h) => {
    const list = h.workspaces.filter((ws) => !seen.has(wsKey(accountOf(h), ws.id)));
    list.forEach((ws) => seen.add(wsKey(accountOf(h), ws.id)));
    return { h, list };
  });
  const labelled = own.filter((o) => o.list.length).length > 1;
  const rows: SwitcherRow[] = [];
  for (const { h, list } of own) {
    const account = accountOf(h);
    list.forEach((ws, i) => {
      const listing = hosts.filter((x) => accountOf(x) === account && x.workspaces.some((w) => w.id === ws.id));
      const live = listing.flatMap((x) => x.sessions).filter((s) => !s.archived && s.workspace_id === ws.id).length;
      const n = rows.length;
      rows.push({
        host: h.host,
        hostLabel: labelled && i === 0 ? h.label : null,
        account,
        hosts: listing.map((x) => x.host),
        ws,
        initial: workspaceInitial(ws.name),
        summary: `${count(ws.section_ids.length, "section")} · ${count(live, "session")} · ${profileName(ws, h.profiles)}`,
        from: null,
        kbd: n < 9 ? `⌃⌘${n + 1}` : null,
      });
    });
  }
  for (const r of rows) {
    const twin = rows.some((o) => o !== r && o.account === r.account && o.ws.name === r.ws.name);
    r.from = twin ? (r.ws.made_by ?? null) : null;
  }
  return rows;
}

/** The workspaces `cur` can merge into (X68): the others of its account. */
export function mergeTargets(rows: SwitcherRow[], cur: SwitcherRow): SwitcherRow[] {
  return rows.filter((r) => r !== cur && r.account === cur.account);
}

/** The host a merge of `from` into `into` is asked of: one that lists both,
 * as members may list a new workspace a moment apart. */
export function mergeHost(from: SwitcherRow, into: SwitcherRow): string {
  return from.hosts.find((h) => into.hosts.includes(h)) ?? from.host;
}

/** The question before `from` merges into `into`. Two workspaces of one
 * name are told apart as "this" and "the other". Merging into a workspace
 * with another Claude profile says what that does to running agents. */
export function mergePrompt(from: Workspace, into: Workspace, moving?: { agents: number; profile: string }): ConfirmOptions {
  const same = from.name === into.name;
  const n = from.section_ids.length;
  const them = n === 1 ? "its" : "their";
  const what = `the ${count(n, "section")} of ${same ? `this ${from.name}` : from.name}, with ${them} sessions,`;
  const where = same ? `the other ${into.name}` : into.name;
  const agents = moving ? profileChangeConfirm(moving.agents, moving.profile) : null;
  return {
    title: "Merge workspaces",
    message: `Move ${what} into ${where}, and delete ${same ? "this one" : from.name}? Every Mac sharing them gets the change.${agents ? ` ${agents}` : ""}`,
    action: "Merge",
  };
}

/** What a merge of `from` into `into` does to `agents` Claude agents running
 * in `from`, when the two use other Claude profiles: the profile they move to. */
export function mergeProfileChange(from: Workspace, into: Workspace, profiles: ProfileInfo[], agents: number): { agents: number; profile: string } | undefined {
  if (!agents || (from.claude_profile ?? null) === (into.claude_profile ?? null)) return undefined;
  return { agents, profile: profiles.find((p) => p.id === into.claude_profile)?.name ?? "Default" };
}

/** The notice the first time this Mac shares its central host's account
 * (X68), or null when it has none or was told already. */
export function sharedNotice(info: AccountInfo, seen: string[]): string | null {
  return info.central && !seen.includes(info.account) ? `Workspaces are now shared with ${info.central}` : null;
}

/** Where the sidebar is: a workspace of a host, and the account it belongs
 * to, which shows it on every member of that account (X68). */
export interface WorkspaceRef {
  host: string;
  id: string;
  account?: string;
}

/** The key of a workspace in per-workspace records (`lastSession`, attention). */
export const wsKey = (host: string, id: string) => `${host}/${id}`;

/** The host and id back from a `wsKey`; an id may hold a slash. */
export function parseWsKey(key: string): { host: string; id: string } {
  const at = key.indexOf("/");
  return { host: key.slice(0, at), id: key.slice(at + 1) };
}

/** Whether workspace `id` of `host`, which shares `account`, is the one
 * shown: on its own host, and on every member of its account (X68). */
export function isShown(shown: WorkspaceRef | null, host: string, id: string, account?: string): boolean {
  if (!shown || shown.id !== id) return false;
  return shown.host === host || (!!shown.account && shown.account === account);
}

/** The remembered workspace while a host of its account lists it, else the
 * first one. */
export function currentWorkspace(cur: WorkspaceRef | null, hosts: HostWorkspaces[]): WorkspaceRef | null {
  if (cur) {
    const lists = (h: HostWorkspaces) => h.workspaces.some((w) => w.id === cur.id);
    const own = hosts.find((h) => h.host === cur.host && lists(h));
    // Another member may list it while this one cannot, for a moment (X68).
    const member = own ?? hosts.find((h) => !!cur.account && accountOf(h) === cur.account && lists(h));
    if (member) {
      const account = accountOf(member);
      return member.host === cur.host && cur.account === account ? cur : { host: member.host, id: cur.id, account };
    }
  }
  const first = hosts.find((h) => h.workspaces.length);
  return first ? { host: first.host, id: first.workspaces[0].id, account: accountOf(first) } : null;
}

/** Whether a session on any member of the row's account needs you. */
export function rowNeedsYou(row: SwitcherRow, needing: Set<string>): boolean {
  return row.hosts.some((h) => needing.has(wsKey(h, row.ws.id)));
}

/** The key under which the session last open in workspace `ref` is kept:
 * its account's, so every member of it finds it (X68). */
export const lastSessionKey = (ref: WorkspaceRef) => wsKey(ref.account ?? ref.host, ref.id);

/** The session to reopen in workspace `ref` from what was kept, `host/id`
 * (or an id alone, kept before X68, on the shown host): while it is still
 * live there. */
export function restoreTarget(kept: string | undefined, hosts: HostWorkspaces[], ref: WorkspaceRef): { host: string; session: string } | null {
  if (!kept) return null;
  const at = kept.indexOf("/");
  const host = at < 0 ? ref.host : kept.slice(0, at);
  const session = at < 0 ? kept : kept.slice(at + 1);
  const h = hosts.find((x) => x.host === host);
  const s = h?.sessions.find((x) => x.id === session);
  return s && !s.archived && s.workspace_id === ref.id ? { host, session } : null;
}

/** `host/id` of each workspace with a live session for which `needs` holds
 * (it needs input, or finished unread). */
export function workspacesNeedingYou(hosts: HostWorkspaces[], needs: (host: string, s: Session) => boolean): Set<string> {
  const out = new Set<string>();
  for (const h of hosts) {
    for (const s of h.sessions) {
      if (!s.archived && s.workspace_id && needs(h.host, s)) out.add(wsKey(h.host, s.workspace_id));
    }
  }
  return out;
}

export interface NewWorkspaceForm {
  name: string;
  color: WorkspaceColor;
  /** Start empty, or with sections moved from the current workspace. */
  start: "empty" | "move";
  moving: string[];
}

/** `workspace.create`'s params, or null while the form cannot be sent. */
export function createRequest(f: NewWorkspaceForm): { name: string; color: WorkspaceColor; move_sections: string[] } | null {
  const name = f.name.trim();
  if (!name) return null;
  return { name, color: f.color, move_sections: f.start === "move" ? f.moving : [] };
}

/** Why Delete workspace is disabled, mirroring the daemon's refusals. */
export function deleteBlocked(ws: Workspace, workspaceCount: number): string | null {
  if (workspaceCount <= 1) return "The last workspace cannot be deleted.";
  const n = ws.section_ids.length;
  if (n) return n === 1 ? "Move or delete its section first." : `Move or delete its ${n} sections first.`;
  return null;
}

/** One host as the composer sees it. */
export interface ComposerHost<P extends { id: string }> {
  connected: boolean;
  /** The account it shares (X68). */
  account?: string;
  workspaces: Workspace[];
  sections: Section[];
  projects: P[];
}

/** The composer's project picker (X32): the target workspace's projects, in
 * section order and labelled with the section holding them; without a
 * target, every connected host's projects. */
export function composerOptions<P extends { id: string }>(hosts: Record<string, ComposerHost<P>>, target: WorkspaceRef | null): { host: string; project: P; section: string | null }[] {
  const out: { host: string; project: P; section: string | null }[] = [];
  for (const [host, h] of Object.entries(hosts)) {
    if (!h.connected) continue;
    const ws = target ? h.workspaces.find((w) => isShown(target, host, w.id, h.account ?? host)) : undefined;
    if (target && !ws) continue;
    const secs = ws ? ws.section_ids.flatMap((id) => h.sections.find((s) => s.id === id) ?? []) : h.sections;
    for (const sec of secs) {
      for (const id of sec.project_ids) {
        const project = h.projects.find((p) => p.id === id);
        if (project && !out.some((o) => o.host === host && o.project.id === id)) out.push({ host, project, section: sec.name });
      }
    }
    if (!ws) for (const project of h.projects) if (!out.some((o) => o.host === host && o.project.id === project.id)) out.push({ host, project, section: null });
  }
  return out;
}

type ComposerOption = { host: string; project: { id: string; name: string } };

/**
 * The project the composer starts on. Started from an issue (X44): the one
 * project in the workspace that links the issue's tracker project, or none
 * when several do, so the user picks. Otherwise the preset, then the current
 * session's project, then the first. An adopted worktree stays in its
 * project (the preset), whatever links the issue (X46).
 */
export function composerPick<O extends ComposerOption>(options: O[], s: { host?: string; preset?: string; linked?: string[]; current: { host: string; id: string } | null; worktree?: boolean }): O | null {
  const linked = s.worktree ? [] : options.filter((o) => o.host === s.host && s.linked?.includes(o.project.id));
  if (linked.length) return linked.length === 1 ? linked[0] : null;
  return (
    options.find((o) => o.host === s.host && o.project.id === s.preset) ??
    options.find((o) => s.current && o.host === s.current.host && o.project.id === s.current.id) ??
    options[0] ??
    null
  );
}

/**
 * The composer's project menu, filtered by `query` on the name: the projects
 * on `host` that link the issue's tracker project first, then the others (X44).
 */
export function composerProjects<O extends ComposerOption>(options: O[], linked: string[], query: string, host: string | undefined): { linked: O[]; others: O[] } {
  const q = query.trim().toLowerCase();
  const shown = options.filter((o) => o.project.name.toLowerCase().includes(q));
  const isLinked = (o: O) => o.host === host && linked.includes(o.project.id);
  return { linked: shown.filter(isLinked), others: shown.filter((o) => !isLinked(o)) };
}

/** Where the composer creates the session: the workspace it was opened for
 * (`host` defaults to the shown one's), else the shown workspace. */
export function composerTarget(host: string | undefined, workspace: string | undefined, shown: WorkspaceRef | null): WorkspaceRef | null {
  if (workspace) {
    const h = host ?? shown?.host;
    return h ? { host: h, id: workspace } : null;
  }
  return shown;
}

/** The workspace "New section" adds to: the shown one when `host` lists
 * it, else the host's first. */
export function newSectionWorkspace(shown: WorkspaceRef | null, host: string, workspaces: Workspace[], account?: string): string | null {
  return shown && workspaces.some((w) => isShown(shown, host, w.id, account)) ? shown.id : (workspaces[0]?.id ?? null);
}

/** The workspace a session started on `host` goes in: the composer's target
 * when that host lists it, as every member of its account does (X68). */
export function composerWorkspace(target: WorkspaceRef | null, host: string, hosts: HostWorkspaces[]): string | null {
  const h = hosts.find((x) => x.host === host);
  if (!target || !h) return null;
  return h.workspaces.some((w) => isShown(target, host, w.id, accountOf(h))) ? target.id : null;
}

/** Under a workspace page's name (X43): "Workspace on this Mac · 2 sections ·
 * 9 sessions". `remote`: the host's name, null for this Mac. */
export function workspaceSummary(ws: Workspace, remote: string | null, sessions: Session[]): string {
  const open = sessions.filter((s) => s.workspace_id === ws.id && !s.archived).length;
  return `Workspace on ${remote ?? "this Mac"} · ${count(ws.section_ids.length, "section")} · ${count(open, "session")}`;
}

/** A workspace's sections in sidebar order, with their project counts. */
export function sectionRows(ws: Workspace, sections: Section[]): { id: string; name: string; projects: string }[] {
  return workspaceSections(ws, sections).map((sec) => ({ id: sec.id, name: sec.name, projects: count(sec.project_ids.length, "project") }));
}

/** The workspace page's fields; `profile` is "" for the default profile. */
export interface WorkspaceForm {
  name: string;
  color: WorkspaceColor;
  profile: string;
}

export function workspaceDirty(ws: Workspace, f: WorkspaceForm): boolean {
  return f.name.trim() !== ws.name || f.color !== ws.color || f.profile !== (ws.claude_profile ?? "");
}

/** The form after the workspace changed from `before` to `after` elsewhere:
 * an untouched form follows it, edits are kept. */
export function syncWorkspaceForm(before: Workspace, after: Workspace, f: WorkspaceForm): WorkspaceForm {
  return workspaceDirty(before, f) ? f : { name: after.name, color: after.color, profile: after.claude_profile ?? "" };
}

/** Save on a workspace page: something changed, the name isn't blank, and
 * no save is running. */
export function workspaceCanSave(ws: Workspace, f: WorkspaceForm, saving: boolean): boolean {
  return workspaceDirty(ws, f) && !!f.name.trim() && !saving;
}
