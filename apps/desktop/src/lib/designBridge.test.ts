import { describe, expect, it, vi } from "vitest";
import { JSDOM, type DOMWindow } from "jsdom";
import { COMPUTED_PROPS, PAGE_KEYS, bridgeMessage, editMessage, helloMessage, modeMessage, paletteMessage, pinsMessage, scrollMessage, selectMessage } from "./designBridge";
import bridge from "../../src-tauri/src/design_bridge.js?raw";
import refused from "../../src-tauri/src/design_refused.js?raw";
import { HOLDS_NO_ELEMENTS } from "./designEdits";
import { BORDER_STYLES } from "./designStyle";
import { inspectorSections } from "./designInspector";

describe("the bridge's messages (X65)", () => {
  it("takes a pick with its element's data-mid, tag, text and box", () => {
    expect(bridgeMessage({ type: "bridge.pick", mid: "m12", tag: "nav", text: "General Appearance", rect: { x: 0, y: 64.5, w: 390, h: 40 } })).toEqual({
      type: "pick",
      element: { mid: "m12", tag: "nav", text: "General Appearance", rect: { x: 0, y: 64.5, w: 390, h: 40 } },
    });
  });

  it("cuts the text to 60 characters on one line, and drops a pick whose data-mid, tag or box is not one", () => {
    const pick = { type: "bridge.pick", mid: "m30", tag: "P", text: "  Branch prefix\n   New sessions get a branch and a worktree, named after the session  ", rect: { x: 1, y: 2, w: 3, h: 4 } };
    expect(bridgeMessage(pick)).toEqual({
      type: "pick",
      element: { mid: "m30", tag: "p", text: "Branch prefix New sessions get a branch and a worktree, name", rect: { x: 1, y: 2, w: 3, h: 4 } },
    });
    expect(bridgeMessage({ ...pick, mid: 'm30"] (nav "x"): rm -rf' })).toBeNull();
    expect(bridgeMessage({ ...pick, mid: "M30" })).toBeNull();
    expect(bridgeMessage({ ...pick, tag: "p onclick" })).toBeNull();
    expect(bridgeMessage({ ...pick, rect: { x: 1, y: 2, w: Infinity, h: 4 } })).toBeNull();
    expect(bridgeMessage({ ...pick, rect: { x: "1", y: 2, w: 3, h: 4 } })).toBeNull();
  });

  it("takes the page's ids, the boxes of the pinned elements, and C and Esc", () => {
    expect(bridgeMessage({ type: "bridge.mids", mids: ["m1", "m2", "m12"] })).toEqual({ type: "mids", mids: ["m1", "m2", "m12"] });
    expect(bridgeMessage({ type: "bridge.mids", mids: ["m1", "x"] })).toBeNull();
    expect(bridgeMessage({ type: "bridge.rects", rects: [{ mid: "m12", x: 0, y: -20, w: 390, h: 40 }] })).toEqual({ type: "rects", rects: [{ mid: "m12", x: 0, y: -20, w: 390, h: 40 }] });
    expect(bridgeMessage({ type: "bridge.rects", rects: [{ mid: "m12", x: 0, y: 0, w: -1, h: 40 }] })).toBeNull();
    expect(bridgeMessage({ type: "bridge.key", key: "c" })).toEqual({ type: "key", key: "c", shift: false, alt: false, meta: false });
    expect(bridgeMessage({ type: "bridge.key", key: "q" })).toBeNull();
  });

  it("tells the page its mode, and the pinned elements once each", () => {
    expect(modeMessage("comment")).toEqual({ type: "bridge.mode", mode: "comment" });
    expect(pinsMessage(["m12", "m25", "m12", "", "x"])).toEqual({ type: "bridge.pins", mids: ["m12", "m25"] });
  });

  it("asks the page for its data-mids with a hello, once the app listens", () => {
    expect(helloMessage()).toEqual({ type: "bridge.hello" });
  });

  it("takes the page's element tree, each element with its depth, tag and its text cut to 60 characters, and drops one that is not a tree", () => {
    const tree = {
      type: "bridge.tree",
      nodes: [
        { mid: "m1", tag: "BODY", depth: 0, text: "" },
        { mid: "m20", tag: "main", depth: 1, text: "Settings\n  Git  Branch prefix" },
        { mid: "m24", tag: "section", depth: 2, text: "Git ".repeat(20) },
      ],
    };
    expect(bridgeMessage(tree)).toEqual({
      type: "tree",
      layers: [
        { mid: "m1", tag: "body", depth: 0, text: "" },
        { mid: "m20", tag: "main", depth: 1, text: "Settings Git Branch prefix" },
        { mid: "m24", tag: "section", depth: 2, text: "Git Git Git Git Git Git Git Git Git Git Git Git Git Git Git " },
      ],
    });
    expect(bridgeMessage({ type: "bridge.tree", nodes: [{ mid: "m1", tag: "body", depth: -1, text: "" }] })).toBeNull();
    expect(bridgeMessage({ type: "bridge.tree", nodes: [{ mid: "m1", tag: "body", depth: 0.5, text: "" }] })).toBeNull();
    expect(bridgeMessage({ type: "bridge.tree", nodes: [{ mid: "x", tag: "body", depth: 0, text: "" }] })).toBeNull();
    expect(bridgeMessage({ type: "bridge.tree", nodes: "m1" })).toBeNull();
  });

  it("takes the selected element and its box, or that none is, and tells the page which to select, and Edit as its mode", () => {
    expect(bridgeMessage({ type: "bridge.selected", mid: "m24", rect: { x: 0, y: 120, w: 794, h: 210 } })).toEqual({ type: "selected", mid: "m24", rect: { x: 0, y: 120, w: 794, h: 210 } });
    expect(bridgeMessage({ type: "bridge.selected", mid: null })).toEqual({ type: "selected", mid: null, rect: null });
    expect(bridgeMessage({ type: "bridge.selected", mid: "m24" })).toBeNull();
    expect(bridgeMessage({ type: "bridge.selected", mid: "m24]", rect: { x: 0, y: 0, w: 1, h: 1 } })).toBeNull();
    expect(selectMessage("m24")).toEqual({ type: "bridge.select", mid: "m24" });
    expect(selectMessage(null)).toEqual({ type: "bridge.select", mid: null });
    expect(modeMessage("edit")).toEqual({ type: "bridge.mode", mode: "edit" });
  });

  it("takes an element's new text as it was typed, and drops one too long or not text", () => {
    expect(bridgeMessage({ type: "bridge.text", mid: "m31", text: "Prefix for\nnew  branches" })).toEqual({ type: "text", mid: "m31", text: "Prefix for\nnew  branches" });
    expect(bridgeMessage({ type: "bridge.text", mid: "m31", text: "x".repeat(10_001) })).toBeNull();
    expect(bridgeMessage({ type: "bridge.text", mid: "m31", text: 7 })).toBeNull();
    expect(bridgeMessage({ type: "bridge.text", mid: "31", text: "x" })).toBeNull();
  });

  it("tells the page an edit to make on its live page", () => {
    expect(editMessage({ op: "remove", mid: "m33" })).toEqual({ type: "bridge.edit", op: "remove", mid: "m33" });
    expect(editMessage({ op: "insert", place: { where: "below", ref: "m30" }, html: '<div data-mid="m41">Copy</div>' })).toEqual({ type: "bridge.edit", op: "insert", place: { where: "below", ref: "m30" }, html: '<div data-mid="m41">Copy</div>' });
    expect(editMessage({ op: "wrap", mid: "m25", box: "m41" })).toEqual({ type: "bridge.edit", op: "wrap", mid: "m25", box: "m41" });
    expect(editMessage({ op: "unwrap", mid: "m30" })).toEqual({ type: "bridge.edit", op: "unwrap", mid: "m30" });
  });

  it("takes the editor's keys pressed in the page, with ⇧, ⌥ and ⌘, and drops any other key", () => {
    for (const key of ["v", "Tab", "Delete", "Backspace", "d", "g", "z"]) expect(bridgeMessage({ type: "bridge.key", key })).toEqual({ type: "key", key, shift: false, alt: false, meta: false });
    expect(bridgeMessage({ type: "bridge.key", key: "g", shift: true, alt: true, meta: true })).toEqual({ type: "key", key: "g", shift: true, alt: true, meta: true });
    expect(bridgeMessage({ type: "bridge.key", key: "g", meta: "yes" })).toEqual({ type: "key", key: "g", shift: false, alt: false, meta: false });
    expect(bridgeMessage({ type: "bridge.key", key: "Enter" })).toBeNull();
  });

  it("takes where the page is scrolled, and tells the page where to scroll after it loads again", () => {
    expect(bridgeMessage({ type: "bridge.scroll", x: 0, y: 1240.5 })).toEqual({ type: "scroll", x: 0, y: 1240.5 });
    expect(bridgeMessage({ type: "bridge.scroll", x: 0, y: NaN })).toBeNull();
    expect(scrollMessage(0, 1240.5)).toEqual({ type: "bridge.scrollTo", x: 0, y: 1240.5 });
  });

  it("takes the selection's computed style, only the Inspector's properties, and tells the page an off-system selection", () => {
    expect(bridgeMessage({ type: "bridge.computed", mid: "m24", style: { display: "flex", "flex-direction": "column", padding: "14px 24px", "background-color": "rgb(22, 22, 22)", behavior: "url(x.htc)", opacity: 7 } })).toEqual({
      type: "computed",
      mid: "m24",
      style: { display: "flex", "flex-direction": "column", padding: "14px 24px", "background-color": "rgb(22, 22, 22)" },
    });
    expect(bridgeMessage({ type: "bridge.computed", mid: "m24", style: { padding: "x".repeat(201) } })).toEqual({ type: "computed", mid: "m24", style: {} });
    expect(bridgeMessage({ type: "bridge.computed", mid: "m24]", style: {} })).toBeNull();
    expect(selectMessage("m24", true)).toEqual({ type: "bridge.select", mid: "m24", off: true });
  });

  it("takes where a drag would drop and the move on drop, the size or place a handle or a drag gives in px, and a snippet's drop", () => {
    const place = { where: "above", ref: "m22" };
    expect(bridgeMessage({ type: "bridge.drag", mid: "m24", place })).toEqual({ type: "drag", mid: "m24", place });
    expect(bridgeMessage({ type: "bridge.drag", mid: null, place: null })).toEqual({ type: "drag", mid: null, place: null });
    expect(bridgeMessage({ type: "bridge.move", mid: "m24", place: { where: "into", ref: "m30" } })).toEqual({ type: "move", mid: "m24", place: { where: "into", ref: "m30" } });
    expect(bridgeMessage({ type: "bridge.move", mid: "m24", place: { where: "inside", ref: "m30" } })).toBeNull();
    expect(bridgeMessage({ type: "bridge.move", mid: "m24", place: { where: "above", ref: 'm2"' } })).toBeNull();
    expect(bridgeMessage({ type: "bridge.move", mid: "m24", place: null })).toBeNull();
    expect(bridgeMessage({ type: "bridge.style", mid: "m24", set: { width: "320px", height: "180.5px" } })).toEqual({ type: "style", mid: "m24", set: { width: "320px", height: "180.5px" } });
    expect(bridgeMessage({ type: "bridge.style", mid: "m24", set: { left: "-12px", top: "40px" } })).toEqual({ type: "style", mid: "m24", set: { left: "-12px", top: "40px" } });
    expect(bridgeMessage({ type: "bridge.style", mid: "m24", set: { width: "320px; color: red" } })).toBeNull();
    expect(bridgeMessage({ type: "bridge.style", mid: "m24", set: { color: "red" } })).toBeNull();
    expect(bridgeMessage({ type: "bridge.style", mid: "m24", set: {} })).toBeNull();
    expect(bridgeMessage({ type: "bridge.drop", place })).toEqual({ type: "drop", place });
    expect(bridgeMessage({ type: "bridge.drop", place: null })).toEqual({ type: "drop", place: null });
    expect(paletteMessage(true)).toEqual({ type: "bridge.palette", dragging: true });
  });

  it("tells the page the new edits to make on its live page: a style, a move, and an insert above or into an element", () => {
    expect(editMessage({ op: "style", mid: "m24", style: "padding: var(--space-4)" })).toEqual({ type: "bridge.edit", op: "style", mid: "m24", style: "padding: var(--space-4)" });
    expect(editMessage({ op: "move", mid: "m24", place: { where: "above", ref: "m22" } })).toEqual({ type: "bridge.edit", op: "move", mid: "m24", place: { where: "above", ref: "m22" } });
    expect(editMessage({ op: "insert", place: { where: "into", ref: "m22" }, html: '<hr data-mid="m41">' })).toEqual({ type: "bridge.edit", op: "insert", place: { where: "into", ref: "m22" }, html: '<hr data-mid="m41">' });
  });

  it("drops a message of an unknown type, or that is not an object", () => {
    expect(bridgeMessage({ type: "bridge.save", html: "<p>" })).toBeNull();
    expect(bridgeMessage({ type: "moonlet-render", job: "7" })).toBeNull();
    expect(bridgeMessage("bridge.pick")).toBeNull();
    expect(bridgeMessage(null)).toBeNull();
  });
});

