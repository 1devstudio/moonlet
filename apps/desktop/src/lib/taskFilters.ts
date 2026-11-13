// The board header's Filter menu, applied filters and Display options (X100).

import type { ColumnView } from "./boardColumns";
import type { Assignee } from "./boards";
import type { Card } from "./tasksBoard";

export type FilterField = "state" | "assignee" | "priority" | "type" | "labels" | "sessions" | "pr" | "cycle";

/** A filter applied to a board: the tasks with one of `values` of `field`, or, `not`, those with none. */
export interface TaskFilter {
  field: FilterField;
  values: string[];
  not: boolean;
}

/** Assignee's Me: the user's own tasks, and those a session of theirs is on (X45 Assignee: me). */
export const ME = ":me";
/** No assignee, No session, No pull request, No cycle. */
export const NONE = ":none";

/** A session's pull request: `open`, `draft`, `merged` or `closed`. */
const prValue = (pr: { state: string; draft?: boolean }) => (pr.state.toLowerCase() === "open" && pr.draft ? "draft" : pr.state.toLowerCase());

/** The values card `c`, in column `column`, has for `field`. */
function valuesOf(c: Card, column: string, field: FilterField): string[] {
  const t = c.task;
  switch (field) {
    case "state":
      return [column];
    case "assignee": {
      const me = t.mine !== false || c.rows.length > 0 ? [ME] : [];
      return [...me, ...(t.assignees.length ? t.assignees : [NONE])];
    }
    case "priority":
      return [String(t.priority)];
    case "type":
      return t.issueType ? [t.issueType] : [];
    case "labels":
      return t.labels;
    case "sessions":
      return c.rows.length ? (c.needsYou ? ["needs_you", "with"] : ["with"]) : [NONE];
    case "pr": {
      const prs = c.rows.flatMap((r) => (r.session.pr ? [prValue(r.session.pr)] : []));
      return prs.length ? [...new Set(prs)] : [NONE];
    }
    case "cycle":
      return [t.cycle === undefined ? NONE : String(t.cycle)];
  }
}

const passes = (c: Card, column: string, f: TaskFilter) => {
  const have = valuesOf(c, column, f.field);
  return f.values.some((v) => have.includes(v)) !== f.not;
};

/** The board's columns with only the cards every filter keeps. */
export function applyFilters(views: ColumnView[], filters: TaskFilter[]): ColumnView[] {
  if (!filters.length) return views;
  return views.map((v) => {
    const cards = v.cards.filter((c) => filters.every((f) => passes(c, v.name, f)));
    return { ...v, cards, ...(v.wip && { wip: { ...v.wip, count: cards.length, full: cards.length >= v.wip.max } }) };
  });
}

export interface FilterValue {
  id: string;
  label: string;
  /** How many of the board's tasks have it. */
  count: number;
  /** A State value's column category, for its glyph. */
  category?: ColumnView["category"];
}

export interface FieldChoice {
  field: FilterField;
  label: string;
  values: FilterValue[];
}

export const FIELD_LABEL: Record<FilterField, string> = { state: "State", assignee: "Assignee", priority: "Priority", type: "Type", labels: "Labels", sessions: "Sessions", pr: "Pull request", cycle: "Cycle" };
const ORDER: FilterField[] = ["state", "assignee", "priority", "type", "labels", "sessions", "pr", "cycle"];
const PRIORITY = ["No priority", "Low", "Medium", "High"];
const SESSIONS: Record<string, string> = { needs_you: "Needs you", with: "With a session" };
const PR: Record<string, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };
const NO: Record<FilterField, string> = { state: "No state", assignee: "No assignee", priority: "No priority", type: "No type", labels: "No label", sessions: "No session", pr: "No pull request", cycle: "No cycle" };

/** How value `id` of `field` reads in the menu and on a chip. */
export function valueLabel(field: FilterField, id: string): string {
  if (id === NONE) return NO[field];
  if (field === "assignee" && id === ME) return "Me";
  if (field === "priority") return PRIORITY[Number(id)] ?? id;
  if (field === "sessions") return SESSIONS[id] ?? id;
  if (field === "pr") return PR[id] ?? id;
  if (field === "cycle") return `Cycle ${id}`;
  return id;
}

