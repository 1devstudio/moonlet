import { describe, expect, it } from "vitest";
import { branchPreview, defaultStartLabel, gitHosts, gitSettingsOf, prefixError, tooOldText, worktreesText } from "./gitSettings";
import type { HostInfo } from "./protocol";

const host = (id: string, label: string, remote: boolean, status: HostInfo["status"] = "connected"): HostInfo => ({
  id,
  label,
  remote,
  status,
  message: null,
  daemon_version: null,
  hostname: null,
  home: null,
});

describe("gitSettingsOf", () => {
  it("stages all and opens ready PRs on a host whose settings are not known", () => {
    expect(gitSettingsOf({}, "local")).toEqual({ branch_prefix: "moonlet/", start_from: "local", stage_all: true, draft_prs: false });
    expect(gitSettingsOf({ devbox: null }, "devbox")).toEqual({ branch_prefix: "moonlet/", start_from: "local", stage_all: true, draft_prs: false });
  });

  it("is what the host's daemon keeps", () => {
    const devbox = { branch_prefix: "", start_from: "origin", stage_all: false, draft_prs: true } as const;
    expect(gitSettingsOf({ devbox }, "devbox")).toEqual(devbox);
  });
});

describe("gitHosts", () => {
  it("lists This Mac, then each connected remote host by its label", () => {
    const hosts = { local: host("local", "local", false), devbox: host("devbox", "devbox", true), mini: host("mini", "studio-mini", true, "reconnecting") };
    expect(gitHosts(hosts)).toEqual([
      { id: "local", label: "This Mac" },
      { id: "devbox", label: "devbox" },
    ]);
  });

  it("is only This Mac without remote hosts", () => {
    expect(gitHosts({ local: host("local", "local", false) })).toEqual([{ id: "local", label: "This Mac" }]);
  });
});

describe("tooOldText", () => {
  it("names the host whose daemon is too old", () => {
    expect(tooOldText("devbox")).toBe("devbox's moonletd is too old for Git settings. Reinstall the helper from Hosts.");
  });
});

describe("prefixError", () => {
  it("takes what git takes in a branch name, empty included", () => {
    for (const ok of ["", "moonlet/", "marcin/", "feat/", "a.b-c_d/"]) expect(prefixError(ok)).toBe("");
  });

  it("says which characters git rejects", () => {
    for (const bad of ["my prefix/", "a~", "a^", "a:", "a?", "a*", "a[", "a\\b"]) expect(prefixError(bad)).toBe("Branch names cannot hold spaces or ~ ^ : ? * [ \\");
    for (const bad of ["a..b/", "a//", "a@{"]) expect(prefixError(bad)).toBe("Branch names cannot hold .., // or @{");
    for (const bad of ["/a", ".a", "-a"]) expect(prefixError(bad)).toBe("Start with a letter or digit.");
  });
});

describe("new session branches", () => {
  it("previews the prefix before a session's name", () => {
    expect(branchPreview("marcin/")).toBe("marcin/add-search-to-the-product-list");
    expect(branchPreview("")).toBe("add-search-to-the-product-list");
  });

  it("names the default start point in the composer", () => {
    expect(defaultStartLabel("main", "local")).toBe("Start from main (default)");
    expect(defaultStartLabel("develop", "origin")).toBe("Start from origin/develop (default)");
  });

  it("shows the worktrees folder under the user's home as ~", () => {
    expect(worktreesText("/Users/alex/.moonlet", "/Users/alex")).toBe("~/.moonlet/worktrees/‹project›/‹session›");
    expect(worktreesText("/srv/moonlet", "/home/alex")).toBe("/srv/moonlet/worktrees/‹project›/‹session›");
  });
});
