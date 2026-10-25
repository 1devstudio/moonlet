import { describe, expect, it } from "vitest";
import { centralHostButton, centralHostId, clampSlots, heavyHostIds, linkLine, linkRetries, pairThenLink, pickCentral, remoteLinkAction, remoteLinkError, remoteLinkLine, remoteSwitchOn, slotsHint, turnOnNeeds, watchLink, withRunning } from "./workerLink";
import { DaemonError } from "./daemon";
import type { HostInfo, LinkInfo, LinkState } from "./protocol";

const info = (state: LinkState, central: string | null = "studio-mini"): LinkInfo => ({
  central: central ? { name: central, addrs: ["100.101.102.103:47428"] } : null,
  worker: { id: "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37", name: "Alex's MacBook Pro", enabled: true },
  state,
});

describe("the link's status line (X41)", () => {
  it("reads one line per link state", () => {
    const since = new Date(2026, 9, 21, 10, 42).getTime();
    expect(linkLine(info({ kind: "off" }, null))).toEqual({ tone: "muted", text: "Not linked" });
    expect(linkLine(info({ kind: "connecting" }))).toEqual({ tone: "blocked", text: "Linking to studio-mini…" });
    expect(linkLine(info({ kind: "connected", since }))).toEqual({ tone: "done", text: "Linked to studio-mini since 10:42" });
    expect(linkLine(info({ kind: "reconnecting" }))).toEqual({ tone: "blocked", text: "Reconnecting to studio-mini…" });
    expect(linkLine(info({ kind: "needs_update", daemon_version: "0.1.26" }))).toEqual({ tone: "error", text: "Update moonlet on studio-mini" });
    expect(linkLine(info({ kind: "refused" }))).toEqual({
      tone: "error",
      text: "studio-mini no longer accepts this Mac. Pair it again.",
    });
    expect(linkLine(info({ kind: "error", message: "connection refused" }))).toEqual({ tone: "error", text: "connection refused" });
  });

  it("pads the time of day", () => {
    const since = new Date(2026, 9, 21, 9, 5).getTime();
    expect(linkLine(info({ kind: "connected", since })).text).toBe("Linked to studio-mini since 09:05");
  });

  it("offers Retry for a connection error and after updating, not for a host that removed this Mac", () => {
    expect(linkRetries(info({ kind: "error", message: "connection refused" }))).toBe(true);
    expect(linkRetries(info({ kind: "needs_update", daemon_version: "0.1.26" }))).toBe(true);
    expect(linkRetries(info({ kind: "refused" }))).toBe(false);
    expect(linkRetries(info({ kind: "connected", since: 0 }))).toBe(false);
  });
});

describe("the central host choice (X41)", () => {
  const host = (id: string, kind: HostInfo["kind"]): HostInfo => ({ id, label: id, remote: true, kind, status: "connected", message: null, daemon_version: null, hostname: null, home: null });
  const hosts = [host("studio-mini", "tailnet"), host("build-box", "tailnet"), host("devbox", "ssh")];

  it("is the tailnet host the link goes to", () => {
    expect(centralHostId(hosts, info({ kind: "off" }, "studio-mini"))).toBe("studio-mini");
    expect(centralHostId(hosts, info({ kind: "off" }, null))).toBeNull();
    expect(centralHostId(hosts, null)).toBeNull();
  });

  it("is never an SSH host, nor a host this Mac no longer has", () => {
    expect(centralHostId(hosts, info({ kind: "off" }, "devbox"))).toBeNull();
    expect(centralHostId(hosts, info({ kind: "off" }, "old-mini"))).toBeNull();
  });

  it("moves to another host, and choosing it again clears it", () => {
    expect(pickCentral(null, "studio-mini")).toBe("studio-mini");
    expect(pickCentral("studio-mini", "build-box")).toBe("build-box");
    expect(pickCentral("studio-mini", "studio-mini")).toBeNull();
  });

  it("reads as the action it takes, on every tailnet host's row", () => {
    expect(centralHostButton(null, "studio-mini")).toEqual({ label: "Make central host", title: "Make studio-mini this Mac's central host" });
    expect(centralHostButton("build-box", "studio-mini")).toEqual({ label: "Make central host", title: "Make studio-mini this Mac's central host" });
    expect(centralHostButton("studio-mini", "studio-mini")).toEqual({
      label: "Clear central host",
      title: "studio-mini is this Mac's central host. Click to clear it.",
    });
  });
});

