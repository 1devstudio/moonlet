import { describe, expect, it } from "vitest";
import type { Copy } from "@desktop/lib/protocol";
import { buildInbox } from "./inbox";
import { needsFaceId } from "./cards";
import { applyChanges, eventChanges } from "./events";
import { setupAnswer, setupError } from "./setups";
import { DaemonError } from "@desktop/lib/daemon";
import { data, project, session } from "./fixtures";

const copy = (id: string, setup: Copy["setup"]): Copy => ({
  id,
  host: "studio-mini",
  session: "fix-cart",
  path: `/Users/alex/.moonlet/sync/${id}`,
  state: { kind: "in_sync" },
  setup,
  differs: [],
  too_big: [],
  diverged: null,
});

/** X60's journey: This Mac keeps studio-mini's "Fix cart" in sync, and a
 * routing copy of shop waits too (X62). */
const world = () => ({
  hosts: {
    mac: { id: "mac", label: "This Mac", status: "connected" as const, via: null },
    mini: { id: "mini", label: "studio-mini", status: "connected" as const, via: null },
  },
  data: {
    mac: data({
      copies: [copy("c1", { state: { kind: "needs_approval" }, command: "pnpm install", approved: false }), copy("c2", { state: { kind: "done" }, command: "pnpm install", approved: true })],
      setups: [{ copy: "r1", host: "studio-mini", project: "shop", command: "make deps" }],
    }),
    mini: data({ projects: [project("shop", "shop")], sessions: [session("fix-cart", "Fix cart", { project_id: "shop" })] }),
  },
});

describe("setup asks in the Inbox (X60, X62)", () => {
  it("lists every copy's setup waiting for approval on each Mac, with the exact command", () => {
    const w = world();
    const cards = buildInbox(w.hosts, w.data, null).needs.filter((c) => c.kind === "setup");
    expect(cards.map((c) => [c.host, c.title, c.project, c.setup?.message, c.setup?.command])).toEqual([
      ["mac", "Fix cart", "shop", "Run shop's setup in the copy on This Mac? (from .moonlet/config.toml)", "pnpm install"],
      ["mac", "shop's routing copy", "shop", "Run shop's setup in its routing copy on This Mac? (from .moonlet/config.toml)", "make deps"],
    ]);
  });

  it("names the session's project only while its central host is connected", () => {
    const w = world();
    w.hosts.mini = { ...w.hosts.mini, status: "reconnecting" as never };
    const card = buildInbox(w.hosts, w.data, null).needs.find((c) => c.setup?.copy === "c1")!;
    expect([card.title, card.project, card.setup?.message]).toEqual(["The session", null, "Run the project's setup in the copy on This Mac? (from .moonlet/config.toml)"]);
  });

  it("shows them whatever the workspace, as copies belong to none on this Mac", () => {
    const w = world();
    expect(buildInbox(w.hosts, w.data, { host: "mac", id: "work", account: "mac" }).needs.filter((c) => c.kind === "setup")).toHaveLength(2);
  });

  it("runs a setup only after Face ID, while the setting is on", () => {
    expect(needsFaceId("setup", true)).toBe(true);
    expect(needsFaceId("setup", false)).toBe(false);
  });
});

describe("setup events (X60, X62)", () => {
  it("follow a copy's changes, and drop a copy that went", () => {
    const d = data({ copies: [copy("c1", { state: { kind: "needs_approval" }, command: "pnpm install", approved: false })] });
    const ran = applyChanges(d, eventChanges("sync.changed", copy("c1", { state: { kind: "running" }, command: "pnpm install", approved: true })) as never);
    expect(ran.copies.map((c) => c.setup?.state.kind)).toEqual(["running"]);
    const gone = applyChanges(ran, eventChanges("sync.changed", { ...copy("c1", null), removed: { reason: "stopped", folder: "", leftovers: [] } }) as never);
    expect(gone.copies).toEqual([]);
  });

  it("add a routing copy's setup once", () => {
    const ask = { copy: "r1", host: "studio-mini", project: "shop", command: "make deps" };
    let d = applyChanges(data({}), eventChanges("exec.setup", ask) as never);
    d = applyChanges(d, eventChanges("exec.setup", ask) as never);
    expect(d.setups).toEqual([ask]);
  });
});

describe("answering a setup (X60, X62)", () => {
  it("runs exactly the command shown, or skips", () => {
    expect(setupAnswer("c1", "pnpm install", true)).toEqual({ method: "sync.run_setup", params: { copy: "c1", command: "pnpm install" } });
    expect(setupAnswer("c1", "pnpm install", false)).toEqual({ method: "sync.skip_setup", params: { copy: "c1" } });
  });

  it("says when the command changed meanwhile, or the copy lost its setup", () => {
    // The daemon's `setup_changed` message is the current command (sync.rs).
    expect(setupError(new DaemonError({ code: "setup_changed", message: "pnpm install --frozen-lockfile" }), "This Mac")).toBe(
      "The setup changed on This Mac meanwhile, to: pnpm install --frozen-lockfile. Nothing ran; check the new command before running it.",
    );
    expect(setupError(new DaemonError({ code: "no_setup", message: "no setup" }), "This Mac")).toBe("This copy has no setup script any more.");
    expect(setupError(new DaemonError({ code: "failed", message: "connection reset" }), "This Mac")).toBe("connection reset");
  });
});
