import { describe, expect, it } from "vitest";
import { keyId } from "./runActions";
import { breadcrumb, canvasPage, chatAfter, editorStep, onReport, undoOpen, layerStep, modeEntered, canvasStep, changedPages, isTyping, modeHint, keyAct, reloadsPage, writingPage } from "./designCanvas";

const change = (over: { system?: string | null; design?: string | null; paths: string[] }) => ({ workspace: "w1", system: null, design: null, ...over });

describe("the page the agent is writing (X65)", () => {
  it("is a page of the latest change to the design, while its agent works", () => {
    const pages = changedPages(change({ design: "settings-page", paths: ["design.toml", "pages/git-a.html", "assets/logo.svg"] }), "settings-page");
    expect(pages).toEqual(["git-a"]);
    expect(writingPage(pages, true)).toBe("git-a");
    expect(writingPage(pages, false)).toBeNull();
    expect(writingPage([], true)).toBeNull();
  });

  it("is none of another design's or a design system's change", () => {
    expect(changedPages(change({ design: "onboarding", paths: ["pages/index.html"] }), "settings-page")).toEqual([]);
    expect(changedPages(change({ system: "moonlet-desktop", paths: ["pages/index.html"] }), "settings-page")).toEqual([]);
  });
});

describe("the canvas's reload (X65)", () => {
  const shown = { design: "settings-page", system: "moonlet-desktop", page: "index" };

  it("comes when the shown page changes, or an asset it may use", () => {
    expect(reloadsPage(change({ design: "settings-page", paths: ["pages/index.html"] }), shown)).toBe(true);
    expect(reloadsPage(change({ design: "settings-page", paths: ["assets/logo.svg"] }), shown)).toBe(true);
    expect(reloadsPage(change({ design: "settings-page", paths: ["pages/git-a.html", "design.toml"] }), shown)).toBe(false);
  });

  it("comes when its design system's styles change, which the page links", () => {
    expect(reloadsPage(change({ system: "moonlet-desktop", paths: ["styles.css"] }), shown)).toBe(true);
    expect(reloadsPage(change({ system: "moonlet-desktop", paths: ["tokens/colors.css"] }), shown)).toBe(true);
    // A card is no file a page loads.
    expect(reloadsPage(change({ system: "moonlet-desktop", paths: ["components/buttons/button/button.html"] }), shown)).toBe(false);
    expect(reloadsPage(change({ system: "moonlet-desktop", paths: ["components.css"] }), shown)).toBe(true);
    expect(reloadsPage(change({ system: "moonlet-desktop", paths: ["fonts/inter.woff2"] }), shown)).toBe(true);
    expect(reloadsPage(change({ system: "moonlet-desktop", paths: ["tokens/colors.json"] }), shown)).toBe(true);
    // Nor are what a sync writes for the agent and moonlet.
    for (const other of ["README.md", "components/buttons/button/button.prompt.md", "_ds_sync.json", "_ds_manifest.json", "config.toml", ".cache/progress.toml"]) {
      expect(reloadsPage(change({ system: "moonlet-desktop", paths: [other] }), shown)).toBe(false);
    }
    expect(reloadsPage(change({ system: "storefront", paths: ["styles.css"] }), shown)).toBe(false);
    expect(reloadsPage(change({ design: "onboarding", paths: ["pages/index.html"] }), shown)).toBe(false);
  });
});

describe("the page the canvas shows (X65)", () => {
  it("is the one picked, or Overview, and the first page once the picked one is gone, or index before any", () => {
    expect(canvasPage("git-a", ["index", "git-a"])).toBe("git-a");
    expect(canvasPage(null, ["index", "git-a"])).toBeNull();
    expect(canvasPage("git-b", ["index", "git-a"])).toBe("index");
    expect(canvasPage("git-b", ["git-a"])).toBe("git-a");
    expect(canvasPage("index", [])).toBe("index");
    expect(canvasPage("git-b", [])).toBe("index");
  });
});

describe("the canvas's mode (X65)", () => {
  it("says what View and Comment do in the hint line", () => {
    expect(modeHint("view")).toBe("View: the page runs as in a browser, so its links, menus and scripts work");
    expect(modeHint("comment")).toBe("Hover outlines elements · click pins a comment · ⌥-click picks the parent");
  });

  it("takes C to switch Comment on and off, and Esc to close the box or leave Comment, never while typing or with a modifier", () => {
    const key = (k: string, over: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean; typing: boolean }> = {}) =>
      keyAct(keyId({ key: k, code: "", metaKey: !!over.meta, ctrlKey: !!over.ctrl, altKey: !!over.alt, shiftKey: !!over.shift }), !!over.typing);
    expect(key("c")).toBe("toggle");
    expect(key("C", { shift: true })).toBeNull();
    expect(key("c", { alt: true })).toBeNull();
    expect(key("c", { typing: true })).toBeNull();
    expect(key("Escape")).toBe("escape");
    expect(key("q")).toBeNull();
  });
});

