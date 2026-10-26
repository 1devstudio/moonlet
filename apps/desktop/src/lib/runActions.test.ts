import { describe, expect, it } from "vitest";
import { ACTIONS, actionForKey, assignShortcut, effectiveKeys, filterActions, highlight, keyId, keyLabel, keyParts, recordKey, resetShortcut, shortcutGroups } from "./runActions";

describe("filtering", () => {
  it("lists all 29 actions in catalogue order for an empty query", () => {
    const rows = filterActions("");
    expect(rows).toHaveLength(29);
    expect(rows[0].action.label).toBe("New session…");
    expect(rows[1].action.label).toBe("New workspace…");
    expect(rows[24].action.label).toBe("Switch between Sessions and Tasks");
    expect(rows[25].action.label).toBe("Switch between Sessions and Design");
    expect(rows[26].action.label).toBe("New design…");
    expect(rows[27].action.label).toBe("Settings…");
    expect(rows[28].action.label).toBe("Check for updates…");
  });

  it("finds the update check (X35)", () => {
    expect(filterActions("update").map((r) => r.action.label)).toEqual(["Check for updates…"]);
  });

  it("ranks contiguous matches above scattered ones, earlier above later", () => {
    expect(filterActions("set").map((r) => r.action.label)).toEqual([
      "Settings…",
      "Re-run setup script",
      "Project settings…",
      "New section…",
      "Split pane right",
      "Show review (PR, checks, commits)",
      "Switch between Sessions and Tasks",
      "Switch between Sessions and Design",
    ]);
  });

  it("ignores case", () => {
    expect(filterActions("SPL").map((r) => r.action.label)).toEqual(["Split pane right", "Split pane down"]);
  });

  it("returns nothing when the letters are not all there in order", () => {
    expect(filterActions("deploy")).toEqual([]);
  });
});

describe("highlight", () => {
  it("splits a label into matched and unmatched runs", () => {
    const [row] = filterActions("pane d");
    expect(highlight(row.action.label, row.hits)).toEqual([
      { text: "Split ", hit: false },
      { text: "pane d", hit: true },
      { text: "own", hit: false },
    ]);
  });

  it("marks scattered letters one by one", () => {
    const row = filterActions("set").find((r) => r.action.id === "split-r")!;
    expect(highlight(row.action.label, row.hits)).toEqual([
      { text: "S", hit: true },
      { text: "plit pan", hit: false },
      { text: "e", hit: true },
      { text: " righ", hit: false },
      { text: "t", hit: true },
    ]);
  });
});

const ev = (key: string, code: string, mods: Partial<Record<"metaKey" | "shiftKey" | "altKey" | "ctrlKey", boolean>> = {}) =>
  ({ key, code, metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, ...mods }) as KeyboardEvent;

describe("keys", () => {
  it("names a key press with modifiers in a fixed order", () => {
    expect(keyId(ev("N", "KeyN", { metaKey: true, shiftKey: true }))).toBe("shift+cmd+n");
    expect(keyId(ev("ArrowUp", "ArrowUp", { metaKey: true }))).toBe("cmd+arrowup");
  });

  it("uses the physical key when ⌥ composes a character", () => {
    expect(keyId(ev("ß", "KeyS", { metaKey: true, altKey: true }))).toBe("alt+cmd+s");
    expect(keyId(ev("¡", "Digit1", { metaKey: true, altKey: true }))).toBe("alt+cmd+1");
    expect(keyId(ev("”", "BracketRight", { metaKey: true, shiftKey: true }))).toBe("shift+cmd+]");
  });

  it("labels a key id with macOS symbols", () => {
    expect(keyLabel("shift+cmd+n")).toBe("⇧⌘N");
    expect(keyLabel("alt+cmd+d")).toBe("⌥⌘D");
    expect(keyLabel("cmd+arrowdown")).toBe("⌘↓");
    expect(keyLabel("ctrl+cmd+enter")).toBe("⌃⌘↵");
    expect(keyLabel("cmd+,")).toBe("⌘,");
    expect(keyLabel("cmd+f5")).toBe("⌘F5");
    expect(keyLabel("shift+cmd+ ")).toBe("⇧⌘Space");
  });
});

