import { describe, expect, it } from "vitest";
import { EditRefused, applyEdit, copyElement, highestMid, editLine, editLines, editSaid, editsChip, editsMessage, inlineStyles, lineRead, readEditsMessage, type EditOp, type Untold } from "./designEdits";

/** A page as a design's agent writes it (designs.md): the design system's
 *  styles.css, classes, a page script, an <svg> whose part holds an id, and
 *  the markup a hand or an agent leaves: CRLF line ends, unquoted and
 *  single-quoted attributes, entities, void elements and an implied end tag. */
const PAGE = [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8">',
  "<title>Settings</title>",
  '<link rel="stylesheet" href="../../../systems/moonlet-desktop/styles.css">',
  "<style>",
  "  .rows { display: flex; flex-direction: column; gap: var(--space-2); }",
  "</style>",
  "</head>",
  '<body data-mid="m1" class="app">',
  "  <nav data-mid='m12' class=sidenav><a data-mid=\"m13\" href=\"#general\">General</a><a data-mid=\"m14\" href=\"#git\">Git</a></nav>",
  '  <main data-mid="m20">',
  '    <h1 data-mid="m21">Settings</h1>',
  '    <section data-mid="m22" class="card">',
  '      <h2 data-mid="m23">General</h2>',
  "    </section>",
  '    <section data-mid="m24" class="card rows">',
  '      <h2 data-mid="m25">Git</h2>',
  '      <div data-mid="m30" class="row"><span data-mid="m31">Branch prefix</span><input data-mid="m32" class="field" value="marcin/"></div>',
  '      <p data-mid="m33" class=hint>Tom &amp; Jerry&nbsp;rules</p>',
  '      <ul data-mid="m35"><li data-mid="m36">Rows<li data-mid="m37">Cards</ul>',
  '      <svg data-mid="m34" viewBox="0 0 8 8"><path data-mid="m40" d="M0 0h8"/></svg>',
  "    </section>",
  "  </main>",
  "  <script>",
  "    document.querySelectorAll('.sidenav a').forEach((a) => a.addEventListener('click', () => {}));",
  "  </script>",
  "</body>",
  "</html>",
  "",
].join("\r\n");

/** PAGE with its lines from `from` (1-based, as an editor numbers them)
 *  replaced by `lines`, `count` of them. */
const withLines = (from: number, count: number, ...lines: string[]) => {
  const all = PAGE.split("\r\n");
  all.splice(from - 1, count, ...lines);
  return all.join("\r\n");
};

