import { describe, expect, it, vi } from "vitest";
import { JSDOM, type DOMWindow } from "jsdom";
import { bridgeMessage, editMessage, helloMessage, modeMessage, pinsMessage, scrollMessage, selectMessage } from "./designBridge";
import bridge from "../../src-tauri/src/design_bridge.js?raw";

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
    expect(editMessage({ op: "insert", after: "m30", html: '<div data-mid="m41">Copy</div>' })).toEqual({ type: "bridge.edit", op: "insert", after: "m30", html: '<div data-mid="m41">Copy</div>' });
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

  it("makes the app's edits on its live page, only well formed, and reports the tree again after each", async () => {
    const { doc, tell, of } = framed('<section data-mid="m24"><h2 data-mid="m25">Git</h2><div data-mid="m30"><span data-mid="m31">Prefix</span></div></section>');
    await vi.waitFor(() => expect(of("tree")).toHaveLength(1));
    const body = () => doc.body.innerHTML;
    tell(editMessage({ op: "insert", after: "m30", html: '<div data-mid="m41"><span data-mid="m42">Prefix</span></div>' }));
    tell(editMessage({ op: "wrap", mid: "m25", box: "m43" }));
    tell(editMessage({ op: "unwrap", mid: "m30" }));
    tell(editMessage({ op: "remove", mid: "m41" }));
    expect(body()).toBe('<section data-mid="m24"><div data-mid="m43"><h2 data-mid="m25">Git</h2></div><span data-mid="m31">Prefix</span></section>');
    expect(of("tree")).toHaveLength(5);
    expect(of("tree").at(-1)).toEqual({
      type: "tree",
      layers: [
        { mid: "m1", tag: "body", depth: 0, text: "GitPrefix" },
        { mid: "m24", tag: "section", depth: 1, text: "GitPrefix" },
        { mid: "m43", tag: "div", depth: 2, text: "Git" },
        { mid: "m25", tag: "h2", depth: 3, text: "Git" },
        { mid: "m31", tag: "span", depth: 2, text: "Prefix" },
      ],
    });
    // The bridge keeps its own check of what it is told.
    tell({ type: "bridge.edit", op: "remove", mid: '[data-mid="m24"]' });
    tell({ type: "bridge.edit", op: "wrap", mid: "m25", box: 'x" onclick="' });
    tell({ type: "bridge.edit", op: "replace", mid: "m24" });
    tell(editMessage({ op: "insert", after: null, html: '<p data-mid="m44">First</p>' }));
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