describe("shortcuts", () => {
  it("resolves defaults, custom keys and removed keys", () => {
    expect(actionForKey("cmd+t", undefined)).toBe("new-tab");
    // ⌃⌘T switches Sessions ⇄ Tasks (X45); ⇧⌘T stays New terminal tab.
    expect(actionForKey("ctrl+cmd+t", undefined)).toBe("tasks");
    // ⌃⌘D switches Sessions ⇄ Design (X65); ⌘D stays Split pane right.
    expect(actionForKey("ctrl+cmd+d", undefined)).toBe("design");
    expect(actionForKey("cmd+d", undefined)).toBe("split-r");
    expect(actionForKey("shift+cmd+t", undefined)).toBe("new-terminal");
    expect(actionForKey("alt+cmd+s", undefined)).toBeUndefined();
    expect(actionForKey("alt+cmd+s", { setup: "alt+cmd+s" })).toBe("setup");
    expect(actionForKey("cmd+t", { "new-tab": "" })).toBeUndefined();
    expect(actionForKey("cmd+t", { "new-tab": "alt+cmd+t" })).toBeUndefined();
    expect(actionForKey("alt+cmd+t", { "new-tab": "alt+cmd+t" })).toBe("new-tab");
  });

  it("gives ⇧⌘N to New design… in Design mode and to New session… elsewhere (X65)", () => {
    expect(ACTIONS.find((a) => a.id === "new-session")?.label).toBe("New session…");
    expect(ACTIONS.find((a) => a.id === "new-design")?.label).toBe("New design…");
    expect(actionForKey("shift+cmd+n", undefined, "design")).toBe("new-design");
    expect(actionForKey("shift+cmd+n", undefined, "sessions")).toBe("new-session");
    expect(actionForKey("shift+cmd+n", undefined, "tasks")).toBe("new-session");
    // A key the user gives New design is its own in Design mode only.
    expect(actionForKey("alt+cmd+n", { "new-design": "alt+cmd+n" }, "design")).toBe("new-design");
    expect(actionForKey("alt+cmd+n", { "new-design": "alt+cmd+n" }, "sessions")).toBeUndefined();
    // Taking ⇧⌘N from New session asks, and then New design loses it too.
    expect(recordKey("shift+cmd+n", "commit", {})).toEqual({ kind: "conflict", keys: "shift+cmd+n", other: "new-session" });
    expect(actionForKey("shift+cmd+n", { commit: "shift+cmd+n", "new-session": "" }, "design")).toBe("commit");
    // New design and New session share ⇧⌘N without a conflict: one key, one per mode.
    expect(recordKey("shift+cmd+n", "new-design", { "new-design": "" })).toEqual({ kind: "ok", keys: "shift+cmd+n" });
  });

  it("opens an agent tab with ⌘T and a terminal tab with ⇧⌘T (X38)", () => {
    expect(actionForKey("cmd+t", undefined)).toBe("new-tab");
    expect(ACTIONS.find((a) => a.id === "new-tab")?.label).toBe("New agent tab");
    expect(actionForKey("shift+cmd+t", undefined)).toBe("new-terminal");
    expect(ACTIONS.find((a) => a.id === "new-terminal")?.label).toBe("New terminal tab");
  });

  it("lets a key the user set win over another action's default (X38)", () => {
    // ⇧⌘T was free before "New terminal tab" took it as its default.
    expect(actionForKey("shift+cmd+t", { commit: "shift+cmd+t" })).toBe("commit");
    expect(effectiveKeys({ commit: "shift+cmd+t" })["new-terminal"]).toBe("");
    expect(effectiveKeys({ commit: "shift+cmd+t" }).commit).toBe("shift+cmd+t");
  });

  it("gives each action its current key", () => {
    const keys = effectiveKeys({ setup: "alt+cmd+s", "new-tab": "" });
    expect(keys.setup).toBe("alt+cmd+s");
    expect(keys["new-tab"]).toBe("");
    expect(keys["split-r"]).toBe("cmd+d");
    expect(keys.commit).toBe("");
  });

  it("keeps waiting while only modifiers are held", () => {
    expect(recordKey("cmd+meta", "setup", {})).toEqual({ kind: "wait" });
    expect(recordKey("shift+cmd+shift", "setup", {})).toEqual({ kind: "wait" });
    expect(recordKey("alt+alt", "setup", {})).toEqual({ kind: "wait" });
  });

  it("requires ⌘", () => {
    expect(recordKey("alt+s", "setup", {})).toEqual({ kind: "error", message: "Include ⌘ so the key never reaches the terminal." });
  });

  it("refuses reserved keys", () => {
    expect(recordKey("cmd+c", "setup", {})).toEqual({ kind: "error", message: "⌘C is reserved for Copy." });
    expect(recordKey("cmd+k", "setup", {})).toEqual({ kind: "error", message: "⌘K is reserved for Run action." });
    expect(recordKey("cmd+b", "setup", {})).toEqual({ kind: "error", message: "⌘B is reserved for Toggle sidebar." });
    expect(recordKey("cmd+3", "setup", {})).toEqual({ kind: "error", message: "⌘3 is reserved for Go to session 3." });
    expect(recordKey("cmd+=", "setup", {})).toEqual({ kind: "error", message: "⌘= is reserved for Bigger text." });
    expect(recordKey("shift+cmd++", "setup", {})).toEqual({ kind: "error", message: "⇧⌘+ is reserved for Bigger text." });
    expect(recordKey("shift+cmd+=", "setup", {})).toEqual({ kind: "error", message: "⇧⌘= is reserved for Bigger text." });
    expect(recordKey("cmd++", "setup", {})).toEqual({ kind: "error", message: "⌘+ is reserved for Bigger text." });
    expect(recordKey("cmd+-", "setup", {})).toEqual({ kind: "error", message: "⌘- is reserved for Smaller text." });
    expect(recordKey("cmd+0", "setup", {})).toEqual({ kind: "error", message: "⌘0 is reserved for Default text size." });
  });

  it("reports a key another action uses", () => {
    expect(recordKey("cmd+t", "setup", {})).toEqual({ kind: "conflict", keys: "cmd+t", other: "new-tab" });
    expect(recordKey("alt+cmd+s", "commit", { setup: "alt+cmd+s" })).toEqual({ kind: "conflict", keys: "alt+cmd+s", other: "setup" });
  });

  it("accepts a free key, or the action's own key", () => {
    expect(recordKey("alt+cmd+s", "setup", {})).toEqual({ kind: "ok", keys: "alt+cmd+s" });
    expect(recordKey("cmd+t", "setup", { "new-tab": "" })).toEqual({ kind: "ok", keys: "cmd+t" });
    expect(recordKey("cmd+t", "new-tab", {})).toEqual({ kind: "ok", keys: "cmd+t" });
  });

  it("assigns a key, taking it from another action when replacing", () => {
    expect(assignShortcut({}, "setup", "alt+cmd+s")).toEqual({ setup: "alt+cmd+s" });
    expect(assignShortcut({ commit: "alt+cmd+c" }, "setup", "cmd+t", "new-tab")).toEqual({ commit: "alt+cmd+c", setup: "cmd+t", "new-tab": "" });
  });
});