describe("following the link (X41)", () => {
  const info = (kind: "off" | "connecting", name = "studio-mini"): LinkInfo => ({
    central: { name, addrs: ["100.101.102.103:47428"] },
    worker: { id: "7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37", name: "Alex's MacBook Pro", enabled: kind !== "off" },
    state: { kind } as LinkState,
  });

  /** A fake daemon: `get` answers when resolved by the test. */
  function fake() {
    const answers: ((l: LinkInfo) => void)[] = [];
    let changed: (l: LinkInfo) => void = () => {};
    let reconnected: () => void = () => {};
    const seen: (LinkInfo | null)[] = [];
    const stop = watchLink({
      get: () => new Promise<LinkInfo>((r) => answers.push(r)),
      onChanged: (cb) => {
        changed = cb;
        return () => {};
      },
      onReconnected: (cb) => {
        reconnected = cb;
        return () => {};
      },
      set: (l) => seen.push(l),
    });
    return { answers, changed: (l: LinkInfo) => changed(l), reconnected: () => reconnected(), seen, stop };
  }

  it("drops a snapshot that an event overtook", async () => {
    const f = fake();
    f.changed(info("connecting"));
    f.answers[0](info("off"));
    await Promise.resolve();
    expect(f.seen.map((l) => l?.state.kind)).toEqual(["connecting"]);
  });

  it("reads the link again when this Mac's daemon is back", async () => {
    const f = fake();
    f.answers[0](info("off"));
    await Promise.resolve();
    f.reconnected();
    f.answers[1](info("connecting"));
    await Promise.resolve();
    expect(f.seen.map((l) => l?.state.kind)).toEqual(["off", "connecting"]);
  });

  it("sets nothing once stopped", async () => {
    const f = fake();
    f.stop();
    f.answers[0](info("off"));
    f.changed(info("connecting"));
    await Promise.resolve();
    expect(f.seen).toEqual([]);
  });
});

/** A remote host `build-box`'s link (X61), to `central` or none. */
const remote = (state: LinkState, central: string | null = "studio-mini", enabled = true): LinkInfo => ({
  central: central ? { name: central, addrs: ["100.101.102.103:47428"] } : null,
  worker: { id: "9b1e4c7d-2f3a-4d5e-8a6b-0c1d2e3f4a5b", name: "build-box", enabled },
  state,
});

const remoteHost = (id: string, kind: HostInfo["kind"], status: HostInfo["status"] = "connected"): HostInfo => ({ id, label: id, remote: true, kind, status, message: null, daemon_version: null, hostname: null, home: null });

describe("which remote hosts take heavy commands (X61)", () => {
  it("is every connected tailnet host but the central host", () => {
    const hosts = [
      remoteHost("studio-mini", "tailnet"),
      remoteHost("build-box", "tailnet"),
      remoteHost("old-mini", "tailnet", "reconnecting"),
      remoteHost("spare-mini", "tailnet", "needs_update"),
      remoteHost("devbox", "ssh"),
    ];
    expect(heavyHostIds(hosts, "studio-mini")).toEqual(["build-box"]);
    expect(heavyHostIds(hosts, null)).toEqual(["studio-mini", "build-box"]);
  });
});

describe("a remote host's link line (X61)", () => {
  it("reads one line per link state, naming the remote host", () => {
    const since = new Date(2026, 9, 22, 10, 42).getTime();
    const line = (l: LinkInfo) => remoteLinkLine(l, "build-box", "studio-mini");
    expect(line(remote({ kind: "off" }, null, false))).toEqual({ tone: "muted", text: "Not linked" });
    expect(line(remote({ kind: "off" }, "studio-mini", false))).toEqual({ tone: "muted", text: "Not linked" });
    expect(line(remote({ kind: "connecting" }))).toEqual({ tone: "blocked", text: "Linking to studio-mini…" });
    expect(line(remote({ kind: "connected", since }))).toEqual({ tone: "done", text: "Linked to studio-mini since 10:42" });
    expect(line(remote({ kind: "reconnecting" }))).toEqual({ tone: "blocked", text: "Reconnecting to studio-mini…" });
    expect(line(remote({ kind: "needs_update", daemon_version: "0.1.26" }))).toEqual({ tone: "error", text: "Update moonlet on studio-mini" });
    expect(line(remote({ kind: "refused" }))).toEqual({ tone: "error", text: "studio-mini no longer accepts build-box" });
    expect(line(remote({ kind: "error", message: "connection refused" }))).toEqual({ tone: "error", text: "connection refused" });
  });

  it("says so when the host is linked to another central host", () => {
    expect(remoteLinkLine(remote({ kind: "connected", since: 0 }, "other-mini"), "build-box", "studio-mini")).toEqual({ tone: "blocked", text: "Linked to other-mini, not to studio-mini" });
    // Off, its old central host does not matter.
    expect(remoteLinkLine(remote({ kind: "off" }, "other-mini", false), "build-box", "studio-mini")).toEqual({ tone: "muted", text: "Not linked" });
  });

  it("asks for a central host first while this Mac has none, whatever the host's link", () => {
    expect(remoteLinkLine(remote({ kind: "off" }, null, false), "build-box", null)).toEqual({ tone: "muted", text: "Choose a central host first" });
    expect(remoteLinkLine(remote({ kind: "connected", since: 0 }, "other-mini"), "build-box", null)).toEqual({ tone: "muted", text: "Choose a central host first" });
  });

  it("offers Retry for a connection error or an update, and Pair again for a central host that removed the host", () => {
    const action = (l: LinkInfo) => remoteLinkAction(l, "studio-mini");
    expect(action(remote({ kind: "error", message: "connection refused" }))).toBe("retry");
    expect(action(remote({ kind: "needs_update", daemon_version: "0.1.26" }))).toBe("retry");
    expect(action(remote({ kind: "refused" }))).toBe("pair-again");
    expect(action(remote({ kind: "connected", since: 0 }))).toBeNull();
    expect(action(remote({ kind: "refused" }, "other-mini"))).toBeNull();
    expect(remoteLinkAction(remote({ kind: "refused" }), null)).toBeNull();
  });
});