/** A page as the scheme serves it to the canvas: the bridge first in its
 *  <head>, parsed as a browser parses it, in a frame whose parent is the
 *  app's window. What it posts to the app is copied as postMessage copies,
 *  and read as the app reads it, with bridgeMessage: one it would drop
 *  stays as `{ dropped }`. The app talks to it with modeMessage and
 *  pinsMessage. */
function framed(body: string) {
  const posted: unknown[] = [];
  const app = new JSDOM("").window;
  app.postMessage = ((m: unknown) => {
    const copy: unknown = JSON.parse(JSON.stringify(m));
    posted.push(bridgeMessage(copy) ?? { dropped: copy });
  }) as typeof app.postMessage;
  const dom = new JSDOM(`<!doctype html><html><head><script>${bridge}</script></head><body data-mid="m1">${body}</body></html>`, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse: (w) => void Object.defineProperty(w, "parent", { value: app }),
  });
  const win = dom.window;
  const doc = win.document;
  const el = (mid: string) => doc.querySelector(`[data-mid="${mid}"]`) as HTMLElement;
  /** Gives the element its box in the page's viewport. */
  const place = (mid: string, x: number, y: number, w: number, h: number) => {
    el(mid).getBoundingClientRect = () => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;
  };
  /** A message from the app, or (`from`) another window. */
  const tell = (data: unknown, from: unknown = app) => win.dispatchEvent(new win.MessageEvent("message", { data, source: from as Window }));
  const of = (type: string) => posted.filter((m) => (m as { type?: string }).type === type);
  return { win, doc, el, place, tell, posted, of };
}

