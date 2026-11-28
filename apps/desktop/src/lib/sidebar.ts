// How a section's sessions are grouped, filtered and sorted in the sidebar
// (X5, X32). Pure, so it is unit-tested.

import type { AgentState, Project, ProjectIdentity, Section, Session, Workspace } from "./protocol";
import { agentCount } from "./subagents";
import { parseCopyHost } from "./copyHost";
import { firstListings } from "./sessionsOnce";

/**
 * The sidebar's width, from 260px, where the workspace switcher's square,
 * attention dot and chevron fit beside the traffic lights and the mode
 * switch (X32), to 420px.
 */
export const clampSidebarWidth = (w: number) => Math.max(260, Math.min(420, w));

export interface Group {
  key: string;
  kind: "project" | "status" | "task" | "all";
  label: string;
  projectId?: string;
  sessions: Session[];
}

/** How a group is headed: a project row (mark, settings, new session), a
 * plain label (status, task), or nothing for the ungrouped list. */
export function groupHeading(g: Pick<Group, "kind">): "project" | "label" | null {
  return g.kind === "project" ? "project" : g.kind === "all" ? null : "label";
}

const STATUS_ORDER: { state: AgentState | null; label: string }[] = [
  { state: "blocked", label: "Needs input" },
  { state: "working", label: "Working" },
  { state: "done", label: "Ready for review" },
  { state: "error", label: "Failed" },
  { state: "idle", label: "Idle" },
  { state: null, label: "No agent" },
];

/** An agent that works or waits for the user: on top of a recent activity sort. */
const live = (state: AgentState | null) => state === "working" || state === "blocked";

/** How a section orders its sessions, newest or most active first, or by
 * name; `of` finds the session in an item, `activeAt` its last activity and
 * `stateOf` its agent's state, so live agents lead the most active.
 * Sessions pinned to the top come first, in the same order (X112). */
export function bySort<T>(sortBy: Section["view"]["sort_by"], of: (x: T) => Session, activeAt: (x: T) => number, stateOf: (x: T) => AgentState | null): (a: T, b: T) => number {
  return (a, b) => {
    const [x, y] = [of(a), of(b)];
    const pinned = Number(!!y.pinned_top) - Number(!!x.pinned_top);
    if (pinned) return pinned;
    if (sortBy === "name") return x.name.localeCompare(y.name);
    if (sortBy === "created") return y.created_at - x.created_at;
    return Number(live(stateOf(b))) - Number(live(stateOf(a))) || activeAt(b) - activeAt(a) || y.created_at - x.created_at;
  };
}

/** The groups of section `sec`, showing only the sessions of `workspaceId`,
 * the workspace the section is in. */
export function arrange(
  workspaceId: string,
  sec: Section,
  projects: Project[],
  sessions: Session[],
  stateOf: (s: Session) => AgentState | null,
  activeAt: (s: Session) => number,
  /** Archived sessions whose row still plays the archive loader (X21). */
  archiving: (s: Session) => boolean = () => false,
  /** The task a session works on, for grouping by task (X46). */
  taskOf: (s: Session) => { key: string; title: string } | null = () => null,
): Group[] {
  const filter = sec.view.filter.filter((id) => sec.project_ids.includes(id));
  const visible = sec.project_ids.filter((id) => filter.length === 0 || filter.includes(id));
  const byId = new Map(projects.map((p) => [p.id, p]));
  const rest = sessions
    .filter((s) => (!s.archived || archiving(s)) && s.workspace_id === workspaceId && visible.includes(s.project_id))
    .sort(bySort(sec.view.sort_by, (s) => s, activeAt, stateOf));

  const groups: Group[] = [];
  if (sec.view.group_by === "project") {
    for (const id of visible) {
      const p = byId.get(id);
      if (!p) continue;
      groups.push({ key: `proj:${id}`, kind: "project", label: p.name, projectId: id, sessions: rest.filter((s) => s.project_id === id) });
    }
  } else if (sec.view.group_by === "task") {
    const byTask = new Map<string, Group>();
    const none: Session[] = [];
    for (const s of rest) {
      const t = taskOf(s);
      if (!t) none.push(s);
      else if (byTask.has(t.key)) byTask.get(t.key)!.sessions.push(s);
      else byTask.set(t.key, { key: `task:${t.key}`, kind: "task", label: `${t.key} ${t.title}`, sessions: [s] });
    }
    groups.push(...byTask.values());
    if (none.length) groups.push({ key: "task:none", kind: "task", label: "No task", sessions: none });
  } else if (sec.view.group_by === "status") {
    for (const { state, label } of STATUS_ORDER) {
      const list = rest.filter((s) => stateOf(s) === state);
      if (list.length) groups.push({ key: `status:${state}`, kind: "status", label, sessions: list });
    }
  } else {
    groups.push({ key: "all", kind: "all", label: "All sessions", sessions: rest });
  }
  return groups;
}

