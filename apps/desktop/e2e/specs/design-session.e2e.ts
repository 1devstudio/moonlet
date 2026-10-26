// A session's Design tab (X65 entry 12b): a session design, made in the
// session's worktree with design.create {session}, shows in the session's
// right panel with the design screen's canvas, toolbar and rail; its
// comments and edits by hand go to the session's own chat; Changes groups
// the files as Design, Spec and Code; a design system synced since the
// design pinned it shows the Update bar; History previews and restores the
// session design's snapshots; and the chat's slash menu lists
// /moonlet-design's three forms.
//
// WebDriver cannot reach inside the page, a sandboxed frame on another host
// in its own web process (design-comments.e2e.ts): pins are made with
// design.comment.put before the tab opens, so the page's first report after
// it loads places them, and the selection is made from Layers, the tree the
// page reported at load. A hidden window's frames are suspended about 2 s
// after they load, so nothing here waits on the frame after that.

import { chmodSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { diskShows, within } from "../design";
import { PROJECT, fill, rpc, sel, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const SESSION = "Settings page session";
const SYSTEM = "session-kit";
const SLUG = "settings-page";
// The session chat's input; its placeholder is shorter while the Design tab
// makes the chat narrow.
const EDITOR = '//main//section[@aria-label="Chat input"]//textarea';
const workspaceId = () => rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
const systemDir = () => join(w.home, "design", workspaceId(), "systems", SYSTEM);
const PAGE = [
  "<!doctype html>",
  '<html><head><meta charset="utf-8"><link rel="stylesheet" href="../system/styles.css"></head>',
  '<body data-mid="m1" style="margin:0">',
  '<nav data-mid="m12" style="display:block;height:300px;background:#333;color:#fff">General Appearance</nav>',
  '<section data-mid="m24"><h2 data-mid="m25">Git</h2>',
  '  <p data-mid="m30">Branch prefix</p>',
  "</section>",
  "</body></html>",
  "",
].join("\n");
const tab = (name: string) => $(`//div[@role="tablist"]/button[@role="tab"][starts-with(normalize-space(), "${name}")]`);
const panel = () => $('//*[@id="right-tabpanel"]');
const rail = () => panel().$('.//aside[@aria-label="Right rail"]');
const layer = (name: string) => rail().$(`.//button[@role="treeitem"][@aria-label="${name}"]`);
const canvasMode = (label: string) => panel().$(`.//div[@role="group"][@aria-label="Canvas mode"]/button[starts-with(normalize-space(), "${label}")]`);
const bar = (tone: string) => panel().$(`.//div[@role="status"][@data-tone="${tone}"]`);
/** The newest snapshot in History whose row says `text`. */
const snapshot = (text: string) => rail().$(`.//article[starts-with(@aria-label, "Snapshot ")][contains(normalize-space(), "${text}")]`);
/** The session's chat, beside the right panel. */
const chat = () => $("//main");
const card = (n: number) => chat().$(`.//*[@data-comment-pin="${n}"]`);

// The session's agent: it lists /moonlet-design among its commands, logs
// every message it gets, and ends each turn with a short answer. printf,
// because /bin/sh's echo expands the \n in the JSON.
const SESSION_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"control_response","response":{"subtype":"success","request_id":"init-1","response":{"commands":[{"name":"compact","description":"Compact the conversation","argumentHint":""},{"name":"moonlet-design","description":"Prototype a UI","argumentHint":""}],"agents":[]}}}' ;;
    *'"type":"user"'*)
      printf '%s\n' "$line" >> "$0.log"
      out '{"type":"assistant","message":{"id":"a1","content":[{"type":"text","text":"Noted."}]}}'
      out '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
  esac
