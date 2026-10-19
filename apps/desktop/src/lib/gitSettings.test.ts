import { describe, expect, it } from "vitest";
import { branchPreview, defaultStartLabel, fetchLabel, fetchOptions, gitHosts, gitSettingsOf, prefixError, tooOldText, worktreesFolder, worktreesText } from "./gitSettings";
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
    expect(gitSettingsOf({}, "local")).toEqual({ branch_prefix: "moonlet/", start_from: "local", stage_all: true, draft_prs: false, fetch_minutes: 5, fast_forward_base: false });
    expect(gitSettingsOf({ devbox: null }, "devbox")).toEqual({ branch_prefix: "moonlet/", start_from: "local", stage_all: true, draft_prs: false, fetch_minutes: 5, fast_forward_base: false });
  });

  it("is what the host's daemon keeps", () => {
    const devbox = { branch_prefix: "", start_from: "origin", stage_all: false, draft_prs: true, fetch_minutes: 0, fast_forward_base: true } as const;
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
    for (const bad of ["team/.x/", "x.lock/", "a/b.lock/c"]) expect(prefixError(bad)).toBe("No part can start with . or end with .lock");
    expect(prefixError("a\u0007b")).toBe("Branch names cannot hold spaces or ~ ^ : ? * [ \\");
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

  it("finds the worktrees in the daemon's data folder, or ~/.moonlet for an older daemon", () => {
    expect(worktreesFolder({ home: "/Users/alex", data_dir: "/srv/moonlet" })).toBe("/srv/moonlet/worktrees");
    expect(worktreesFolder({ home: "/Users/alex" })).toBe("/Users/alex/.moonlet/worktrees");
  });

  it("shows the worktrees folder under the user's home as ~", () => {
    expect(worktreesText("/Users/alex/.moonlet/worktrees", "/Users/alex")).toBe("~/.moonlet/worktrees/‹project›/‹session›");
    expect(worktreesText("/srv/moonlet/worktrees", "/home/alex")).toBe("/srv/moonlet/worktrees/‹project›/‹session›");
  });
});

describe("Fetch from origin (X55)", () => {
  it("offers 5 min, 15 min and Manually", () => {
    expect(fetchOptions(5)).toEqual([
      { id: "5", label: "5 min" },
      { id: "15", label: "15 min" },
      { id: "0", label: "Manually" },
    ]);
  });

  it("shows an interval set in git.toml by hand as it is", () => {
    expect(fetchOptions(10).map((o) => o.label)).toEqual(["5 min", "10 min", "15 min", "Manually"]);
    expect(fetchLabel(10)).toBe("10 min");
    expect(fetchLabel(0)).toBe("Manually");
  });
});
