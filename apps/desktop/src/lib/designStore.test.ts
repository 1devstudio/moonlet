import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Design, DesignComment, DesignSystem, TerminalInfo } from "./protocol";
import { modeOf, setMode } from "./mode";
import { agentOnScreen, goToAgent, useStore } from "./store";
import { pageKey, pageOfKey, commentsOf, historyOf, keepComment, loadComments, loadHistory, sendComments, sendingOf, resolveComment, sessionDesignsOf, shownSessionDesign, showSessionDesign, updateSystem } from "./designStore";
import { cardsOf, checkDesign, createFromNewDesign, createSystem, designsOf, detectStack, latestOf, loadCards, loadDesigns, loadSystems, openCard, saveViewport, pageRevOf, problemsOf, revOf, shownCard, shownDesign, shownSystem, showDesign, showSystem, startDesign, systemNameOf, systemsOf, useDesign } from "./designStore";

const calls = vi.hoisted(() => [] as { host: string; method: string; params: unknown }[]);
/** What the daemon answers, by method. */
const answers = vi.hoisted(() => ({}) as Record<string, (params: unknown) => unknown>);
const events = vi.hoisted(() => ({ emit: (_e: { host: string; name: string; data: unknown }) => {} }));
const hostStatus = vi.hoisted(() => ({ emit: (_h: { id: string; status: string }) => {} }));
const shown = vi.hoisted(() => [] as { title: string; body: string }[]);
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(true),
  requestPermission: () => Promise.resolve("granted"),
  sendNotification: (n: { title: string; body: string }) => shown.push(n),
}));

vi.mock("./daemon", () => ({
  rpc: vi.fn((host: string, method: string, params: unknown) => {
    calls.push({ host, method, params });
    const answer = answers[method];
    return answer ? Promise.resolve().then(() => answer(params)) : Promise.reject(new Error(`no ${method}`));
  }),
  onDaemonEvent: (cb: (e: { host: string; name: string; data: unknown }) => void) => ((events.emit = cb), Promise.resolve(() => {})),
  onHostStatus: (cb: (h: { id: string; status: string }) => void) => ((hostStatus.emit = cb), Promise.resolve(() => {})),
}));

const system = (over: Partial<DesignSystem> = {}): DesignSystem => ({
  slug: "moonlet-desktop",
  name: "moonlet desktop",
  sources: ["/Users/alex/Workspace/moonlet"],
  synced_at: null,
  synced_commit: null,
  cards: 0,
  layouts: 0,
  changed_sources: [],
  check_problems: 0,
  to_settle: 0,
  step: null,
  step_summary: null,
  error: null,
  agent: 7,
  last_sync: [],
  needs_you: null,
  steps: [],
  sync_running: false,
  ...over,
});

const settle = () => new Promise((r) => setTimeout(r, 0));
const listed = () => calls.filter((c) => c.method === "design.systems");

beforeEach(async () => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  useDesign.setState({ systems: {}, shown: {}, cards: {}, opened: {}, changes: {}, designs: {}, sessionDesigns: {}, sessionShown: {}, designShown: {}, pageRevs: {}, latest: {}, problems: {}, systemNames: {}, comments: {}, mids: {}, sending: {}, histories: {} });
  await startDesign();
});