describe("an edit by hand on a page's source (X65)", () => {
  it("changes an element's text, and leaves the rest of the page as it was, byte for byte", () => {
    const edit = applyEdit(PAGE, { kind: "text", mid: "m31", text: "Prefix for new branches" });
    expect(edit.html).toBe(
      withLines(20, 1, '      <div data-mid="m30" class="row"><span data-mid="m31">Prefix for new branches</span><input data-mid="m32" class="field" value="marcin/"></div>'),
    );
  });

  it("writes the new text with &, < and > as entities, also where the end tag is implied, and only on an element whose children are only text", () => {
    expect(applyEdit(PAGE, { kind: "text", mid: "m36", text: "Rows & <cards>" }).html).toBe(
      withLines(22, 1, '      <ul data-mid="m35"><li data-mid="m36">Rows &amp; &lt;cards&gt;<li data-mid="m37">Cards</ul>'),
    );
    expect(() => applyEdit(PAGE, { kind: "text", mid: "m30", text: "Branch prefix" })).toThrow(new EditRefused("m30 holds more than text: edit the text of its parts"));
    expect(() => applyEdit(PAGE, { kind: "text", mid: "m99", text: "x" })).toThrow(new EditRefused("m99 is not on the page"));
  });

  it("writes back the text the live page shows as the source had it, so an unchanged text leaves the captured page byte for byte", () => {
    expect(applyEdit(PAGE, { kind: "text", mid: "m33", text: "Tom & Jerry\u00a0rules" }).html).toBe(PAGE);
  });

  it("deletes an element, with its line when it is alone on it, and selects its next sibling, else the one before, else its parent", () => {
    const alone = applyEdit(PAGE, { kind: "delete", mid: "m33" });
    expect(alone.html).toBe(withLines(21, 1));
    expect(alone.select).toBe("m35");
    const inline = applyEdit(PAGE, { kind: "delete", mid: "m13" });
    expect(inline.html).toBe(withLines(12, 1, "  <nav data-mid='m12' class=sidenav><a data-mid=\"m14\" href=\"#git\">Git</a></nav>"));
    expect(inline.select).toBe("m14");
    expect(applyEdit(PAGE, { kind: "delete", mid: "m34" }).select).toBe("m35");
    expect(applyEdit(withLines(19, 4), { kind: "delete", mid: "m34" }).select).toBe("m24");
    expect(() => applyEdit(PAGE, { kind: "delete", mid: "m1" })).toThrow(new EditRefused("The page's body stays"));
  });

  it("duplicates an element after itself, on a line of its own when it has one, its copy and the copy's insides with the next free ids, never one an svg part holds", () => {
    const own = applyEdit(PAGE, { kind: "duplicate", mid: "m30" });
    expect(own.html).toBe(
      withLines(
        20,
        1,
        '      <div data-mid="m30" class="row"><span data-mid="m31">Branch prefix</span><input data-mid="m32" class="field" value="marcin/"></div>',
        '      <div data-mid="m41" class="row"><span data-mid="m42">Branch prefix</span><input data-mid="m43" class="field" value="marcin/"></div>',
      ),
    );
    expect(own.select).toBe("m41");
    const inline = applyEdit(PAGE, { kind: "duplicate", mid: "m13" });
    expect(inline.html).toBe(withLines(12, 1, "  <nav data-mid='m12' class=sidenav><a data-mid=\"m13\" href=\"#general\">General</a><a data-mid=\"m41\" href=\"#general\">General</a><a data-mid=\"m14\" href=\"#git\">Git</a></nav>"));
    expect(() => applyEdit(PAGE, { kind: "duplicate", mid: "m1" })).toThrow(new EditRefused("The page's body stays"));
  });

  it("gives a copy's ids fresh values where its data-mids are written, unquoted, single- or double-quoted, or with an entity", () => {
    const page = '<!doctype html>\n<body data-mid="m1">\n<ul data-mid=m2><li data-mid=m3>a</li><li data-mid=\'m4\'>b</li><li data-mid="m5">c</li><li data-mid="m&#54;">m6</li></ul>\n</body>\n';
    expect(applyEdit(page, { kind: "duplicate", mid: "m2" }).html).toBe(
      '<!doctype html>\n<body data-mid="m1">\n<ul data-mid=m2><li data-mid=m3>a</li><li data-mid=\'m4\'>b</li><li data-mid="m5">c</li><li data-mid="m&#54;">m6</li></ul>\n<ul data-mid=m7><li data-mid=m8>a</li><li data-mid=\'m9\'>b</li><li data-mid="m10">c</li><li data-mid="m11">m6</li></ul>\n</body>\n',
    );
  });

  it("never gives an id the page had earlier, as one an element deleted since held: fresh ids start after the highest it ever had", () => {
    const without = applyEdit(PAGE, { kind: "delete", mid: "m34" }).html;
    expect(highestMid(PAGE)).toBe(40);
    expect(applyEdit(without, { kind: "wrap", mid: "m25" }).select).toBe("m38");
    expect(applyEdit(without, { kind: "wrap", mid: "m25" }, highestMid(PAGE)).select).toBe("m41");
  });

  it("never gives an id an element inside a <noscript> holds, which a browser running scripts reads as text", () => {
    const page = '<!doctype html>\n<body data-mid="m1">\n<p data-mid="m2">Git</p>\n<noscript><p data-mid="m50">Turn on scripts</p></noscript>\n</body>\n';
    expect(highestMid(page)).toBe(50);
    expect(applyEdit(page, { kind: "wrap", mid: "m2" }).select).toBe("m51");
  });

  it("wraps an element in a box, a div with the next free id, which it selects", () => {
    const wrapped = applyEdit(PAGE, { kind: "wrap", mid: "m25" });
    expect(wrapped.html).toBe(withLines(19, 1, '      <div data-mid="m41"><h2 data-mid="m25">Git</h2></div>'));
    expect(wrapped.select).toBe("m41");
    expect(() => applyEdit(PAGE, { kind: "wrap", mid: "m1" })).toThrow(new EditRefused("The page's body stays"));
  });

  it("refuses a box where the browser would not keep it around the element: inside a <p>, or around a table's cell", () => {
    const para = '<!doctype html>\n<body data-mid="m1">\n<p data-mid="m2">Branch <span data-mid="m3">prefix</span></p>\n</body>\n';
    expect(() => applyEdit(para, { kind: "wrap", mid: "m3" })).toThrow(new EditRefused("A box cannot go around m3 inside <p>"));
    const table = '<!doctype html>\n<body data-mid="m1">\n<table data-mid="m2"><tr data-mid="m3"><td data-mid="m4">Git</td></tr></table>\n</body>\n';
    expect(() => applyEdit(table, { kind: "wrap", mid: "m4" })).toThrow(new EditRefused("A box cannot go around m4 inside <tr>"));
    expect(applyEdit(table, { kind: "wrap", mid: "m2" }).html).toBe('<!doctype html>\n<body data-mid="m1">\n<div data-mid="m5"><table data-mid="m2"><tr data-mid="m3"><td data-mid="m4">Git</td></tr></table></div>\n</body>\n');
  });

  it("unwraps an element, keeping what is inside it in its place, and selects its first child, else its parent", () => {
    const unwrapped = applyEdit(PAGE, { kind: "unwrap", mid: "m30" });
    expect(unwrapped.html).toBe(withLines(20, 1, '      <span data-mid="m31">Branch prefix</span><input data-mid="m32" class="field" value="marcin/">'));
    expect(unwrapped.select).toBe("m31");
    expect(applyEdit(PAGE, { kind: "unwrap", mid: "m36" }).html).toBe(withLines(22, 1, '      <ul data-mid="m35">Rows<li data-mid="m37">Cards</ul>'));
    expect(applyEdit(PAGE, { kind: "unwrap", mid: "m36" }).select).toBe("m35");
    expect(() => applyEdit(PAGE, { kind: "unwrap", mid: "m32" })).toThrow(new EditRefused("<input> m32 has nothing inside to keep"));
    expect(() => applyEdit(PAGE, { kind: "unwrap", mid: "m1" })).toThrow(new EditRefused("The page's body stays"));
  });

  it("copies an element as its source, and pastes it after the selection, or at the end of the body, with the next free ids, which it selects", () => {
    const other = '<!doctype html>\n<body data-mid="m1">\n<section data-mid="m3"><h3 data-mid="m4">Rows</h3><svg data-mid="m5"><path data-mid="m50" d="M0 0"/></svg></section>\n</body>\n';
    const copied = copyElement(other, "m3")!;
    expect(copied).toBe('<section data-mid="m3"><h3 data-mid="m4">Rows</h3><svg data-mid="m5"><path data-mid="m50" d="M0 0"/></svg></section>');
    const pasted = applyEdit(PAGE, { kind: "paste", after: "m25", html: copied });
    expect(pasted.html).toBe(
      withLines(19, 1, '      <h2 data-mid="m25">Git</h2>', '      <section data-mid="m41"><h3 data-mid="m42">Rows</h3><svg data-mid="m43"><path data-mid="m44" d="M0 0"/></svg></section>'),
    );
    expect(pasted.select).toBe("m41");
    expect(applyEdit(PAGE, { kind: "paste", after: null, html: '<p data-mid="m9">Note</p>' }).html).toBe(withLines(25, 1, "  </main>", '  <p data-mid="m41">Note</p>'));
    expect(copyElement(PAGE, "m99")).toBeNull();
  });

  it("gives the same edit for the live page, the copy's source with its fresh ids, and none for a text the page already shows", () => {
    expect(applyEdit(PAGE, { kind: "delete", mid: "m33" }).live).toEqual({ op: "remove", mid: "m33" });
    expect(applyEdit(PAGE, { kind: "duplicate", mid: "m31" }).live).toEqual({ op: "insert", place: { where: "below", ref: "m31" }, html: '<span data-mid="m41">Branch prefix</span>' });
    expect(applyEdit(PAGE, { kind: "wrap", mid: "m25" }).live).toEqual({ op: "wrap", mid: "m25", box: "m41" });
    expect(applyEdit(PAGE, { kind: "unwrap", mid: "m30" }).live).toEqual({ op: "unwrap", mid: "m30" });
    expect(applyEdit(PAGE, { kind: "paste", after: null, html: '<p data-mid="m9">Note</p>' }).live).toEqual({ op: "insert", place: { where: "below", ref: "m20" }, html: '<p data-mid="m41">Note</p>' });
    expect(applyEdit(PAGE, { kind: "text", mid: "m31", text: "Prefix" }).live).toBeNull();
  });

  it("moves an element above another, with its lines when it has them to itself, and selects it", () => {
    const moved = applyEdit(PAGE, { kind: "move", mid: "m24", place: { where: "above", ref: "m22" } });
    expect(moved.html).toBe(
      withLines(
        15,
        10,
        '    <section data-mid="m24" class="card rows">',
        '      <h2 data-mid="m25">Git</h2>',
        '      <div data-mid="m30" class="row"><span data-mid="m31">Branch prefix</span><input data-mid="m32" class="field" value="marcin/"></div>',
        '      <p data-mid="m33" class=hint>Tom &amp; Jerry&nbsp;rules</p>',
        '      <ul data-mid="m35"><li data-mid="m36">Rows<li data-mid="m37">Cards</ul>',
        '      <svg data-mid="m34" viewBox="0 0 8 8"><path data-mid="m40" d="M0 0h8"/></svg>',
        "    </section>",
        '    <section data-mid="m22" class="card">',
        '      <h2 data-mid="m23">General</h2>',
        "    </section>",
      ),
    );
    expect(moved.select).toBe("m24");
    expect(moved.live).toEqual({ op: "move", mid: "m24", place: { where: "above", ref: "m22" } });
    expect(applyEdit(PAGE, { kind: "move", mid: "m14", place: { where: "above", ref: "m13" } }).html).toBe(
      withLines(12, 1, "  <nav data-mid='m12' class=sidenav><a data-mid=\"m14\" href=\"#git\">Git</a><a data-mid=\"m13\" href=\"#general\">General</a></nav>"),
    );
  });

  it("moves an element below another, or into a container after its last child, on a line of its own indented as that child", () => {
    expect(applyEdit(PAGE, { kind: "move", mid: "m21", place: { where: "below", ref: "m22" } }).html).toBe(
      withLines(14, 4, '    <section data-mid="m22" class="card">', '      <h2 data-mid="m23">General</h2>', "    </section>", '    <h1 data-mid="m21">Settings</h1>'),
    );
    expect(applyEdit(PAGE, { kind: "move", mid: "m33", place: { where: "into", ref: "m22" } }).html).toBe(
      withLines(
        17,
        5,
        '      <p data-mid="m33" class=hint>Tom &amp; Jerry&nbsp;rules</p>',
        "    </section>",
        '    <section data-mid="m24" class="card rows">',
        '      <h2 data-mid="m25">Git</h2>',
        '      <div data-mid="m30" class="row"><span data-mid="m31">Branch prefix</span><input data-mid="m32" class="field" value="marcin/"></div>',
      ),
    );
  });

  it("refuses to move an element into itself, into an element that holds no elements, or the body", () => {
    expect(() => applyEdit(PAGE, { kind: "move", mid: "m24", place: { where: "into", ref: "m30" } })).toThrow(new EditRefused("m24 cannot go inside itself"));
    expect(() => applyEdit(PAGE, { kind: "move", mid: "m24", place: { where: "above", ref: "m24" } })).toThrow(new EditRefused("m24 cannot go inside itself"));
    expect(() => applyEdit(PAGE, { kind: "move", mid: "m33", place: { where: "into", ref: "m32" } })).toThrow(new EditRefused("<input> m32 holds no elements"));
    expect(() => applyEdit(PAGE, { kind: "move", mid: "m33", place: { where: "into", ref: "m34" } })).toThrow(new EditRefused("<svg> m34 holds no elements"));
    expect(() => applyEdit(PAGE, { kind: "move", mid: "m1", place: { where: "above", ref: "m22" } })).toThrow(new EditRefused("The page's body stays"));
  });

  it("refuses a move or an insert the page would not keep where it goes, as a box into a paragraph, which the browser reads outside it", () => {
    expect(() => applyEdit(PAGE, { kind: "move", mid: "m30", place: { where: "into", ref: "m33" } })).toThrow(new EditRefused("m30 cannot go into m33: the page would not keep its structure"));
    expect(() => applyEdit(PAGE, { kind: "insert", place: { where: "into", ref: "m33" }, html: "<section><h3>Rows</h3></section>" })).toThrow(new EditRefused("The page would not keep its structure around m33"));
  });

  it("inserts a snippet after the selection, every element of it with a fresh data-mid, which it selects", () => {
    const edit = applyEdit(PAGE, { kind: "insert", place: { where: "below", ref: "m25" }, html: '<button class="btn btn--primary">Save</button>' });
    expect(edit.html).toBe(withLines(19, 1, '      <h2 data-mid="m25">Git</h2>', '      <button data-mid="m41" class="btn btn--primary">Save</button>'));
    expect(edit.select).toBe("m41");
    expect(edit.live).toEqual({ op: "insert", place: { where: "below", ref: "m25" }, html: '<button data-mid="m41" class="btn btn--primary">Save</button>' });
    expect(editLine({ page: "index", ...edit.change })).toBe("index.html m41 button: inserted after m25");
  });

  it("inserts a snippet of several elements in a box, above an element or into a container, its svg's drawing without ids", () => {
    const snippet = '\n  <span class="switch"><svg viewBox="0 0 8 8"><path d="M0 0h8"/></svg></span>\n  <label>On</label>\n';
    const into = applyEdit(PAGE, { kind: "insert", place: { where: "into", ref: "m22" }, html: snippet });
    expect(into.html).toBe(
      withLines(17, 1, '      <div data-mid="m41"><span data-mid="m42" class="switch"><svg data-mid="m43" viewBox="0 0 8 8"><path d="M0 0h8"/></svg></span>\n  <label data-mid="m44">On</label></div>', "    </section>"),
    );
    expect(editLine({ page: "index", ...into.change })).toBe("index.html m41 div: inserted into m22");
    const above = applyEdit(PAGE, { kind: "insert", place: { where: "above", ref: "m22" }, html: "<hr>" });
    expect(above.html).toBe(withLines(15, 1, '    <hr data-mid="m41">', '    <section data-mid="m22" class="card">'));
    expect(editLine({ page: "index", ...above.change })).toBe("index.html m41 hr: inserted above m22");
    expect(() => applyEdit(PAGE, { kind: "insert", place: null, html: "  just text  " })).toThrow(new EditRefused("The snippet has no element to insert"));
  });

  it("gives a snippet's id written with an entity a fresh one where its attribute writes it", () => {
    const edit = applyEdit(PAGE, { kind: "insert", place: { where: "below", ref: "m25" }, html: '<div data-mid="m&#51;" class="row"><span>x</span></div>' });
    expect(edit.html).toBe(withLines(19, 1, '      <h2 data-mid="m25">Git</h2>', '      <div data-mid="m41" class="row"><span data-mid="m42">x</span></div>'));
  });

  it("restyles an element by its inline style, written as the style attribute after its others", () => {
    const edit = applyEdit(PAGE, { kind: "restyle", mid: "m24", set: { padding: "var(--space-4)" } });
    expect(edit.html).toBe(withLines(18, 1, '    <section data-mid="m24" class="card rows" style="padding: var(--space-4)">'));
    expect(edit.select).toBe("m24");
    expect(edit.live).toEqual({ op: "style", mid: "m24", style: "padding: var(--space-4)" });
  });

  it("keeps the inline style's other properties in their order, sets one in its place, removes one, and the attribute once it has none", () => {
    const styled = withLines(21, 1, "      <p data-mid=\"m33\" style='color: #d97757;  margin:0 ; background: url(\"a;b.png\")' class=hint>Tom &amp; Jerry&nbsp;rules</p>");
    expect(applyEdit(styled, { kind: "restyle", mid: "m33", set: { margin: "var(--space-2)", color: null, gap: "4px" } }).html).toBe(
      withLines(21, 1, '      <p data-mid="m33" style="margin: var(--space-2); background: url(&quot;a;b.png&quot;); gap: 4px" class=hint>Tom &amp; Jerry&nbsp;rules</p>'),
    );
    const one = withLines(21, 1, '      <p data-mid="m33" class=hint style="color: red">Tom &amp; Jerry&nbsp;rules</p>');
    const none = applyEdit(one, { kind: "restyle", mid: "m33", set: { color: null } });
    expect(none.html).toBe(PAGE);
    expect(none.live).toEqual({ op: "style", mid: "m33", style: "" });
    // A void element written with a slash keeps it last.
    const input = withLines(20, 1, '      <div data-mid="m30" class="row"><span data-mid="m31">Branch prefix</span><input data-mid="m32" class="field" value="marcin/" /></div>');
    expect(applyEdit(input, { kind: "restyle", mid: "m32", set: { width: "320px" } }).html).toBe(
      withLines(20, 1, '      <div data-mid="m30" class="row"><span data-mid="m31">Branch prefix</span><input data-mid="m32" class="field" value="marcin/" style="width: 320px" /></div>'),
    );
  });

  it("leaves every declaration it does not set as written: a custom property's case, a comment, a duplicate with !important, an underscore and a vendor prefix", () => {
    const p = (style: string) => withLines(21, 1, `      <p data-mid="m33" class=hint style="${style}">Tom &amp; Jerry&nbsp;rules</p>`);
    const padded = (style: string) => applyEdit(p(style), { kind: "restyle", mid: "m33", set: { padding: "4px" } }).html;
    expect(padded("--Main: #161616; color: var(--Main)")).toBe(p("--Main: #161616; color: var(--Main); padding: 4px"));
    expect(padded("/* brand */ color: red;margin:0")).toBe(p("/* brand */ color: red;margin:0; padding: 4px"));
    expect(padded("color: red !important; color: blue")).toBe(p("color: red !important; color: blue; padding: 4px"));
    expect(padded("--a_b: 2px; margin: var(--a_b)")).toBe(p("--a_b: 2px; margin: var(--a_b); padding: 4px"));
    expect(padded("-webkit-line-clamp:2;display:-webkit-box;")).toBe(p("-webkit-line-clamp:2;display:-webkit-box; padding: 4px"));
    expect(padded("color: red; padding: 2px /* tight */; margin: 0")).toBe(p("color: red; padding: 4px; margin: 0"));
    expect(applyEdit(p("/* brand */ color: red;  margin:0"), { kind: "restyle", mid: "m33", set: { color: null } }).html).toBe(p("/* brand */ margin:0"));
  });

  it("sets a property written twice in the place of the first, and reads the one that counts, an !important one first", () => {
    const p = (style: string) => withLines(21, 1, `      <p data-mid="m33" class=hint style="${style}">Tom &amp; Jerry&nbsp;rules</p>`);
    expect(inlineStyles(p("color: red !important; gap: 2px; color: blue"))["m33"]).toEqual([
      ["color", "red !important"],
      ["gap", "2px"],
    ]);
    expect(inlineStyles(p("--Main: #161616; /* note */ Color: blue; color: var(--Main)"))["m33"]).toEqual([
      ["--Main", "#161616"],
      ["color", "var(--Main)"],
    ]);
    expect(inlineStyles(p("padding: 4px /* tight */ 8px"))["m33"]).toEqual([["padding", "4px 8px"]]);
    expect(applyEdit(p("color: red !important; gap: 2px; color: blue"), { kind: "restyle", mid: "m33", set: { color: "green" } }).html).toBe(p("color: green; gap: 2px"));
  });

  it("rewrites a property keeping parts its value already had, as a background's image, which a new value could not bring", () => {
    const styled = withLines(21, 1, "      <p data-mid=\"m33\" style='background: url(\"grain.png\") #161616' class=hint>Tom &amp; Jerry&nbsp;rules</p>");
    expect(applyEdit(styled, { kind: "restyle", mid: "m33", set: { background: 'url("grain.png") var(--color-panel)' } }).html).toBe(
      withLines(21, 1, '      <p data-mid="m33" style="background: url(&quot;grain.png&quot;) var(--color-panel)" class=hint>Tom &amp; Jerry&nbsp;rules</p>'),
    );
    expect(() => applyEdit(styled, { kind: "restyle", mid: "m33", set: { background: 'url("other.png") red' } })).toThrow(new EditRefused('url("other.png") red is not a value the editor writes'));
  });

  it("refuses a style value that could end the declaration or the attribute, or a property that is not one", () => {
    for (const value of ['4px" onclick="alert(1)', "4px; color: red", "4px</p><script>x</script>", "url(https://x.test/a.png)", "calc(4px", "\\34 px", "{}"]) {
      expect(() => applyEdit(PAGE, { kind: "restyle", mid: "m24", set: { padding: value } })).toThrow(new EditRefused(`${value} is not a value the editor writes`));
    }
    expect(() => applyEdit(PAGE, { kind: "restyle", mid: "m24", set: { 'padding" x': "4px" } })).toThrow(new EditRefused('padding" x is not a style property'));
    expect(() => applyEdit(PAGE, { kind: "restyle", mid: "m1", set: { padding: "4px" } })).toThrow(new EditRefused("The page's body stays"));
  });

  it("refuses a value that opens or closes a comment, which would hide the declarations after it, and keeps a slash where CSS has one", () => {
    for (const value of ["4px /*", "*/ red", "4px/**/8px"]) {
      expect(() => applyEdit(PAGE, { kind: "restyle", mid: "m24", set: { padding: value } })).toThrow(new EditRefused(`${value} is not a value the editor writes`));
    }
    expect(applyEdit(PAGE, { kind: "restyle", mid: "m24", set: { "grid-column": "1 / 3", font: "12px/1.5 system-ui" } }).html).toBe(withLines(18, 1, '    <section data-mid="m24" class="card rows" style="grid-column: 1 / 3; font: 12px/1.5 system-ui">'));
  });

  it("refuses an edit that would lose another element of the page, where an element's tags cross another's", () => {
    const tangled = '<!doctype html>\n<body data-mid="m1"><b data-mid="m2">bold<p data-mid="m3">para</b> tail</p></body>\n';
    expect(() => applyEdit(tangled, { kind: "delete", mid: "m2" })).toThrow(new EditRefused("The page's markup around m2 is tangled: ask the agent to fix it"));
    expect(applyEdit(tangled, { kind: "delete", mid: "m3" }).html).toBe('<!doctype html>\n<body data-mid="m1"><b data-mid="m2">bold</body>\n');
  });
});

