import { describe, expect, it } from "vitest";
import { countdown, deviceLine, mobileLine, pairEndedText } from "./mobile";
import type { MobileDevice, MobileStatus } from "./protocol";

const status = (patch: Partial<MobileStatus> = {}): MobileStatus => ({
  enabled: true,
  port: 47428,
  tailscale: true,
  addresses: ["100.101.102.103"],
  listening: ["100.101.102.103:47428"],
  host: "studio-mac",
  devices: [],
  ...patch,
});

describe("mobileLine", () => {
  it("says where phones connect while listening", () => {
    expect(mobileLine(status())).toBe("Listening on 100.101.102.103:47428");
  });

  it("says Tailscale is missing when there is no tailnet address", () => {
    expect(mobileLine(status({ tailscale: false, addresses: [], listening: [] }))).toBe("Tailscale is not running on this Mac");
  });

  it("says off while phone access is off", () => {
    expect(mobileLine(status({ enabled: false, listening: [] }))).toBe("Off");
  });

  it("says it is starting before the listener is up", () => {
    expect(mobileLine(status({ listening: [] }))).toBe("Starting…");
  });
});

const NOW = 1_760_000_000_000;
const device = (patch: Partial<MobileDevice> = {}): MobileDevice => ({
  id: "a1",
  name: "Alex's iPhone",
  created_at: NOW - 20_000,
  last_seen: NOW - 20_000,
  connected: true,
  ...patch,
});

describe("deviceLine", () => {
  it("shows when it paired and that it is connected", () => {
    expect(deviceLine(device(), NOW)).toBe("paired just now · connected");
  });

  it("shows when a disconnected phone was last seen", () => {
    expect(deviceLine(device({ created_at: NOW - 3 * 86_400_000, last_seen: NOW - 2 * 3_600_000, connected: false }), NOW)).toBe(
      "paired 3 days ago · last seen 2 h ago",
    );
    expect(deviceLine(device({ created_at: NOW - 86_400_000, last_seen: NOW - 5 * 60_000, connected: false }), NOW)).toBe(
      "paired 1 day ago · last seen 5 min ago",
    );
  });

  it("says never seen for a phone that never came back", () => {
    expect(deviceLine(device({ last_seen: null, connected: false }), NOW)).toBe("paired just now · not seen since");
  });
});

describe("countdown", () => {
  it("counts down minutes and seconds to the code's expiry", () => {
    expect(countdown(NOW + 5 * 60_000, NOW)).toBe("Expires in 5:00");
    // Rounded up, so it never shows 0:00 before the code expires.
    expect(countdown(NOW + 61_500, NOW)).toBe("Expires in 1:02");
    expect(countdown(NOW + 500, NOW)).toBe("Expires in 0:01");
    expect(countdown(NOW + 9_000, NOW)).toBe("Expires in 0:09");
  });

  it("says expired at zero", () => {
    expect(countdown(NOW, NOW)).toBe("Expired");
    expect(countdown(NOW - 1, NOW)).toBe("Expired");
  });
});

describe("pairEndedText", () => {
  it("explains why the code stopped working", () => {
    expect(pairEndedText("too_many_attempts")).toBe("Too many wrong attempts. Start again.");
    expect(pairEndedText("expired")).toBe("The code expired. Start again.");
    expect(pairEndedText("cancelled")).toBe("Pairing was cancelled.");
  });
});
