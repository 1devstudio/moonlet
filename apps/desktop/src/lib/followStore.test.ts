import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "./protocol";
import { bringHere, moveSession, sendOrBring } from "./followStore";
import { dismissToast, useStore } from "./store";

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
    // A message the last test left held goes when its toast is closed.
    for (const t of useStore.getState().toasts) t.onClose?.();
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
  const shown = () => useStore.getState().toasts.map((t) => [t.text, t.action?.label ?? null, t.secondAction?.label ?? null]);
  /** Presses a toast's button as the window does: its action runs, and
   * the toast closes. */
  const press = (label: string) => {
    const t = useStore.getState().toasts.find((t) => t.action?.label === label || t.secondAction?.label === label)!;
    (t.action?.label === label ? t.action : t.secondAction)!.run();
    dismissToast(t.id);
  };
  /** Closes a toast with its ✕, as the window does. */
  const close = (text: string) => {
    const t = useStore.getState().toasts.find((t) => t.text === text)!;
    t.onClose?.();
    dismissToast(t.id);
  };
  const cantCome = "fix-cart can't come to this Mac: moonlet/fix-cart is checked out in ~/src/shop on this Mac.";
  const refuses = () => {
    throw Object.assign(new Error("moonlet/fix-cart is checked out in ~/src/shop on this Mac."), { code: "copy_failed" });
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
    expect(shown()).toEqual([]);
  });

  it("never sends the message there by itself on Try again, though the session is no longer listed there", async () => {
    answers["local session.bring"] = refuses;
    const sentThere = vi.fn(() => Promise.resolve());
    await sendOrBring("studio-mini", "fix-cart", 3, "And the tests", [], sentThere);
    // The app's list changes meanwhile.
    useStore.setState({ sessions: { "studio-mini": [] } });
    press("Try again");
    await vi.advanceTimersByTimeAsync(0);
    expect(sentThere).not.toHaveBeenCalled();
    expect(shown()).toEqual([[cantCome, "Send it there", "Try again"]]);
  });

  it("sends the message to the owner when the session was pinned there since the app last heard", async () => {
    answers["local session.bring"] = () => {
      throw Object.assign(new Error("that session is kept where it is"), { code: "pinned" });
    };
    const sentThere = vi.fn(() => Promise.resolve());
    await sendOrBring("studio-mini", "fix-cart", 3, "And the tests", [], sentThere);
    expect(sentThere).toHaveBeenCalledWith("And the tests", []);
    expect(shown()).toEqual([]);
  });

  it("keeps a message typed while the toast shows with the first, and sends both there in order", async () => {
    answers["local session.bring"] = refuses;
    const sentThere = vi.fn(() => Promise.resolve());
    await sendOrBring("studio-mini", "fix-cart", 3, "Fix the cart", [], sentThere);
    await sendOrBring("studio-mini", "fix-cart", 3, "And the tests", [], sentThere);
    expect(shown()).toEqual([[cantCome, "Send it there", "Try again"]]);
    press("Send it there");
    await vi.advanceTimersByTimeAsync(0);
    expect(sentThere.mock.calls).toEqual([["Fix the cart\n\nAnd the tests", []]]);
  });

  it("drops the message when the toast is closed, and brings the next one by itself", async () => {
    const brought: unknown[] = [];
    answers["local session.bring"] = refuses;
    const sentThere = vi.fn(() => Promise.resolve());
    await sendOrBring("studio-mini", "fix-cart", 3, "Fix the cart", [], sentThere);
    close(cantCome);
    answers["local session.bring"] = (p) => {
      brought.push(p);
      return session("fix-cart");
    };
    await sendOrBring("studio-mini", "fix-cart", 3, "And the tests", [], sentThere);
    expect(brought).toEqual([{ session: "fix-cart", now: false, terminal: 3, message: "And the tests", images: [] }]);
    expect(sentThere).not.toHaveBeenCalled();
  });

  it("holds the message again when sending it there fails", async () => {
    answers["local session.bring"] = refuses;
    const sentThere = vi.fn(() => Promise.reject(new Error("studio-mini is not connected")));
    await sendOrBring("studio-mini", "fix-cart", 3, "And the tests", [], sentThere);
    press("Send it there");
    await vi.advanceTimersByTimeAsync(0);
    expect(shown()).toContainEqual([cantCome, "Send it there", "Try again"]);
  });

  it("names the branch this Mac's commits went on", async () => {
    answers["local session.bring"] = () => ({ ...session("fix-cart"), kept_on: "moonlet/fix-cart-this-mac" });

    await sendOrBring("studio-mini", "fix-cart", 3, "And the tests", [], vi.fn());
    expect(shown()).toEqual([["fix-cart is here. Its commits from this Mac are on moonlet/fix-cart-this-mac: merge that branch into moonlet/fix-cart to keep them.", null, null]]);
  });
  it("names the branch this Mac's commits went on when Run only on brings it here", async () => {
    answers["local session.move"] = () => ({ ...session("fix-cart"), kept_on: "moonlet/fix-cart-this-mac" });
    useStore.setState({ toasts: [] });

    await moveSession("fix-cart", "book-id");
    expect(shown()).toContainEqual(["fix-cart is here. Its commits from this Mac are on moonlet/fix-cart-this-mac: merge that branch into moonlet/fix-cart to keep them.", null, null]);
  });
  it("brings a session here from its menu, with no message", async () => {
    const brought: unknown[] = [];
    answers["local session.bring"] = (p) => {
      brought.push(p);
      return session("fix-cart");
    };

    await bringHere("studio-mini", "fix-cart");
    expect(brought).toEqual([{ session: "fix-cart", now: false, images: [] }]);
    expect(useStore.getState().selected).toEqual({ host: "local", session: "fix-cart" });
  });

  it("says why a session can't come here from its menu, with Try again only", async () => {
    answers["local session.bring"] = refuses;
    await bringHere("studio-mini", "fix-cart");
    expect(shown()).toEqual([[cantCome, "Try again", null]]);
  });

  it("brings a message typed while the menu's bring waits, with it", async () => {
    const ends = Date.now() + 60_000;
    const brought: unknown[] = [];
    answers["local session.bring"] = (p) => {
      if (Date.now() < ends) throw Object.assign(new Error("a turn is running; it moves when the turn ends"), { code: "busy" });
      brought.push(p);
      return session("fix-cart");
    };
    const sentThere = vi.fn(() => Promise.resolve());
    const done = bringHere("studio-mini", "fix-cart");
    await vi.advanceTimersByTimeAsync(5_000);
    await sendOrBring("studio-mini", "fix-cart", 3, "And the tests", [], sentThere);
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
    expect(sentThere).not.toHaveBeenCalled();
    expect(brought).toEqual([{ session: "fix-cart", now: false, terminal: 3, message: "And the tests", images: [] }]);
  });
});