/** One member's side of a section shared by the members of an account (X68). */
export interface SectionPart {
  host: string;
  sec: Section;
  projects: Project[];
  sessions: Session[];
  /** The host a row of the part is opened under, by session id, when it
   * is not `host`: the copy host of a session another member runs (X88). */
  hostOf?: Record<string, string>;
}

/** A session and the host it is on. */
export interface HostSession {
  host: string;
  session: Session;
}

/** A group of a shared section: each session with the host it is on. */
export interface SharedGroup {
  key: string;
  kind: Group["kind"];
  label: string;
  /** The host of the project row (its mark, settings, new session). */
  host: string;
  projectId?: string;
  /** Where the project is when the shown member lacks it: on another
   * member, or on none that is connected, with its identity (X70). */
  on: { host: string } | { missing: ProjectIdentity } | null;
  sessions: HostSession[];
}

/** A project identity as one key, `<origin>|<root>`; null without a root. */
export const identityKey = (i: ProjectIdentity | undefined) => (i?.root ? `${i.origin ?? ""}|${i.root}` : null);

/** A project's name from its identity: the last part of its origin. */
const identityName = (i: ProjectIdentity) => i.origin?.split("/").pop() ?? i.root?.slice(0, 7) ?? "project";

/**
 * A section shared by the members of an account, as one list (X68): each
 * part is `arrange`d on its own, then a project's groups meet by identity
 * and other groups by key, with every member's sessions sorted together.
 * The first part, the shown member's, decides the order and the view; its
 * project filter picks the same projects on every member, by identity.
 */
