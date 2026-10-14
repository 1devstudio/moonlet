import { describe, expect, it } from "vitest";
import { hostMeta, hostRoute, hostWord } from "./hosts";

const NOW = 1_760_000_000_000;

describe("hostWord", () => {
  it("says connected, connecting or offline", () => {
    expect(hostWord("connected")).toBe("connected");
    expect(hostWord("connecting")).toBe("connecting");
    expect(hostWord("reconnecting")).toBe("connecting");
    expect(hostWord("error")).toBe("offline");
    expect(hostWord("needs_install")).toBe("offline");
  });
});

describe("hostRoute", () => {
  it("shows a Mac's direct link with its round trip", () => {
    expect(hostRoute({ status: "connected", via: null }, { latencyMs: 14.2, lastSeen: NOW }, NOW)).toBe("Paired · direct over Tailscale · 14 ms");
    expect(hostRoute({ status: "connected", via: null }, { latencyMs: null, lastSeen: NOW }, NOW)).toBe("Paired · direct over Tailscale");
  });

  it("shows which Mac an SSH host is reached through", () => {
    expect(hostRoute({ status: "connected", via: "studio-mac" }, { latencyMs: 40, lastSeen: NOW }, NOW)).toBe("Reached through studio-mac over SSH");
  });

  it("says when an offline host was last seen, and that its sessions go on", () => {
    expect(hostRoute({ status: "error", via: "studio-mac" }, { latencyMs: null, lastSeen: NOW - 2 * 3_600_000 }, NOW)).toBe(
      "Last seen 2 h ago · sessions keep running",
    );
    expect(hostRoute({ status: "error", via: null }, { latencyMs: null, lastSeen: null }, NOW)).toBe("Not reachable over Tailscale");
  });
});

describe("hostMeta", () => {
  it("counts sessions and terminals after the daemon version", () => {
    expect(hostMeta("0.1.16", 6, 9)).toBe("moonletd 0.1.16 · 6 sessions · 9 terminals");
    expect(hostMeta("0.1.15", 1, 1)).toBe("moonletd 0.1.15 · 1 session · 1 terminal");
    expect(hostMeta(null, 0, 0)).toBe("");
  });
});
