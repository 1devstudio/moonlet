import { beforeEach, describe, expect, it, vi } from "vitest";
import { askWithEdits, copyElementOf, dismissUnsaved, editPage, pasteInto, sendCommentsWithEdits, sendWithEdits, redoEdit, undoEdit, loadPageSource, pendingOf, resetEditor, settleChecks, settleSaves, sourceOf, undoOf, unsavedOf, useEditor } from "./designEditor";
import { loadDesigns, pageRevOf, startDesign, useDesign } from "./designStore";
import { editLines } from "./designEdits";

const calls = vi.hoisted(() => [] as { method: string; params: Record<string, unknown> }[]);
/** What the daemon answers, by method. */
const answers = vi.hoisted(() => ({}) as Record<string, (params: Record<string, unknown>) => unknown>);
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: () => Promise.resolve(true), requestPermission: () => Promise.resolve("granted"), sendNotification: () => {} }));
const { DaemonError } = vi.hoisted(() => ({
  DaemonError: class extends Error {
    code: string;
    constructor(e: { code: string; message: string }) {
      super(e.message);
      this.code = e.code;
    }
  },
}));
const events = vi.hoisted(() => ({ emit: (_e: { host: string; name: string; data: unknown }) => {} }));
vi.mock("./daemon", () => ({
  DaemonError,
  rpc: vi.fn((_host: string, method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    const answer = answers[method];
    return answer ? Promise.resolve().then(() => answer(params)) : Promise.reject(new DaemonError({ code: "unknown", message: `no ${method}` }));
  }),
  onDaemonEvent: (cb: (e: { host: string; name: string; data: unknown }) => void) => ((events.emit = cb), Promise.resolve(() => {})),
  onHostStatus: () => Promise.resolve(() => {}),
}));

const WS = "w-1devstudio";
const SLUG = "settings-page";
const PAGE = '<!doctype html>\n<body data-mid="m1">\n  <h2 data-mid="m25">Git</h2>\n  <p data-mid="m30">Branch prefix</p>\n</body>\n';

/** The disk: each page's text, its version a count of its saves. */
let disk: Record<string, { html: string; version: string }> = {};
const writes = () => calls.filter((c) => c.method === "design.write_page").map((c) => [c.params.html, c.params.base_version]);

beforeEach(() => {
  calls.length = 0;
  resetEditor();
  disk = { index: { html: PAGE, version: "v1" } };
  answers["design.page"] = (p) => disk[p.page as string];
  answers["design.write_page"] = (p) => {
    const page = disk[p.page as string];
    if (page.version !== p.base_version) throw new DaemonError({ code: "stale", message: "pages/index.html changed since it was read" });
    disk[p.page as string] = { html: p.html as string, version: `v${Number(page.version.slice(1)) + 1}` };
    return { version: disk[p.page as string].version };
  };
});

