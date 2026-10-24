import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignSystem } from "./protocol";
import { cardsOf, createSystem, detectStack, loadCards, loadSystems, openCard, shownCard, shownSystem, showSystem, startDesign, systemsOf, useDesign } from "./designStore";

const calls = vi.hoisted(() => [] as { host: string; method: string; params: unknown }[]);
/** What the daemon answers, by method. */
const answers = vi.hoisted(() => ({}) as Record<string, (params: unknown) => unknown>);
const events = vi.hoisted(() => ({ emit: (_e: { host: string; name: string; data: unknown }) => {} }));
const hostStatus = vi.hoisted(() => ({ emit: (_h: { id: string; status: string }) => {} }));

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
  ...over,
});

const settle = () => new Promise((r) => setTimeout(r, 0));
const listed = () => calls.filter((c) => c.method === "design.systems");

beforeEach(async () => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  useDesign.setState({ systems: {}, shown: {}, cards: {}, card: {} });
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

  it("one opens as the card page, and opening another system closes it", () => {
    showSystem("local", "w-1devstudio", "moonlet-desktop");
    openCard("local", "w-1devstudio", "components/buttons/button/button.html");
    expect(shownCard(useDesign.getState(), "local", "w-1devstudio")).toBe("components/buttons/button/button.html");
    openCard("local", "w-1devstudio", null);
    expect(shownCard(useDesign.getState(), "local", "w-1devstudio")).toBeNull();
    openCard("local", "w-1devstudio", "components/buttons/button/button.html");
    showSystem("local", "w-1devstudio", "storefront");
    expect(shownCard(useDesign.getState(), "local", "w-1devstudio")).toBeNull();
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