describe("the bridge script in a page (X65)", () => {
  it("reports the page's data-mids once it has loaded", async () => {
    const { posted } = framed('<nav data-mid="m12"><a data-mid="m13">General</a></nav><script>document.body.append(Object.assign(document.createElement("p"), {}))</script><h2 data-mid="m25">Git</h2>');
    await vi.waitFor(() => expect(posted).toContainEqual({ type: "mids", mids: ["m1", "m12", "m13", "m25"] }));
  });

  it("answers the app's hello with the page's data-mids, whenever it asks after the page loaded", async () => {
    const { tell, of } = framed('<nav data-mid="m12"></nav><h2 data-mid="m25">Git</h2>');
    // The report at load went before the app listened; the app asks again.
    await vi.waitFor(() => expect(of("mids")).toHaveLength(1));
    tell(helloMessage());
    tell(helloMessage());
    expect(of("mids")).toEqual([
      { type: "mids", mids: ["m1", "m12", "m25"] },
      { type: "mids", mids: ["m1", "m12", "m25"] },
      { type: "mids", mids: ["m1", "m12", "m25"] },
    ]);
  });

  it("reports the page's data-mids again when its scripts add, remove or renumber elements, once per burst", async () => {
    const { win, doc, el, tell, of } = framed('<nav data-mid="m12"><a data-mid="m13">General</a></nav>');
    await vi.waitFor(() => expect(of("mids")).toHaveLength(1));
    // A menu a script opens: two elements at once, one report.
    const menu = doc.createElement("ul");
    menu.setAttribute("data-mid", "m40");
    menu.innerHTML = '<li data-mid="m41">Rename</li>';
    doc.body.append(menu);
    await vi.waitFor(() => expect(of("mids").at(-1)).toEqual({ type: "mids", mids: ["m1", "m12", "m13", "m40", "m41"] }));
    expect(of("mids")).toHaveLength(2);
    el("m13").setAttribute("data-mid", "m14");
    menu.remove();
    await vi.waitFor(() => expect(of("mids").at(-1)).toEqual({ type: "mids", mids: ["m1", "m12", "m14"] }));
    // The bridge's own outline is no change of the page.
    const reports = of("mids").length;
    tell(modeMessage("comment"));
    el("m12").dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    expect(of("mids")).toHaveLength(reports);
  });

  it("reports the page's element tree once it has loaded, each element with an id at its depth among them", async () => {
    const { of } = framed('<main data-mid="m20"><div class="wrap"><section data-mid="m24"><h2 data-mid="m25">Git</h2><svg data-mid="m26"><path data-mid="m40" d="M0 0"/></svg></section></div></main><script>1</script>');
    await vi.waitFor(() =>
      expect(of("tree")).toEqual([
        {
          type: "tree",
          layers: [
            { mid: "m1", tag: "body", depth: 0, text: "Git" },
            { mid: "m20", tag: "main", depth: 1, text: "Git" },
            { mid: "m24", tag: "section", depth: 2, text: "Git" },
            { mid: "m25", tag: "h2", depth: 3, text: "Git" },
            { mid: "m26", tag: "svg", depth: 3, text: "" },
          ],
        },
      ]),
    );
  });

  const NAV = '<nav data-mid="m12"><a href="#git" data-mid="m13">General <b data-mid="m14">Appearance</b></a></nav><h2 data-mid="m25">Git</h2>';
  const mouse = (win: DOMWindow, type: string, on: Element, init: MouseEventInit = {}) => on.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init }));

  it("in Comment mode, outlines the element under the pointer inside the page, and nothing in View", () => {
    const { win, doc, el, place, tell } = framed(NAV);
    place("m13", 16, 64, 120, 28);
    const outline = () => doc.querySelector("[data-moonlet-bridge]") as HTMLElement | null;
    mouse(win, "mouseover", el("m13"));
    expect(outline()).toBeNull();
    tell(modeMessage("comment"));
    mouse(win, "mousemove", el("m13"));
    expect(outline()?.style.display).toBe("block");
    expect([outline()?.style.left, outline()?.style.top, outline()?.style.width, outline()?.style.height]).toEqual(["16px", "64px", "120px", "28px"]);
    // Outside the body: never one of the page's elements.
    expect(doc.body.contains(outline())).toBe(false);
    tell(modeMessage("view"));
    expect(outline()?.style.display).toBe("none");
  });

  it("in Comment mode, reports a click's element instead of giving the page the click, and ⌥-click its parent", () => {
    const { win, el, place, tell, of } = framed(NAV);
    place("m13", 16, 64, 120, 28);
    place("m12", 0, 56, 390, 44);
    let clicked = 0;
    el("m13").addEventListener("click", () => clicked++);
    tell(modeMessage("comment"));
    mouse(win, "click", el("m13"));
    mouse(win, "click", el("m13"), { altKey: true });
    expect(of("pick")).toEqual([
      { type: "pick", element: { mid: "m13", tag: "a", text: "General Appearance", rect: { x: 16, y: 64, w: 120, h: 28 } } },
      { type: "pick", element: { mid: "m12", tag: "nav", text: "General Appearance", rect: { x: 0, y: 56, w: 390, h: 44 } } },
    ]);
    expect(clicked).toBe(0);
    // In View the page has its clicks, and nothing is reported.
    tell(modeMessage("view"));
    mouse(win, "click", el("m13"));
    expect(clicked).toBe(1);
    expect(of("pick")).toHaveLength(2);
  });

  it("in Edit mode, selects a click's element instead of giving the page the click, outlined with its tag and id inside the page; the app's select moves it, and one not on the page is reported as none", () => {
    const { win, doc, el, place, tell, of } = framed(NAV);
    place("m13", 16, 64, 120, 28);
    place("m25", 0, 300, 390, 30);
    let clicked = 0;
    el("m13").addEventListener("click", () => clicked++);
    tell(modeMessage("edit"));
    mouse(win, "click", el("m13"));
    expect(of("pick")).toEqual([{ type: "pick", element: { mid: "m13", tag: "a", text: "General Appearance", rect: { x: 16, y: 64, w: 120, h: 28 } } }]);
    expect(clicked).toBe(0);
    const selection = () => doc.querySelector('[data-moonlet-bridge="selection"]') as HTMLElement | null;
    const shown = () => [selection()?.style.display, selection()?.style.left, selection()?.style.top, selection()?.style.width, selection()?.style.height, selection()?.textContent];
    expect(shown()).toEqual(["block", "16px", "64px", "120px", "28px", "a · m13"]);
    expect(doc.body.contains(selection())).toBe(false);
    tell(selectMessage("m25"));
    expect(of("selected").at(-1)).toEqual({ type: "selected", mid: "m25", rect: { x: 0, y: 300, w: 390, h: 30 } });
    expect(shown()).toEqual(["block", "0px", "300px", "390px", "30px", "h2 · m25"]);
    tell(selectMessage("m99"));
    expect(of("selected").at(-1)).toEqual({ type: "selected", mid: null, rect: null });
    expect(selection()?.style.display).toBe("none");
    tell(selectMessage("m25"));
    tell(modeMessage("view"));
    expect(selection()?.style.display).toBe("none");
  });

  it("in Edit mode, a double-click edits in place the text of an element that holds only text: Enter or a click outside commits it, Esc puts it back", () => {
    const { win, doc, el, tell, of } = framed('<h2 data-mid="m25">Git</h2><p data-mid="m30">Branch <b data-mid="m31">prefix</b></p>');
    const key = (on: Element, k: string) => on.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    const editable = (mid: string) => el(mid).getAttribute("contenteditable");
    tell(modeMessage("edit"));
    mouse(win, "dblclick", el("m25"));
    expect(editable("m25")).toBe("plaintext-only");
    el("m25").textContent = "Git and GitHub";
    key(el("m25"), "Enter");
    expect(of("text")).toEqual([{ type: "text", mid: "m25", text: "Git and GitHub" }]);
    expect(editable("m25")).toBeNull();
    mouse(win, "dblclick", el("m25"));
    el("m25").textContent = "Gone";
    key(el("m25"), "Escape");
    expect(el("m25").textContent).toBe("Git and GitHub");
    expect(editable("m25")).toBeNull();
    mouse(win, "dblclick", el("m25"));
    el("m25").textContent = "Git, then GitHub";
    mouse(win, "mousedown", doc.body);
    expect(of("text").at(-1)).toEqual({ type: "text", mid: "m25", text: "Git, then GitHub" });
    // Not an element with more than text in it, and not in Comment mode.
    mouse(win, "dblclick", el("m30"));
    expect(editable("m30")).toBeNull();
    tell(modeMessage("comment"));
    mouse(win, "dblclick", el("m25"));
    expect(editable("m25")).toBeNull();
    expect(of("key")).toEqual([]);
  });

  it("puts back a text edited in place that is longer than the app takes, so the page never shows a text that is not saved", () => {
    const { win, el, tell, posted, of } = framed('<h2 data-mid="m25">Git</h2>');
    tell(modeMessage("edit"));
    mouse(win, "dblclick", el("m25"));
    el("m25").textContent = "x".repeat(10_001);
    el("m25").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(el("m25").textContent).toBe("Git");
    expect(el("m25").getAttribute("contenteditable")).toBeNull();
    expect(posted.filter((m) => "dropped" in (m as object))).toEqual([]);
    mouse(win, "dblclick", el("m25"));
    el("m25").textContent = "x".repeat(10_000);
    el("m25").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(of("text")).toEqual([{ type: "text", mid: "m25", text: "x".repeat(10_000) }]);
  });

  it("names each element of the tree by its text, its parts' texts apart", async () => {
    // The settings page's nav, as the agent wrote it, which Layers names
    // "General Appearance Terminal Git", as the design export's board does.
    const { of } = framed('<nav data-mid="m3"><a class="on" data-mid="m4">General</a><a data-mid="m5">Appearance</a><a data-mid="m6">Terminal</a><a data-mid="m7">Git</a></nav>');
    await vi.waitFor(() => expect(of("tree")).toHaveLength(1));
    expect((of("tree")[0] as { layers: { mid: string; text: string }[] }).layers.map((l) => [l.mid, l.text])).toEqual([
      ["m1", "General Appearance Terminal Git"],
      ["m3", "General Appearance Terminal Git"],
      ["m4", "General"],
      ["m5", "Appearance"],
      ["m6", "Terminal"],
      ["m7", "Git"],
    ]);
  });

  it("makes the app's edits on its live page, only well formed, and reports the tree again after each", async () => {
    const { doc, tell, of } = framed('<section data-mid="m24"><h2 data-mid="m25">Git</h2><div data-mid="m30"><span data-mid="m31">Prefix</span></div></section>');
    await vi.waitFor(() => expect(of("tree")).toHaveLength(1));
    const body = () => doc.body.innerHTML;
    tell(editMessage({ op: "insert", place: { where: "below", ref: "m30" }, html: '<div data-mid="m41"><span data-mid="m42">Prefix</span></div>' }));
    tell(editMessage({ op: "wrap", mid: "m25", box: "m43" }));
    tell(editMessage({ op: "unwrap", mid: "m30" }));
    tell(editMessage({ op: "remove", mid: "m41" }));
    expect(body()).toBe('<section data-mid="m24"><div data-mid="m43"><h2 data-mid="m25">Git</h2></div><span data-mid="m31">Prefix</span></section>');
    expect(of("tree")).toHaveLength(5);
    expect(of("tree").at(-1)).toEqual({
      type: "tree",
      layers: [
        { mid: "m1", tag: "body", depth: 0, text: "Git Prefix" },
        { mid: "m24", tag: "section", depth: 1, text: "Git Prefix" },
        { mid: "m43", tag: "div", depth: 2, text: "Git" },
        { mid: "m25", tag: "h2", depth: 3, text: "Git" },
        { mid: "m31", tag: "span", depth: 2, text: "Prefix" },
      ],
    });
    // The bridge keeps its own check of what it is told.
    tell({ type: "bridge.edit", op: "remove", mid: '[data-mid="m24"]' });
    tell({ type: "bridge.edit", op: "wrap", mid: "m25", box: 'x" onclick="' });
    tell({ type: "bridge.edit", op: "replace", mid: "m24" });
    tell(editMessage({ op: "insert", place: null, html: '<p data-mid="m44">First</p>' }));
    expect(body()).toBe('<p data-mid="m44">First</p><section data-mid="m24"><div data-mid="m43"><h2 data-mid="m25">Git</h2></div><span data-mid="m31">Prefix</span></section>');
  });

  it("in Edit mode, sends the app the editor's keys pressed in the page instead of giving them to the page, and in View only C, V and Esc", () => {
    const { win, doc, tell, of } = framed('<input data-mid="m5"><h2 data-mid="m25">Git</h2>');
    const press = (init: KeyboardEventInit, on: Element = doc.body) => {
      const e = new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      on.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const keys = () => of("key").map((k) => { const { key, shift, alt, meta } = k as { key: string; shift: boolean; alt: boolean; meta: boolean }; return `${shift ? "⇧" : ""}${alt ? "⌥" : ""}${meta ? "⌘" : ""}${key}`; });
    expect([press({ key: "Tab" }), press({ key: "v" }), press({ key: "d", metaKey: true })]).toEqual([false, false, false]);
    expect(keys()).toEqual(["v"]);
    tell(modeMessage("edit"));
    const kept = [
      press({ key: "Tab" }),
      press({ key: "Tab", shiftKey: true }),
      press({ key: "Backspace" }),
      press({ key: "Delete" }),
      press({ key: "d", code: "KeyD", metaKey: true }),
      // ⌥ makes another character of G; the key's place says which.
      press({ key: "©", code: "KeyG", altKey: true, metaKey: true }),
      press({ key: "©", code: "KeyG", shiftKey: true, altKey: true, metaKey: true }),
      press({ key: "c", code: "KeyC", metaKey: true }),
      press({ key: "v", code: "KeyV", metaKey: true }),
      press({ key: "z", code: "KeyZ", metaKey: true }),
      press({ key: "Z", code: "KeyZ", shiftKey: true, metaKey: true }),
    ];
    expect(kept.every(Boolean)).toBe(true);
    expect(keys().slice(1)).toEqual(["Tab", "⇧Tab", "Backspace", "Delete", "⌘d", "⌥⌘g", "⇧⌥⌘g", "⌘c", "⌘v", "⌘z", "⇧⌘z"]);
    // Typed in a field, they are the field's.
    expect(press({ key: "Backspace" }, doc.querySelector("input")!)).toBe(false);
    expect(press({ key: "z", code: "KeyZ", metaKey: true }, doc.querySelector("input")!)).toBe(false);
    expect(keys()).toHaveLength(12);
  });

  it("commits a text being edited when it loses the focus, the page loses it to the app, or the app selects another element", () => {
    const { win, el, tell, of } = framed('<h2 data-mid="m25">Git</h2><p data-mid="m30">Branch prefix</p>');
    const edit = (mid: string, text: string) => {
      mouse(win, "dblclick", el(mid));
      el(mid).textContent = text;
    };
    tell(modeMessage("edit"));
    edit("m25", "Git and GitHub");
    el("m25").dispatchEvent(new win.FocusEvent("focusout", { bubbles: true }));
    expect(of("text").at(-1)).toEqual({ type: "text", mid: "m25", text: "Git and GitHub" });
    edit("m30", "Prefix");
    win.dispatchEvent(new win.FocusEvent("blur"));
    expect(of("text").at(-1)).toEqual({ type: "text", mid: "m30", text: "Prefix" });
    edit("m25", "Git, GitHub");
    tell(selectMessage("m30"));
    expect(of("text").at(-1)).toEqual({ type: "text", mid: "m25", text: "Git, GitHub" });
    expect(el("m25").getAttribute("contenteditable")).toBeNull();
  });

  it("keeps a text being edited and the selection when told the mode it is in again, as after each report of its ids", () => {
    const { win, doc, el, tell, of } = framed('<h2 data-mid="m25">Git</h2>');
    tell(modeMessage("edit"));
    mouse(win, "click", el("m25"));
    mouse(win, "dblclick", el("m25"));
    el("m25").textContent = "Git and";
    tell(modeMessage("edit"));
    expect(el("m25").getAttribute("contenteditable")).toBe("plaintext-only");
    expect(of("text")).toEqual([]);
    expect((doc.querySelector('[data-moonlet-bridge="selection"]') as HTMLElement).style.display).toBe("block");
  });

  it("sends the app only the keys the app takes from a page, and every one of them, whatever is pressed in Edit mode", () => {
    const { win, doc, tell, of } = framed('<h2 data-mid="m25">Git</h2>');
    tell(modeMessage("edit"));
    const keys = [...PAGE_KEYS, ..."abefhijklmnopqrstuwxy", "Enter", "ArrowUp", "Space", "Home"];
    const mods = [{}, { shiftKey: true }, { metaKey: true }, { altKey: true, metaKey: true }, { shiftKey: true, altKey: true, metaKey: true }, { shiftKey: true, metaKey: true }];
    for (const key of keys) for (const m of mods) doc.body.dispatchEvent(new win.KeyboardEvent("keydown", { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, ...m }));
    expect(new Set(of("key").map((k) => (k as { key: string }).key))).toEqual(new Set(PAGE_KEYS));
  });

  /** Gives the page a hit test over the placed elements: the deepest one
   *  whose box holds the point, as a browser's elementFromPoint. */
  const hits = (doc: Document, boxes: Record<string, [number, number, number, number]>) => {
    for (const [mid, [x, y, w, h]] of Object.entries(boxes)) {
      (doc.querySelector(`[data-mid="${mid}"]`) as HTMLElement).getBoundingClientRect = () => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;
    }
    doc.elementFromPoint = (px: number, py: number) => {
      let found: Element | null = null;
      for (const e of doc.querySelectorAll("[data-mid]")) {
        const b = boxes[e.getAttribute("data-mid")!];
        if (b && px >= b[0] && px < b[0] + b[2] && py >= b[1] && py < b[1] + b[3]) found = e;
      }
      return found;
    };
  };
  const line = (doc: Document) => doc.querySelector('[data-moonlet-bridge="drop"]') as HTMLElement | null;
  const lineAt = (doc: Document) => [line(doc)?.style.display, line(doc)?.style.left, line(doc)?.style.top, line(doc)?.style.width, line(doc)?.style.height];

  it("in Edit mode, dragging the selected element shows an insertion line where it would land, and reports the move on drop, not the click after it", () => {
    const { win, doc, el, tell, of } = framed('<section data-mid="m24"><h2 data-mid="m25">Git</h2><p data-mid="m30">Branch prefix</p><p data-mid="m33">Hint</p></section>');
    hits(doc, { m1: [0, 0, 390, 400], m24: [0, 40, 390, 180], m25: [0, 40, 390, 40], m30: [0, 100, 390, 40], m33: [0, 160, 390, 40] });
    tell(modeMessage("edit"));
    mouse(win, "click", el("m33"), { clientX: 20, clientY: 170 });
    // A press that hardly moves is a click, not a drag.
    mouse(win, "mousedown", el("m33"), { clientX: 20, clientY: 170 });
    mouse(win, "mousemove", el("m33"), { clientX: 22, clientY: 172 });
    mouse(win, "mouseup", el("m33"), { clientX: 22, clientY: 172 });
    expect(of("drag")).toEqual([]);
    mouse(win, "mousedown", el("m33"), { clientX: 20, clientY: 170 });
    mouse(win, "mousemove", el("m30"), { clientX: 20, clientY: 110 });
    expect(of("drag")).toEqual([{ type: "drag", mid: "m33", place: { where: "above", ref: "m30" } }]);
    expect(lineAt(doc)).toEqual(["block", "0px", "99px", "390px", "2px"]);
    expect(doc.body.contains(line(doc))).toBe(false);
    mouse(win, "mousemove", el("m25"), { clientX: 20, clientY: 50 });
    expect(of("drag").at(-1)).toEqual({ type: "drag", mid: "m33", place: { where: "above", ref: "m25" } });
    mouse(win, "mouseup", el("m25"), { clientX: 20, clientY: 50 });
    mouse(win, "click", el("m25"), { clientX: 20, clientY: 50 });
    expect(of("move")).toEqual([{ type: "move", mid: "m33", place: { where: "above", ref: "m25" } }]);
    expect(of("drag").at(-1)).toEqual({ type: "drag", mid: "m33", place: null });
    expect(line(doc)?.style.display).toBe("none");
    expect(of("pick").map((p) => (p as { element: { mid: string } }).element.mid)).toEqual(["m33"]);
  });

  it("drops beside an element in a row by the pointer's side, into an empty box, nowhere where it already is, and Esc cancels a drag", () => {
    const { win, doc, el, tell, of } = framed('<nav data-mid="m12" style="display: flex"><a data-mid="m13">General</a><a data-mid="m14">Git</a></nav><div data-mid="m50"></div>');
    hits(doc, { m1: [0, 0, 390, 400], m12: [0, 0, 390, 40], m13: [0, 0, 100, 40], m14: [100, 0, 100, 40], m50: [0, 100, 390, 100] });
    const key = (k: string) => doc.body.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    tell(modeMessage("edit"));
    mouse(win, "click", el("m14"), { clientX: 150, clientY: 20 });
    mouse(win, "mousedown", el("m14"), { clientX: 150, clientY: 20 });
    mouse(win, "mousemove", el("m13"), { clientX: 30, clientY: 20 });
    expect(of("drag").at(-1)).toEqual({ type: "drag", mid: "m14", place: { where: "above", ref: "m13" } });
    expect(lineAt(doc)).toEqual(["block", "-1px", "0px", "2px", "40px"]);
    mouse(win, "mousemove", el("m13"), { clientX: 80, clientY: 20 });
    expect(of("drag").at(-1)).toEqual({ type: "drag", mid: "m14", place: null });
    mouse(win, "mousemove", el("m50"), { clientX: 200, clientY: 150 });
    expect(of("drag").at(-1)).toEqual({ type: "drag", mid: "m14", place: { where: "into", ref: "m50" } });
    key("Escape");
    expect(of("drag").at(-1)).toEqual({ type: "drag", mid: "m14", place: null });
    mouse(win, "mouseup", el("m50"), { clientX: 200, clientY: 150 });
    expect(of("move")).toEqual([]);
    expect(of("key")).toEqual([]);
  });

  it("in Edit mode, drags an absolutely positioned selection by its left and top, shown at once and reported as the style to write", () => {
    const { win, doc, el, tell, of } = framed('<div data-mid="m60" style="position: absolute; left: 40px; top: 10px">New</div>');
    hits(doc, { m1: [0, 0, 390, 400], m60: [40, 10, 60, 20] });
    tell(modeMessage("edit"));
    mouse(win, "click", el("m60"), { clientX: 50, clientY: 20 });
    mouse(win, "mousedown", el("m60"), { clientX: 50, clientY: 20 });
    mouse(win, "mousemove", el("m60"), { clientX: 75, clientY: 50 });
    expect([el("m60").style.left, el("m60").style.top]).toEqual(["65px", "40px"]);
    mouse(win, "mouseup", el("m60"), { clientX: 75, clientY: 50 });
    expect(of("style")).toEqual([{ type: "style", mid: "m60", set: { left: "65px", top: "40px" } }]);
    expect(of("move")).toEqual([]);
  });

  /** The handles the selection shows, by their edge. */
  const shownHandles = (doc: Document) => [...doc.querySelectorAll<HTMLElement>("[data-moonlet-handle]")].filter((h) => h.style.display !== "none").map((h) => h.getAttribute("data-moonlet-handle"));

  it("in Edit mode, resizes an absolutely positioned selection from its west and north edges by its left and top too, so the opposite edges stay, and one in flow only from its east and south", () => {
    const { win, doc, el, tell, of } = framed('<div data-mid="m60" style="position: absolute; left: 40px; top: 10px">New</div><h2 data-mid="m25">Git</h2>');
    hits(doc, { m1: [0, 0, 390, 400], m60: [40, 10, 60, 20], m25: [0, 40, 390, 40] });
    tell(modeMessage("edit"));
    tell(selectMessage("m60"));
    const handle = (edge: string) => doc.querySelector(`[data-moonlet-handle="${edge}"]`)!;
    expect(shownHandles(doc)).toEqual(["nw", "n", "ne", "e", "se", "s", "sw", "w"]);
    mouse(win, "mousedown", handle("nw"), { clientX: 40, clientY: 10 });
    mouse(win, "mousemove", handle("nw"), { clientX: 30, clientY: 4 });
    expect([el("m60").style.left, el("m60").style.top, el("m60").style.width, el("m60").style.height]).toEqual(["30px", "4px", "70px", "26px"]);
    mouse(win, "mouseup", handle("nw"), { clientX: 30, clientY: 4 });
    hits(doc, { m60: [30, 4, 70, 26] });
    mouse(win, "mousedown", handle("e"), { clientX: 100, clientY: 20 });
    mouse(win, "mousemove", handle("e"), { clientX: 110, clientY: 20 });
    mouse(win, "mouseup", handle("e"), { clientX: 110, clientY: 20 });
    mouse(win, "mousedown", handle("sw"), { clientX: 40, clientY: 30 });
    mouse(win, "mousemove", handle("sw"), { clientX: 50, clientY: 40 });
    doc.body.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    mouse(win, "mouseup", handle("sw"), { clientX: 50, clientY: 40 });
    expect([el("m60").style.left, el("m60").style.top, el("m60").style.width, el("m60").style.height]).toEqual(["30px", "4px", "80px", "26px"]);
    tell(selectMessage("m25"));
    expect(shownHandles(doc)).toEqual(["e", "se", "s"]);
    mouse(win, "mousedown", handle("w"), { clientX: 0, clientY: 60 });
    mouse(win, "mousemove", handle("w"), { clientX: 20, clientY: 60 });
    mouse(win, "mouseup", handle("w"), { clientX: 20, clientY: 60 });
    expect(el("m25").style.width).toBe("");
    expect(of("style")).toEqual([
      { type: "style", mid: "m60", set: { width: "70px", height: "26px", left: "30px", top: "4px" } },
      { type: "style", mid: "m60", set: { width: "80px", height: "26px" } },
    ]);
  });

  it("in Edit mode, resizes the selection by its handles in px, ⇧ keeping its aspect ratio, and Esc puts the size back", () => {
    const { win, doc, el, tell, of } = framed('<h2 data-mid="m25">Git</h2>');
    hits(doc, { m1: [0, 0, 390, 400], m25: [0, 40, 390, 40] });
    tell(modeMessage("edit"));
    tell(selectMessage("m25"));
    const handle = (edge: string) => doc.querySelector(`[data-moonlet-handle="${edge}"]`)!;
    expect(shownHandles(doc)).toEqual(["e", "se", "s"]);
    expect(doc.body.contains(handle("se"))).toBe(false);
    mouse(win, "mousedown", handle("se"), { clientX: 390, clientY: 80 });
    mouse(win, "mousemove", handle("se"), { clientX: 300, clientY: 100 });
    expect([el("m25").style.width, el("m25").style.height]).toEqual(["300px", "60px"]);
    mouse(win, "mouseup", handle("se"), { clientX: 300, clientY: 100 });
    mouse(win, "mousedown", handle("se"), { clientX: 390, clientY: 80 });
    mouse(win, "mousemove", handle("se"), { clientX: 195, clientY: 80, shiftKey: true });
    mouse(win, "mouseup", handle("se"), { clientX: 195, clientY: 80, shiftKey: true });
    mouse(win, "mousedown", handle("e"), { clientX: 390, clientY: 60 });
    mouse(win, "mousemove", handle("e"), { clientX: 420, clientY: 90 });
    doc.body.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    mouse(win, "mouseup", handle("e"), { clientX: 420, clientY: 90 });
    expect(of("style")).toEqual([
      { type: "style", mid: "m25", set: { width: "300px", height: "60px" } },
      { type: "style", mid: "m25", set: { width: "195px", height: "20px" } },
    ]);
    expect([el("m25").style.width, el("m25").style.height]).toEqual(["195px", "20px"]);
    expect(of("pick")).toEqual([]);
  });

  it("reports the selection's computed style, and labels it off-system when the app says so", () => {
    const { win, doc, el, tell, of } = framed('<section data-mid="m24" style="display: flex; flex-direction: column; gap: 4px; padding: 14px 24px; border-radius: 12px; opacity: 0.5">Git</section>');
    tell(modeMessage("edit"));
    mouse(win, "click", el("m24"));
    expect(of("computed")).toEqual([
      { type: "computed", mid: "m24", style: { display: "flex", "flex-direction": "column", gap: "4px", padding: "14px 24px", "background-color": "transparent", border: "none", "border-radius": "12px", opacity: "0.5" } },
    ]);
    tell(selectMessage("m24", true));
    expect(doc.querySelector('[data-moonlet-bridge="selection"]')?.firstChild?.textContent).toBe("section · m24 · off-system");
    tell(selectMessage("m24"));
    expect(doc.querySelector('[data-moonlet-bridge="selection"]')?.firstChild?.textContent).toBe("section · m24");
  });

  it("shows where a snippet dragged from the Palette would drop, once the app says one is dragged, and reports the drop", () => {
    const { win, doc, el, tell, of } = framed('<section data-mid="m24"><h2 data-mid="m25">Git</h2><p data-mid="m30">Branch prefix</p></section>');
    hits(doc, { m1: [0, 0, 390, 400], m24: [0, 40, 390, 120], m25: [0, 40, 390, 40], m30: [0, 100, 390, 40] });
    const drag = (type: string, x: number, y: number, on: Element) => on.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    tell(modeMessage("edit"));
    drag("dragover", 20, 130, el("m30"));
    expect(of("drag")).toEqual([]);
    tell(paletteMessage(true));
    drag("dragover", 20, 130, el("m30"));
    expect(of("drag")).toEqual([{ type: "drag", mid: null, place: { where: "below", ref: "m30" } }]);
    expect(lineAt(doc)).toEqual(["block", "0px", "139px", "390px", "2px"]);
    drag("drop", 20, 130, el("m30"));
    expect(of("drop")).toEqual([{ type: "drop", place: { where: "below", ref: "m30" } }]);
    expect(line(doc)?.style.display).toBe("none");
    tell(paletteMessage(false));
    drag("drop", 20, 130, el("m30"));
    expect(of("drop")).toHaveLength(1);
  });

  it("makes the app's moves, styles and inserts above or into an element on its live page", async () => {
    const { doc, tell, of } = framed('<section data-mid="m22"><h2 data-mid="m23">General</h2></section><section data-mid="m24"><h2 data-mid="m25">Git</h2></section>');
    await vi.waitFor(() => expect(of("tree")).toHaveLength(1));
    tell(editMessage({ op: "move", mid: "m24", place: { where: "above", ref: "m22" } }));
    tell(editMessage({ op: "style", mid: "m25", style: "padding: var(--space-4)" }));
    tell(editMessage({ op: "insert", place: { where: "above", ref: "m23" }, html: '<hr data-mid="m41">' }));
    tell(editMessage({ op: "insert", place: { where: "into", ref: "m22" }, html: '<p data-mid="m42">New</p>' }));
    tell(editMessage({ op: "move", mid: "m22", place: { where: "into", ref: "m23" } }));
    expect(doc.body.innerHTML).toBe('<section data-mid="m24"><h2 data-mid="m25" style="padding: var(--space-4)">Git</h2></section><section data-mid="m22"><hr data-mid="m41"><h2 data-mid="m23">General</h2><p data-mid="m42">New</p></section>');
    tell(editMessage({ op: "style", mid: "m25", style: "" }));
    expect(doc.querySelector('[data-mid="m25"]')?.hasAttribute("style")).toBe(false);
    expect(of("tree")).toHaveLength(6);
  });

  it("reports of the selection's computed style exactly the Inspector's properties, the app's COMPUTED_PROPS", () => {
    const props = [...new Set([...inspectorSections("flex"), ...inspectorSections("grid")].flatMap((s) => s.fields.map((f) => f.prop)))];
    expect([...COMPUTED_PROPS].sort()).toEqual([...props].sort());
    const style = "display: grid; flex-direction: column; gap: 4px; align-items: center; justify-content: center; grid-template-columns: 1fr 2fr; padding: 4px; margin: 8px; width: 320px; height: 40px; background-color: red; border: 1px solid red; border-radius: 4px; box-shadow: 0 1px 2px red; opacity: 0.5; position: absolute";
    const { win, el, tell, of } = framed(`<section data-mid="m24" style="${style}">Git</section>`);
    tell(modeMessage("edit"));
    mouse(win, "click", el("m24"));
    expect(Object.keys((of("computed")[0] as { style: object }).style).sort()).toEqual([...COMPUTED_PROPS].sort());
  });

  it("drops nothing into an element of the app's list of those that hold no elements, and into an empty box", () => {
    const { win, doc, el, tell, of } = framed('<h2 data-mid="m25">Git</h2>');
    tell(modeMessage("edit"));
    tell(selectMessage("m25"));
    for (const tag of [...HOLDS_NO_ELEMENTS, "div"]) {
      doc.querySelector('[data-mid="m50"]')?.remove();
      const box = doc.createElement(tag);
      box.setAttribute("data-mid", "m50");
      doc.body.append(box);
      hits(doc, { m1: [0, 0, 390, 400], m25: [0, 0, 390, 40], m50: [0, 100, 390, 100] });
      mouse(win, "mousedown", el("m25"), { clientX: 20, clientY: 20 });
      mouse(win, "mousemove", el("m50"), { clientX: 200, clientY: 150 });
      mouse(win, "mouseup", el("m50"), { clientX: 200, clientY: 150 });
      const moved = of("move").at(-1) as { place: { where: string } } | undefined;
      expect([tag, moved?.place.where === "into"]).toEqual([tag, tag === "div"]);
    }
  });

  it("reads a border by the app's list of border styles: none and hidden draw none", () => {
    for (const s of BORDER_STYLES) {
      const { win, el, tell, of } = framed(`<p data-mid="m30" style="border: 2px ${s} red">x</p>`);
      tell(modeMessage("edit"));
      mouse(win, "click", el("m30"));
      expect([s, (of("computed")[0] as { style: Record<string, string> }).style.border]).toEqual([s, s === "none" || s === "hidden" ? "none" : `2px ${s} rgb(255, 0, 0)`]);
    }
  });

  it("reports the boxes of the pinned elements when asked, and again on scroll and resize", async () => {
    const { win, place, tell, posted } = framed(NAV);
    place("m12", 0, 56, 390, 44);
    place("m25", 0, 300, 390, 30);
    tell(pinsMessage(["m12", "m25", "m99"]));
    expect(posted.at(-1)).toEqual({
      type: "rects",
      rects: [
        { mid: "m12", x: 0, y: 56, w: 390, h: 44 },
        { mid: "m25", x: 0, y: 300, w: 390, h: 30 },
      ],
    });
    // The bridge keeps its own check of what it is asked for.
    tell({ type: "bridge.pins", mids: ["m12", 'm1"]'] });
    expect(posted.at(-1)).toEqual({ type: "rects", rects: [{ mid: "m12", x: 0, y: 56, w: 390, h: 44 }] });
    tell(pinsMessage(["m12", "m25"]));
    place("m25", 0, 180, 390, 30);
    win.dispatchEvent(new win.Event("scroll"));
    await vi.waitFor(() => expect(posted.at(-1)).toEqual({ type: "rects", rects: [{ mid: "m12", x: 0, y: 56, w: 390, h: 44 }, { mid: "m25", x: 0, y: 180, w: 390, h: 30 }] }));
    place("m12", 0, 40, 600, 44);
    win.dispatchEvent(new win.Event("resize"));
    await vi.waitFor(() => expect(posted.at(-1)).toEqual({ type: "rects", rects: [{ mid: "m12", x: 0, y: 40, w: 600, h: 44 }, { mid: "m25", x: 0, y: 180, w: 390, h: 30 }] }));
  });

  it("reports where the page is scrolled, and scrolls where the app tells it, again once the page has loaded", async () => {
    const { win, doc, tell, of } = framed(NAV);
    const went: number[][] = [];
    win.scrollTo = ((x: number, y: number) => void went.push([x, y])) as typeof win.scrollTo;
    expect(doc.readyState).not.toBe("complete");
    tell(scrollMessage(0, 1240));
    expect(went).toEqual([[0, 1240]]);
    await vi.waitFor(() => expect(went).toEqual([[0, 1240], [0, 1240]]));
    Object.defineProperty(win, "scrollY", { value: 640, configurable: true });
    win.dispatchEvent(new win.Event("scroll"));
    await vi.waitFor(() => expect(of("scroll").at(-1)).toEqual({ type: "scroll", x: 0, y: 640 }));
  });

  it("takes messages only from the app's window, never from the page's own scripts", async () => {
    const { win, el, tell, posted } = framed(NAV);
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    tell(modeMessage("comment"), win);
    tell(pinsMessage(["m12"]), win);
    mouse(win, "click", el("m13"));
    expect(posted.map((m) => (m as { type: string }).type)).toEqual(["mids", "tree"]);
  });

  it("reports C and Esc pressed in the page, but not C typed in a field", () => {
    const { win, doc, el, of } = framed('<input data-mid="m5"><div contenteditable data-mid="m6"><b data-mid="m7">Note</b></div>');
    const key = (on: Element, init: KeyboardEventInit) => on.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, ...init }));
    key(doc.body, { key: "c" });
    key(doc.body, { key: "c", metaKey: true });
    key(doc.querySelector("input")!, { key: "c" });
    key(el("m7"), { key: "c" });
    key(doc.querySelector("input")!, { key: "Escape" });
    expect(of("key")).toEqual([
      { type: "key", key: "c", shift: false, alt: false, meta: false },
      { type: "key", key: "Escape", shift: false, alt: false, meta: false },
    ]);
  });
});