describe("a workspace's design systems (X64, X65)", () => {
  it("are listed from the daemon", async () => {
    answers["design.systems"] = () => [system()];
    await loadSystems("local", "w-1devstudio");
    expect(listed().map((c) => c.params)).toEqual([{ workspace: "w-1devstudio" }]);
    expect(systemsOf(useDesign.getState(), "local", "w-1devstudio")?.map((s) => s.name)).toEqual(["moonlet desktop"]);
    expect(systemsOf(useDesign.getState(), "local", "w-acme")).toBeUndefined();
  });

  it("are listed again when a file in that workspace's design folder changes", async () => {
    answers["design.systems"] = () => [system()];
    await loadSystems("local", "w-1devstudio");
    answers["design.systems"] = () => [system({ step: "tokens" })];
    events.emit({ host: "local", name: "design.changed", data: { workspace: "w-1devstudio", system: "moonlet-desktop", paths: [".cache/progress.toml"] } });
    await settle();
    expect(systemsOf(useDesign.getState(), "local", "w-1devstudio")?.[0].step).toBe("tokens");
    // Another workspace's change, or one never shown, is not asked for.
    events.emit({ host: "local", name: "design.changed", data: { workspace: "w-acme", system: null, paths: ["x"] } });
    await settle();
    expect(listed()).toHaveLength(2);
  });

  it("are listed again when a sync agent asks something, so its row says needs you", async () => {
    answers["design.systems"] = () => [system()];
    await loadSystems("local", "w-1devstudio");
    const ask = { id: "a1", tool: "AskUserQuestion", summary: "Which button set is current?", input: null, reason: null, can_always: false };
    answers["design.systems"] = () => [system({ needs_you: { kind: "question", text: "Which button set is current?" } })];
    events.emit({ host: "local", name: "chat.state", data: { id: 7, state: { pending: [ask], status: "waiting" } } });
    await settle();
    expect(systemsOf(useDesign.getState(), "local", "w-1devstudio")?.[0].needs_you).toEqual({ kind: "question", text: "Which button set is current?" });
    // The same ask again, or another chat's, changes nothing.
    events.emit({ host: "local", name: "chat.state", data: { id: 7, state: { pending: [ask], status: "waiting" } } });
    events.emit({ host: "local", name: "chat.state", data: { id: 9, state: { pending: [ask], status: "waiting" } } });
    await settle();
    expect(listed()).toHaveLength(2);
  });

  it("are asked for once while a listing is on its way", async () => {
    answers["design.systems"] = () => [system()];
    await Promise.all([loadSystems("local", "w-1devstudio"), loadSystems("local", "w-1devstudio")]);
    expect(listed()).toHaveLength(1);
  });

  it("are listed again when something changes while a listing is on its way, so the last answer is the latest", async () => {
    let release = (_list: DesignSystem[]) => {};
    answers["design.systems"] = () => new Promise<DesignSystem[]>((r) => (release = r));
    const first = loadSystems("local", "w-1devstudio");
    await settle();
    // The agent asks a question while the listing is on its way.
    answers["design.systems"] = () => [system({ needs_you: { kind: "question", text: "Which button set is current?" } })];
    events.emit({ host: "local", name: "design.changed", data: { workspace: "w-1devstudio", system: "moonlet-desktop", paths: [] } });
    release([system()]);
    await first;
    await settle();
    await settle();
    expect(listed().filter((c) => (c.params as { workspace: string }).workspace === "w-1devstudio")).toHaveLength(2);
    expect(systemsOf(useDesign.getState(), "local", "w-1devstudio")?.[0].needs_you?.kind).toBe("question");
  });

  it("are asked for again after a listing failed, when the host comes back or the folder changes", async () => {
    answers["design.systems"] = () => {
      throw new Error("host offline");
    };
    await expect(loadSystems("local", "w-acme")).rejects.toThrow("host offline");
    answers["design.systems"] = () => [system()];
    hostStatus.emit({ id: "local", status: "connected" });
    await settle();
    expect(systemsOf(useDesign.getState(), "local", "w-acme")?.map((s) => s.slug)).toEqual(["moonlet-desktop"]);
    useDesign.setState({ systems: {} });
    answers["design.systems"] = () => {
      throw new Error("host offline");
    };
    await expect(loadSystems("local", "w-acme")).rejects.toThrow("host offline");
    answers["design.systems"] = () => [system({ slug: "storefront" })];
    events.emit({ host: "local", name: "design.changed", data: { workspace: "w-acme", system: "storefront", paths: ["config.toml"] } });
    await settle();
    expect(systemsOf(useDesign.getState(), "local", "w-acme")?.map((s) => s.slug)).toEqual(["storefront"]);
  });

  it("are listed again when the host comes back", async () => {
    answers["design.systems"] = () => [system()];
    await loadSystems("local", "w-1devstudio");
    hostStatus.emit({ id: "local", status: "connected" });
    await settle();
    expect(listed().filter((c) => (c.params as { workspace: string }).workspace === "w-1devstudio")).toHaveLength(2);
  });
});

describe("a removed design system's name (X65)", () => {
  it("is kept from before it was removed, for the designs on it", async () => {
    answers["design.systems"] = () => [system({ slug: "screen-kit", name: "Screen kit" })];
    await loadSystems("local", "w-names");
    answers["design.systems"] = () => [];
    await loadSystems("local", "w-names", true);
    expect(systemsOf(useDesign.getState(), "local", "w-names")).toEqual([]);
    expect(systemNameOf(useDesign.getState(), "local", "w-names", "screen-kit")).toBe("Screen kit");
    expect(systemNameOf(useDesign.getState(), "local", "w-names", "never-listed")).toBeNull();
  });
});

describe("the open design system (X65)", () => {
  it("is the one picked, else the first, so the main area is never blank", async () => {
    answers["design.systems"] = () => [system(), system({ slug: "storefront", name: "storefront" })];
    expect(shownSystem(useDesign.getState(), "local", "w-1devstudio")).toBeNull();
    await loadSystems("local", "w-1devstudio");
    expect(shownSystem(useDesign.getState(), "local", "w-1devstudio")?.slug).toBe("moonlet-desktop");
    showSystem("local", "w-1devstudio", "storefront");
    expect(shownSystem(useDesign.getState(), "local", "w-1devstudio")?.slug).toBe("storefront");
    // The picked one was removed.
    answers["design.systems"] = () => [system()];
    await loadSystems("local", "w-1devstudio");
    expect(shownSystem(useDesign.getState(), "local", "w-1devstudio")?.slug).toBe("moonlet-desktop");
  });
});

