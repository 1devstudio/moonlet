import { describe, expect, it } from "vitest";
import { avatarUrl } from "./projectAvatar";

describe("avatarUrl", () => {
  it("uses the GitHub owner of an https remote", () => {
    expect(avatarUrl("https://github.com/1devstudio/jaunt.git")).toBe("https://github.com/1devstudio.png?size=64");
    expect(avatarUrl("https://github.com/1devstudio/jaunt")).toBe("https://github.com/1devstudio.png?size=64");
  });

  it("uses the GitHub owner of an ssh remote", () => {
    expect(avatarUrl("git@github.com:1devstudio/jaunt.git")).toBe("https://github.com/1devstudio.png?size=64");
    expect(avatarUrl("ssh://git@github.com/1devstudio/jaunt.git")).toBe("https://github.com/1devstudio.png?size=64");
  });

  it("ignores credentials in the remote", () => {
    expect(avatarUrl("https://x-access-token:ghp_secret@github.com/acme-corp/api.git")).toBe("https://github.com/acme-corp.png?size=64");
  });

  it("has no avatar without a GitHub remote", () => {
    expect(avatarUrl(null)).toBeNull();
    expect(avatarUrl("")).toBeNull();
    expect(avatarUrl("git@gitlab.com:acme/api.git")).toBeNull();
    expect(avatarUrl("https://github.example.com/acme/api.git")).toBeNull();
    expect(avatarUrl("/Users/me/src/origin.git")).toBeNull();
  });
});