done
`;

describe("A session's Design tab", () => {
  let fake = "";
  let sessionId = "";
  let worktree = "";
  let folder = "";
  const page = () => join(folder, "pages", "index.html");
  const onDisk = () => readFileSync(page(), "utf8");
  const said = () => {
    try {
      return readFileSync(`${FAKE}.log`, "utf8");
    } catch {
      return "";
    }
  };

  before(async () => {
    fake = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, SESSION_CLAUDE);
    chmodSync(FAKE, 0o755);
    const ws = workspaceId();
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    rpc(w, "design.system.create", { workspace: ws, name: "Session kit", sources: [{ project: project.id }], agent: false });
    writeFileSync(join(systemDir(), "styles.css"), "h2 { color: #d97757; }\n");
    const session = rpc<{ id: string; path: string }>(w, "session.create", { project_id: project.id, name: SESSION, agent: "claude" });
    sessionId = session.id;
    worktree = session.path;
    const design = rpc<{ path: string }>(w, "design.create", { workspace: ws, name: "Settings page", system: SYSTEM, brief: "A settings page", session: sessionId });
    folder = design.path;
    writeFileSync(page(), PAGE);
    // Placed by the page's first report once the tab frames it.
    rpc(w, "design.comment.put", { session: sessionId, slug: SLUG, new: { page: "index", mid: "m12", tag: "nav", text: "General Appearance", comment: "Collapse it" } });
    await $(sel.sessionRow(SESSION)).click();
    // Tabs switch on mousedown, which the embedded driver's click does not send.
    await browser.execute(() => {
      const t = document.evaluate('//span[normalize-space()="claude"]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      t?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await expect($(EDITOR)).toBeDisplayed({ wait: 30_000 });
  });

  after(async () => {
    writeFileSync(FAKE, fake);
    await within(5_000, (async () => {
      if (await tab("Files").isExisting()) await tab("Files").click();
    })());
    rpc(w, "session.archive", { id: sessionId });
    await expect($(sel.sessionRow(SESSION))).not.toBeExisting();
    rpc(w, "design.system.remove", { workspace: workspaceId(), slug: SYSTEM });
  });

  it("shows the pen icon on the session's row, and the Design tab with the page in the canvas under its worktree path", async () => {
    await expect($(`${sel.sessionRow(SESSION)}//span[@aria-label="Design: Settings page"]`)).toBeExisting();
    await expect(tab("Design")).toHaveText(expect.stringContaining("1"));
    await tab("Design").click();
    const frame = panel().$('.//iframe[@title="index.html"]');
    await expect(frame).toBeExisting();
    expect(await frame.getAttribute("src")).toMatch(new RegExp(`^moonlet-design://[0-9a-f]{16}\\.s-${sessionId}/${SLUG}/pages/index\\.html\\?(v=\\d+&)?moonlet-bridge=1$`));
    await expect(panel().$(`.//*[normalize-space()="docs/design/${SLUG}/pages/index.html"]`)).toBeDisplayed();
    // The page loaded through the session's host: its bridge placed the pin.
    await expect(panel().$('.//button[@aria-label="Comment 1"]')).toBeDisplayed();
  });

  it("sends a comment from the canvas to the session's chat as a Comment from the Design view card", async () => {
    await panel().$('.//button[@aria-label="Comment 1"]').click();
    const box = panel().$('.//div[@role="dialog"][@aria-label="Comment"]');
    await expect(box).toHaveText(expect.stringContaining('nav · m12 · "General Appe…"'));
    await fill('//*[@id="right-tabpanel"]//div[@role="dialog"][@aria-label="Comment"]//textarea', "Collapse into a menu on phone");
    await box.$('.//button[normalize-space()="Send"]').click();
    await expect(card(1)).toBeDisplayed();
    await expect(card(1)).toHaveText(expect.stringContaining("Comment from the Design view"));
    await expect(card(1)).toHaveText(expect.stringContaining('Comment on index.html [data-mid=m12] (nav "General Appearance"): Collapse into a menu on phone'));
    await browser.waitUntil(() => said().includes("Collapse into a menu on phone"), { timeoutMsg: "the session's agent never got the comment" });
  });

  it("edits the page by hand in Edit mode, and the next message in the session's chat starts with the edit", async () => {
    await canvasMode("Edit").click();
    await expect(rail().$('.//button[@role="tab"][@aria-selected="true"]')).toHaveText("Layers");
    await layer("p m30").click();
    await expect(layer("p m30")).toHaveAttribute("aria-current", "true");
    // Delete, pressed once the user is in the tab, where its keys work: the
    // embedded driver's click sends no pointerdown, so it is sent here.
    await browser.execute(() => {
      const row = document.querySelector('#right-tabpanel aside button[role="treeitem"][aria-label="p m30"]');
      row?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    });
    await diskShows(onDisk, (html) => !html.includes("m30"), "lost m30");
    await expect(panel().$('.//*[@aria-label="Edits by hand"]')).toHaveText("1 edit by hand · go with your next message");
    await fill(EDITOR, "Tighter rows, please");
    await browser.execute(() => document.querySelector<HTMLButtonElement>('main button[title="Send (↵)"]')?.click());
    const block = chat().$('.//*[@aria-label="Edits by hand since your last turn"]');
    await expect(block).toBeDisplayed();
    await expect(block).toHaveText(expect.stringContaining("index.html m30 p: deleted"));
    await browser.waitUntil(() => said().includes("index.html m30 p: deleted"), { timeoutMsg: "the session's agent never got the edit" });
    await expect(panel().$('.//*[@aria-label="Edits by hand"]')).not.toBeExisting();
  });

  it("lists the session design's snapshots in History, previews one read only, and restores it", async () => {
    // The edits by hand were kept on their own before the message reached the agent.
    await panel().$('.//button[@aria-label="History"]').click();
    await expect(snapshot("Edits by hand")).toBeDisplayed();
    const n = ((await snapshot("Edits by hand").getAttribute("aria-label")) ?? "").replace("Snapshot ", "");
    await snapshot("Edits by hand").$(".//button").click();
    await expect(bar("blue")).toBeDisplayed();
    const frame = panel().$(`.//iframe[@title="index.html at snapshot ${n}"]`);
    await expect(frame).toBeExisting();
    expect(await frame.getAttribute("src")).toMatch(new RegExp(`^moonlet-design://[0-9a-f]{16}s[0-9a-f]{16}\\.s-${sessionId}/${SLUG}%40${n}/pages/index\\.html$`));
    await bar("blue").$('.//button[normalize-space()="Restore"]').click();
    await expect(bar("blue")).not.toBeExisting();
    await expect(snapshot(`Restored snapshot ${n}`)).toBeDisplayed();
  });

  it("opens the session's Design tab on design.open of its design", async () => {
    await tab("Files").click();
    rpc(w, "design.open", { session: sessionId, slug: SLUG });
    await expect(tab("Design")).toHaveAttribute("aria-selected", "true");
  });

  it("groups the changed files in Changes as Design, Spec and Code, saying comments and snapshots are not committed", async () => {
    mkdirSync(join(worktree, "docs", "specs"), { recursive: true });
    writeFileSync(join(worktree, "docs", "specs", "X66-settings-page.md"), "# X66 Settings page\n");
    writeFileSync(join(worktree, "settings.ts"), "export const settings = {};\n");
    await tab("Changes").click();
    const group = (name: string) => panel().$(`.//section[@aria-label="${name}"]`);
    await expect(group("Design")).toHaveText(expect.stringContaining("index.html"), { wait: 20_000 });
    await expect(group("Spec")).toHaveText(expect.stringContaining("X66-settings-page.md"), { wait: 20_000 });
    await expect(group("Code")).toHaveText(expect.stringContaining("settings.ts"), { wait: 20_000 });
    await expect(panel()).toHaveText(expect.stringContaining("Comments and snapshots stay in .moonlet/ and are not committed."));
  });

  it("shows Design system updated once the design system syncs, and Update tells the session's agent the cards that changed", async () => {
    await tab("Design").click();
    writeFileSync(join(systemDir(), "_ds_sync.json"), '{"synced_at": 1}\n');
    await expect(bar("grey")).toHaveText(expect.stringContaining("Design system updated."), { wait: 20_000 });
    await bar("grey").$('.//button[normalize-space()="Update"]').click();
    await expect(bar("grey")).not.toBeExisting();
    await expect(chat()).toHaveText(expect.stringContaining("The design system Session kit was updated for the design settings-page"));
    await browser.waitUntil(() => said().includes("The design system Session kit was updated"), { timeoutMsg: "the session's agent never heard of the update" });
  });

  it("lists /moonlet-design, /moonlet-design new and /moonlet-design sync in the chat's slash menu, with the design system it will use", async () => {
    await fill(EDITOR, "/moon");
    const row = (text: string) => $(`//button[span[normalize-space()="${text}"]]`);
    await expect(row("/moonlet-design")).toHaveText(expect.stringContaining("Prototype it here, in this session's Design view"));
    await expect(row("/moonlet-design new")).toHaveText(expect.stringContaining("A separate design in Design mode, with its own agent"));
    await expect(row("/moonlet-design sync")).toHaveText(expect.stringContaining("Sync the design system built from this project"));
    await expect($(sel.text("Uses Session kit, the design system built from this project"))).toBeDisplayed();
    await fill(EDITOR, "");
  });
});