export function arrangeShared(
  workspaceId: string,
  parts: SectionPart[],
  o: {
    stateOf: (host: string, s: Session) => AgentState | null;
    activeAt: (host: string, s: Session) => number;
    archiving: (host: string, s: Session) => boolean;
    taskOf: (host: string, s: Session) => { key: string; title: string } | null;
  },
): SharedGroup[] {
  if (!parts.length) return [];
  const view = parts[0].sec.view;
  const picked = view.filter
    .filter((id) => parts[0].sec.project_ids.includes(id))
    .map((id) => identityKey(parts[0].projects.find((p) => p.id === id)?.identity));
  const out: SharedGroup[] = [];
  const byKey = new Map<string, SharedGroup>();
  parts.forEach((part, i) => {
    // Another member's project ids are its own: its side of the filter is
    // the projects with the picked identities.
    const projectIds =
      i === 0 || picked.length === 0 ? part.sec.project_ids : part.sec.project_ids.filter((id) => picked.includes(identityKey(part.projects.find((p) => p.id === id)?.identity)));
    const rowHost = (s: Session) => part.hostOf?.[s.id] ?? part.host;
    const groups = arrange(
      workspaceId,
      { ...part.sec, project_ids: projectIds, view: { ...view, filter: i === 0 ? view.filter : [] } },
      part.projects,
      part.sessions,
      (s) => o.stateOf(rowHost(s), s),
      (s) => o.activeAt(rowHost(s), s),
      (s) => o.archiving(rowHost(s), s),
      (s) => o.taskOf(rowHost(s), s),
    );
    for (const g of groups) {
      const project = g.projectId ? part.projects.find((p) => p.id === g.projectId) : undefined;
      const key = g.kind === "project" ? (identityKey(project?.identity) ?? `${part.host}/${g.key}`) : g.key;
      let shared = byKey.get(key);
      if (!shared) {
        // The shown member's project groups keep their key, and with it
        // their collapse state.
        const elsewhere = i > 0 && g.kind === "project";
        shared = { key: elsewhere ? `proj:${key}` : g.key, kind: g.kind, label: g.label, host: part.host, projectId: g.projectId, on: elsewhere ? { host: part.host } : null, sessions: [] };
        byKey.set(key, shared);
        out.push(shared);
      }
      shared.sessions.push(...g.sessions.map((session) => ({ host: rowHost(session), session })));
    }
  });
  // The first member's projects that no connected member has, as rows of
  // their own while grouped by project.
  for (const i of view.group_by === "project" ? (parts[0].sec.missing ?? []) : []) {
    const key = identityKey(i);
    if (!key || byKey.has(key) || (picked.length > 0 && !picked.includes(key))) continue;
    const g: SharedGroup = { key: `proj:${key}`, kind: "project", label: identityName(i), host: parts[0].host, on: { missing: i }, sessions: [] };
    byKey.set(key, g);
    out.push(g);
  }
  const activeAt = (e: HostSession) => o.activeAt(e.host, e.session);
  const stateOf = (e: HostSession) => o.stateOf(e.host, e.session);
  const compare = bySort(view.sort_by, (e: HostSession) => e.session, activeAt, stateOf);
  for (const g of out) {
    // A session two parts bring, as while it moves between two members
    // (X73), is the first one's: one row, with one key.
    g.sessions = firstListings([g.sessions], (e) => e.session.id)[0];
    g.sessions = nestUnderParents(g.sessions.sort(compare), (e) => e.session);
  }
  if (view.group_by === "status") {
    const order = STATUS_ORDER.map((x) => x.label);
    out.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
  } else if (view.group_by === "task") {
    // Tasks by their first session in the section's order, sessions without
    // one last.
    const all = out.flatMap((g) => g.sessions).sort(compare);
    const first = (g: SharedGroup) => (g.key === "task:none" ? Infinity : Math.min(...g.sessions.map((e) => all.indexOf(e))));
    out.sort((a, b) => first(a) - first(b));
  }
  return out;
}

/** A host with the account it shares and what it lists (X68). */
export interface ListingHost {
  host: string;
  account?: string;
  workspaces: Workspace[];
  sections: Section[];
}

/**
 * The sections the sidebar shows for workspace `shown`, each once, with the
 * hosts holding it (X68): the shown host's first, in its order, then those
 * only other members of its account list yet. A host outside the account
 * never adds its own, whatever its ids.
 */
export function shownSections(shown: { host: string; id: string; account?: string } | null, hosts: ListingHost[]): { ws: Workspace; sec: Section; hosts: string[] }[] {
  if (!shown) return [];
  const member = (h: ListingHost) => h.host === shown.host || (!!shown.account && (h.account ?? h.host) === shown.account);
  const listing = hosts.filter((h) => member(h) && h.workspaces.some((w) => w.id === shown.id));
  listing.sort((a, b) => Number(b.host === shown.host) - Number(a.host === shown.host));
  const out: { ws: Workspace; sec: Section; hosts: string[] }[] = [];
  for (const h of listing) {
    const ws = h.workspaces.find((w) => w.id === shown.id)!;
    for (const sec of workspaceSections(ws, h.sections)) {
      const seen = out.find((x) => x.sec.id === sec.id);
      if (seen) seen.hosts.push(h.host);
      else out.push({ ws, sec, hosts: [h.host] });
    }
  }
  return out;
}