describe("a design system's cards (X64)", () => {
  const button = { group: "Buttons", name: "Button", path: "components/buttons/button/button.html", viewport: [900, 700], source: ["src/ui.tsx"], snippets: [], marker: "", problems: [], changed_sources: [] };

  it("are listed from the daemon, and again when a file of that system changes", async () => {
    answers["design.cards"] = () => [button];
    await loadCards("local", "w-1devstudio", "moonlet-desktop");
    expect(calls.filter((c) => c.method === "design.cards").map((c) => c.params)).toEqual([{ workspace: "w-1devstudio", slug: "moonlet-desktop" }]);
    expect(cardsOf(useDesign.getState(), "local", "w-1devstudio", "moonlet-desktop")?.map((c) => c.name)).toEqual(["Button"]);
    answers["design.cards"] = () => [button, { ...button, name: "Icon button", path: "components/buttons/icon-button/icon-button.html" }];
    events.emit({ host: "local", name: "design.changed", data: { workspace: "w-1devstudio", system: "storefront", paths: ["config.toml"] } });
    await settle();
    expect(cardsOf(useDesign.getState(), "local", "w-1devstudio", "moonlet-desktop")).toHaveLength(1);
    events.emit({ host: "local", name: "design.changed", data: { workspace: "w-1devstudio", system: "moonlet-desktop", paths: ["components/buttons/icon-button/icon-button.html"] } });
    await settle();
    expect(cardsOf(useDesign.getState(), "local", "w-1devstudio", "moonlet-desktop")?.map((c) => c.name)).toEqual(["Button", "Icon button"]);
  });

  it("one opens as the card page of its own system only", () => {
    const path = "components/buttons/button/button.html";
    showSystem("local", "w-1devstudio", "moonlet-desktop");
    openCard("local", "w-1devstudio", "moonlet-desktop", path);
    expect(shownCard(useDesign.getState(), "local", "w-1devstudio", "moonlet-desktop")).toBe(path);
    // Another system shown, even one with a card at the same path, opens on its cards.
    expect(shownCard(useDesign.getState(), "local", "w-1devstudio", "storefront")).toBeNull();
    openCard("local", "w-1devstudio", "moonlet-desktop", null);
    expect(shownCard(useDesign.getState(), "local", "w-1devstudio", "moonlet-desktop")).toBeNull();
    openCard("local", "w-1devstudio", "moonlet-desktop", path);
    showSystem("local", "w-1devstudio", "storefront");
    showSystem("local", "w-1devstudio", "moonlet-desktop");
    expect(shownCard(useDesign.getState(), "local", "w-1devstudio", "moonlet-desktop")).toBeNull();
  });

  it("are listed again when the system changes while they are being listed, so the last answer is the latest", async () => {
    let release = (_list: unknown[]) => {};
    answers["design.cards"] = () => new Promise((r) => (release = r));
    const first = loadCards("local", "w-1devstudio", "moonlet-desktop");
    await settle();
    answers["design.cards"] = () => [button, { ...button, name: "Icon button" }];
    events.emit({ host: "local", name: "design.changed", data: { workspace: "w-1devstudio", system: "moonlet-desktop", paths: ["components/buttons/icon-button/icon-button.html"] } });
    await settle();
    release([button]);
    await first;
    await settle();
    expect(cardsOf(useDesign.getState(), "local", "w-1devstudio", "moonlet-desktop")?.map((c) => c.name)).toEqual(["Button", "Icon button"]);
  });

  it("are rendered again after a change in their system", () => {
    expect(revOf(useDesign.getState(), "local", "w-1devstudio", "moonlet-desktop")).toBe(0);
    events.emit({ host: "local", name: "design.changed", data: { workspace: "w-1devstudio", system: "moonlet-desktop", paths: ["components.css"] } });
    events.emit({ host: "local", name: "design.changed", data: { workspace: "w-1devstudio", system: "storefront", paths: ["components.css"] } });
    expect(revOf(useDesign.getState(), "local", "w-1devstudio", "moonlet-desktop")).toBe(1);
  });
});

describe("the sync agent's notifications (X64, X65)", () => {
  it("come when a listing shows it asking, also the first, or the sync recorded since the last", async () => {
    shown.length = 0;
    // The first listing tells a question still waiting, never a sync recorded before.
    answers["design.systems"] = () => [system({ synced_at: 3, needs_you: { kind: "question", text: "Still waiting?" } })];
    await loadSystems("local", "w-notes");
    await settle();
    expect(shown).toEqual([{ title: "Design · moonlet desktop", body: "asks: Still waiting?" }]);
    shown.length = 0;
    answers["design.systems"] = () => [system({ needs_you: { kind: "question", text: "Which button set is current?" } })];
    await loadSystems("local", "w-notes");
    await settle();
    answers["design.systems"] = () => [system({ synced_at: 5, to_settle: 1 })];
    await loadSystems("local", "w-notes");
    await settle();
    expect(shown).toEqual([
      { title: "Design · moonlet desktop", body: "asks: Which button set is current?" },
      { title: "Design · moonlet desktop", body: "moonlet desktop synced · 1 to settle" },
    ]);
  });
});

describe("the sync agent's notifications, as the settings say (X47, X65)", () => {
  it("follow the banner settings for a question and for a finished sync", async () => {
    shown.length = 0;
    useStore.setState((st) => ({ settings: { ...st.settings, banners: { blocked: false } } }));
    answers["design.systems"] = () => [system()];
    await loadSystems("local", "w-quiet");
    answers["design.systems"] = () => [system({ needs_you: { kind: "question", text: "Which?" } })];
    await loadSystems("local", "w-quiet");
    answers["design.systems"] = () => [system({ synced_at: 9 })];
    await loadSystems("local", "w-quiet");
    await settle();
    expect(shown).toEqual([{ title: "Design · moonlet desktop", body: "moonlet desktop synced" }]);
    useStore.setState((st) => ({ settings: { ...st.settings, banners: {} } }));
  });
});

describe("every workspace's design systems (X64, X65)", () => {
  it("are listed once a host is connected, so a sync started from a session notifies too", async () => {
    answers["design.systems"] = () => [];
    useStore.setState({
      hosts: { local: { id: "local", label: "This Mac", remote: false, status: "connected", message: null, daemon_version: null, hostname: null, home: null } },
      workspaces: { local: [{ id: "w-everyone", name: "Everyone", color: "clay", section_ids: [], created_at: 0 }] },
    });
    await settle();
    expect(listed().some((c) => (c.params as { workspace: string }).workspace === "w-everyone")).toBe(true);
  });
});

