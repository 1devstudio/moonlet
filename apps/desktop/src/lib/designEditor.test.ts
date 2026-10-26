import { beforeEach, describe, expect, it, vi } from "vitest";
import { askWithEdits, kitOf, loadKit, closeDesign, copyElementOf, hasCopy, dismissUnsaved, editPage, pasteInto, sendCommentsWithEdits, sendWithEdits, redoEdit, undoEdit, loadPageSource, pendingOf, resetEditor, startEditor, settleChecks, settleSaves, sourceOf, undoOf, unsavedOf, useEditor } from "./designEditor";
import { loadDesigns, pageRevOf, startDesign, useDesign } from "./designStore";
import { editLines } from "./designEdits";
import { useStore } from "./store";

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

describe("an edit by hand made while a refused save reads the page again (X65)", () => {
  it("is taken back with the edit the save lost, and the yellow bar names it, as the latest", async () => {
    await loadPageSource("local", WS, SLUG, "index");
    const agents = '<!doctype html>\n<body data-mid="m1">\n  <h2 data-mid="m25">Git, by the agent</h2>\n  <p data-mid="m30">Branch prefix</p>\n</body>\n';
    disk.index = { html: agents, version: "v9" };
    const answer = answers["design.page"];
    let reread = (_: unknown) => {};
    answers["design.page"] = () => new Promise((r) => (reread = r));
    editPage("local", WS, SLUG, "index", { kind: "delete", mid: "m30" }, "m30");
    await new Promise((r) => setTimeout(r, 0));
    // The save was refused; the page is being read again.
    expect(calls.map((c) => c.method).at(-1)).toBe("design.page");
    answers["design.page"] = answer;
    editPage("local", WS, SLUG, "index", { kind: "text", mid: "m25", text: "Git and GitHub" }, "m25");
    reread(disk.index);
    await settleSaves();
    const st = useEditor.getState();
    expect(disk.index.html).toBe(agents);
    expect(sourceOf(st, "local", WS, SLUG, "index")).toEqual({ html: agents, version: "v9" });
    expect(pendingOf(st, "local", WS, SLUG)).toEqual([]);
    expect(undoOf(st, "local", WS, SLUG).done).toEqual([]);
    expect(unsavedOf(st, "local", WS, SLUG)).toBe("index.html m25 h2: text “Git and GitHub”");
  });
});

describe("an edit by hand redone (X65)", () => {
  it("is taken back when its save is refused, whatever was saved of another page meanwhile, and the yellow bar names it", async () => {
    disk["git-a"] = { html: '<!doctype html>\n<body data-mid="m1">\n  <section data-mid="m3"><h3 data-mid="m4">Rows</h3></section>\n</body>\n', version: "v1" };
    await loadPageSource("local", WS, SLUG, "index");
    await loadPageSource("local", WS, SLUG, "git-a");
    editPage("local", WS, SLUG, "index", { kind: "delete", mid: "m30" }, "m30");
    await settleSaves();
    editPage("local", WS, SLUG, "git-a", { kind: "delete", mid: "m4" }, "m4");
    await settleSaves();
    await undoEdit("local", WS, SLUG);
    await undoEdit("local", WS, SLUG);
    expect(disk.index.html).toBe(PAGE);
    const agents = '<!doctype html>\n<body data-mid="m1">\n  <h2 data-mid="m25">Git, by the agent</h2>\n  <p data-mid="m30">Branch prefix</p>\n</body>\n';
    disk.index = { html: agents, version: "v9" };
    await redoEdit("local", WS, SLUG);
    const st = useEditor.getState();
    expect(disk.index.html).toBe(agents);
    expect(sourceOf(st, "local", WS, SLUG, "index")).toEqual({ html: agents, version: "v9" });
    expect(editLines(pendingOf(st, "local", WS, SLUG))).toEqual([]);
    expect(unsavedOf(st, "local", WS, SLUG)).toBe("index.html m30 p: deleted");
  });
});