/** The hosts the app is connected to, as one comma-joined string. */
export const connectedHosts = (hosts: Record<string, { id: string; status: string }>) =>
  Object.values(hosts)
    .filter((h) => h.status === "connected")
    .map((h) => h.id)
    .join(",");

/** Each member's side of shared section `sec`, from what it lists: the
 * first holder's is `sec` itself. A holder's side also has the sessions
 * other members run that it holds copies of (X88), each under its copy
 * host, except one a host the app is connected to (`connected`, every host
 * when not given) lists as its own: a copy keeps its session's id (X72).
 * A session two holders list, as while it moves between them (X73), is
 * the first one's only. */
export function sectionParts(
  holding: string[],
  sec: Section,
  of: { sections: Record<string, Section[]>; projects: Record<string, Project[]>; sessions: Record<string, Session[]>; connected?: string[] },
): SectionPart[] {
  const own = new Set(
    Object.entries(of.sessions)
      .filter(([h]) => !parseCopyHost(h) && (!of.connected || of.connected.includes(h)))
      .flatMap(([, list]) => list.map((x) => x.id)),
  );
  const unclaimed = firstListings(
    holding.map((h) => of.sessions[h] ?? []),
    (x) => x.id,
  );
  return holding.map((h, i) => {
    const copies = Object.entries(of.sessions).flatMap(([key, list]) =>
      parseCopyHost(key)?.host === h ? list.filter((x) => !own.has(x.id)).map((x) => ({ key, session: x })) : [],
    );
    return {
      host: h,
      sec: i === 0 ? sec : ((of.sections[h] ?? []).find((x) => x.id === sec.id) ?? sec),
      projects: of.projects[h] ?? [],
      sessions: [...unclaimed[i], ...copies.map((c) => c.session)],
      ...(copies.length && { hostOf: Object.fromEntries(copies.map((c) => [c.session.id, c.key])) }),
    };
  });
}

/** The keys the sidebar folds a shared section and its groups under: the
 * shown member's, as it draws them. */
export const sectionCollapseKey = (primary: string, sec: string) => `ws:${primary}/${sec}`;
export const groupCollapseKey = (primary: string, sec: string, group: string) => `${primary}/${sec}/${group}`;

/** The sessions of the shown workspace in the sidebar's order, for ⌘1–9:
 * every member's, merged as the sidebar shows them, without those in a
 * folded section or group. */
export function sharedSessionOrder(o: {
  shown: { host: string; id: string; account?: string } | null;
  hosts: ListingHost[];
  projects: Record<string, Project[]>;
  sessions: Record<string, Session[]>;
  /** The hosts the app is connected to, for which copies show (X88). */
  connected?: string[];
  activeAt: (host: string, s: Session) => number;
  stateOf?: (host: string, s: Session) => AgentState | null;
  collapsed: Record<string, boolean>;
}): { host: string; id: string }[] {
  const sections = Object.fromEntries(o.hosts.map((h) => [h.host, h.sections]));
  const out: { host: string; id: string }[] = [];
  for (const { ws, sec, hosts } of shownSections(o.shown, o.hosts)) {
    if (o.collapsed[sectionCollapseKey(hosts[0], sec.id)]) continue;
    const groups = arrangeShared(ws.id, sectionParts(hosts, sec, { sections, projects: o.projects, sessions: o.sessions, connected: o.connected }), {
      stateOf: o.stateOf ?? (() => null),
      activeAt: o.activeAt,
      archiving: () => false,
      taskOf: () => null,
    });
    for (const g of groups) {
      if (o.collapsed[groupCollapseKey(hosts[0], sec.id, g.key)]) continue;
      for (const e of g.sessions) if (!out.some((x) => x.host === e.host && x.id === e.session.id)) out.push({ host: e.host, id: e.session.id });
    }
  }
  return out;
}