describe("edits by hand, as the agent is told them (X65)", () => {
  it("says what each edit did to its element: page, data-mid, tag and the change", () => {
    const line = (op: EditOp) => editLine({ page: "index", ...applyEdit(PAGE, op).change });
    expect(line({ kind: "text", mid: "m31", text: "Prefix for new branches" })).toBe("index.html m31 span: text “Prefix for new branches”");
    expect(line({ kind: "delete", mid: "m33" })).toBe("index.html m33 p: deleted");
    expect(line({ kind: "duplicate", mid: "m30" })).toBe("index.html m30 div: duplicated as m41");
    expect(line({ kind: "wrap", mid: "m25" })).toBe("index.html m25 h2: wrapped in div m41");
    expect(line({ kind: "unwrap", mid: "m30" })).toBe("index.html m30 div: unwrapped");
    expect(line({ kind: "paste", after: "m25", html: '<section data-mid="m3"><h3 data-mid="m4">Rows</h3></section>' })).toBe("index.html m41 section: inserted after m25");
    expect(line({ kind: "paste", after: null, html: '<p data-mid="m9">Note</p>' })).toBe("index.html m41 p: inserted at the end of the body");
    expect(line({ kind: "move", mid: "m24", place: { where: "above", ref: "m22" } })).toBe("index.html m24 section: moved above m22");
    expect(line({ kind: "move", mid: "m21", place: { where: "below", ref: "m22" } })).toBe("index.html m21 h1: moved below m22");
    expect(line({ kind: "move", mid: "m33", place: { where: "into", ref: "m22" } })).toBe("index.html m33 p: moved into m22");
  });

  it("go before the user's next message, one line per element, its changes in order with only its latest text, an earlier edit undone too", () => {
    const edits: Untold[] = [
      { page: "index", mid: "m31", tag: "span", change: { kind: "text", text: "Prefix" } },
      { page: "index", mid: "m24", tag: "section", change: { kind: "duplicated", copy: "m41" } },
      { page: "index", mid: "m31", tag: "span", change: { kind: "text", text: "Prefix for new\nbranches" } },
      { page: "git-a", mid: "m31", tag: "p", change: { kind: "deleted" } },
      { page: "index", mid: "m31", tag: "span", change: { kind: "wrapped", box: "m42" } },
      { page: "index", mid: "m12", tag: "nav", change: { kind: "deleted" }, undone: true },
    ];
    expect(editsMessage(edits, "Two more variants of the Git section")).toBe(
      [
        "Edits by hand since your last turn:",
        "index.html m31 span: text “Prefix for new branches”, wrapped in div m42",
        "index.html m24 section: duplicated as m41",
        "git-a.html m31 p: deleted",
        "index.html m12 nav: undid deleted",
        "",
        "Two more variants of the Git section",
      ].join("\n"),
    );
    expect(editsMessage([], "Two more variants")).toBe("Two more variants");
  });

  it("say a restyle as the properties set, and the restyles of one element as one change, each property at its latest", () => {
    expect(editLine({ page: "index", ...applyEdit(PAGE, { kind: "restyle", mid: "m24", set: { padding: "var(--space-4)", width: null } }).change })).toBe("index.html m24 section: restyled with padding: var(--space-4); no width");
    const m24 = (set: Record<string, string | null>, undone?: boolean): Untold => ({ page: "index", mid: "m24", tag: "section", change: { kind: "restyled", set }, ...(undone ? { undone } : {}) });
    const edits: Untold[] = [m24({ padding: "14px 24px" }), { page: "index", mid: "m24", tag: "section", change: { kind: "wrapped", box: "m41" } }, m24({ gap: "8px", padding: "var(--space-4)" }), m24({ width: "320px" }, true)];
    expect(editsMessage(edits, "Tighter")).toBe(
      ["Edits by hand since your last turn:", "index.html m24 section: restyled with padding: var(--space-4); gap: 8px, wrapped in div m41, undid restyled with width: 320px", "", "Tighter"].join("\n"),
    );
    expect(editsChip(edits)).toBe("3 edits by hand · go with your next message");
  });

  it("say a restyle or a text after an undone change after it, not merged into the one before it", () => {
    const m24 = (change: Untold["change"], undone?: boolean): Untold => ({ page: "index", mid: "m24", tag: "section", change, ...(undone ? { undone } : {}) });
    const edits: Untold[] = [
      m24({ kind: "restyled", set: { gap: "2px" } }),
      m24({ kind: "text", text: "Git" }),
      m24({ kind: "restyled", set: { padding: "4px" } }, true),
      m24({ kind: "restyled", set: { padding: "8px" } }),
      m24({ kind: "text", text: "Git and branches" }),
      m24({ kind: "restyled", set: { gap: "4px" } }),
    ];
    expect(editLines(edits)).toEqual(["index.html m24 section: restyled with gap: 2px, text “Git”, undid restyled with padding: 4px, restyled with padding: 8px; gap: 4px, text “Git and branches”"]);
    expect(editsChip(edits)).toBe("5 edits by hand · go with your next message");
  });

  it("are read back from a message as its lines and the user's text, and any other message has none", () => {
    const sent = "Edits by hand since your last turn:\nindex.html m31 span: text “Prefix, for new branches”, wrapped in div m42\ngit-a.html m31 p: deleted\n\nTwo more variants\n\nof the Git section";
    expect(readEditsMessage(sent)).toEqual({
      edits: [
        { page: "index", mid: "m31", tag: "span", said: "text “Prefix, for new branches”, wrapped in div m42" },
        { page: "git-a", mid: "m31", tag: "p", said: "deleted" },
      ],
      text: "Two more variants\n\nof the Git section",
    });
    expect(readEditsMessage(sent)?.edits.map(lineRead)).toEqual(["index.html m31 span: text “Prefix, for new branches”, wrapped in div m42", "git-a.html m31 p: deleted"]);
    expect(readEditsMessage("Edits by hand since your last turn:\nindex.html m31 span: deleted")).toEqual({ edits: [{ page: "index", mid: "m31", tag: "span", said: "deleted" }], text: "" });
    // A page name may have a space, as the daemon takes it.
    expect(readEditsMessage("Edits by hand since your last turn:\ngit rows.html m31 p: deleted")?.edits).toEqual([{ page: "git rows", mid: "m31", tag: "p", said: "deleted" }]);
    expect(readEditsMessage("Edits by hand since your last turn:\n.git.html m31 p: deleted")).toBeNull();
    expect(readEditsMessage("Two more variants of the Git section")).toBeNull();
    expect(readEditsMessage("Edits by hand since your last turn:\nnot an edit\n\nHi")).toBeNull();
  });

  it("are counted on the chip one per change, a text only as its latest, so a wrap and a text change of one element are 2", () => {
    const m31 = (change: Untold["change"]): Untold => ({ page: "index", mid: "m31", tag: "span", change });
    expect(editsChip([m31({ kind: "text", text: "Prefix" }), m31({ kind: "wrapped", box: "m42" }), m31({ kind: "text", text: "Prefix for new branches" })])).toBe("2 edits by hand · go with your next message");
  });

  it("are counted on the chip one each across elements, and none shows no chip", () => {
    const text = (mid: string, t: string): Untold => ({ page: "index", mid, tag: "span", change: { kind: "text", text: t } });
    expect(editsChip([text("m31", "Prefix"), text("m31", "Prefix for new branches"), { page: "index", mid: "m24", tag: "section", change: { kind: "deleted" } }, text("m25", "Git")])).toBe(
      "3 edits by hand · go with your next message",
    );
    expect(editsChip([text("m31", "Prefix")])).toBe("1 edit by hand · go with your next message");
    expect(editsChip([])).toBeNull();
  });
});

