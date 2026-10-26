// Build it and the Designs index (X65 entry 12c): a workspace design's
// Build it opens the New session composer with the design attached, a
// line per page and one for the styles; × leaves a page out; Create makes
// a session whose worktree has the design, and the design's header says
// where it is building. The session's Design tab shows the design, and its
// Design and build each page beside its built screenshot. A session's
// agent that wrote a spec from the design is offered Implement it. The
// Designs index lists the workspace's designs as In sessions, Workspace
// designs and In projects, the last from a design committed on the
// project's base branch, and Use as a start copies it into a new
// workspace design.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { within } from "../design";
import { PROJECT, fill, rpc, sel, world } from "../fixtures";

const w = world();
const FAKE = join(w.root, "bin", "claude");
const SYSTEM = "build-kit";
const SLUG = "settings-page";
const SESSION = "implement-settings-page";
const workspaceId = () => rpc<{ id: string }[]>(w, "workspace.list", {})[0].id;
const designDir = () => join(w.home, "design", workspaceId(), "designs", SLUG);
const mode = (label: string) => $(`//div[@role="group"][@aria-label="Mode"]/button[starts-with(@aria-label, "${label}")]`);
const composer = '//div[@role="dialog"][@aria-label="New session"]';
const attachment = (label: string) => $(`${composer}//div[@role="group"][@aria-label="${label}"]`);
const tab = (name: string) => $(`//div[@role="tablist"]/button[@role="tab"][starts-with(normalize-space(), "${name}")]`);
const panel = () => $('//*[@id="right-tabpanel"]');
const group = (title: string) => $(`//section[@aria-label="Designs"]//section[@aria-label="${title}"]`);
const git = (...args: string[]) => execFileSync("git", args, { cwd: w.repo, env: w.env, stdio: "pipe" }).toString();
const page = (title: string) =>
  `<!doctype html>\n<html><head><meta charset="utf-8"><link rel="stylesheet" href="../../../systems/${SYSTEM}/styles.css"></head>\n<body data-mid="m1"><h1 data-mid="m2">${title}</h1></body></html>\n`;
// A 1×1 PNG, as a screenshot of a built screen.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// Every agent here: it logs each message it gets, and ends each turn with a
// short answer; a message asking for the spec makes it write one first.
// printf, because /bin/sh's echo expands the \n in the JSON.
const BUILD_CLAUDE = String.raw`#!/bin/sh
out() { printf '%s\n' "$1"; }
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"initialize"'*) out '{"type":"system","subtype":"init","session_id":"e2e-build","model":"e2e-model","permissionMode":"acceptEdits","slash_commands":[]}' ;;
    *'Write the spec from the design'*)
      printf '%s\n' "$line" >> "$0.log"
      mkdir -p docs/specs && printf '# X66 Settings page\n' > docs/specs/X66-settings-page.md
      out "{\"type\":\"assistant\",\"message\":{\"id\":\"w1\",\"content\":[{\"type\":\"tool_use\",\"id\":\"tw1\",\"name\":\"Write\",\"input\":{\"file_path\":\"$PWD/docs/specs/X66-settings-page.md\",\"content\":\"# X66\"}}]}}"
      out '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tw1","content":"File created"}]}}'
      out '{"type":"assistant","message":{"id":"w2","content":[{"type":"text","text":"Spec X66 is written."}]}}'
      out '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
    *'"type":"user"'*)
      printf '%s\n' "$line" >> "$0.log"
      out '{"type":"assistant","message":{"id":"a1","content":[{"type":"text","text":"Noted."}]}}'
      out '{"type":"result","subtype":"success","is_error":false,"usage":{}}' ;;
  esac
done
`;