/** A workspace's sections in its order (X32). */
export function workspaceSections(ws: Workspace, sections: Section[]): Section[] {
  const byId = new Map(sections.map((s) => [s.id, s]));
  return ws.section_ids.flatMap((id) => byId.get(id) ?? []);
}

/** A host's sections in sidebar order, each with its workspace and the label
 * pickers show ("Workspace › Section" once there are several workspaces). */
export function hostSections(workspaces: Workspace[], sections: Section[]): { ws: Workspace; sec: Section; label: string }[] {
  return workspaces.flatMap((ws) => workspaceSections(ws, sections).map((sec) => ({ ws, sec, label: workspaces.length > 1 ? `${ws.name} › ${sec.name}` : sec.name })));
}

/** Whether a section of `ws` holds `projectId`: its sessions may live there. */
export function holdsProject(ws: Workspace, sections: Section[], projectId: string): boolean {
  return workspaceSections(ws, sections).some((s) => s.project_ids.includes(projectId));
}

/** A section's project filter after ticking or unticking `id` among `all`
 * its projects: an empty filter is every project (X32). */
export function filterAfterToggle(filter: string[], all: string[], id: string): string[] {
  const cur = filter.length ? filter : all;
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  return next.length === all.length ? [] : next;
}

/** `5512` → `5.5k`, as in Conductor's sidebar. */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

/**
 * A session row's leading glyph: the agent's state dot, or the branch when the
 * agent is at rest. A merged PR shows as an icon at the row's end, so its
 * session keeps a dot (idle when no agent runs).
 */
export function sessionGlyph(state: AgentState | null, pr: string | undefined): AgentState | "branch" {
  if (state && state !== "idle") return state;
  return pr === "merged" ? "idle" : "branch";
}

/** The chip at the end of a session row, most urgent first; running
 *  subagents (X42) come after needs input. `icon` draws it as an icon. */
export function sessionBadge(o: {
  creating: boolean;
  state: AgentState | null;
  merged: boolean;
  git?: { additions: number; deletions: number };
  agents: number;
}): { text: string; tone: "muted" | "blocked" | "agents" | "diff"; icon?: true } | null {
  if (o.creating) return { text: "creating", tone: "muted" };
  // An icon, its text the label, keeps the badge column narrow (X119).
  if (o.state === "blocked") return { text: "needs input", tone: "blocked", icon: true };
  if (o.agents) return { text: agentCount(o.agents), tone: "agents" };
  // A merged PR's row ends in its merge icon, beside any badge above, instead of the diff.
  if (o.merged) return null;
  if (o.git && (o.git.additions || o.git.deletions)) {
    return { text: `+${compact(o.git.additions)}${o.git.deletions ? ` -${compact(o.git.deletions)}` : ""}`, tone: "diff" };
  }
  return null;
}

/**
 * The project row's "Remove from <section>" item. `section.remove_project`
 * drops a project no other section holds, so that case asks first.
 */
export function projectRemoval(sections: Section[], secId: string, project: Project): { label: string; confirm: string | null } {
  const sec = sections.find((s) => s.id === secId);
  const elsewhere = sections.some((s) => s.id !== secId && s.project_ids.includes(project.id));
  return {
    label: `Remove from ${sec?.name ?? "section"}`,
    confirm: elsewhere ? null : `${project.name} is in no other section, so it will be removed from moonlet. The folder on disk is not touched.`,
  };
}

/** Latest output of a session's own terminals (its "recent" sort key). A sort
 *  asks for it on every comparison, so it is given the session's terminals,
 *  not the host's. */
export function lastActive(own: readonly { last_output_at: number }[], s: Session): number {
  return own.reduce((m, t) => Math.max(m, t.last_output_at), s.created_at);
}

export type SessionMenuItem = "open" | "open-pr" | "open-in" | "pin-top" | "unpin-top" | "mark-read" | "mark-unread" | "rename" | "fork" | "move-workspace" | "move-under" | "link-task" | "keep-sync" | "archive" | "-";