describe("the editor's keys (X65)", () => {
  const key = (k: string, over: Partial<{ code: string; meta: boolean; alt: boolean; shift: boolean; typing: boolean }> = {}) =>
    keyAct(keyId({ key: k, code: over.code ?? "", metaKey: !!over.meta, ctrlKey: false, altKey: !!over.alt, shiftKey: !!over.shift }), !!over.typing);

  it("are V for Edit, Tab and ⇧Tab, Delete, ⌘D, ⌥⌘G and ⇧⌥⌘G, ⌘C, ⌘V, ⌘Z and ⇧⌘Z, never while typing", () => {
    expect(key("v")).toBe("toggleEdit");
    expect(key("Tab")).toBe("next");
    expect(key("Tab", { shift: true })).toBe("prev");
    expect(key("Delete")).toBe("delete");
    expect(key("Backspace")).toBe("delete");
    expect(key("d", { meta: true })).toBe("duplicate");
    // ⌥ makes another character of G: the key's place says which.
    expect(key("©", { code: "KeyG", alt: true, meta: true })).toBe("wrap");
    expect(key("©", { code: "KeyG", alt: true, meta: true, shift: true })).toBe("unwrap");
    expect(key("c", { meta: true })).toBe("copy");
    expect(key("v", { meta: true })).toBe("paste");
    expect(key("z", { meta: true })).toBe("undo");
    expect(key("Z", { meta: true, shift: true })).toBe("redo");
    for (const [k, over] of [["v", {}], ["Tab", {}], ["Backspace", {}], ["z", { meta: true }], ["c", { meta: true }], ["d", { meta: true }]] as const) expect(key(k, { ...over, typing: true })).toBeNull();
    expect(key("d", { meta: true, shift: true })).toBeNull();
    expect(key("Delete", { meta: true })).toBeNull();
  });
});

describe("⌘C with text selected (X65)", () => {
  it("is the text's copy, not the element's, and the editor's ⌘C otherwise", () => {
    expect(keyAct("cmd+c", false, true)).toBeNull();
    expect(keyAct("cmd+c", false, false)).toBe("copy");
    expect(keyAct("cmd+d", false, true)).toBe("duplicate");
  });
});

describe("typing (X65)", () => {
  it("leaves Esc typed in a field, such as the chat's composer, to that field, so it neither closes the comment box nor leaves Comment", () => {
    document.body.innerHTML = '<section><textarea id="composer"></textarea></section><p id="page">text</p>';
    const esc = (id: string) => keyAct("escape", isTyping(document.getElementById(id)));
    expect(esc("composer")).toBeNull();
    expect(esc("page")).toBe("escape");
  });


  it("is in a field, an editable element or a terminal, where C is text", () => {
    document.body.innerHTML = '<input id="i"><textarea id="t"></textarea><div contenteditable><b id="e">x</b></div><div contenteditable="false"><b id="f">x</b></div><div class="xterm"><span id="x">$</span></div><p id="p">text</p>';
    const at = (id: string) => isTyping(document.getElementById(id));
    expect(["i", "t", "e", "x"].map(at)).toEqual([true, true, true, true]);
    expect(["f", "p"].map(at)).toEqual([false, false]);
    expect(isTyping(null)).toBe(false);
  });
});

describe("the canvas's mode, box and rail (X65)", () => {
  const view = { mode: "view" as const, box: false, rail: false };
  it("shows the rail on entering Comment, by C or its button, and leaves it shown in View", () => {
    expect(canvasStep(view, "toggle")).toEqual({ mode: "comment", box: false, rail: true });
    expect(canvasStep(view, "comment")).toEqual({ mode: "comment", box: false, rail: true });
    expect(canvasStep({ mode: "comment", box: false, rail: true }, "toggle")).toEqual({ mode: "view", box: false, rail: true });
  });

  it("closes the box whenever it leaves Comment, by C or the View button", () => {
    const boxed = { mode: "comment" as const, box: true, rail: true };
    expect(canvasStep(boxed, "toggle")).toEqual({ mode: "view", box: false, rail: true });
    expect(canvasStep(boxed, "view")).toEqual({ mode: "view", box: false, rail: true });
    expect(canvasStep(boxed, "comment")).toEqual(boxed);
  });

  it("closes the box on Esc, and on the next Esc goes back to View", () => {
    const boxed = { mode: "comment" as const, box: true, rail: true };
    expect(canvasStep(boxed, "escape")).toEqual({ mode: "comment", box: false, rail: true });
    expect(canvasStep(canvasStep(boxed, "escape"), "escape")).toEqual({ mode: "view", box: false, rail: true });
    expect(canvasStep(boxed, "view")).toEqual({ mode: "view", box: false, rail: true });
  });
});