describe("an edit by hand saved (X65)", () => {
  it("is written as the page's new source over the version it was read at, and the next over the version that save gave, one save at a time", async () => {
    await loadPageSource("local", WS, SLUG, "index");
    editPage("local", WS, SLUG, "index", { kind: "delete", mid: "m30" }, "m30");
    editPage("local", WS, SLUG, "index", { kind: "text", mid: "m25", text: "Git & GitHub" }, "m25");
    editPage("local", WS, SLUG, "index", { kind: "wrap", mid: "m25" }, "m25");
    await settleSaves();
    expect(writes()).toEqual([
      ['<!doctype html>\n<body data-mid="m1">\n  <h2 data-mid="m25">Git</h2>\n</body>\n', "v1"],
      ['<!doctype html>\n<body data-mid="m1">\n  <div data-mid="m31"><h2 data-mid="m25">Git &amp; GitHub</h2></div>\n</body>\n', "v2"],
    ]);
    expect(disk.index.html).toBe('<!doctype html>\n<body data-mid="m1">\n  <div data-mid="m31"><h2 data-mid="m25">Git &amp; GitHub</h2></div>\n</body>\n');
  });

  it("is refused when the page changed on disk since it was read: the page loads again, the edit is undone and untold, and the yellow bar names it", async () => {
    await loadPageSource("local", WS, SLUG, "index");
    editPage("local", WS, SLUG, "index", { kind: "text", mid: "m25", text: "Git and GitHub" }, "m25");
    await settleSaves();
    const agents = '<!doctype html>\n<body data-mid="m1">\n  <h2 data-mid="m25">Git, by the agent</h2>\n  <p data-mid="m30">Branch prefix</p>\n</body>\n';
    disk.index = { html: agents, version: "v9" };
    editPage("local", WS, SLUG, "index", { kind: "delete", mid: "m30" }, "m30");
    await settleSaves();
    const st = useEditor.getState();
    expect(unsavedOf(st, "local", WS, SLUG)).toBe("index.html m30 p: deleted");
    expect(sourceOf(st, "local", WS, SLUG, "index")).toEqual({ html: agents, version: "v9" });
    expect(disk.index.html).toBe(agents);
    // Only the edit saved before goes with the next message, and nothing of the page is left to undo.
    expect(editLines(pendingOf(st, "local", WS, SLUG))).toEqual(["index.html m25 h2: text “Git and GitHub”"]);
    expect(undoOf(st, "local", WS, SLUG).done).toEqual([]);
    expect(pageRevOf(useDesign.getState(), "local", WS, SLUG, "index")).toBe(1);
    dismissUnsaved("local", WS, SLUG);
    expect(unsavedOf(useEditor.getState(), "local", WS, SLUG)).toBeNull();
  });
});

describe("a page the editor saved, changed on disk (X65)", () => {
  const changed = (paths: string[]) => events.emit({ host: "local", name: "design.changed", data: { workspace: WS, system: null, design: SLUG, paths } });
  const rev = () => pageRevOf(useDesign.getState(), "local", WS, SLUG, "index");

  it("does not load again for its own save, so the canvas does not flicker, and loads again with the other writer's page", async () => {
    answers["design.list"] = () => [{ slug: SLUG, name: "Settings page", kind: "workspace", system: "moonlet-desktop", path: "", brief: "", viewport: "1440x900", pages: [{ name: "index", label: null }], updated_at: 0, open_comments: 0, agent: null, agent_state: null, needs_you: null, error: null }];
    answers["design.check"] = () => [];
    await startDesign();
    await loadDesigns("local", WS);
    await loadPageSource("local", WS, SLUG, "index");
    const before = rev();
    editPage("local", WS, SLUG, "index", { kind: "delete", mid: "m30" }, "m30");
    await settleSaves();
    changed(["pages/index.html"]);
    await settleChecks();
    expect(rev()).toBe(before);
    const agents = '<!doctype html>\n<body data-mid="m1"><h2 data-mid="m25">Rows</h2></body>\n';
    disk.index = { html: agents, version: "v9" };
    changed(["pages/index.html"]);
    await settleChecks();
    expect(rev()).toBe(before + 1);
    expect(sourceOf(useEditor.getState(), "local", WS, SLUG, "index")).toEqual({ html: agents, version: "v9" });
    // Its earlier change is not undone over the other writer's page.
    expect(undoOf(useEditor.getState(), "local", WS, SLUG).done).toEqual([]);
  });
});

describe("undo and redo on a design (X65)", () => {
  it("save the page as it was before the change, or after it, load it again on the canvas, and select the element as it was", async () => {
    await loadPageSource("local", WS, SLUG, "index");
    const rev = () => pageRevOf(useDesign.getState(), "local", WS, SLUG, "index");
    const before = rev();
    editPage("local", WS, SLUG, "index", { kind: "delete", mid: "m30" }, "m30");
    await settleSaves();
    expect(await undoEdit("local", WS, SLUG)).toEqual({ page: "index", select: "m30" });
    expect(disk.index.html).toBe(PAGE);
    expect(rev()).toBe(before + 1);
    expect(pendingOf(useEditor.getState(), "local", WS, SLUG)).toEqual([]);
    expect(await redoEdit("local", WS, SLUG)).toEqual({ page: "index", select: "m25" });
    expect(disk.index.html).toBe('<!doctype html>\n<body data-mid="m1">\n  <h2 data-mid="m25">Git</h2>\n</body>\n');
    expect(rev()).toBe(before + 2);
    expect(editLines(pendingOf(useEditor.getState(), "local", WS, SLUG))).toEqual(["index.html m30 p: deleted"]);
    expect(await redoEdit("local", WS, SLUG)).toBeNull();
  });
});