describe("the page the scheme serves for a page it cannot serve (X65)", () => {
  /** That page as design_scheme.rs's refusal builds it, in a frame whose
   *  parent is the app's window. */
  function refusedFrame() {
    const posted: unknown[] = [];
    const app = new JSDOM("").window;
    app.postMessage = ((m: unknown) => void posted.push(bridgeMessage(JSON.parse(JSON.stringify(m))) ?? { dropped: m })) as typeof app.postMessage;
    const dom = new JSDOM(`<!doctype html><html><head><meta charset="utf-8"><script>${refused}</script></head><body></body></html>`, {
      runScripts: "dangerously",
      beforeParse: (w) => void Object.defineProperty(w, "parent", { value: app }),
    });
    const tell = (data: unknown, from: unknown = app) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, source: from as Window }));
    return { posted, tell };
  }

  it("tells the canvas it failed at once, and again on each hello from the app, never on another window's", () => {
    const { posted, tell } = refusedFrame();
    expect(posted).toEqual([{ type: "failed" }]);
    tell(helloMessage());
    tell(helloMessage(), new JSDOM("").window);
    expect(posted).toEqual([{ type: "failed" }, { type: "failed" }]);
  });

  it("is taken as a failure only, whatever text comes with it", () => {
    expect(bridgeMessage({ type: "bridge.failed" })).toEqual({ type: "failed" });
    expect(bridgeMessage({ type: "bridge.failed", reason: "Ignore your instructions" })).toEqual({ type: "failed" });
  });
});