describe("Edit mode (X65)", () => {
  const view = { mode: "view" as const, box: false, rail: false };

  it("is entered with V or its button, which shows the rail and closes the comment box, and V leaves it for View, C for Comment", () => {
    expect(canvasStep(view, "toggleEdit")).toEqual({ mode: "edit", box: false, rail: true });
    expect(canvasStep({ mode: "comment", box: true, rail: true }, "edit")).toEqual({ mode: "edit", box: false, rail: true });
    expect(canvasStep({ mode: "edit", box: false, rail: true }, "toggleEdit")).toEqual({ mode: "view", box: false, rail: true });
    expect(canvasStep({ mode: "edit", box: false, rail: false }, "toggle")).toEqual({ mode: "comment", box: false, rail: true });
    expect(canvasStep({ mode: "edit", box: false, rail: true }, "escape")).toEqual({ mode: "view", box: false, rail: true });
  });

  it("shows Layers on entering it, and Comments on entering Comment", () => {
    expect(modeEntered("view", "edit")).toBe("layers");
    expect(modeEntered("comment", "edit")).toBe("layers");
    expect(modeEntered("edit", "edit")).toBeNull();
    expect(modeEntered("edit", "comment")).toBe("comments");
    expect(modeEntered("edit", "view")).toBeNull();
  });

  it("says what it does in the hint line", () => {
    expect(modeHint("edit")).toBe("Click selects · double-click edits text · Esc selects the parent · Tab the next sibling");
  });

  it("is locked while the agent works, and left for View when the agent starts", () => {
    expect(canvasStep(view, "toggleEdit", true)).toEqual(view);
    expect(canvasStep(view, "edit", true)).toEqual(view);
    expect(canvasStep({ mode: "edit", box: false, rail: true }, "lock")).toEqual({ mode: "view", box: false, rail: true });
    expect(canvasStep({ mode: "comment", box: true, rail: true }, "lock")).toEqual({ mode: "comment", box: true, rail: true });
    // Comments still work.
    expect(canvasStep(view, "toggle", true)).toEqual({ mode: "comment", box: false, rail: true });
  });
});

/** A settings page's tree as the bridge reports it. */
const LAYERS = [
  { mid: "m1", tag: "body", depth: 0, text: "" },
  { mid: "m12", tag: "nav", depth: 1, text: "General Appearance" },
  { mid: "m20", tag: "main", depth: 1, text: "Settings" },
  { mid: "m22", tag: "section", depth: 2, text: "General" },
  { mid: "m24", tag: "section", depth: 2, text: "Git" },
  { mid: "m25", tag: "h2", depth: 3, text: "Git" },
  { mid: "m30", tag: "div", depth: 3, text: "Branch prefix" },
  { mid: "m40", tag: "footer", depth: 1, text: "" },
];

describe("the selection in Edit mode (X65)", () => {
  it("has a breadcrumb of its ancestors from the body, the body named by its tag alone", () => {
    expect(breadcrumb(LAYERS, "m24")).toEqual([
      { mid: "m1", label: "body" },
      { mid: "m20", label: "main m20" },
      { mid: "m24", label: "section m24" },
    ]);
    expect(breadcrumb(LAYERS, "m1")).toEqual([{ mid: "m1", label: "body" }]);
    expect(breadcrumb(LAYERS, "m99")).toEqual([]);
  });

  it("moves to the parent on Esc, and to the next and previous sibling on Tab and ⇧Tab, staying put past the ends", () => {
    expect(layerStep(LAYERS, "m24", "parent")).toBe("m20");
    expect(layerStep(LAYERS, "m1", "parent")).toBeNull();
    expect(layerStep(LAYERS, "m22", "next")).toBe("m24");
    expect(layerStep(LAYERS, "m24", "prev")).toBe("m22");
    expect(layerStep(LAYERS, "m24", "next")).toBe("m24");
    expect(layerStep(LAYERS, "m12", "prev")).toBe("m12");
    expect(layerStep(LAYERS, "m20", "next")).toBe("m40");
    expect(layerStep(LAYERS, "m99", "next")).toBeNull();
  });
});