/** The order of a field's values that is not the board's own: fixed ones first, by most tasks, by name, or newest cycle. */
function sortValues(field: FilterField, counts: Map<string, number>): string[] {
  const ids = [...counts.keys()].filter((id) => id !== NONE && id !== ME);
  const fixed: Partial<Record<FilterField, string[]>> = { priority: ["3", "2", "1"], sessions: ["needs_you", "with"], pr: ["open", "draft", "merged", "closed"] };
  let sorted: string[];
  if (fixed[field]) sorted = [...fixed[field], ...ids.filter((id) => !fixed[field]!.includes(id))].filter((id) => counts.has(id));
  else if (field === "assignee") sorted = ids.sort((a, b) => counts.get(b)! - counts.get(a)! || a.localeCompare(b));
  else if (field === "cycle") sorted = ids.sort((a, b) => Number(b) - Number(a));
  else sorted = ids.sort((a, b) => a.localeCompare(b));
  const none = field === "priority" ? "0" : NONE;
  return [...(field === "assignee" ? [ME] : []), ...sorted.filter((id) => id !== none), ...(counts.has(none) ? [none] : [])];
}

/** The Filter menu's fields and their values, with how many of the board's tasks (shown and folded columns) have each. */
export function filterFields(views: ColumnView[]): FieldChoice[] {
  const cards = views.flatMap((v) => v.cards.map((c) => ({ c, column: v.name })));
  return ORDER.flatMap((field): FieldChoice[] => {
    const counts = new Map<string, number>();
    for (const { c, column } of cards) for (const v of new Set(valuesOf(c, column, field))) counts.set(v, (counts.get(v) ?? 0) + 1);
    if (field === "state") return [{ field, label: FIELD_LABEL[field], values: views.map((v) => ({ id: v.name, label: v.name, count: v.cards.length, category: v.category })) }];
    // A field no task has a value for is left out; an optional field's "none" doesn't count.
    const anyValue = [...counts.keys()].some((id) => id !== NONE && !(field === "priority" && id === "0"));
    if (!anyValue && (field === "priority" || field === "type" || field === "labels" || field === "cycle")) return [];
    const values = sortValues(field, counts).map((id) => ({ id, label: valueLabel(field, id), count: counts.get(id) ?? 0 }));
    return [{ field, label: FIELD_LABEL[field], values }];
  });
}

const PLURAL: Record<FilterField, string> = { state: "states", assignee: "assignees", priority: "priorities", type: "types", labels: "labels", sessions: "values", pr: "values", cycle: "cycles" };

/** A chip in the applied filters' row: `<field> <op> <value>`. */
export function chipOf(f: TaskFilter): { field: string; op: string; value: string } {
  const many = f.values.length > 1;
  const op = f.not ? (many ? "is none of" : "is not") : many ? "is any of" : "is";
  const value = f.values.length > 2 ? `${f.values.length} ${PLURAL[f.field]}` : f.values.map((v) => valueLabel(f.field, v)).join(", ");
  return { field: FIELD_LABEL[f.field], op, value };
}

/** The filters with `value` of `field` added, or taken out; a filter left with no value goes. */
export function toggleValue(filters: TaskFilter[], field: FilterField, value: string): TaskFilter[] {
  if (!filters.some((f) => f.field === field)) return [...filters, { field, values: [value], not: false }];
  return filters.flatMap((f) => {
    if (f.field !== field) return [f];
    const values = f.values.includes(value) ? f.values.filter((v) => v !== value) : [...f.values, value];
    return values.length ? [{ ...f, values }] : [];
  });
}

/** `field`'s filter switched between keeping and leaving out its values. */
export const flipOp = (filters: TaskFilter[], field: FilterField): TaskFilter[] => filters.map((f) => (f.field === field ? { ...f, not: !f.not } : f));

export const removeFilter = (filters: TaskFilter[], field: FilterField): TaskFilter[] => filters.filter((f) => f.field !== field);

const isMeOnly = (f: TaskFilter) => f.field === "assignee" && !f.not && f.values.length === 1 && f.values[0] === ME;

/** A board's filters: at Assignee me (X50), the chip Assignee is Me first, in place of a saved Assignee filter; at anyone, those saved. */
export function filtersAtPick(saved: TaskFilter[], pick: Assignee): TaskFilter[] {
  if (pick === "anyone") return saved;
  return [{ field: "assignee", values: [ME], not: false }, ...saved.filter((f) => f.field !== "assignee")];
}

/** What a board's filters save: Assignee is Me alone is the pick at me, kept as X50's pick; anything else picks anyone, the filters kept. */
export function saveFilters(filters: TaskFilter[]): { saved: TaskFilter[]; pick: Assignee } {
  return filters.some(isMeOnly) ? { saved: filters.filter((f) => !isMeOnly(f)), pick: "me" } : { saved: filters, pick: "anyone" };
}

