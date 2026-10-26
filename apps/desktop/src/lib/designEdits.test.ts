import { describe, expect, it } from "vitest";
import { EditRefused, applyEdit, copyElement, highestMid, editLine, editsChip, editsMessage, lineRead, readEditsMessage, type EditOp, type Untold } from "./designEdits";

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
    expect(applyEdit(PAGE, { kind: "duplicate", mid: "m31" }).live).toEqual({ op: "insert", after: "m31", html: '<span data-mid="m41">Branch prefix</span>' });
    expect(applyEdit(PAGE, { kind: "wrap", mid: "m25" }).live).toEqual({ op: "wrap", mid: "m25", box: "m41" });
    expect(applyEdit(PAGE, { kind: "unwrap", mid: "m30" }).live).toEqual({ op: "unwrap", mid: "m30" });
    expect(applyEdit(PAGE, { kind: "paste", after: null, html: '<p data-mid="m9">Note</p>' }).live).toEqual({ op: "insert", after: "m20", html: '<p data-mid="m41">Note</p>' });
    expect(applyEdit(PAGE, { kind: "text", mid: "m31", text: "Prefix" }).live).toBeNull();
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
