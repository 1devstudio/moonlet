import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Design, DesignSystem, TerminalInfo } from "./protocol";
import { modeOf, setMode } from "./mode";
import { agentOnScreen, goToAgent, useStore } from "./store";
import { cardsOf, createSystem, designsOf, detectStack, latestOf, loadCards, loadDesigns, loadSystems, openCard, pageRevOf, revOf, shownCard, shownDesign, shownSystem, showDesign, showSystem, startDesign, systemsOf, useDesign } from "./designStore";

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
  useDesign.setState({ systems: {}, shown: {}, cards: {}, opened: {}, changes: {}, designs: {}, designShown: {}, pageRevs: {}, latest: {}, problems: {} });
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
