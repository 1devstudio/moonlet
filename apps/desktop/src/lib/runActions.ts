// The Run action modal's catalogue, matching and custom shortcuts (X19).
// Pure: the store and the action handlers live elsewhere.

export interface ActionDef {
  id: string;
  label: string;
  group: string;
  /** Default shortcut as a key id (see keyId), "" for none. */
  keys: string;
}

export const ACTIONS: ActionDef[] = [
  ["new-session", "New session…", "Session", "shift+cmd+n"],
  ["new-ws", "New workspace…", "Workspace", ""],
  ["new-section", "New section…", "Section", ""],
  ["add-project", "Add project…", "Section", ""],
  ["new-tab", "New agent tab", "Agent", "cmd+t"],
  ["new-terminal", "New terminal tab", "Terminal", "shift+cmd+t"],
  ["split-r", "Split pane right", "Terminal", "cmd+d"],
  ["split-d", "Split pane down", "Terminal", "alt+cmd+d"],
  ["close", "Close pane", "Terminal", "cmd+w"],
  ["run", "Run script", "Project", "cmd+r"],
  ["setup", "Re-run setup script", "Project", ""],
  ["project-settings", "Project settings…", "Project", ""],
  ["changes", "Show changes", "Panels", "shift+cmd+d"],
  ["files", "Show files", "Panels", "shift+cmd+e"],
  ["checks", "Show review (PR, checks, commits)", "Panels", ""],
  ["commit", "Commit…", "Git", ""],
  ["pr", "Create pull request…", "Git", "shift+cmd+p"],
  ["archive", "Archive session…", "Session", ""],
  ["find", "Find in terminal", "Terminal", "cmd+f"],
  ["prev-cmd", "Jump to previous command", "Terminal", "cmd+arrowup"],
  ["next-cmd", "Jump to next command", "Terminal", "cmd+arrowdown"],
  ["copy-out", "Copy last command output", "Terminal", "shift+cmd+c"],
  ["rerun", "Re-run last command", "Terminal", ""],
  ["history", "Show archived sessions", "Session", ""],
  ["settings", "Settings…", "App", "cmd+,"],
  ["check-updates", "Check for updates…", "App", ""],
].map(([id, label, group, keys]) => ({ id, label, group, keys }));

/** Scores `text` against `q`: a contiguous match ranks by position, letters
 * in order rank below, anything else is 0. `hits` are the matched indexes. */
export function match(q: string, text: string): { score: number; hits: number[] } {
  if (!q) return { score: 1, hits: [] };
  const t = text.toLowerCase();
  const query = q.toLowerCase();
  const at = t.indexOf(query);
  if (at >= 0) return { score: 100 - at, hits: Array.from(query, (_, i) => at + i) };
  const hits: number[] = [];
  for (let k = 0; k < t.length && hits.length < query.length; k++) if (t[k] === query[hits.length]) hits.push(k);
  return hits.length === query.length ? { score: 10, hits } : { score: 0, hits: [] };
}

export interface ActionRow {
  action: ActionDef;
  hits: number[];
}

/** Actions matching `q`, best first; ties keep catalogue order. */
export function filterActions(q: string): ActionRow[] {
  return ACTIONS.map((action) => ({ action, ...match(q, action.label) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ action, hits }) => ({ action, hits }));
}

/** Splits `label` into runs of matched and unmatched characters. */
export function highlight(label: string, hits: number[]): { text: string; hit: boolean }[] {
  const set = new Set(hits);
  const parts: { text: string; hit: boolean }[] = [];
  for (let k = 0; k < label.length; k++) {
    const hit = set.has(k);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += label[k];
    else parts.push({ text: label[k], hit });
  }
  return parts;
}

/** Key id of a key press: modifiers in fixed order + lower-case key, e.g.
 * "shift+cmd+n". The format of ActionDef.keys and settings.shortcuts. */
export function keyId(e: KeyboardEvent): string {
  const parts = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  if (e.metaKey) parts.push("cmd");
  // With ⌥ held, e.key is a composed character; use the physical key.
  let key = e.key.toLowerCase();
  if (e.altKey && e.code.startsWith("Key")) key = e.code.slice(3).toLowerCase();
  if (e.altKey && e.code.startsWith("Digit")) key = e.code.slice(5);
  if (e.code === "BracketRight") key = "]";
  if (e.code === "BracketLeft") key = "[";
  parts.push(key);
  return parts.join("+");
}