describe("a page's source while a save is on its way (X65)", () => {
  it("is not read over the save, which has edits the text read may not have, so the next edit keeps them", async () => {
    await loadPageSource("local", WS, SLUG, "index");
    let release = () => {};
    const write = answers["design.write_page"];
    // The first save waits; the next goes at once.
    answers["design.write_page"] = (p) =>
      new Promise((r) => {
        answers["design.write_page"] = write;
        release = () => r(write(p));
      });
    editPage("local", WS, SLUG, "index", { kind: "delete", mid: "m30" }, "m30");
    await new Promise((r) => setTimeout(r, 0));
    // The canvas loads the page again meanwhile, still as it was on disk.
    await loadPageSource("local", WS, SLUG, "index");
    editPage("local", WS, SLUG, "index", { kind: "text", mid: "m25", text: "Git and GitHub" }, "m25");
    release();
    await settleSaves();
    expect(disk.index.html).toBe('<!doctype html>\n<body data-mid="m1">\n  <h2 data-mid="m25">Git and GitHub</h2>\n</body>\n');
  });

  it("shows a save that fails for another reason than a change on disk", async () => {
    await loadPageSource("local", WS, SLUG, "index");
    answers["design.write_page"] = () => {
      throw new DaemonError({ code: "failed", message: "disk full" });
    };
    editPage("local", WS, SLUG, "index", { kind: "delete", mid: "m30" }, "m30");
    await settleSaves();
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().toasts.map((t) => [t.kind, t.text])).toContainEqual(["error", "disk full"]);
  });
});