describe("a remote host's switch (X61)", () => {
  it("is on only while the host takes heavy commands for this Mac's central host", () => {
    expect(remoteSwitchOn(remote({ kind: "connected", since: 0 }), "studio-mini")).toBe(true);
    expect(remoteSwitchOn(remote({ kind: "refused" }), "studio-mini")).toBe(true);
    expect(remoteSwitchOn(remote({ kind: "off" }, "studio-mini", false), "studio-mini")).toBe(false);
    expect(remoteSwitchOn(remote({ kind: "connected", since: 0 }, "other-mini"), "studio-mini")).toBe(false);
    expect(remoteSwitchOn(remote({ kind: "connected", since: 0 }, "other-mini"), null)).toBe(false);
  });
});

describe("turning a remote host's switch on (X61)", () => {
  it("only enables a host that is paired with this Mac's central host", () => {
    expect(turnOnNeeds(remote({ kind: "off" }, "studio-mini", false), "build-box", "studio-mini")).toEqual({ kind: "enable" });
    expect(turnOnNeeds(remote({ kind: "error", message: "connection refused" }, "studio-mini", false), "build-box", "studio-mini")).toEqual({ kind: "enable" });
  });

  it("pairs a host with no central host, or one the central host removed", () => {
    expect(turnOnNeeds(remote({ kind: "off" }, null, false), "build-box", "studio-mini")).toEqual({ kind: "pair" });
    expect(turnOnNeeds(remote({ kind: "refused" }, "studio-mini", false), "build-box", "studio-mini")).toEqual({ kind: "pair" });
  });

  it("asks before moving a host linked to another central host", () => {
    expect(turnOnNeeds(remote({ kind: "connected", since: 0 }, "other-mini"), "build-box", "studio-mini")).toEqual({
      kind: "pair",
      confirm: "build-box is linked to other-mini. Link it to studio-mini instead?",
    });
  });

  it("says a host from before X61 needs an update, whether it refuses link.pair or a paired Mac's link.set", () => {
    expect(remoteLinkError(new DaemonError({ code: "unknown_method", message: "unknown method link.pair" }), "build-box")).toBe("Update moonlet on build-box");
    expect(remoteLinkError(new DaemonError({ code: "forbidden", message: "manage the link from the Mac" }), "build-box")).toBe("Update moonlet on build-box");
    expect(remoteLinkError(new DaemonError({ code: "pair_failed", message: "The code was not accepted. Start pairing again on studio-mini." }), "build-box")).toBe(
      "The code was not accepted. Start pairing again on studio-mini.",
    );
  });
});

describe("pairing a remote host with the central host (X61)", () => {
  const central = { name: "studio-mini", addrs: ["100.101.102.103:47428"] };
  const fails = (failing: string, code: string, message: string) => async (method: string) => {
    if (method === failing) throw new DaemonError({ code, message });
  };

  it("pairs, then turns the link on", async () => {
    expect(await pairThenLink(async () => {}, central, "7KQ2MX9PDA")).toEqual({ paired: true, error: null });
  });

  it("is not paired when the code is refused", async () => {
    const r = await pairThenLink(fails("link.pair", "pair_failed", "The code was not accepted. Start pairing again on studio-mini."), central, "7KQ2MX9PDA");
    expect(r.paired).toBe(false);
    expect((r.error as Error).message).toBe("The code was not accepted. Start pairing again on studio-mini.");
  });

  it("is paired even when turning the link on fails, so the used code is not asked for again", async () => {
    const r = await pairThenLink(fails("link.set", "internal", "cannot write link.json"), central, "7KQ2MX9PDA");
    expect(r.paired).toBe(true);
    expect((r.error as Error).message).toBe("cannot write link.json");
  });
});

describe("the run-at-most row (X62)", () => {
  it("says how many commands run here, and keeps slots from 1 to 64", () => {
    const since = new Date(2026, 9, 21, 9, 2).getTime();
    const line = linkLine(info({ kind: "connected", since }));
    expect(withRunning(line, 1)).toEqual({ tone: "done", text: "Linked to studio-mini since 09:02 · 1 running" });
    expect(withRunning(line, 0)).toEqual(line);
    expect(withRunning(linkLine(info({ kind: "off" }, null)), 2)).toEqual({ tone: "muted", text: "Not linked" });
    expect(slotsHint(null)).toBe("Routed commands side by side. 1 suits a laptop on battery.");
    expect(slotsHint("devbox")).toBe("Saved on devbox.");
    expect([0, 1, 2, 64, 65].map(clampSlots)).toEqual([1, 1, 2, 64, 64]);
  });
});
