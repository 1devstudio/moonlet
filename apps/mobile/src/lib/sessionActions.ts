// A session's long-press menu and a section's view menu on the phone
// (X118): the desktop sidebar's items (X112, X32) the phone can do, and the
// daemon calls they make.

import { M, type Section, type SectionView, type Session } from "@desktop/lib/protocol";
import { filterAfterToggle, sessionMenu, type SessionMenuItem } from "@desktop/lib/sidebar";

/** Only the Mac can do these: its own read state, its apps, its copies. */
const MAC_ONLY: SessionMenuItem[] = ["open-in", "mark-read", "mark-unread", "keep-sync"];

/** The items of `s`'s menu, split by "-", Archive last after its own divider. */
export function menuItems(s: Session, c: { linked: boolean; sources: boolean; pr: boolean }): SessionMenuItem[] {
  const copy = s.owner ? { reachable: s.owner.reachable } : undefined;
  const ids = sessionMenu({ linked: c.linked, sources: c.sources, copy, pr: c.pr, pinnedTop: !!s.pinned_top }).filter((id) => !MAC_ONLY.includes(id));
  // Archive comes after a divider, as the desktop's brings its own.
  const out: SessionMenuItem[] = [];
  for (const id of ids) {
    if (id === "archive") out.push("-");
    // No divider twice in a row, nor at the end, once Mac-only items went.
    if (id === "-" && (out.length === 0 || out[out.length - 1] === "-")) continue;
    out.push(id);
  }
  while (out[out.length - 1] === "-") out.pop();
  return out;
}

/** A change picked in a session's menu. */
export type SessionAction =
  | { kind: "pin-top" | "unpin-top" | "fork" }
  | { kind: "rename"; name: string }
  | { kind: "move-workspace"; workspace: string }
  | { kind: "move-under"; parent: string | null };

/** The daemon call `a` makes on `s`'s host, or null when it changes nothing. */
export function actionCall(s: Session, a: SessionAction): { method: string; params: Record<string, unknown> } | null {
  const update = (patch: Record<string, unknown>) => ({ method: M.sessionUpdate, params: { id: s.id, ...patch } });
  switch (a.kind) {
    case "pin-top":
      return update({ pinned_top: true });
    case "unpin-top":
      return update({ pinned_top: false });
    case "rename": {
      const name = a.name.trim();
      return name && name !== s.name ? update({ name }) : null;
    }
    case "move-workspace":
      return update({ workspace_id: a.workspace });
    case "move-under":
      return update({ parent: a.parent });
    case "fork":
      return { method: M.sessionFork, params: { id: s.id } };
  }
}

/** A choice in a section's ⋯ menu: its grouping, its sorting, a project ticked or unticked, or All projects. */
export type ViewChoice = Pick<SectionView, "group_by"> | Pick<SectionView, "sort_by"> | { toggle: string } | { all: true };

/** The `section.update` saving `sec`'s view after `c`, on its host, so the
 * Mac shows it too. `known`: the section's projects its host has, which
 * the filter counts, as the desktop's does. */
export function viewCall(sec: Section, c: ViewChoice, known: string[]): { method: string; params: { id: string; view: SectionView } } {
  const view =
    "toggle" in c ? { ...sec.view, filter: filterAfterToggle(sec.view.filter, known, c.toggle) } : "all" in c ? { ...sec.view, filter: [] } : { ...sec.view, ...c };
  return { method: M.sectionUpdate, params: { id: sec.id, view } };
}