describe("a page the editor saved, changed on disk (X65)", () => {
  const changed = (paths: string[]) => events.emit({ host: "local", name: "design.changed", data: { workspace: WS, system: null, design: SLUG, paths } });
  const rev = () => pageRevOf(useDesign.getState(), "local", WS, SLUG, "index");

  it("does not load again for its own save, so the canvas does not flicker, and loads again with the other writer's page", async () => {
    answers["design.list"] = () => [{ slug: SLUG, name: "Settings page", kind: "workspace", system: "moonlet-desktop", path: "", brief: "", viewport: "1440x900", pages: [{ name: "index", label: null }], updated_at: 0, open_comments: 0, agent: null, agent_state: null, needs_you: null, error: null }];
    answers["design.check"] = () => [];
    await startDesign();
    startEditor();
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

  it("takes the latest of two checks of the page, whatever order their answers come back in", async () => {
    answers["design.list"] = () => [{ slug: SLUG, name: "Settings page", kind: "workspace", system: "moonlet-desktop", path: "", brief: "", viewport: "1440x900", pages: [{ name: "index", label: null }], updated_at: 0, open_comments: 0, agent: null, agent_state: null, needs_you: null, error: null }];
    answers["design.check"] = () => [];
    await startDesign();
    startEditor();
    await loadDesigns("local", WS);
    await loadPageSource("local", WS, SLUG, "index");
    const before = rev();
    const first = { html: '<!doctype html>\n<body data-mid="m1"><h2 data-mid="m25">Rows</h2></body>\n', version: "v5" };
    const second = { html: '<!doctype html>\n<body data-mid="m1"><h2 data-mid="m25">Rows and cards</h2></body>\n', version: "v6" };
    const answer = answers["design.page"];
    let late = (_: unknown) => {};
    answers["design.page"] = () => new Promise((r) => (late = r));
    changed(["pages/index.html"]);
    await new Promise((r) => setTimeout(r, 0));
    answers["design.page"] = answer;
    disk.index = second;
    changed(["pages/index.html"]);
    await new Promise((r) => setTimeout(r, 0));
    late(first);
    await settleChecks();
    expect(sourceOf(useEditor.getState(), "local", WS, SLUG, "index")).toEqual(second);
    expect(rev()).toBe(before + 1);
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
    expect(hasCopy("local", WS, SLUG)).toBe(false);
    expect(copyElementOf("local", WS, SLUG, "git-a", "m3")).toBe(true);
    expect([hasCopy("local", WS, SLUG), hasCopy("local", WS, "onboarding")]).toEqual([true, false]);
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

describe("edits by hand told to the agent, once saved (X65)", () => {
  it("wait for their pages' saves: one a save refused as stale is never told, and one whose save failed waits for a save that takes it", async () => {
    answers["chat.send"] = () => true;
    await loadPageSource("local", WS, SLUG, "index");
    editPage("local", WS, SLUG, "index", { kind: "delete", mid: "m30" }, "m30");
    await settleSaves();
    disk.index = { html: '<!doctype html>\n<body data-mid="m1">\n  <h2 data-mid="m25">Git, by the agent</h2>\n</body>\n', version: "v9" };
    editPage("local", WS, SLUG, "index", { kind: "text", mid: "m25", text: "Git and GitHub" }, "m25");
    await sendWithEdits("local", WS, SLUG, 12, "Thanks", []);
    disk.git = { html: '<!doctype html>\n<body data-mid="m1">\n  <p data-mid="m2">Rows</p>\n  <p data-mid="m3">Cards</p>\n</body>\n', version: "v1" };
    await loadPageSource("local", WS, SLUG, "git");
    const write = answers["design.write_page"];
    answers["design.write_page"] = () => {
      answers["design.write_page"] = write;
      throw new DaemonError({ code: "failed", message: "disk full" });
    };
    editPage("local", WS, SLUG, "git", { kind: "delete", mid: "m3" }, "m3");
    await sendWithEdits("local", WS, SLUG, 12, "And now?", []);
    editPage("local", WS, SLUG, "git", { kind: "text", mid: "m2", text: "Rows only" }, "m2");
    await sendWithEdits("local", WS, SLUG, 12, "Done", []);
    expect(calls.filter((c) => c.method === "chat.send").map((c) => c.params.text)).toEqual([
      "Edits by hand since your last turn:\nindex.html m30 p: deleted\n\nThanks",
      "And now?",
      "Edits by hand since your last turn:\ngit.html m3 p: deleted\ngit.html m2 p: text “Rows only”\n\nDone",
    ]);
    expect(disk.git.html).toBe('<!doctype html>\n<body data-mid="m1">\n  <p data-mid="m2">Rows only</p>\n</body>\n');
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

describe("a design's undo when it is closed (X65)", () => {
  it("forgets its changes, so the next time it opens there is nothing to undo or redo, and keeps the edits not told yet", async () => {
    await loadPageSource("local", WS, SLUG, "index");
    editPage("local", WS, SLUG, "index", { kind: "delete", mid: "m30" }, "m30");
    await settleSaves();
    closeDesign("local", WS, SLUG);
    expect(undoOf(useEditor.getState(), "local", WS, SLUG)).toEqual({ done: [], undone: [] });
    expect(await undoEdit("local", WS, SLUG)).toBeNull();
    expect(editLines(pendingOf(useEditor.getState(), "local", WS, SLUG))).toEqual(["index.html m30 p: deleted"]);
  });
});

describe("a page's source read before an edit (X65)", () => {
  it("is dropped when it comes back after the edit was saved, so the editor keeps the edit and the version its save gave", async () => {
    await loadPageSource("local", WS, SLUG, "index");
    const answer = answers["design.page"];
    let late = (_: unknown) => {};
    answers["design.page"] = () => new Promise((r) => (late = r));
    // The canvas loads the page again; the read is on its way.
    const read = loadPageSource("local", WS, SLUG, "index");
    await new Promise((r) => setTimeout(r, 0));
    answers["design.page"] = answer;
    editPage("local", WS, SLUG, "index", { kind: "delete", mid: "m30" }, "m30");
    await settleSaves();
    late({ html: PAGE, version: "v1" });
    await read;
    const deleted = '<!doctype html>\n<body data-mid="m1">\n  <h2 data-mid="m25">Git</h2>\n</body>\n';
    expect(sourceOf(useEditor.getState(), "local", WS, SLUG, "index")).toEqual({ html: deleted, version: "v2" });
    editPage("local", WS, SLUG, "index", { kind: "text", mid: "m25", text: "Git and GitHub" }, "m25");
    await settleSaves();
    expect(disk.index).toEqual({ html: '<!doctype html>\n<body data-mid="m1">\n  <h2 data-mid="m25">Git and GitHub</h2>\n</body>\n', version: "v3" });
    expect(unsavedOf(useEditor.getState(), "local", WS, SLUG)).toBeNull();
  });
});

describe("a page's source read twice (X65)", () => {
  it("is the latest read's, whatever order the answers come back in", async () => {
    const answer = answers["design.page"];
    let first = (_: unknown) => {};
    answers["design.page"] = () => new Promise((r) => (first = r));
    const slow = loadPageSource("local", WS, SLUG, "index");
    await new Promise((r) => setTimeout(r, 0));
    answers["design.page"] = answer;
    disk.index = { html: '<!doctype html>\n<body data-mid="m1"></body>\n', version: "v2" };
    await loadPageSource("local", WS, SLUG, "index");
    first({ html: PAGE, version: "v1" });
    await slow;
    expect(sourceOf(useEditor.getState(), "local", WS, SLUG, "index")?.version).toBe("v2");
  });
});


describe("a design's kit (X65)", () => {
  it("is read with design.kit for the design, the latest read's, whatever order the answers come back in", async () => {
    const kit = (value: string) => ({ system: "moonlet-desktop", tokens: [{ name: "--space-4", value, family: "spacing" }], cards: [] });
    let first = (_: unknown) => {};
    answers["design.kit"] = () => new Promise((r) => (first = r));
    const slow = loadKit("local", WS, SLUG);
    await new Promise((r) => setTimeout(r, 0));
    answers["design.kit"] = () => kit("18px");
    await loadKit("local", WS, SLUG);
    first(kit("16px"));
    await slow;
    expect(kitOf(useEditor.getState(), "local", WS, SLUG)?.tokens).toEqual([{ name: "--space-4", value: "18px", family: "spacing" }]);
    expect(calls.filter((c) => c.method === "design.kit").map((c) => c.params)).toEqual([
      { workspace: WS, slug: SLUG },
      { workspace: WS, slug: SLUG },
    ]);
  });
});

describe("a style, a move and a snippet edited by hand (X65)", () => {
  it("are saved as the page's new source, go with the next message, and undo as any edit", async () => {
    await loadPageSource("local", WS, SLUG, "index");
    editPage("local", WS, SLUG, "index", { kind: "restyle", mid: "m25", set: { padding: "var(--space-4)" } }, "m25");
    editPage("local", WS, SLUG, "index", { kind: "move", mid: "m30", place: { where: "above", ref: "m25" } }, "m30");
    editPage("local", WS, SLUG, "index", { kind: "insert", place: { where: "below", ref: "m30" }, html: '<button class="btn">Save</button>' }, "m30");
    await settleSaves();
    expect(disk.index.html).toBe('<!doctype html>\n<body data-mid="m1">\n  <p data-mid="m30">Branch prefix</p>\n  <button data-mid="m31" class="btn">Save</button>\n  <h2 data-mid="m25" style="padding: var(--space-4)">Git</h2>\n</body>\n');
    expect(editLines(pendingOf(useEditor.getState(), "local", WS, SLUG))).toEqual([
      "index.html m25 h2: restyled with padding: var(--space-4)",
      "index.html m30 p: moved above m25",
      "index.html m31 button: inserted after m30",
    ]);
    await undoEdit("local", WS, SLUG);
    await undoEdit("local", WS, SLUG);
    await undoEdit("local", WS, SLUG);
    await settleSaves();
    expect(disk.index.html).toBe(PAGE);
  });
});