const MOD_LABEL: Record<string, string> = { ctrl: "⌃", shift: "⇧", alt: "⌥", cmd: "⌘" };
const KEY_LABEL: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  enter: "↵",
  backspace: "⌫",
  tab: "⇥",
  escape: "⎋",
  " ": "Space",
};

/** "shift+cmd+n" → "⇧⌘N". */
export function keyLabel(id: string): string {
  const mods = /^((?:ctrl|shift|alt|cmd)\+)*/.exec(id)?.[0] ?? "";
  const key = id.slice(mods.length);
  const name = KEY_LABEL[key] ?? (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));
  return mods.split("+").map((m) => MOD_LABEL[m] ?? "").join("") + name;
}

/** Custom shortcuts, saved in settings: action id → key id, "" for none. */
export type Shortcuts = Record<string, string>;

/** Every action's current key id, "" for none. A key the user set wins
 * over another action's default, such as one added later (X38). */
export function effectiveKeys(custom: Shortcuts | undefined): Record<string, string> {
  const taken = new Set(Object.values(custom ?? {}).filter(Boolean));
  return Object.fromEntries(ACTIONS.map((a) => [a.id, custom?.[a.id] ?? (taken.has(a.keys) ? "" : a.keys)]));
}

/** The action `key` runs, if any. */
export function actionForKey(key: string, custom: Shortcuts | undefined): string | undefined {
  const keys = effectiveKeys(custom);
  return ACTIONS.find((a) => keys[a.id] === key)?.id;
}

/** Keys an action cannot take: editing and window keys, and the app's fixed shortcuts. */
const RESERVED: Record<string, string> = {
  "cmd+k": "Run action",
  "cmd+c": "Copy",
  "cmd+v": "Paste",
  "cmd+x": "Cut",
  "cmd+a": "Select all",
  "cmd+z": "Undo",
  "shift+cmd+z": "Redo",
  "cmd+q": "Quit moonlet",
  "cmd+h": "Hide moonlet",
  "cmd+m": "Minimize",
  "cmd+b": "Toggle sidebar",
  "cmd+\\": "Toggle right panel",
  "cmd+enter": "Send block to agent",
  "shift+cmd+enter": "Send block to a new agent",
  "alt+cmd+c": "Copy command",
  "alt+cmd+arrowright": "Focus next pane",
  "alt+cmd+arrowleft": "Focus previous pane",
  "shift+cmd+]": "Next tab",
  "shift+cmd+[": "Previous tab",
  "cmd+=": "Bigger text",
  "shift+cmd+=": "Bigger text",
  "cmd++": "Bigger text",
  "shift+cmd++": "Bigger text",
  "cmd+-": "Smaller text",
  "cmd+0": "Default text size",
};

function reservedFor(key: string): string | undefined {
  const n = /^cmd\+([1-9])$/.exec(key)?.[1];
  return n ? `Go to session ${n}` : RESERVED[key];
}

export type Recording =
  | { kind: "wait" }
  | { kind: "error"; message: string }
  | { kind: "conflict"; keys: string; other: string }
  | { kind: "ok"; keys: string };

/** What pressing `key` does while recording a shortcut for `action`. */
export function recordKey(key: string, action: string, custom: Shortcuts | undefined): Recording {
  if (/(^|\+)(meta|shift|alt|control)$/.test(key)) return { kind: "wait" };
  if (!key.split("+").includes("cmd")) return { kind: "error", message: "Include ⌘ so the key never reaches the terminal." };
  const reserved = reservedFor(key);
  if (reserved) return { kind: "error", message: `${keyLabel(key)} is reserved for ${reserved}.` };
  const other = actionForKey(key, custom);
  if (other && other !== action) return { kind: "conflict", keys: key, other };
  return { kind: "ok", keys: key };
}

/** Gives `action` the key; `takeFrom` loses it. */
export function assignShortcut(custom: Shortcuts | undefined, action: string, keys: string, takeFrom?: string): Shortcuts {
  return { ...custom, [action]: keys, ...(takeFrom ? { [takeFrom]: "" } : {}) };
}