describe("the Keyboard shortcuts page (X43)", () => {
  it("groups every action in catalogue order, with its key or none", () => {
    const groups = shortcutGroups({}, "");
    expect(groups.map((g) => g.name)).toEqual(["Session", "Workspace", "Section", "Agent", "Terminal", "Project", "Panels", "Git", "App"]);
    expect(groups.find((g) => g.name === "Git")?.rows).toEqual([
      { id: "commit", label: "Commit…", keys: "", custom: false },
      { id: "pr", label: "Create pull request…", keys: "⇧⌘P", custom: false },
    ]);
  });

  it("marks a key the user changed or cleared as custom", () => {
    const git = shortcutGroups({ commit: "alt+cmd+g", pr: "" }, "").find((g) => g.name === "Git")!;
    expect(git.rows).toEqual([
      { id: "commit", label: "Commit…", keys: "⌥⌘G", custom: true },
      { id: "pr", label: "Create pull request…", keys: "", custom: true },
    ]);
  });

  it("filters by action name or by key, dropping empty groups", () => {
    expect(shortcutGroups({}, "split")).toEqual([
      {
        name: "Terminal",
        rows: [
          { id: "split-r", label: "Split pane right", keys: "⌘D", custom: false },
          { id: "split-d", label: "Split pane down", keys: "⌥⌘D", custom: false },
        ],
      },
    ]);
    expect(shortcutGroups({}, "⇧⌘P").flatMap((g) => g.rows.map((r) => r.id))).toEqual(["pr"]);
  });

  it("says a key works only in Design mode, so ⇧⌘N listed twice is not a clash (X65)", () => {
    expect(shortcutGroups({}, "⇧⌘N").flatMap((g) => g.rows)).toEqual([
      { id: "new-session", label: "New session…", keys: "⇧⌘N", custom: false },
      { id: "new-design", label: "New design…", keys: "⇧⌘N", custom: false, mode: "in Design mode" },
    ]);
    // With no key, there is nothing for the mode to qualify.
    expect(shortcutGroups({ "new-design": "" }, "new design").flatMap((g) => g.rows)).toEqual([{ id: "new-design", label: "New design…", keys: "", custom: true }]);
  });

  it("puts one action's default key back, or every one", () => {
    expect(resetShortcut({ commit: "alt+cmd+g", pr: "" }, "pr")).toEqual({ commit: "alt+cmd+g" });
    expect(shortcutGroups(resetShortcut({ pr: "" }, "pr"), "pull").flatMap((g) => g.rows)).toEqual([{ id: "pr", label: "Create pull request…", keys: "⇧⌘P", custom: false }]);
  });
});

describe("a shortcut's keys, one keycap each (X43)", () => {
  it("splits the modifiers from the key, in key id order", () => {
    expect(keyParts("shift+cmd+n")).toEqual(["⇧", "⌘", "N"]);
    expect(keyParts("ctrl+shift+alt+cmd+arrowup")).toEqual(["⌃", "⇧", "⌥", "⌘", "↑"]);
  });

  it("keeps a named key whole", () => {
    expect(keyParts("cmd+ ")).toEqual(["⌘", "Space"]);
    expect(keyParts("cmd+,")).toEqual(["⌘", ","]);
  });
});