describe("copy and paste (X65)", () => {
  it("copies an element of one page and pastes it into another page of the same design, with fresh ids; another design has nothing to paste", async () => {
    disk["git-a"] = { html: '<!doctype html>\n<body data-mid="m1">\n  <section data-mid="m3"><h3 data-mid="m4">Rows</h3></section>\n</body>\n', version: "v1" };
    await loadPageSource("local", WS, SLUG, "index");
    await loadPageSource("local", WS, SLUG, "git-a");
    await loadPageSource("local", WS, "onboarding", "index");
    expect(copyElementOf("local", WS, SLUG, "git-a", "m3")).toBe(true);
    const pasted = pasteInto("local", WS, SLUG, "index", "m25");
    expect(pasted?.select).toBe("m31");
    await settleSaves();
    expect(disk.index.html).toBe('<!doctype html>\n<body data-mid="m1">\n  <h2 data-mid="m25">Git</h2>\n  <section data-mid="m31"><h3 data-mid="m32">Rows</h3></section>\n  <p data-mid="m30">Branch prefix</p>\n</body>\n');
    expect(pasteInto("local", WS, "onboarding", "index", null)).toBeNull();
  });
});

describe("edits by hand told to the agent (X65)", () => {
  it("go before the user's next message to the design's agent, and not with the one after", async () => {
    answers["chat.send"] = () => true;
    await loadPageSource("local", WS, SLUG, "index");
    editPage("local", WS, SLUG, "index", { kind: "delete", mid: "m30" }, "m30");
    editPage("local", WS, SLUG, "index", { kind: "text", mid: "m25", text: "Git and GitHub" }, "m25");
    await sendWithEdits("local", WS, SLUG, 12, "Two more variants of the Git section", []);
    await sendWithEdits("local", WS, SLUG, 12, "Thanks", []);
    expect(calls.filter((c) => c.method === "chat.send").map((c) => c.params)).toEqual([
      { id: 12, text: "Edits by hand since your last turn:\nindex.html m30 p: deleted\nindex.html m25 h2: text “Git and GitHub”\n\nTwo more variants of the Git section", images: [] },
      { id: 12, text: "Thanks", images: [] },
    ]);
    expect(pendingOf(useEditor.getState(), "local", WS, SLUG)).toEqual([]);
  });
});

describe("edits by hand before the app's own messages to the agent (X65)", () => {
  it("go before a message of comments that Send sends, which keeps its comment lines after them", async () => {
    answers["chat.send"] = () => true;
    answers["design.comment.put"] = () => [];
    await loadPageSource("local", WS, SLUG, "index");
    editPage("local", WS, SLUG, "index", { kind: "delete", mid: "m30" }, "m30");
    const nav = { n: 1, page: "index", mid: "m12", tag: "nav", text: "General", comment: "Collapse it", sent_at: null, state: "open" as const };
    await sendCommentsWithEdits("local", WS, SLUG, 12, [nav]);
    await askWithEdits("local", WS, SLUG, 12, "Fix the check problems of pages/index.html");
    expect(calls.filter((c) => c.method === "chat.send").map((c) => c.params.text)).toEqual([
      'Edits by hand since your last turn:\nindex.html m30 p: deleted\n\nComment on index.html [data-mid=m12] (nav "General"): Collapse it',
      "Fix the check problems of pages/index.html",
    ]);
  });
});