describe("the New design system dialog (X64)", () => {
  it("builds a system from the picked projects with what to cover, and lists it", async () => {
    answers["design.system.create"] = () => ({ slug: "moonlet-desktop", agent: 7, agent_error: null });
    answers["design.systems"] = () => [system()];
    const created = await createSystem("local", "w-1devstudio", { name: "moonlet desktop", projects: ["p-moonlet"], cover: "all" });
    expect(created).toEqual({ slug: "moonlet-desktop", agent: 7, agent_error: null });
    expect(calls.find((c) => c.method === "design.system.create")?.params).toEqual({ workspace: "w-1devstudio", name: "moonlet desktop", sources: [{ project: "p-moonlet" }], cover: "all" });
    expect(systemsOf(useDesign.getState(), "local", "w-1devstudio")?.map((s) => s.slug)).toEqual(["moonlet-desktop"]);
  });

  it("names each project's stack, or nothing when it cannot tell", async () => {
    answers["design.detect"] = (p) => ((p as { path: string }).path === "/r/web" ? ["React", "Tailwind"] : []);
    expect(await detectStack("local", "w-1devstudio", "/r/web")).toBe("React · Tailwind");
    expect(await detectStack("local", "w-1devstudio", "/r/notes")).toBe("");
    delete answers["design.detect"];
    expect(await detectStack("local", "w-1devstudio", "/r/api")).toBe("");
  });
});

const design = (over: Partial<Design> = {}): Design => ({
  slug: "settings-page",
  name: "Settings page",
  kind: "workspace",
  system: "moonlet-desktop",
  path: "/Users/alex/.moonlet/design/w-1devstudio/designs/settings-page",
  brief: "A left nav",
  viewport: "1440x900",
  pages: [
    { name: "index", label: null },
    { name: "git-a", label: "cards" },
  ],
  updated_at: 0,
  open_comments: 0,
  agent: 12,
  agent_state: "working",
  needs_you: null,
  error: null,
  ...over,
});
const designsListed = (ws: string) => calls.filter((c) => c.method === "design.list" && (c.params as { workspace: string }).workspace === ws);
const changed = (workspace: string, over: { system?: string | null; design?: string | null; paths: string[] }) =>
  events.emit({ host: "local", name: "design.changed", data: { workspace, system: null, design: null, ...over } });

describe("a design's pages on a change (X65)", () => {
  const revs = () => ["index", "git-a"].map((p) => pageRevOf(useDesign.getState(), "local", "w-1devstudio", "settings-page", p));

  it("load again when they, the design's assets or its design system's styles change, and the latest written page is known", async () => {
    answers["design.list"] = () => [design()];
    answers["design.check"] = () => [];
    await loadDesigns("local", "w-1devstudio");
    expect(revs()).toEqual([0, 0]);
    changed("w-1devstudio", { design: "settings-page", paths: ["pages/git-a.html"] });
    expect(revs()).toEqual([0, 1]);
    expect(latestOf(useDesign.getState(), "local", "w-1devstudio", "settings-page")).toEqual(["git-a"]);
    changed("w-1devstudio", { design: "settings-page", paths: ["assets/logo.svg"] });
    expect(revs()).toEqual([1, 2]);
    changed("w-1devstudio", { system: "moonlet-desktop", paths: ["styles.css"] });
    expect(revs()).toEqual([2, 3]);
    // design.toml alone, another design system's styles, or another workspace's change: none.
    changed("w-1devstudio", { design: "settings-page", paths: ["design.toml"] });
    changed("w-1devstudio", { system: "storefront", paths: ["styles.css"] });
    changed("w-acme", { design: "settings-page", paths: ["pages/index.html"] });
    expect(revs()).toEqual([2, 3]);
    expect(latestOf(useDesign.getState(), "local", "w-1devstudio", "settings-page")).toEqual(["git-a"]);
  });

  it("include a page not listed yet, which loads once it is", async () => {
    answers["design.list"] = () => [design({ pages: [] })];
    answers["design.check"] = () => [];
    await loadDesigns("local", "w-1devstudio");
    changed("w-1devstudio", { design: "settings-page", paths: ["pages/index.html"] });
    expect(pageRevOf(useDesign.getState(), "local", "w-1devstudio", "settings-page", "index")).toBe(1);
  });
});

describe("a design's snapshots (X65)", () => {
  const snapshot = (n: number) => ({ n, time: n * 1000, type: "agent_turn", summary: "Wrote index.html · 1 page", pages: ["index"] });
  const ns = () => historyOf(useDesign.getState(), "local", "w-1devstudio", "settings-page")?.map((s) => s.n);

  it("are listed from the daemon, and again as each is taken, which loads no page", async () => {
    answers["design.list"] = () => [design()];
    answers["design.check"] = () => [];
    await loadDesigns("local", "w-1devstudio");
    answers["design.history"] = () => [snapshot(1)];
    await loadHistory("local", "w-1devstudio", "settings-page");
    expect(calls.filter((c) => c.method === "design.history").map((c) => c.params)).toEqual([{ workspace: "w-1devstudio", slug: "settings-page" }]);
    expect(ns()).toEqual([1]);
    answers["design.history"] = () => [snapshot(2), snapshot(1)];
    changed("w-1devstudio", { design: "settings-page", paths: ["history/2/pages/index.html", "history/2/snapshot.json"] });
    await settle();
    await settle();
    expect(ns()).toEqual([2, 1]);
    expect(pageRevOf(useDesign.getState(), "local", "w-1devstudio", "settings-page", "index")).toBe(0);
  });
});

