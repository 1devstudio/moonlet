import { describe, expect, it } from "vitest";
import { addSignIn, dropSignIn, signInCard, signInKey, takesSignIn } from "./signIns";

const show = { url: "https://github.com/login/device", from: "studio-mini", session: "s1", session_name: "deploy-fix", to: "phone" };

describe("a sign-in on the phone (X75)", () => {
  it("takes only the URLs the central host found the user here for", () => {
    expect(takesSignIn(show)).toBe(true);
    expect(takesSignIn({ ...show, to: undefined })).toBe(false);
    expect(takesSignIn({ ...show, url: "file:///etc/passwd" })).toBe(false);
  });

  it("names the page's host and who asked", () => {
    expect(signInCard(show)).toEqual({ title: "studio-mini · deploy-fix opened a sign-in", site: "github.com", mac: false, code: null });
  });

  it("says a sign-in that comes back to localhost finishes on a Mac", () => {
    expect(signInCard({ ...show, url: "https://accounts.google.com/o/oauth2/auth", forward: 8085 })).toEqual({
      title: "studio-mini · deploy-fix opened a sign-in",
      site: "accounts.google.com",
      mac: true,
      code: null,
    });
  });

  it("shows the one-time code the command printed", () => {
    expect(signInCard({ ...show, code: "AB12-CD34" }).code).toBe("AB12-CD34");
  });

  it("keeps one card per URL, newest first", () => {
    const one = addSignIn([], "mini", show);
    expect(addSignIn(one, "mini", show)).toHaveLength(1);
    expect(addSignIn(one, "mini", { ...show, url: "https://x.test/" }).map((s) => s.show.url)).toEqual(["https://x.test/", show.url]);
  });

  it("keeps the same page asked for by two members, or through two hosts, as cards of their own", () => {
    const two = addSignIn(addSignIn([], "mini", show), "mini", { ...show, from: "build-box", session: "s2", session_name: "release" });
    expect(two.map((s) => s.show.from)).toEqual(["build-box", "studio-mini"]);
    const three = addSignIn(two, "book", show);
    expect(three).toHaveLength(3);
    // Dismissing one leaves the others.
    expect(dropSignIn(three, signInKey(three[0])).map((s) => `${s.host} ${s.show.from}`)).toEqual(["mini build-box", "mini studio-mini"]);
  });
});