describe("Build it and the Designs index", () => {
  let fake = "";
  let base = "";
  let session: { id: string; path: string } | null = null;
  const said = () => (existsSync(`${FAKE}.log`) ? readFileSync(`${FAKE}.log`, "utf8") : "");

  before(async () => {
    fake = readFileSync(FAKE, "utf8");
    writeFileSync(FAKE, BUILD_CLAUDE);
    chmodSync(FAKE, 0o755);
    const ws = workspaceId();
    const project = rpc<{ id: string; name: string }[]>(w, "project.list", {}).find((p) => p.name === PROJECT)!;
    rpc(w, "design.system.create", { workspace: ws, name: "Build kit", sources: [{ project: project.id }], agent: false });
    writeFileSync(join(w.home, "design", ws, "systems", SYSTEM, "styles.css"), "h1 { color: #d97757; }\n");
    rpc(w, "design.create", { workspace: ws, name: "Settings page", system: SYSTEM, brief: "A settings page" });
    for (const [name, title] of [["index", "Settings"], ["git-a", "Git as cards"], ["git-b", "Git, compact"]]) writeFileSync(join(designDir(), "pages", `${name}.html`), page(title));
    const toml = join(designDir(), "design.toml");
    writeFileSync(toml, `${readFileSync(toml, "utf8")}\n[pages.index]\nlabel = "rows"\n\n[pages.git-a]\nlabel = "cards"\n\n[pages.git-b]\nlabel = "compact"\n`);
    // A design merged into the project's base branch: a project design.
    base = git("rev-parse", "HEAD").trim();
    const merged = join(w.repo, "docs", "design", "checkout-flow");
    mkdirSync(join(merged, "pages"), { recursive: true });
    mkdirSync(join(merged, "system"), { recursive: true });
    writeFileSync(join(merged, "design.toml"), `name = "Checkout flow"\nsystem = "${SYSTEM}"\nbrief = "A shorter checkout"\n`);
    writeFileSync(join(merged, "pages", "index.html"), page("Checkout").replace(`../../../systems/${SYSTEM}/styles.css`, "../system/styles.css"));
    writeFileSync(join(merged, "system", "styles.css"), "h1 { color: #d97757; }\n");
    git("add", "docs/design");
    git("-c", "user.email=e2e@moonlet.test", "-c", "user.name=e2e", "commit", "-qm", "Checkout flow design");
    await mode("Design").click();
    await $(`//nav[@aria-label="Designs"]//button[.//span[normalize-space()="Settings page"]]`).click();
    await expect($('//section[@aria-label="Design · Settings page"]')).toBeDisplayed();
  });

  after(async () => {
    writeFileSync(FAKE, fake);
    if (await $(composer).isExisting()) {
      await $(`${composer}//textarea`).click();
      await browser.keys("Escape");
    }
    for (const s of rpc<{ id: string; name: string }[]>(w, "session.list", {})) if (s.name === SESSION) rpc(w, "session.archive", { id: s.id });
    const ws = workspaceId();
    for (const d of rpc<{ slug: string; kind: string }[]>(w, "design.list", { workspace: ws })) if (d.kind === "workspace") rpc(w, "design.remove", { workspace: ws, slug: d.slug });
    rpc(w, "design.system.remove", { workspace: ws, slug: SYSTEM });
    git("reset", "-q", "--hard", base);
    await within(5_000, (async () => {
      if (await mode("Sessions").isExisting()) await mode("Sessions").click();
    })());
  });

  it("opens the New session composer from Build it, with the design's pages and styles attached, and × leaves a page out", async () => {
    await $(sel.button("Build it")).click();
    await expect($(composer)).toBeDisplayed();
    await expect($(`${composer}//div[@role="group"][@aria-label="Project and task"]`)).toHaveText(expect.stringContaining(PROJECT));
    await expect($(`${composer}//*[@role="group"][@aria-label="Design · Settings page"]`)).toBeDisplayed();
    await expect($(`${composer}//div[@role="group"][@aria-label="Branch"]`)).toHaveText(expect.stringContaining("moonlet/implement-settings-page"));
    await expect($(`${composer}//textarea`)).toHaveValue("Implement the Settings page design");
    await expect(attachment("index.html Settings page, rows")).toBeDisplayed();
    await expect(attachment("git-a.html Settings page, cards")).toBeDisplayed();
    await expect(attachment("git-b.html Settings page, compact")).toBeDisplayed();
    await expect(attachment("styles.css Build kit styles")).toBeDisplayed();
    // The styles cannot be left out.
    await expect(attachment("styles.css Build kit styles").$('.//button[starts-with(@title, "Leave")]')).not.toBeExisting();
    await expect($(sel.text("The project is the design system's first source. The design keeps a link to the session it starts."))).toBeDisplayed();
    // Unfolded, a page shows its line and the page, framed on a host of its own.
    await attachment("index.html Settings page, rows").$('.//button[@aria-expanded="false"]').click();
    await expect(attachment("index.html Settings page, rows")).toHaveText(expect.stringContaining("docs/design/settings-page/pages/index.html · Settings page, rows"));
    const thumb = attachment("index.html Settings page, rows").$('.//iframe[@title="index.html preview"]');
    await expect(thumb).toBeExisting();
    expect(await thumb.getAttribute("src")).toMatch(new RegExp(`^moonlet-design://[0-9a-f]{16}\\.${workspaceId()}/designs/${SLUG}/pages/index\\.html$`));
    await attachment("git-a.html Settings page, cards").$('.//button[@title="Leave git-a.html out of the copy and the message"]').click();
    await expect(attachment("git-a.html Settings page, cards")).not.toBeExisting();
  });

  it("makes a session whose worktree has the design's pages kept, sends their lines first, and the design's header says Building in", async () => {
    await $(`${composer}//button[starts-with(normalize-space(), "Create")]`).click();
    await expect($(composer)).not.toBeExisting({ wait: 30_000 });
    await browser.waitUntil(() => !!rpc<{ id: string; name: string; path: string }[]>(w, "session.list", {}).find((s) => s.name === SESSION), { timeoutMsg: "no session was made" });
    session = rpc<{ id: string; name: string; path: string }[]>(w, "session.list", {}).find((s) => s.name === SESSION)!;
    const copy = join(session.path, "docs", "design", SLUG);
    expect(readFileSync(join(copy, "pages", "index.html"), "utf8")).toContain('href="../system/styles.css"');
    expect(existsSync(join(copy, "pages", "git-b.html"))).toBe(true);
    expect(existsSync(join(copy, "pages", "git-a.html"))).toBe(false);
    expect(existsSync(join(copy, "system", "styles.css"))).toBe(true);
    // The first message: a line per page kept, then the styles', then the prompt, a blank line apart (as JSON).
    const first = [
      "docs/design/settings-page/pages/index.html · Settings page, rows",
      "docs/design/settings-page/pages/git-b.html · Settings page, compact",
      "docs/design/settings-page/system/styles.css · Build kit styles",
      "Implement the Settings page design",
    ].join("\\n\\n");
    await browser.waitUntil(() => said().includes(`"text":"${first}"`), { timeoutMsg: `the session's agent never got the design's lines:\n${said()}` });
    await expect($(`//section[@aria-label="Design · Settings page"]//button[starts-with(normalize-space(), "Building in")]`)).toHaveText(`Building in ${PROJECT} · ${SESSION}`, { wait: 20_000 });
  });

  it("opens the session from Building in, its Design tab showing the design under its worktree path", async () => {
    await $(`//section[@aria-label="Design · Settings page"]//button[starts-with(normalize-space(), "Building in")]`).click();
    await expect(tab("Design")).toHaveAttribute("aria-selected", "true", { wait: 20_000 });
    const frame = panel().$('.//iframe[@title="index.html"]');
    await expect(frame).toBeExisting();
    expect(await frame.getAttribute("src")).toMatch(new RegExp(`^moonlet-design://[0-9a-f]{16}\\.s-${session!.id}/${SLUG}/pages/index\\.html`));
    await expect(panel().$(`.//*[normalize-space()="docs/design/${SLUG}/pages/index.html"]`)).toBeDisplayed();
  });

  it("shows each page beside its built screenshot in Design and build, or Not built yet", async () => {
    const built = join(session!.path, ".moonlet", "design", SLUG, "built");
    mkdirSync(built, { recursive: true });
    writeFileSync(join(built, "index.png"), PNG);
    await panel().$(sel.button("Design and build").replace(/^\/\//, ".//")).click();
    const view = panel().$('.//section[@aria-label="Design and build"]');
    await expect(view).toHaveText(expect.stringContaining("Design and build"));
    const index = view.$('.//article[@aria-label="index design and build"]');
    await expect(index.$('.//iframe[@title="index built"]')).toBeExisting({ wait: 20_000 });
    expect(await index.$('.//iframe[@title="index built"]').getAttribute("src")).toMatch(new RegExp(`^moonlet-design://[0-9a-f]{16}\\.s-${session!.id}/${SLUG}%40built/index\\.png`));
    await expect(index).toHaveText(expect.stringContaining(`.moonlet/design/${SLUG}/built/index.png`));
    await expect(view.$('.//article[@aria-label="git-b design and build"]')).toHaveText(expect.stringContaining("Not built yet"));
    await panel().$(sel.button("Canvas").replace(/^\/\//, ".//")).click();
    await expect(panel().$('.//iframe[@title="index.html"]')).toBeExisting();
  });

  it("offers Implement it and Back to the design once the session's agent wrote the spec from the design", async () => {
    const input = '//main//section[@aria-label="Chat input"]//textarea';
    await expect($(input)).toBeDisplayed({ wait: 20_000 });
    await fill(input, "Write the spec from the design");
    await browser.execute(() => document.querySelector<HTMLButtonElement>('main button[title="Send (↵)"]')?.click());
    const replies = $('//main//div[@role="group"][@aria-label="Suggested replies"]');
    await expect(replies).toBeDisplayed({ wait: 20_000 });
    await tab("Files").click();
    await replies.$(sel.button("Back to the design").replace(/^\/\//, ".//")).click();
    await expect(tab("Design")).toHaveAttribute("aria-selected", "true");
    await replies.$(sel.button("Implement it").replace(/^\/\//, ".//")).click();
    await browser.waitUntil(() => said().includes("Implement the spec docs/specs/X66-settings-page.md"), { timeoutMsg: "the session's agent was never asked to implement the spec" });
    await expect(replies).not.toBeExisting();
  });

  it("lists the workspace's designs in the Designs index as In sessions, Workspace designs and In projects", async () => {
    await mode("Design").click();
    await $('//button[normalize-space()="Designs"]').click();
    await expect(group("In sessions")).toHaveText(expect.stringContaining("Their pages live in the session's branch; open the session to change them"));
    const inSession = group("In sessions").$('.//article[@aria-label="Settings page"]');
    await expect(inSession).toHaveText(expect.stringContaining(`${PROJECT} · ${SESSION} · docs/design/${SLUG}`));
    await expect(inSession.$(".//button[normalize-space()=\"Open session\"]")).toBeDisplayed();
    expect(await inSession.$(".//iframe").getAttribute("src")).toMatch(new RegExp(`\\.s-${session!.id}/${SLUG}/pages/index\\.html$`));
    await expect(group("Workspace designs")).toHaveText(expect.stringContaining("Their own agent, no branch"));
    const own = group("Workspace designs").$('.//article[@aria-label="Settings page"]');
    await expect(own).toHaveText(expect.stringContaining(`Build kit · built in ${SESSION}`));
    await expect(own.$('.//button[normalize-space()="Open"]')).toBeDisplayed();
    await expect(group("In projects")).toHaveText(expect.stringContaining("Merged to main: found under docs/design/. Read only; reuse them as a start"));
    const merged = group("In projects").$('.//article[@aria-label="Checkout flow"]');
    await expect(merged).toHaveText(expect.stringContaining(`${PROJECT} · docs/design/checkout-flow`));
    await expect(merged).toHaveText(expect.stringContaining("No preview: its pages are read from the base branch, not checked out"));
  });

  it("makes a workspace design from a project design with Use as a start, and opens it", async () => {
    await group("In projects").$('.//article[@aria-label="Checkout flow"]//button[normalize-space()="Use as a start"]').click();
    await expect($('//section[@aria-label="Design · Checkout flow"]')).toBeDisplayed({ wait: 20_000 });
    const made = rpc<{ slug: string; kind: string; pages: { name: string }[] }[]>(w, "design.list", { workspace: workspaceId() }).find((d) => d.kind === "workspace" && d.slug === "checkout-flow");
    expect(made?.pages.map((p) => p.name)).toEqual(["index"]);
    await expect($('//nav[@aria-label="Designs"]//button[.//span[normalize-space()="Checkout flow"]]')).toHaveAttribute("aria-current", "page");
  });

  it("says in the composer why Create is refused when the base branch has the design's folder already", async () => {
    // The copy keeps the project design's slug, whose folder the base branch has.
    await $('//section[@aria-label="Design · Checkout flow"]').$(sel.button("Build it").replace(/^\/\//, ".//")).click();
    await expect($(composer)).toBeDisplayed();
    await $(`${composer}//button[starts-with(normalize-space(), "Create")]`).click();
    await expect($(`${composer}//*[@role="alert"]`)).toHaveText("docs/design/checkout-flow is in the worktree already: rename the design before building it", { wait: 30_000 });
    expect(rpc<{ name: string }[]>(w, "session.list", {}).some((s) => s.name === "implement-checkout-flow")).toBe(false);
  });
});