describe("edits by hand, as a snapshot sums them up (X65)", () => {
  it("say what each did to which element, an undone one as undone: moved section m24, restyled h2 m25, text of m30", () => {
    const e = (mid: string, tag: string, change: Untold["change"], undone = false): Untold => ({ page: "index", mid, tag, change, ...(undone ? { undone } : {}) });
    expect(
      [
        e("m24", "section", { kind: "moved", place: { where: "above", ref: "m22" } }),
        e("m25", "h2", { kind: "restyled", set: { "font-size": "var(--text-lg)" } }),
        e("m30", "p", { kind: "text", text: "Prefix for new branches" }),
        e("m30", "p", { kind: "deleted" }),
        e("m25", "h2", { kind: "duplicated", copy: "m41" }),
        e("m25", "h2", { kind: "wrapped", box: "m42" }),
        e("m42", "div", { kind: "unwrapped" }),
        e("m43", "button", { kind: "inserted", place: null }),
        e("m24", "section", { kind: "moved", place: { where: "above", ref: "m22" } }, true),
      ].map(editSaid),
    ).toEqual(["moved section m24", "restyled h2 m25", "text of m30", "deleted p m30", "duplicated h2 m25", "wrapped h2 m25", "unwrapped div m42", "inserted button m43", "undid moved section m24"]);
  });
});
