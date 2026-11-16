import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@desktop/lib/protocol";
import { DaemonError } from "@desktop/lib/daemon";

// What the central host answers each `session.forward`, in order; the
// calls made, by method and params.
const answers: (unknown | DaemonError)[] = [];
const calls: { host: string; method: string; params: unknown }[] = [];
vi.mock("@desktop/lib/daemon", async (real) => ({
  ...(await real<typeof import("@desktop/lib/daemon")>()),
  rpc: (host: string, method: string, params: unknown) => {
    calls.push({ host, method, params });
    const a = answers.shift();
    return a instanceof DaemonError
      ? Promise.reject(a)
      : Promise.resolve(a ?? true);
  },
}));

const { useApp, emptyData } = await import("./app");
const { cancelHeld, heldLine, retryIn, sendFor, sentOutcome, useHeld } =
  await import("./held");

const NOW = 1_790_000_100_000;
const session = (owner?: Session["owner"], pinned?: string): Session => ({
  id: "5e7f9a1b3c5d",
  project_id: "p1",
  name: "fix-cart",
  branch: "moonlet/fix-cart",
  base: "",
  path: "/Users/alex/.moonlet/copies/MacBook/shop/fix-cart",
  agent: null,
  archived: false,
  created_at: 1790000000002,
  terminals: [],
  layout: null,
  owner,
  pinned,
});
const away = (since: number) =>
  session({
    worker: "w1",
    name: "MacBook",
    reachable: false,
    unreachable_since: since,
  });
const silent = session({ worker: "w1", name: "MacBook", reachable: true });
const refused = (code: string, message = "") => ({
  error: new DaemonError({ code, message }),
});

describe("what became of a message or an answer for a session whose Mac is away (X73)", () => {
  it("says the session continues on the central host when it took it over", () => {
    expect(
      sentOutcome(
        { value: { continued_on: "studio-mini" } },
        away(NOW - 31_000),
        "studio-mini",
      ),
    ).toEqual({
      kind: "sent",
      note: "MacBook is not reachable. Continuing on studio-mini.",
    });
    expect(sentOutcome({ value: true }, silent, "studio-mini")).toEqual({
      kind: "sent",
      note: null,
    });
  });

  it("holds it when the central host refused it unsent: too soon, a silent Mac, kept on that Mac, or the Mac back just then", () => {
    expect(
      sentOutcome(
        refused("not_yet", "MacBook has been unreachable for less than 30 s"),
        away(NOW - 5_000),
        "studio-mini",
      ),
    ).toEqual({ kind: "held" });
    expect(
      sentOutcome(
        refused("owner_not_responding", "MacBook is not responding"),
        silent,
        "studio-mini",
      ),
    ).toEqual({ kind: "held" });
    expect(
      sentOutcome(
        refused("pinned", "that session is kept on its member"),
        away(NOW - 40_000),
        "studio-mini",
      ),
    ).toEqual({ kind: "held" });
    expect(sentOutcome(refused("reachable", "the member running that session is reachable"), away(NOW - 31_000), "studio-mini")).toEqual({ kind: "held" });
  });

  it("says why it was not sent when nothing will send it", () => {
    // A central host from before X73's take-over for a message.
    expect(
      sentOutcome(
        refused("owner_offline", "MacBook is not reachable"),
        away(NOW - 40_000),
        "studio-mini",
      ),
    ).toEqual({
      kind: "failed",
      line: "Not sent: MacBook is not reachable. Continue on studio-mini, then send it again.",
    });
    // Sent while the Mac answered, then the link went quiet: it may have got it.
    expect(
      sentOutcome(
        refused(
          "owner_lost",
          "MacBook stopped answering before it said whether it got this",
        ),
        silent,
        "studio-mini",
      ),
    ).toEqual({
      kind: "failed",
      line: "MacBook stopped answering before it said whether it got this. Check the chat before you send it again.",
    });
    // The phone's own link to the central host dropped while it waited.
    expect(
      sentOutcome(
        refused("disconnected", "connection closed"),
        silent,
        "studio-mini",
      ),
    ).toEqual({
      kind: "failed",
      line: "The connection to studio-mini dropped before it said whether it got this. Check the chat before you send it again.",
    });
    expect(
      sentOutcome(
        refused("no_copy", "this host has no copy of that session yet"),
        away(NOW - 40_000),
        "studio-mini",
      ),
    ).toEqual({
      kind: "failed",
      line: "Not sent: studio-mini has no copy of fix-cart yet.",
    });
    expect(
      sentOutcome({ error: new Error("boom") }, silent, "studio-mini"),
    ).toEqual({ kind: "failed", line: "Not sent: boom" });
  });

  it("shows a held message with the count-down until the session can continue", () => {
    expect(heldLine(away(NOW - 18_000), "studio-mini", "message", NOW)).toBe(
      "MacBook is not reachable. Your message goes on studio-mini in 12 s.",
    );
    expect(heldLine(away(NOW - 30_000), "studio-mini", "answer", NOW)).toBe(
      "MacBook is not reachable. Continuing on studio-mini…",
    );
    expect(heldLine(silent, "studio-mini", "message", NOW)).toBe(
      "MacBook is not responding. Your message goes as soon as it answers, or on studio-mini once it has been away for 30 s.",
    );
    expect(
      heldLine(
        session(
          {
            worker: "w1",
            name: "MacBook",
            reachable: false,
            unreachable_since: NOW - 60_000,
          },
          "w1",
        ),
        "studio-mini",
        "answer",
        NOW,
      ),
    ).toBe(
      "Kept on MacBook · not reachable. Your answer goes when MacBook is back.",
    );
  });

  it("sends it again when the count-down ends, and every few seconds while the Mac is silent or kept", () => {
    expect(retryIn(away(NOW - 18_000), NOW)).toBe(12_000);
    expect(retryIn(away(NOW - 31_000), NOW)).toBe(1_000);
    expect(retryIn(silent, NOW)).toBe(3_000);
    expect(
      retryIn(
        session(
          {
            worker: "w1",
            name: "MacBook",
            reachable: false,
            unreachable_since: NOW - 60_000,
          },
          "w1",
        ),
        NOW,
      ),
    ).toBe(5_000);
  });
});