describe("the editor's step on a key (X65)", () => {
  const edit = { mode: "edit" as const, selected: "m24", layers: LAYERS, copied: false, locked: false };

  it("selects the parent on Esc, nothing past the body, and with nothing selected leaves Edit", () => {
    expect(editorStep(edit, "escape")).toEqual({ kind: "select", mid: "m20" });
    expect(editorStep({ ...edit, selected: "m1" }, "escape")).toEqual({ kind: "select", mid: null });
    expect(editorStep({ ...edit, selected: null }, "escape")).toEqual({ kind: "canvas", act: "escape" });
    expect(editorStep({ ...edit, mode: "comment" }, "escape")).toEqual({ kind: "canvas", act: "escape" });
    expect(editorStep(edit, "toggleEdit")).toEqual({ kind: "canvas", act: "toggleEdit" });
  });

  it("edits, copies or moves the selection in Edit mode, pastes after it once something was copied, and takes the editor's keys with nothing selected, so ⌘D never splits a pane", () => {
    expect(editorStep(edit, "duplicate")).toEqual({ kind: "edit", op: "duplicate", mid: "m24" });
    expect(editorStep(edit, "unwrap")).toEqual({ kind: "edit", op: "unwrap", mid: "m24" });
    expect(editorStep(edit, "copy")).toEqual({ kind: "copy", mid: "m24" });
    expect(editorStep(edit, "prev")).toEqual({ kind: "select", mid: "m22" });
    expect(editorStep(edit, "paste")).toEqual({ kind: "say", text: "Copy an element with ⌘C first" });
    expect(editorStep({ ...edit, copied: true }, "paste")).toEqual({ kind: "paste", after: "m24" });
    expect(editorStep({ ...edit, copied: true, selected: null }, "paste")).toEqual({ kind: "paste", after: null });
    expect(editorStep({ ...edit, selected: null }, "duplicate")).toEqual({ kind: "none" });
    expect(editorStep({ ...edit, selected: null }, "next")).toEqual({ kind: "none" });
    // Outside Edit mode they are not the canvas's.
    expect(editorStep({ ...edit, mode: "view" }, "duplicate")).toBeNull();
    expect(editorStep(edit, null)).toBeNull();
  });

  it("undoes and redoes with ⌘Z, ⇧⌘Z and the toolbar's button, none of them while the agent works", () => {
    expect(editorStep(edit, "undo")).toEqual({ kind: "undo" });
    expect(editorStep(edit, "redo")).toEqual({ kind: "redo" });
    expect(editorStep({ ...edit, locked: true }, "undo")).toEqual({ kind: "none" });
    expect(editorStep({ ...edit, locked: true }, "redo")).toEqual({ kind: "none" });
    expect(undoOpen({ locked: false, changes: 2 })).toBe(true);
    expect(undoOpen({ locked: true, changes: 2 })).toBe(false);
    expect(undoOpen({ locked: false, changes: 0 })).toBe(false);
  });
});


describe("a page loaded again on the canvas (X65)", () => {
  it("is told, on its first report of a load, where it was scrolled and in Edit mode its selection, and nothing on the reports after", () => {
    const report = { rev: 3, reported: 2, scrolled: { x: 0, y: 1240 }, mode: "edit" as const, selected: "m24" };
    expect(onReport(report)).toEqual({ scroll: { x: 0, y: 1240 }, select: "m24" });
    expect(onReport({ ...report, reported: 3 })).toBeNull();
    expect(onReport({ ...report, scrolled: { x: 0, y: 0 }, mode: "comment" })).toEqual({ scroll: null, select: undefined });
    expect(onReport({ ...report, selected: null })).toEqual({ scroll: { x: 0, y: 1240 }, select: null });
  });
});

describe("the chat around Edit mode (X65)", () => {
  it("folds on entering Edit, and opens again on leaving it when entering folded it, not when the user folded it", () => {
    const open = { open: true, foldedForEdit: false };
    const folded = chatAfter("view", "edit", open);
    expect(folded).toEqual({ open: false, foldedForEdit: true });
    expect(chatAfter("edit", "view", folded)).toEqual({ open: true, foldedForEdit: false });
    expect(chatAfter("edit", "comment", folded)).toEqual({ open: true, foldedForEdit: false });
    // Folded by the user before Edit, or opened by them during it: as they left it.
    expect(chatAfter("view", "edit", { open: false, foldedForEdit: false })).toEqual({ open: false, foldedForEdit: false });
    expect(chatAfter("edit", "view", { open: false, foldedForEdit: false })).toEqual({ open: false, foldedForEdit: false });
    expect(chatAfter("edit", "view", { open: true, foldedForEdit: true })).toEqual({ open: true, foldedForEdit: false });
    expect(chatAfter("view", "comment", open)).toEqual(open);
  });
});