describe("a design's check (X65)", () => {
  const problems = () => problemsOf(useDesign.getState(), "local", "w-1devstudio", "settings-page");

  it("keeps no earlier problems once a check fails, so the bar never shows them as the page's", async () => {
    answers["design.check"] = () => [{ path: "pages/index.html", line: 4, kind: "missing_mid", message: "<p> has no data-mid" }];
    await checkDesign("local", "w-1devstudio", "settings-page");
    expect(problems()).toEqual([{ path: "pages/index.html", line: 4, kind: "missing_mid", message: "<p> has no data-mid" }]);
    answers["design.check"] = () => {
      throw new Error("cannot read pages/index.html");
    };
    await checkDesign("local", "w-1devstudio", "settings-page");
    expect(problems()).toEqual([]);
  });
});

describe("Create design in the New design dialog (X65)", () => {
  const brief = { name: "Settings page", system: "moonlet-desktop", brief: "A left nav" };
  const toasts = () => useStore.getState().toasts.map((t) => [t.text, t.action?.label ?? null]);
  beforeEach(() => {
    useStore.setState({ toasts: [], dialog: { kind: "new-design", host: "local", workspace: "w-1devstudio" } });
    answers["design.list"] = () => [design()];
    answers["design.check"] = () => [];
  });

  it("shows the design and closes the dialog while it is still open", async () => {
    answers["design.create"] = () => ({ ...design(), agent_error: null });
    await createFromNewDesign("local", "w-1devstudio", brief);
    expect(useStore.getState().dialog).toBeNull();
    expect(shownDesign(useDesign.getState(), "local", "w-1devstudio")?.slug).toBe("settings-page");
    expect(toasts()).toEqual([]);
  });

  it("leaves the view and another dialog opened meanwhile as they are, and offers the design in a toast", async () => {
    let made = (_: unknown) => {};
    answers["design.create"] = () => new Promise((r) => (made = r));
    const creating = createFromNewDesign("local", "w-1devstudio", brief);
    await settle();
    useStore.setState({ dialog: { kind: "new-design-system", host: "local", workspace: "w-1devstudio" } });
    made({ ...design(), agent_error: null });
    await creating;
    expect(useStore.getState().dialog).toEqual({ kind: "new-design-system", host: "local", workspace: "w-1devstudio" });
    expect(shownDesign(useDesign.getState(), "local", "w-1devstudio")).toBeNull();
    expect(toasts()).toEqual([["Settings page was made", "Open"]]);
  });
});

describe("a workspace's designs (X65)", () => {
  it("are listed again when a design's agent asks something, so its row and bar say so", async () => {
    answers["design.list"] = () => [design()];
    await loadDesigns("local", "w-1devstudio");
    const ask = { id: "a2", tool: "Bash", summary: "rm -rf assets", input: null, reason: null, can_always: false };
    answers["design.list"] = () => [design({ needs_you: { kind: "approval", text: "Bash: rm -rf assets" } })];
    events.emit({ host: "local", name: "chat.state", data: { id: 12, state: { pending: [ask], status: "waiting" } } });
    await settle();
    expect(designsOf(useDesign.getState(), "local", "w-1devstudio")?.[0].needs_you).toEqual({ kind: "approval", text: "Bash: rm -rf assets" });
  });

  it("are asked for again after a listing failed, when the host comes back", async () => {
    answers["design.list"] = () => {
      throw new Error("host offline");
    };
    await expect(loadDesigns("local", "w-designs-only")).rejects.toThrow("host offline");
    answers["design.list"] = () => [design()];
    hostStatus.emit({ id: "local", status: "connected" });
    await settle();
    expect(designsOf(useDesign.getState(), "local", "w-designs-only")?.map((d) => d.slug)).toEqual(["settings-page"]);
  });

  it("are listed once more when something changes while a listing is on its way, so the last answer is the latest", async () => {
    let release = (_list: Design[]) => {};
    answers["design.list"] = () => new Promise<Design[]>((r) => (release = r));
    const first = loadDesigns("local", "w-busy");
    await settle();
    answers["design.list"] = () => [design({ open_comments: 2 })];
    changed("w-busy", { design: "settings-page", paths: ["comments.json"] });
    release([design()]);
    await first;
    await settle();
    await settle();
    expect(designsListed("w-busy")).toHaveLength(2);
    expect(designsOf(useDesign.getState(), "local", "w-busy")?.[0].open_comments).toBe(2);
  });
});

describe("a design's agent outside the sessions (X65)", () => {
  const host = { id: "local", label: "This Mac", remote: false, status: "connected" as const, message: null, daemon_version: null, hostname: null, home: null };
  const tag = { kind: "design" as const, workspace: "w-1devstudio", slug: "settings-page", name: "Settings page" };
  const given = async () => {
    useStore.setState({
      hosts: { local: host },
      workspaces: { local: [{ id: "w-1devstudio", name: "1devstudio", color: "clay" as const, section_ids: [], created_at: 0 }] },
      workspace: { host: "local", id: "w-1devstudio" },
      mode: {},
      terminals: { local: { 12: { id: 12, kind: "agent", title: "Design · Settings page", design: tag, chat: true } as unknown as TerminalInfo } },
      unread: { "local:12": "done" },
    });
    answers["design.list"] = () => [design()];
    answers["design.check"] = () => [];
    await loadDesigns("local", "w-1devstudio");
  };

  it("opens its design on Go to", async () => {
    await given();
    goToAgent("local", 12);
    await settle();
    expect(modeOf(useStore.getState())).toBe("design");
    expect(shownDesign(useDesign.getState(), "local", "w-1devstudio")?.slug).toBe("settings-page");
  });

  it("is on screen while its design screen is shown, which marks it seen", async () => {
    await given();
    expect(agentOnScreen("local", 12)).toBe(false);
    setMode("design");
    showDesign("local", "w-1devstudio", "settings-page");
    expect(agentOnScreen("local", 12)).toBe(true);
    expect(useStore.getState().unread["local:12"]).toBeUndefined();
    showSystem("local", "w-1devstudio", "moonlet-desktop");
    expect(agentOnScreen("local", 12)).toBe(false);
  });
});