describe("sendFor (X73)", () => {
  const central = "mini";
  const host = `${central}#copy:5e7f9a1b3c5d`;
  const params = { id: 3, text: "Again", images: [] };
  afterEach(() => {
    vi.useRealTimers();
    answers.length = 0;
    calls.length = 0;
    cancelHeld(host, 3, "message");
  });
  const listed = (s: Session) =>
    useApp.setState({
      hosts: { mini: { id: "mini", label: "studio-mini" } as never },
      data: { mini: { ...emptyData(), sessions: [s] } },
    });

  it("holds a message refused unsent and sends it once, when the session can continue", async () => {
    vi.useFakeTimers({ now: NOW });
    listed(away(NOW - 25_000));
    answers.push(refused("not_yet").error, { continued_on: "studio-mini" });
    expect(await sendFor(host, 3, "chat.send", params, "message")).toBe("held");
    expect(useHeld.getState().held[`${host}|3|message`]?.params).toEqual(
      params,
    );
    await vi.advanceTimersByTimeAsync(4_900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ host, method: "chat.send", params });
    expect(useHeld.getState().held[`${host}|3|message`]).toBeUndefined();
    expect(useHeld.getState().notes["5e7f9a1b3c5d"]).toBe(
      "MacBook is not reachable. Continuing on studio-mini.",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(2);
  });

  it("sends nothing more once the user takes a held message back", async () => {
    vi.useFakeTimers({ now: NOW });
    listed(silent);
    answers.push(refused("owner_not_responding").error);
    expect(await sendFor(host, 3, "chat.send", params, "message")).toBe("held");
    expect(cancelHeld(host, 3, "message")?.params).toEqual(params);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(1);
  });

  it("gives up on a held message the central host then refuses for good, and says why", async () => {
    vi.useFakeTimers({ now: NOW });
    listed(away(NOW - 29_000));
    answers.push(refused("not_yet").error, refused("no_copy").error);
    expect(await sendFor(host, 3, "chat.send", params, "message")).toBe("held");
    await vi.advanceTimersByTimeAsync(1_100);
    expect(useHeld.getState().held[`${host}|3|message`]).toBeUndefined();
    expect(useHeld.getState().failed[`${host}|3|message`]).toEqual({
      line: "Not sent: studio-mini has no copy of fix-cart yet.",
      params,
    });
  });

  it("throws what to show when nothing will send it", async () => {
    listed(away(NOW - 40_000));
    answers.push(refused("owner_offline").error);
    await expect(
      sendFor(host, 3, "chat.send", params, "message"),
    ).rejects.toThrow(
      "Not sent: MacBook is not reachable. Continue on studio-mini, then send it again.",
    );
  });

  it("sends a host's own session's message as before", async () => {
    answers.push(true);
    expect(await sendFor("mini", 3, "chat.send", params, "message")).toBe(
      "sent",
    );
    expect(calls).toEqual([{ host: "mini", method: "chat.send", params }]);
  });
});
