// The render check and snapshots (X64): with the app running, the daemon's
// design.check with render and design.snap have the app load each card in its
// hidden render window, measure it there and snap it with WKWebView's
// takeSnapshot. The window is never shown.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { browser, expect } from "@wdio/globals";
import { projectId, rpc, world } from "../fixtures";

const w = world();
const workspaceId = () => rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
const SLUG = "render-kit";
const dir = () => join(w.home, "design", workspaceId(), "systems", SLUG);

const style =
  "<style>body{margin:0;padding:24px}.ds-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px;align-items:start}.ds-cell{border:1px solid rgb(127 127 127 / .3);border-radius:8px;padding:12px;overflow:hidden;transform:translateZ(0)}.ds-cell h4{margin:0 0 8px;font:600 12px system-ui;text-transform:uppercase;opacity:.7}</style>";
const head = `<!doctype html>\n<html><head><meta charset="utf-8"><link rel="stylesheet" href="../../../styles.css">\n${style}</head>\n`;
const cell = (id: string, label: string, mount: string) => `<section class="ds-cell" data-snippet="${id}"><h4>${label}</h4><div class="ds-mount">${mount}</div></section>`;
const FILES: [string, string][] = [
  ["styles.css", '@import "tokens/colors.css";\n@import "components.css";\n'],
  ["tokens/colors.css", ":root { --color-accent: #4f8de8; --color-fg: #1b1b1f; --color-bg: #ffffff; }\n"],
  [
    "components.css",
    ".btn { font: 600 14px/20px system-ui; padding: 6px 14px; border-radius: 6px; border: 0; background: var(--color-accent); color: var(--color-bg); }\n.btn--ghost { background: transparent; color: var(--color-fg); border: 1px solid var(--color-fg); }\n",
  ],
  [
    "components/buttons/button/button.html",
    `<!-- @dsCard group="Buttons" name="Button" source="README.md" viewport="720x200" -->\n${head}<body><div class="ds-grid">\n${cell("buttons/button/primary", "primary", '<button class="btn">Create PR</button>')}\n${cell("buttons/button/ghost", "ghost", '<button class="btn btn--ghost">Cancel</button>')}\n</div></body></html>\n`,
  ],
  // A mount the agent left empty: bad.
  ["components/forms/field/field.html", `<!-- @dsCard group="Forms" name="Field" source="README.md" -->\n${head}<body><div class="ds-grid">\n${cell("forms/field/default", "default", "")}\n</div></body></html>\n`],
  // A label that does not show, beside one that does: collapsed.
  [
    "components/forms/email/email.html",
    `<!-- @dsCard group="Forms" name="Email" source="README.md" -->\n${head}<body><div class="ds-grid">\n${cell("forms/email/default", "default", '<label>Email address</label> <span hidden>Required</span>')}\n</div></body></html>\n`,
  ],
  // A mount holding only a <style>: empty, whatever its CSS says.
  ["components/data/tag/tag.html", `<!-- @dsCard group="Data" name="Tag" source="README.md" -->\n${head}<body><div class="ds-grid">\n${cell("data/tag/default", "default", "<style>.tag { color: red; }</style>")}\n</div></body></html>\n`],
  // A menu shown outside every cell, as a portal mounts it: escape.
  [
    "components/menus/menu/menu.html",
    `<!-- @dsCard group="Menus" name="Menu" source="README.md" -->\n${head}<body><div class="ds-grid">\n${cell("menus/menu/open", "open", '<button class="btn">Actions</button>')}\n</div>\n<div style="position:absolute;top:150px;left:24px;padding:8px;border:1px solid #ccc">Rename</div></body></html>\n`,
  ],
];

/** Width and height of a PNG, from its IHDR chunk. */
const pngSize = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];

describe("Design card render check and snapshots", () => {
  before(() => {
    const ws = workspaceId();
    rpc(w, "design.system.create", { workspace: ws, name: "Render kit", sources: [{ project: projectId(w) }], agent: false });
    for (const [path, text] of FILES) {
      mkdirSync(dirname(join(dir(), path)), { recursive: true });
      writeFileSync(join(dir(), path), text);
    }
  });

  after(() => {
    rpc(w, "design.system.remove", { workspace: workspaceId(), slug: SLUG });
  });

  it("renders every card in the app and writes each card's flags to render-check.json", () => {
    const out = rpc<{ problems: unknown[]; render: object }>(w, "design.check", { workspace: workspaceId(), slug: SLUG, render: true });
    const report = JSON.parse(readFileSync(join(dir(), ".cache", "render-check.json"), "utf8")) as { cards: { path: string; flags: string[] }[] };
    expect(report.cards).toEqual([
      { path: "components/buttons/button/button.html", flags: [] },
      { path: "components/data/tag/tag.html", flags: ["rootEmpty", "allHollow", "thin", "bad"] },
      { path: "components/forms/email/email.html", flags: ["collapsed", "thin"] },
      { path: "components/forms/field/field.html", flags: ["rootEmpty", "allHollow", "thin", "bad"] },
      { path: "components/menus/menu/menu.html", flags: ["escape"] },
      // The Colours card moonlet writes from the tokens.
      { path: "foundations/colours/colours.html", flags: [] },
    ]);
    expect(out.render).toEqual({ total: 6, bad: 2, thin: 3, variants_identical: 0 });
  });

  it("snaps a card, and one of its variants, to a PNG at the card's viewport", () => {
    const ws = workspaceId();
    const card = "components/buttons/button/button.html";
    const whole = rpc<{ path: string; blank: boolean }>(w, "design.snap", { workspace: ws, slug: SLUG, path: card });
    expect(whole).toEqual({ path: join(dir(), ".cache", "screenshots", "components", "buttons", "button", "button-720x200.png"), blank: false });
    const png = readFileSync(whole.path);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(pngSize(png)).toEqual([720, 200]);
    const ghost = rpc<{ path: string; blank: boolean }>(w, "design.snap", { workspace: ws, slug: SLUG, path: card, variant: "ghost", viewport: [400, 160] });
    expect(ghost).toEqual({ path: join(dir(), ".cache", "screenshots", "components", "buttons", "button", "button--ghost-400x160.png"), blank: false });
    expect(pngSize(readFileSync(ghost.path))).toEqual([400, 160]);
  });

  it("renders in a window that is never shown", async () => {
    const windows = await browser.execute(async () => {
      const tauri = (window as unknown as { __TAURI__: { window: { getAllWindows(): Promise<{ label: string; isVisible(): Promise<boolean> }[]> } } }).__TAURI__;
      const all = await tauri.window.getAllWindows();
      return Promise.all(all.map(async (x) => [x.label, await x.isVisible()] as [string, boolean]));
    });
    expect(windows.sort()).toEqual([
      ["design-render", false],
      ["main", true],
    ]);
  });
});