describe("a design's viewport picked in a row (X65)", () => {
  it("shows and keeps the latest pick, whatever order the saves come back in", async () => {
    answers["design.list"] = () => [design()];
    await loadDesigns("local", "w-picks");
    const pending: (() => void)[] = [];
    answers["design.viewport"] = () => new Promise<boolean>((r) => pending.push(() => r(true)));
    const first = saveViewport("local", "w-picks", "settings-page", "390x844");
    const second = saveViewport("local", "w-picks", "settings-page", "834x1112");
    await settle();
    const shown = () => designsOf(useDesign.getState(), "local", "w-picks")?.[0].viewport;
    expect(shown()).toBe("834x1112");
    // Each round, the later save comes back first, then the earlier one.
    for (let i = 0; i < 5; i++) {
      pending.splice(0).reverse().forEach((done) => done());
      await settle();
    }
    await Promise.all([first, second]);
    expect(shown()).toBe("834x1112");
    // The last size the daemon was asked to save is the latest pick.
    expect(calls.filter((c) => c.method === "design.viewport").at(-1)?.params).toEqual({ workspace: "w-picks", slug: "settings-page", viewport: "834x1112" });
  });

  it("stays the latest pick when its save fails", async () => {
    answers["design.list"] = () => [design()];
    await loadDesigns("local", "w-fails");
    answers["design.viewport"] = () => {
      throw new Error("host offline");
    };
    await expect(saveViewport("local", "w-fails", "settings-page", "390x844")).rejects.toThrow("host offline");
    expect(designsOf(useDesign.getState(), "local", "w-fails")?.[0].viewport).toBe("390x844");
  });
});

