import { describe, expect, it } from "vitest";
import { ACTIVE_EVERY_MS, asksForWaitingSignIns, reportsActive, showAction, signInToast } from "./browserRoute";

describe("sign-ins open where you are (X75)", () => {
  it("the_toast_names_the_member_and_session", () => {
    expect(signInToast({ url: "https://accounts.example.test/", from: "studio-mini", session: "s1", session_name: "deploy-fix" })).toBe("studio-mini · deploy-fix opened a sign-in");
    expect(signInToast({ url: "https://accounts.example.test/", from: "studio-mini" })).toBe("studio-mini opened a sign-in");
  });

  it("opens http and https URLs from this Mac's own daemon, offers a waiting one, and leaves the phone's", () => {
    expect(showAction("local", { url: "https://github.com/login/device", from: "MacBook" })).toBe("open");
    expect(showAction("local", { url: "https://github.com/login/device", from: "MacBook", waiting: true })).toBe("offer");
    expect(showAction("local", { url: "https://github.com/login/device", from: "studio-mini", to: "phone" })).toBe("ignore");
    expect(showAction("mini", { url: "https://github.com/login/device", from: "studio-mini" })).toBe("ignore");
    expect(showAction("local", { url: "file:///etc/passwd", from: "MacBook" })).toBe("ignore");
    expect(showAction("local", { url: "javascript:alert(1)", from: "MacBook" })).toBe("ignore");
  });

  it("asks this Mac's daemon for the sign-ins that waited each time it connects", () => {
    expect(asksForWaitingSignIns({ id: "local", status: "connected" })).toBe(true);
    expect(asksForWaitingSignIns({ id: "local", status: "connecting" })).toBe(false);
    expect(asksForWaitingSignIns({ id: "studio-mini", status: "connected" })).toBe(false);
  });

  it("says the user is active at most every 30 s", () => {
    expect(ACTIVE_EVERY_MS).toBe(30_000);
    expect(reportsActive(null, 1_000)).toBe(true);
    expect(reportsActive(1_000, 30_999)).toBe(false);
    expect(reportsActive(1_000, 31_000)).toBe(true);
  });
});