export type Ordering = "board" | "priority" | "updated";

/** Display options kept for every board: ordering, Show empty columns, Show sessions on cards. */
export interface Display {
  ordering: Ordering;
  showEmpty: boolean;
  sessions: boolean;
}

export const DEFAULT_DISPLAY: Display = { ordering: "board", showEmpty: true, sessions: true };

export const ORDERINGS: { id: Ordering; label: string }[] = [
  { id: "board", label: "Board order" },
  { id: "priority", label: "Priority" },
  { id: "updated", label: "Updated" },
];

/** The columns as Display options draw them: each one's cards in the ordering picked, and those left with no card gone unless Show empty columns. */
export function arrange(views: ColumnView[], d: Display): ColumnView[] {
  const by = d.ordering === "priority" ? (c: Card) => -c.task.priority : d.ordering === "updated" ? (c: Card) => -c.task.updatedMs : null;
  // Array.prototype.sort is stable: ties keep the board's order.
  const ordered = by ? views.map((v) => ({ ...v, cards: [...v.cards].sort((a, b) => by(a) - by(b)) })) : views;
  return d.showEmpty ? ordered : ordered.filter((v) => v.cards.length > 0);
}

/** "8 of 14 tasks": the tasks `after` the filters leave of those `before`. */
export function countLine(before: ColumnView[], after: ColumnView[]): string {
  const n = (vs: ColumnView[]) => vs.reduce((s, v) => s + v.cards.length, 0);
  const total = n(before);
  return `${n(after)} of ${total} ${total === 1 ? "task" : "tasks"}`;
}

/** F opens the Filter menu, V Display options: bare keys, while no text field has the focus and no dialog is open. */
export function panelKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, typing: boolean, dialog: boolean): "filter" | "display" | null {
  if (typing || dialog || e.metaKey || e.ctrlKey || e.altKey) return null;
  return e.key === "f" || e.key === "F" ? "filter" : e.key === "v" || e.key === "V" ? "display" : null;
}

const has = (text: string, q: string) => text.toLowerCase().includes(q);

/** A field's values whose name has `query`, ignoring case and outer spaces. */
export function matchingValues(field: FieldChoice, query: string): FilterValue[] {
  const q = query.trim().toLowerCase();
  return field.values.filter((v) => has(v.label, q));
}

/** "Add filter…" typed in: the fields whose name has the text, then the values that have it; no values while empty. */
export function searchFilterMenu(fields: FieldChoice[], query: string): { fields: FieldChoice[]; values: { field: FilterField; fieldLabel: string; value: FilterValue }[] } {
  const q = query.trim().toLowerCase();
  if (!q) return { fields, values: [] };
  return {
    fields: fields.filter((f) => has(f.label, q)),
    values: fields.flatMap((f) => matchingValues(f, q).map((value) => ({ field: f.field, fieldLabel: f.label, value }))),
  };
}

/** Each board's saved filters as read back from storage, leaving out any it can't read (an unknown field, values that aren't strings). */
export function readSavedFilters(raw: unknown): Record<string, TaskFilter[]> {
  if (!raw || typeof raw !== "object") return {};
  const ok = (f: unknown): f is TaskFilter => {
    const x = f as Partial<TaskFilter> | null;
    return !!x && ORDER.includes(x.field as FilterField) && Array.isArray(x.values) && x.values.length > 0 && x.values.every((v) => typeof v === "string") && typeof x.not === "boolean";
  };
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).flatMap(([id, list]) => {
      const kept = Array.isArray(list) ? list.filter(ok).map((f) => ({ field: f.field, values: f.values, not: f.not })) : [];
      return kept.length ? [[id, kept]] : [];
    }),
  );
}

/** What a key does in the Filter menu: in its list of fields (and values found by "Add filter…"), or in a field's values. */
export type FilterMenuAct = { move: number } | { open: number } | { pick: number } | { back: true } | null;

export function filterMenuKey(key: string, at: { list: "fields" | "values"; active: number; count: number; row: "field" | "value"; query: string }): FilterMenuAct {
  if (at.list === "values" && (key === "Escape" || (key === "ArrowLeft" && !at.query))) return { back: true };
  if (!at.count) return null;
  if (key === "ArrowDown" || key === "ArrowUp") return { move: (at.active + (key === "ArrowDown" ? 1 : at.count - 1)) % at.count };
  if (at.list === "fields" && at.row === "field" && (key === "Enter" || key === "ArrowRight")) return { open: at.active };
  if (key === "Enter") return { pick: at.active };
  return null;
}