describe("a design's comments (X65)", () => {
  const pin = (n: number, over: Partial<DesignComment> = {}): DesignComment => ({
    n,
    page: "index",
    mid: "m12",
    tag: "nav",
    text: "General Appearance",
    comment: "Collapse into a menu on phone",
    sent_at: null,
    state: "open",
    ...over,
  });
  const ns = () => commentsOf(useDesign.getState(), "local", "w-1devstudio", "settings-page").map((p) => [p.n, p.state, p.sent_at]);

  it("are listed from the daemon, and again when the design's comments.json changes", async () => {
    answers["design.comments"] = () => [pin(1)];
    await loadComments("local", "w-1devstudio", "settings-page");
    expect(calls.filter((c) => c.method === "design.comments").map((c) => c.params)).toEqual([{ workspace: "w-1devstudio", slug: "settings-page" }]);
    expect(ns()).toEqual([[1, "open", null]]);
    answers["design.comments"] = () => [pin(1, { state: "resolved" })];
    changed("w-1devstudio", { design: "settings-page", paths: ["comments.json"] });
    await settle();
    await settle();
    expect(ns()).toEqual([[1, "resolved", null]]);
  });

  it("go to the design's agent as their lines in one message, and are then marked sent", async () => {
    const kept = pin(3, { mid: "m33", tag: "div", text: "Warn", comment: "More space" });
    answers["design.comment.put"] = (p) => ("sent" in (p as object) ? [pin(1, { sent_at: 9 }), { ...kept, sent_at: 9 }] : [kept]);
    answers["design.comments"] = () => [];
    answers["chat.send"] = () => true;
    const made = await keepComment("local", "w-1devstudio", "settings-page", { page: "index", mid: "m33", tag: "div", text: "Warn", comment: "More space" });
    expect(made.n).toBe(3);
    // Shown at once, before the change is announced.
    expect(ns()).toEqual([[3, "open", null]]);
    await sendComments("local", "w-1devstudio", "settings-page", 12, [pin(1), made]);
    const sent = calls.filter((c) => c.method === "chat.send" || c.method === "design.comment.put").map((c) => [c.method, c.params]);
    expect(sent).toEqual([
      ["design.comment.put", { workspace: "w-1devstudio", slug: "settings-page", new: { page: "index", mid: "m33", tag: "div", text: "Warn", comment: "More space" } }],
      ["chat.send", { id: 12, text: 'Comment on index.html [data-mid=m12] (nav "General Appearance"): Collapse into a menu on phone\nComment on index.html [data-mid=m33] (div "Warn"): More space', images: [] }],
      [
        "design.comment.put",
        {
          workspace: "w-1devstudio",
          slug: "settings-page",
          sent: {
            pins: [
              { n: 1, comment: "Collapse into a menu on phone" },
              { n: 3, comment: "More space" },
            ],
          },
        },
      ],
    ]);
    expect(ns()).toEqual([
      [1, "open", 9],
      [3, "open", 9],
    ]);
  });

  it("are sent once while a Send of them is on its way, by Send or Send all, and can be sent again once it is done", async () => {
    // Each message is delivered when the test says.
    const waiting: (() => void)[] = [];
    answers["chat.send"] = () => new Promise<boolean>((r) => waiting.push(() => r(true)));
    answers["design.comment.put"] = () => [];
    const git = pin(2, { mid: "m25", tag: "h2", text: "Git", comment: "Git first" });
    const sends = [sendComments("local", "w-1devstudio", "settings-page", 12, [pin(1)])];
    await settle();
    expect(sendingOf(useDesign.getState(), "local", "w-1devstudio", "settings-page")).toEqual([1]);
    // Send again, then Send all, while the first is on its way.
    sends.push(sendComments("local", "w-1devstudio", "settings-page", 12, [pin(1)]));
    sends.push(sendComments("local", "w-1devstudio", "settings-page", 12, [pin(1), git]));
    await settle();
    expect(sendingOf(useDesign.getState(), "local", "w-1devstudio", "settings-page")).toEqual([1, 2]);
    for (const deliver of waiting) deliver();
    await Promise.all(sends);
    expect(calls.filter((c) => c.method === "chat.send").map((c) => (c.params as { text: string }).text)).toEqual([
      'Comment on index.html [data-mid=m12] (nav "General Appearance"): Collapse into a menu on phone',
      'Comment on index.html [data-mid=m25] (h2 "Git"): Git first',
    ]);
    expect(sendingOf(useDesign.getState(), "local", "w-1devstudio", "settings-page")).toEqual([]);
    answers["chat.send"] = () => true;
    await sendComments("local", "w-1devstudio", "settings-page", 12, [pin(1)]);
    expect(calls.filter((c) => c.method === "chat.send")).toHaveLength(3);
  });

  it("stay not sent when the message cannot be sent", async () => {
    answers["chat.send"] = () => {
      throw new Error("the agent is gone");
    };
    await expect(sendComments("local", "w-1devstudio", "settings-page", 12, [pin(1)])).rejects.toThrow("the agent is gone");
    expect(calls.filter((c) => c.method === "design.comment.put")).toEqual([]);
  });

  it("keep a pin kept while an older listing was on its way, whatever order the answers come back in", async () => {
    const kept = pin(3, { mid: "m33", tag: "div", text: "Warn", comment: "More space" });
    // The first listing read the file before the Keep, and answers after it.
    let answerOld = (_: DesignComment[]) => {};
    let asked = 0;
    answers["design.comments"] = () => (++asked === 1 ? new Promise<DesignComment[]>((r) => (answerOld = r)) : [pin(1), kept]);
    answers["design.comment.put"] = () => [kept];
    const old = loadComments("local", "w-1devstudio", "settings-page");
    await settle();
    await keepComment("local", "w-1devstudio", "settings-page", { page: "index", mid: "m33", tag: "div", text: "Warn", comment: "More space" });
    answerOld([pin(1)]);
    await old;
    await settle();
    await settle();
    expect(ns()).toEqual([
      [1, "open", null],
      [3, "open", null],
    ]);
  });

  it("are resolved one at a time", async () => {
    answers["design.comments"] = () => [pin(1)];
    await loadComments("local", "w-1devstudio", "settings-page");
    answers["design.comment.resolve"] = () => pin(1, { state: "resolved" });
    await resolveComment("local", "w-1devstudio", "settings-page", 1);
    expect(calls.filter((c) => c.method === "design.comment.resolve").map((c) => c.params)).toEqual([{ workspace: "w-1devstudio", slug: "settings-page", n: 1 }]);
    expect(ns()).toEqual([[1, "resolved", null]]);
  });
});

describe("a design page's key (X65)", () => {
  it("is read back as its page, only for its own design", () => {
    expect(pageOfKey("local", "w-1devstudio", "settings-page", pageKey("local", "w-1devstudio", "settings-page", "git rows"))).toBe("git rows");
    expect(pageOfKey("local", "w-1devstudio", "settings-page", pageKey("local", "w-1devstudio", "settings-page-2", "index"))).toBeNull();
    expect(pageOfKey("local", "w-1devstudio", "settings-page", pageKey("mac-2", "w-1devstudio", "settings-page", "index"))).toBeNull();
  });
});

