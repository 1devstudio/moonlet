import { describe, expect, it } from "vitest";
import { paletteGroups, parseSnippetId, snippetDrags, snippetsOf } from "./designPalette";
import type { DesignKitCard } from "./protocol";

/** Two cards as a sync agent writes them (X64): each variant a ds-cell
 *  whose ds-mount holds its snippet. */
const BUTTON: DesignKitCard = {
  path: "components/buttons/Button/Button.html",
  group: "Buttons",
  name: "Button",
  html: [
    '<!-- @dsCard group="Buttons" name="Button" source="src/ui.tsx" -->',
    "<!doctype html>",
    '<link rel="stylesheet" href="../../../styles.css">',
    '<div class="ds-grid">',
    '<section class="ds-cell" data-snippet="buttons/button/primary"><h4>primary</h4><div class="ds-mount">',
    '  <button class="btn btn--primary">Save changes</button>',
    "</div></section>",
    '<section class="ds-cell" data-snippet="buttons/button/ghost"><h4>ghost</h4><div class="ds-mount"><button class="btn btn--ghost">Cancel</button></div></section>',
    "</div>",
    "",
  ].join("\n"),
};
const SWITCH: DesignKitCard = {
  path: "components/forms/Switch/Switch.html",
  group: "Forms",
  name: "Switch",
  html: '<!-- @dsCard group="Forms" name="Switch" -->\n<section class="ds-cell" data-snippet="forms/switch/on"><h4>on</h4><div class="ds-mount"><span class="switch is-on" role="switch" aria-checked="true"></span> <label>Notify me</label></div></section>\n<section class="ds-cell" data-snippet="forms/switch/broken"><h4>no mount</h4></section>\n',
};

describe("the Palette's snippets (X65)", () => {
  it("are each variant's markup in its card, inside its ds-mount, by its data-snippet id", () => {
    expect(snippetsOf([BUTTON, SWITCH])).toEqual([
      { id: "buttons/button/primary", group: "Buttons", card: "Button", variant: "primary", html: '<button class="btn btn--primary">Save changes</button>' },
      { id: "buttons/button/ghost", group: "Buttons", card: "Button", variant: "ghost", html: '<button class="btn btn--ghost">Cancel</button>' },
      { id: "forms/switch/on", group: "Forms", card: "Switch", variant: "on", html: '<span class="switch is-on" role="switch" aria-checked="true"></span> <label>Notify me</label>' },
    ]);
  });

  it("have ids of a group, a name and a variant, and a cell whose id is not one has none", () => {
    expect(parseSnippetId("buttons/button/primary")).toEqual({ group: "buttons", name: "button", variant: "primary" });
    expect(parseSnippetId("buttons/primary")).toBeNull();
    expect(parseSnippetId("buttons//primary")).toBeNull();
    const loose: DesignKitCard = { ...SWITCH, html: '<section class="ds-cell" data-snippet="on"><h4>on</h4><div class="ds-mount"><span class="switch"></span></div></section>' };
    expect(snippetsOf([loose])).toEqual([]);
  });

  it("are listed by group, and search keeps those whose card, variant or group has the words", () => {
    const all = snippetsOf([BUTTON, SWITCH]);
    expect(paletteGroups(all, "").map((g) => [g.group, g.snippets.map((s) => s.id)])).toEqual([
      ["Buttons", ["buttons/button/primary", "buttons/button/ghost"]],
      ["Forms", ["forms/switch/on"]],
    ]);
    expect(paletteGroups(all, "  GHOST ").map((g) => [g.group, g.snippets.map((s) => s.id)])).toEqual([["Buttons", ["buttons/button/ghost"]]]);
    expect(paletteGroups(all, "forms on").map((g) => [g.group, g.snippets.map((s) => s.id)])).toEqual([["Forms", ["forms/switch/on"]]]);
    expect(paletteGroups(all, "tabs")).toEqual([]);
  });
});

describe("a snippet dragged from the Palette (X65)", () => {
  it("is the one dropped while it is dragged, and for 2 s after the drag ends, as the page's report of the drop comes later; then none, and once only", () => {
    const [button, ghost] = snippetsOf([BUTTON]);
    const drags = snippetDrags();
    expect(drags.take(0)).toBeNull();
    drags.start(button);
    expect(drags.take(500)).toEqual(button);
    expect(drags.take(500)).toBeNull();
    drags.start(ghost);
    drags.end(1_000);
    expect(drags.take(2_900)).toEqual(ghost);
    drags.start(button);
    drags.end(10_000);
    expect(drags.take(12_001)).toBeNull();
  });
});