/**
 * A session row's right-click menu (X112), its groups split by "-". Open PR
 * shows with a PR; Pin to top or Unpin from top (X112); Mark as read on an unread session, Mark as unread on a
 * read one with an agent tab. Link to task… is there for a session without a
 * task in a workspace with a task source (X46). A copy of a session another
 * member runs (X88) has only what the central host can ask that member for:
 * Open, and Archive while the member is reachable.
 */
export function sessionMenu(s: { linked: boolean; sources: boolean; sync?: boolean; copy?: { reachable: boolean }; pr?: boolean; unread?: boolean; agent?: boolean; pinnedTop?: boolean }): SessionMenuItem[] {
  if (s.copy) return s.copy.reachable ? ["open", "archive"] : ["open"];
  const groups: SessionMenuItem[][] = [
    ["open", ...(s.pr ? (["open-pr"] as const) : []), "open-in"],
    [s.pinnedTop ? "unpin-top" : "pin-top", ...(s.unread ? (["mark-read"] as const) : s.agent ? (["mark-unread"] as const) : []), "rename", "fork"],
    ["move-workspace", "move-under"],
    [...(!s.linked && s.sources ? (["link-task"] as const) : []), ...(s.sync ? (["keep-sync"] as const) : [])],
  ];
  // Archive brings its own divider, after the Run only on… items (X73).
  return [...groups.filter((g) => g.length).flatMap((g, i) => (i ? ["-" as const, ...g] : g)), "archive"];
}

/** The key shown beside Open in a session's menu (X112): ⌘1 to ⌘9 open the
 * first nine sessions in sidebar order (`selectSessionByIndex`). */
export const openShortcut = (index: number): string | undefined => (index >= 0 && index < 9 ? `⌘${index + 1}` : undefined);

/** Whether a session of `group` is drawn nested (X112): its parent is a
 * top-level session of the same group. Nesting is one level deep. */
export function nestedIn<T>(group: readonly T[], of: (x: T) => Session): (s: Session) => boolean {
  const ids = new Set(group.map((x) => of(x).id));
  // A session whose parent is not in the group is a top row itself.
  const top = new Set(group.map(of).filter((s) => !s.parent || !ids.has(s.parent)).map((s) => s.id));
  return (s) => !!s.parent && top.has(s.parent);
}

/** `list` in its order, each nested session moved right after its parent,
 * keeping the order among siblings (X112). */
export function nestUnderParents<T>(list: T[], of: (x: T) => Session): T[] {
  const nested = nestedIn(list, of);
  const out: T[] = [];
  for (const x of list) {
    if (nested(of(x))) continue;
    out.push(x, ...list.filter((y) => of(y).parent === of(x).id && nested(of(y))));
  }
  return out;
}

/** Move under's sessions for `s` (X112): the other top-level, unarchived
 * sessions of its project and workspace, newest first, its parent ticked;
 * Move to top level (`top`) while it has a parent. A session with sessions
 * under it cannot be nested: nesting is one level deep. */
export function moveUnderTargets(s: Session, sessions: readonly Session[]): { disabled: string | null; top: boolean; targets: { id: string; name: string; current: boolean }[] } {
  const live = sessions.filter((x) => !x.archived);
  if (live.some((x) => x.parent === s.id)) return { disabled: "Sessions are under it", top: false, targets: [] };
  const targets = live
    // Another member's session, here through its copy (X88), is not this host's to nest under.
    .filter((x) => x.id !== s.id && !x.parent && !x.owner && x.project_id === s.project_id && x.workspace_id === s.workspace_id)
    .sort((a, b) => b.created_at - a.created_at)
    .map((x) => ({ id: x.id, name: x.name, current: x.id === s.parent }));
  if (!targets.length && !s.parent) return { disabled: "No other session of this project here", top: false, targets };
  return { disabled: null, top: !!s.parent, targets };
}