describe("a session design's state (X65)", () => {
  const S = { session: "4f2a9c1e7b3d" };
  const pin = (n: number, comment: string): DesignComment => ({ n, page: "index", mid: "m12", tag: "nav", text: "General", comment, sent_at: null, state: "open" });
  const sessionChanged = (paths: string[]) =>
    events.emit({ host: "local", name: "design.changed", data: { workspace: "w-1devstudio", system: null, design: "settings-page", session: "4f2a9c1e7b3d", paths } });

  it("is read by its session and slug, apart from a workspace design of the same slug", async () => {
    answers["design.comments"] = (p) => ("session" in (p as object) ? [pin(1, "In the session")] : [pin(1, "In the workspace")]);
    await loadComments("local", S, "settings-page");
    await loadComments("local", "w-1devstudio", "settings-page");
    expect(calls.filter((c) => c.method === "design.comments").map((c) => c.params)).toEqual([
      { session: "4f2a9c1e7b3d", slug: "settings-page" },
      { workspace: "w-1devstudio", slug: "settings-page" },
    ]);
    expect(commentsOf(useDesign.getState(), "local", S, "settings-page").map((p) => p.comment)).toEqual(["In the session"]);
    expect(commentsOf(useDesign.getState(), "local", "w-1devstudio", "settings-page").map((p) => p.comment)).toEqual(["In the workspace"]);
  });

  it("loads its pages, comments and snapshots again when its session's design.changed names them, never a workspace design's of the same slug", async () => {
    answers["design.check"] = () => [];
    answers["design.comments"] = () => [pin(1, "Collapse it")];
    answers["design.history"] = () => [];
    await loadComments("local", S, "settings-page");
    await loadHistory("local", S, "settings-page");
    calls.length = 0;
    sessionChanged(["pages/index.html", "comments.json", "history/2/snapshot.json"]);
    await settle();
    await settle();
    expect(pageRevOf(useDesign.getState(), "local", S, "settings-page", "index")).toBe(1);
    expect(pageRevOf(useDesign.getState(), "local", "w-1devstudio", "settings-page", "index")).toBe(0);
    expect(latestOf(useDesign.getState(), "local", S, "settings-page")).toEqual(["index"]);
    expect(calls.filter((c) => c.method === "design.comments" || c.method === "design.history").map((c) => [c.method, c.params])).toEqual([
      ["design.comments", { session: "4f2a9c1e7b3d", slug: "settings-page" }],
      ["design.history", { session: "4f2a9c1e7b3d", slug: "settings-page" }],
    ]);
  });

  it("loads every page of the design again when its pinned styles or assets change", async () => {
    answers["design.list"] = () => [design({ kind: "session", session: "4f2a9c1e7b3d", path: "/wt/settings-page/docs/design/settings-page", agent: 31 })];
    answers["design.check"] = () => [];
    await loadDesigns("local", "w-1devstudio");
    sessionChanged(["system/styles.css"]);
    sessionChanged(["assets/logo.svg"]);
    expect(["index", "git-a"].map((p) => pageRevOf(useDesign.getState(), "local", S, "settings-page", p))).toEqual([2, 2]);
  });

  it("is listed with its session's designs, never with Design mode's workspace designs", async () => {
    answers["design.list"] = () => [design(), design({ slug: "onboarding", name: "Onboarding", kind: "session", session: "4f2a9c1e7b3d", path: "/wt/s/docs/design/onboarding", agent: 31 })];
    await loadDesigns("local", "w-1devstudio");
    expect(designsOf(useDesign.getState(), "local", "w-1devstudio")?.map((d) => d.slug)).toEqual(["settings-page"]);
    expect(sessionDesignsOf(useDesign.getState(), "local", "4f2a9c1e7b3d").map((d) => d.slug)).toEqual(["onboarding"]);
    expect(sessionDesignsOf(useDesign.getState(), "local", "9c9c9c9c9c9c")).toEqual([]);
  });

  it("is checked by its session and slug", async () => {
    answers["design.check"] = () => [{ path: "pages/index.html", line: 3, kind: "missing_mid", message: "<p> has no data-mid" }];
    await checkDesign("local", S, "settings-page");
    expect(calls.filter((c) => c.method === "design.check").map((c) => c.params)).toEqual([{ design: { session: "4f2a9c1e7b3d", slug: "settings-page" } }]);
    expect(problemsOf(useDesign.getState(), "local", S, "settings-page").map((p) => p.line)).toEqual([3]);
    expect(problemsOf(useDesign.getState(), "local", "w-1devstudio", "settings-page")).toEqual([]);
  });
});

describe("a session's Design tab (X65)", () => {
  const listed = () => [
    design({ slug: "onboarding", name: "Onboarding", kind: "session", session: "4f2a9c1e7b3d", path: "/wt/s/docs/design/onboarding", agent: 31 }),
    design({ kind: "session", session: "4f2a9c1e7b3d", path: "/wt/s/docs/design/settings-page", agent: 31, system_updated: true }),
  ];

  it("shows the design picked, else the session's first", async () => {
    answers["design.list"] = listed;
    await loadDesigns("local", "w-1devstudio");
    expect(shownSessionDesign(useDesign.getState(), "local", "4f2a9c1e7b3d")?.slug).toBe("onboarding");
    showSessionDesign("local", "4f2a9c1e7b3d", "settings-page");
    expect(shownSessionDesign(useDesign.getState(), "local", "4f2a9c1e7b3d")?.slug).toBe("settings-page");
    // One that is gone shows the first again; a session without designs none.
    showSessionDesign("local", "4f2a9c1e7b3d", "billing");
    expect(shownSessionDesign(useDesign.getState(), "local", "4f2a9c1e7b3d")?.slug).toBe("onboarding");
    expect(shownSessionDesign(useDesign.getState(), "local", "9c9c9c9c9c9c")).toBeNull();
  });

  it("updates a design's design system by its session and slug, and its bar goes at once", async () => {
    answers["design.list"] = listed;
    answers["design.system.update"] = () => ({ anchor: "9f86d081", cards: [{ path: "components/buttons/button/button.html", change: "changed" }] });
    await loadDesigns("local", "w-1devstudio");
    expect(await updateSystem("local", { session: "4f2a9c1e7b3d" }, "settings-page")).toEqual({ anchor: "9f86d081", cards: [{ path: "components/buttons/button/button.html", change: "changed" }] });
    expect(calls.filter((c) => c.method === "design.system.update").map((c) => c.params)).toEqual([{ session: "4f2a9c1e7b3d", slug: "settings-page" }]);
    expect(sessionDesignsOf(useDesign.getState(), "local", "4f2a9c1e7b3d").map((d) => [d.slug, !!d.system_updated])).toEqual([
      ["onboarding", false],
      ["settings-page", false],
    ]);
  });
});
