import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "./protocol";
import { sendOrBring } from "./followStore";
import { useStore } from "./store";

/** What the daemon answers, by host and method. */
const answers = vi.hoisted(() => ({}) as Record<string, (params: unknown) => unknown>);

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
    rpc: vi.fn((host: string, method: string, params: unknown) => {
      const answer = answers[`${host} ${method}`];
      return answer ? Promise.resolve().then(() => answer(params)) : Promise.reject(new DaemonError({ code: "unknown", message: `no ${method}` }));
    }),
    onDaemonEvent: () => Promise.resolve(() => {}),
    onHostStatus: () => Promise.resolve(() => {}),
    subscribeHost: () => Promise.resolve(),
    hostsApi: {},
  };
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));

const session = (id: string): Session => ({
  id,
  project_id: "p1",
  name: id,
  branch: `moonlet/${id}`,
  base: "main",
  path: `/Users/me/w/${id}`,
  agent: "claude",
  archived: false,
  created_at: 1700,
  workspace_id: "personal",
  terminals: [3],
  layout: null,
});

describe("typing into a session another Mac runs (X73)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const k of Object.keys(answers)) delete answers[k];
    useStore.setState({
      toasts: [],
      accounts: { local: { account: "mini-id", central: "studio-mini" }, "studio-mini": { account: "mini-id", central: null } } as never,
      sessions: { "studio-mini": [session("fix-cart")] },
      hosts: { "studio-mini": { id: "studio-mini", label: "studio-mini", status: "connected", remote: true } } as never,
    });
  });
  afterEach(() => vi.useRealTimers());

  it("brings it here once a long turn there ends, however long, and the message runs here", async () => {
    // studio-mini's turn runs for 25 minutes.
    const ends = Date.now() + 25 * 60_000;
    const brought: unknown[] = [];
    answers["local session.bring"] = (p) => {
      if (Date.now() < ends) throw Object.assign(new Error("a turn is running; it moves when the turn ends"), { code: "busy" });
      brought.push(p);
      return session("fix-cart");
    };
    const sentThere = vi.fn(() => Promise.resolve());

    const done = sendOrBring("studio-mini", "fix-cart", 3, "And the tests", [], sentThere);
    // Twenty minutes in, the line with Move now still shows.
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const shown = () => useStore.getState().toasts.map((t) => [t.text, t.action?.label ?? null]);
    expect(shown()).toContainEqual(["Moves here when studio-mini's turn ends", "Move now"]);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await done;
    // Gone once it moved.
    expect(shown()).not.toContainEqual(["Moves here when studio-mini's turn ends", "Move now"]);

    expect(sentThere).not.toHaveBeenCalled();
    expect(brought).toEqual([{ session: "fix-cart", now: false, terminal: 3, message: "And the tests", images: [] }]);
    expect(useStore.getState().selected).toEqual({ host: "local", session: "fix-cart" });
  });
  const shown = () => useStore.getState().toasts.map((t) => [t.text, t.action?.label ?? null, t.also?.label ?? null]);
  const press = (label: string) => {
    const t = useStore.getState().toasts.find((t) => t.action?.label === label || t.also?.label === label)!;
    (t.action?.label === label ? t.action : t.also)!.run();
  };

  it("says why a session can't come here, and sends the message there only when asked", async () => {
    answers["local session.bring"] = () => {
      throw Object.assign(new Error("moonlet/fix-cart is checked out in ~/src/shop on this Mac."), { code: "copy_failed" });
    };
    const sentThere = vi.fn(() => Promise.resolve());

    await sendOrBring("studio-mini", "fix-cart", 3, "And the tests", [], sentThere);
    expect(sentThere).not.toHaveBeenCalled();
    expect(shown()).toEqual([["fix-cart can't come to this Mac: moonlet/fix-cart is checked out in ~/src/shop on this Mac.", "Send it there", "Try again"]]);

    press("Send it there");
    await vi.advanceTimersByTimeAsync(0);
    expect(sentThere).toHaveBeenCalledWith("And the tests", []);
  });

  it("brings it again with the message on Try again", async () => {
    let fails = true;
    const brought: unknown[] = [];
    answers["local session.bring"] = (p) => {
      if (fails) throw Object.assign(new Error("the central host is not connected"), { code: "unreachable" });
      brought.push(p);
      return session("fix-cart");
    };
    const sentThere = vi.fn(() => Promise.resolve());

    await sendOrBring("studio-mini", "fix-cart", 3, "And the tests", [], sentThere);
    expect(shown()).toEqual([["fix-cart can't come to this Mac: the central host is not connected.", "Send it there", "Try again"]]);
    fails = false;
    press("Try again");
    await vi.advanceTimersByTimeAsync(0);
    expect(brought).toEqual([{ session: "fix-cart", now: false, terminal: 3, message: "And the tests", images: [] }]);
    expect(sentThere).not.toHaveBeenCalled();
    expect(useStore.getState().selected).toEqual({ host: "local", session: "fix-cart" });
  });

  it("names the branch this Mac's commits went on", async () => {
    answers["local session.bring"] = () => ({ ...session("fix-cart"), kept_on: "moonlet/fix-cart-this-mac" });

    await sendOrBring("studio-mini", "fix-cart", 3, "And the tests", [], vi.fn());
    expect(shown()).toEqual([["fix-cart is here. Its commits from this Mac are on moonlet/fix-cart-this-mac: merge that branch into moonlet/fix-cart to keep them.", null, null]]);
  });
});
