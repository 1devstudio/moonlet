import { describe, expect, it } from "vitest";
import { opensHere, signInToast } from "./browserRoute";

describe("sign-ins open where you are (X75)", () => {
  it("the_toast_names_the_member_and_session", () => {
    expect(signInToast({ url: "https://accounts.example.test/", from: "studio-mini", session: "s1", session_name: "deploy-fix" })).toBe("studio-mini · deploy-fix opened a sign-in");
    expect(signInToast({ url: "https://accounts.example.test/", from: "studio-mini" })).toBe("studio-mini opened a sign-in");
  });

  it("opens only http and https URLs from this Mac's own daemon", () => {
    expect(opensHere("local", { url: "https://github.com/login/device", from: "MacBook" })).toBe(true);
    expect(opensHere("mini", { url: "https://github.com/login/device", from: "studio-mini" })).toBe(false);
    expect(opensHere("local", { url: "file:///etc/passwd", from: "MacBook" })).toBe(false);
    expect(opensHere("local", { url: "javascript:alert(1)", from: "MacBook" })).toBe(false);
  });
});
