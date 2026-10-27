import { describe, expect, it } from "vitest";
import type { HostInfo } from "./protocol";
import { failureShown, followUpdate, olderHosts, olderHostsText, offerNotice, updateAllLabel, updateFailed, updateOffer } from "./hostUpdate";

const host = (patch: Partial<HostInfo>): HostInfo => ({
  id: "studio-mini",
  label: "studio-mini",
  remote: true,
  kind: "tailnet",
  status: "connected",
  message: null,
  daemon_version: "0.1.33",
  hostname: null,
  home: null,
  ...patch,
});

describe("which hosts can be updated from here (X69)", () => {
  it("offers this Mac's version to an older tailnet host, connected or not", () => {
    expect(updateOffer(host({ status: "needs_update" }), "0.1.34")).toBe("0.1.34");
    expect(updateOffer(host({ status: "connected" }), "0.1.34")).toBe("0.1.34");
    // 0.1.9 is older than 0.1.10.
    expect(updateOffer(host({ daemon_version: "0.1.9" }), "0.1.10")).toBe("0.1.10");
  });

  it("offers nothing to a host that is as new or newer, unknown, an SSH host or this Mac", () => {
    expect(updateOffer(host({ daemon_version: "0.1.34" }), "0.1.34")).toBeNull();
    expect(updateOffer(host({ daemon_version: "0.1.35", status: "needs_update" }), "0.1.34")).toBeNull();
    expect(updateOffer(host({ daemon_version: null, status: "needs_update" }), "0.1.34")).toBeNull();
    expect(updateOffer(host({ kind: "ssh" }), "0.1.34")).toBeNull();
    expect(updateOffer(host({ id: "local", remote: false, kind: "local" }), "0.1.34")).toBeNull();
    expect(updateOffer(host({ status: "refused" }), "0.1.34")).toBeNull();
    expect(updateOffer(host({}), "")).toBeNull();
  });

  it("updates every older host at once", () => {
    const hosts = [
      host({ id: "studio-mini", label: "studio-mini" }),
      host({ id: "build-box", label: "build-box", status: "needs_update", daemon_version: "0.1.30", os: "linux" }),
      host({ id: "fresh", label: "fresh", daemon_version: "0.1.34" }),
      host({ id: "devbox", label: "devbox", kind: "ssh" }),
    ];
    expect(olderHosts(hosts, "0.1.34").map((h) => h.id)).toEqual(["studio-mini", "build-box"]);
    expect(updateAllLabel(2)).toBe("Update all (2)");
  });

  it("tells once that hosts run an older moonlet", () => {
    expect(olderHostsText([host({})], "0.1.34")).toBe("studio-mini runs an older moonlet");
    expect(olderHostsText([host({}), host({ id: "build-box", label: "build-box" })], "0.1.34")).toBe("2 hosts run an older moonlet");
    expect(olderHostsText([host({ daemon_version: "0.1.34" })], "0.1.34")).toBeNull();
  });
});

describe("following an update (X69)", () => {
  const updating = { phase: "updating" as const, to: "0.1.34", since: 1_000 };

  it("ends when the host is back on the new version", () => {
    expect(followUpdate(updating, host({ status: "connected", daemon_version: "0.1.34" }), 9_000)).toEqual({ next: null, reconnect: false });
  });

  it("asks the host again while it waits for a retry, and waits while it connects", () => {
    expect(followUpdate(updating, host({ status: "needs_update" }), 5_000)).toEqual({ next: updating, reconnect: true });
    expect(followUpdate(updating, host({ status: "error", message: "connection refused" }), 5_000)).toEqual({ next: updating, reconnect: true });
    expect(followUpdate(updating, host({ status: "reconnecting" }), 5_000)).toEqual({ next: updating, reconnect: false });
    // Still the old daemon, before the handoff.
    expect(followUpdate(updating, host({ status: "connected", daemon_version: "0.1.33" }), 5_000)).toEqual({ next: updating, reconnect: false });
  });

  it("says when the host is back but still on the old version", () => {
    // The handoff failed after the reply, so the old daemon kept serving.
    expect(followUpdate(updating, host({ status: "connected", daemon_version: "0.1.33" }), 61_001)).toEqual({
      next: { phase: "failed", text: "studio-mini still runs moonlet 0.1.33: the update did not finish there (see its moonletd log)", command: null },
      reconnect: false,
    });
  });

  it("gives up a minute after the reply", () => {
    expect(followUpdate(updating, host({ status: "reconnecting" }), 61_001)).toEqual({
      next: { phase: "failed", text: "studio-mini did not come back after the update", command: null },
      reconnect: false,
    });
  });

  it("shows the manual way for a host from before X69", () => {
    const tooOld = (label: string, version: string) => ({ code: "too_old", message: `${label} runs moonlet ${version}, which can't be updated from here` });
    expect(updateFailed(host({ os: "macos" }), tooOld("studio-mini", "0.1.33"))).toEqual({
      phase: "failed",
      text: "studio-mini runs moonlet 0.1.33, which can't be updated from here. Update it from its Settings › Updates.",
      command: null,
    });
    expect(updateFailed(host({ id: "build-box", label: "build-box", os: "linux" }), tooOld("build-box", "0.1.32"))).toEqual({
      phase: "failed",
      text: "build-box runs moonlet 0.1.32, which can't be updated from here: run this there",
      command: "curl -fsSL https://github.com/1devstudio/moonlet/releases/latest/download/install.sh | sh",
    });
  });

  it("shows any other error as the host's", () => {
    expect(updateFailed(host({}), { code: "bad_signature", message: "the release's signature does not match moonlet's key" })).toEqual({
      phase: "failed",
      text: "the release's signature does not match moonlet's key",
      command: null,
    });
  });
});

describe("what stays on a host's row after an update (X69)", () => {
  const failed = { phase: "failed" as const, text: "studio-mini did not come back after the update", command: null };

  it("keeps a failure until the host runs this Mac's version, whatever its state", () => {
    expect(failureShown(failed, host({ status: "reconnecting" }), "0.1.34")).toBe(failed);
    expect(failureShown(failed, host({ status: "error", message: "connection refused" }), "0.1.34")).toBe(failed);
    expect(failureShown(failed, host({ status: "connected", daemon_version: "0.1.33" }), "0.1.34")).toBe(failed);
    expect(failureShown(failed, host({ status: "connected", daemon_version: "0.1.34" }), "0.1.34")).toBeNull();
    expect(failureShown(undefined, host({}), "0.1.34")).toBeNull();
  });

  it("puts a connected older host in the sidebar, where only hosts in trouble showed", () => {
    expect(offerNotice(host({ status: "connected", daemon_version: "0.1.33" }), "0.1.34")).toBe("studio-mini runs moonlet 0.1.33");
    expect(offerNotice(host({ status: "connected", daemon_version: "0.1.34" }), "0.1.34")).toBeNull();
    expect(offerNotice(host({ status: "needs_update" }), "0.1.34")).toBeNull();
  });
});
