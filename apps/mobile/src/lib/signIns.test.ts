import { describe, expect, it } from "vitest";
import { addSignIn, signInCard, takesSignIn } from "./signIns";

const show = { url: "https://github.com/login/device", from: "studio-mini", session: "s1", session_name: "deploy-fix", to: "phone" };

describe("a sign-in on the phone (X75)", () => {
  it("takes only the URLs the central host found the user here for", () => {
    expect(takesSignIn(show)).toBe(true);
    expect(takesSignIn({ ...show, to: undefined })).toBe(false);
    expect(takesSignIn({ ...show, url: "file:///etc/passwd" })).toBe(false);
  });

  it("names the page's host and who asked", () => {
    expect(signInCard(show)).toEqual({ title: "studio-mini · deploy-fix opened a sign-in", site: "github.com", mac: false });
  });

  it("says a sign-in that comes back to localhost finishes on a Mac", () => {
    expect(signInCard({ ...show, url: "https://accounts.google.com/o/oauth2/auth", forward: 8085 })).toEqual({
      title: "studio-mini · deploy-fix opened a sign-in",
      site: "accounts.google.com",
      mac: true,
    });
  });

  it("keeps one card per URL, newest first", () => {
    const one = addSignIn([], "mini", show);
    expect(addSignIn(one, "mini", show)).toHaveLength(1);
    expect(addSignIn(one, "mini", { ...show, url: "https://x.test/" }).map((s) => s.show.url)).toEqual(["https://x.test/", show.url]);
  });
});
