import { describe, expect, it } from "vitest";
import { ACTIONS, actionForKey, assignShortcut, effectiveKeys, filterActions, highlight, keyId, keyLabel, recordKey } from "./runActions";

describe("filtering", () => {
  it("lists all 26 actions in catalogue order for an empty query", () => {
    const rows = filterActions("");
    expect(rows).toHaveLength(26);
    expect(rows[0].action.label).toBe("New session…");
    expect(rows[1].action.label).toBe("New workspace…");
    expect(rows[24].action.label).toBe("Settings…");
    expect(rows[25].action.label).toBe("Check for updates…");
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
    expect(actionForKey("alt+cmd+s", undefined)).toBeUndefined();
    expect(actionForKey("alt+cmd+s", { setup: "alt+cmd+s" })).toBe("setup");
    expect(actionForKey("cmd+t", { "new-tab": "" })).toBeUndefined();
    expect(actionForKey("cmd+t", { "new-tab": "alt+cmd+t" })).toBeUndefined();
    expect(actionForKey("alt+cmd+t", { "new-tab": "alt+cmd+t" })).toBe("new-tab");
  });

  it("opens an agent tab with ⌘T and a terminal tab with ⇧⌘T (X38)", () => {
    expect(actionForKey("cmd+t", undefined)).toBe("new-tab");
    expect(ACTIONS.find((a) => a.id === "new-tab")?.label).toBe("New agent tab");
    expect(actionForKey("shift+cmd+t", undefined)).toBe("new-terminal");
    expect(ACTIONS.find((a) => a.id === "new-terminal")?.label).toBe("New terminal tab");
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
