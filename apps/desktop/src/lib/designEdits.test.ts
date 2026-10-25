import { describe, expect, it } from "vitest";
import { EditRefused, applyEdit, copyElement, editLine, editsChip, editsMessage, readEditsMessage, type EditOp, type Untold } from "./designEdits";

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

  it("wraps an element in a box, a div with the next free id, which it selects", () => {
    const wrapped = applyEdit(PAGE, { kind: "wrap", mid: "m25" });
    expect(wrapped.html).toBe(withLines(19, 1, '      <div data-mid="m41"><h2 data-mid="m25">Git</h2></div>'));
    expect(wrapped.select).toBe("m41");
    expect(() => applyEdit(PAGE, { kind: "wrap", mid: "m1" })).toThrow(new EditRefused("The page's body stays"));
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
    expect(readEditsMessage("Edits by hand since your last turn:\nindex.html m31 span: deleted")).toEqual({ edits: [{ page: "index", mid: "m31", tag: "span", said: "deleted" }], text: "" });
    expect(readEditsMessage("Two more variants of the Git section")).toBeNull();
    expect(readEditsMessage("Edits by hand since your last turn:\nnot an edit\n\nHi")).toBeNull();
  });

  it("are counted on the chip by the lines the next message will have, and none shows no chip", () => {
    const text = (mid: string, t: string): Untold => ({ page: "index", mid, tag: "span", change: { kind: "text", text: t } });
    expect(editsChip([text("m31", "Prefix"), text("m31", "Prefix for new branches"), { page: "index", mid: "m24", tag: "section", change: { kind: "deleted" } }, text("m25", "Git")])).toBe(
      "3 edits by hand · go with your next message",
    );
    expect(editsChip([text("m31", "Prefix")])).toBe("1 edit by hand · go with your next message");
    expect(editsChip([])).toBeNull();
  });
});
