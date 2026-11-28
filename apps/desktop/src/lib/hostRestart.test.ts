import { describe, expect, it } from "vitest";
import type { HostInfo } from "./protocol";
import { followRestart, restartOffer, rowFailure } from "./hostRestart";

const host = (patch: Partial<HostInfo>): HostInfo => ({
  id: "studio-mini",
  label: "studio-mini",
  remote: true,
  kind: "tailnet",
  status: "connected",
  message: null,
  daemon_version: "0.2.2",
  hostname: null,
  home: null,
  ...patch,
});

describe("which hosts can be restarted from here (X120)", () => {
  it("offers Restart to a connected tailnet host only", () => {
    expect(restartOffer(host({}))).toBe(true);
    expect(restartOffer(host({ kind: "ssh" }))).toBe(false);
    expect(restartOffer(host({ id: "local", remote: false, kind: "local" }))).toBe(false);
    expect(restartOffer(host({ status: "reconnecting" }))).toBe(false);
    expect(restartOffer(host({ status: "needs_update" }))).toBe(false);
  });
});

describe("following a restart (X120)", () => {
  const restarting = { phase: "restarting" as const, from: 4242, since: 1_000 };

  it("is done once a daemon with another pid answers", () => {
    expect(followRestart(restarting, host({}), { pid: 5151 }, 3_000)).toEqual({ next: null, reconnect: false });
  });

  it("keeps waiting while the old daemon or no daemon answers, and asks a dropped host to connect again", () => {
    expect(followRestart(restarting, host({}), { pid: 4242 }, 3_000)).toEqual({ next: restarting, reconnect: false });
    expect(followRestart(restarting, host({ status: "reconnecting" }), null, 3_000)).toEqual({ next: restarting, reconnect: false });
    expect(followRestart(restarting, host({ status: "error" }), null, 3_000)).toEqual({ next: restarting, reconnect: true });
  });

  it("gives up a minute after the reply, saying whether the old daemon still runs", () => {
    expect(followRestart(restarting, host({}), { pid: 4242 }, 61_001).next).toEqual({
      phase: "failed",
      text: "studio-mini still runs the same moonletd: the restart did not finish there (see its moonletd log)",
    });
    expect(followRestart(restarting, host({ status: "error" }), null, 61_001).next).toEqual({
      phase: "failed",
      text: "studio-mini did not come back after the restart",
    });
  });
});

describe("the failure a host's row shows (X69, X120)", () => {
  it("shows an update's failure first, then a restart's, else none", () => {
    const restartFailed = { phase: "failed" as const, text: "studio-mini did not come back after the restart" };
    expect(rowFailure("the download took longer than 5 minutes", restartFailed)).toBe("the download took longer than 5 minutes");
    expect(rowFailure(null, restartFailed)).toBe("studio-mini did not come back after the restart");
    expect(rowFailure(null, { phase: "restarting", from: 4242, since: 1_000 })).toBeNull();
    expect(rowFailure(null, undefined)).toBeNull();
  });
});
