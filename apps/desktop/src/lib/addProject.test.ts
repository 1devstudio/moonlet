import { describe, expect, it } from "vitest";
import { beforeEach } from "vitest";
import type { CloneDone, CloneProgress } from "./protocol";
import { afterCloneDone, runsAfterProgress, afterCloneProgress, cantSee, ghLine, targetTaken, repoParts, clonePath, cloneTabState, cloneIntoHint, moveHighlight, clonePercent, cloneStepRows, cloneParent, diskSize, matchingRepos, pushedAgo, rememberCloneParent, repoOwners, repoRef } from "./addProject";

describe("repoRef", () => {
  it("reads GitHub URLs and owner/repo as the repository", () => {
    for (const input of [
      "https://github.com/acme/storefront",
      "https://github.com/acme/storefront.git",
      "https://github.com/acme/storefront/tree/main/src",
      "github.com/acme/storefront",
      "  acme/storefront ",
    ]) {
      expect(repoRef(input), input).toEqual({ repo: "acme/storefront" });
    }
  });

  it("keeps an SSH address, in the form the daemon accepts", () => {
    expect(repoRef("git@github.com:acme/storefront.git")).toEqual({ repo: "acme/storefront", ssh: "git@github.com:acme/storefront.git" });
    expect(repoRef("ssh://git@github.com/acme/storefront.git")).toEqual({ repo: "acme/storefront", ssh: "git@github.com:acme/storefront.git" });
  });

  it("reads folders, other forges and plain words as no repository", () => {
    for (const input of ["storefront", "https://gitlab.com/acme/storefront", "~/code/storefront", "/Users/alex/code", "./acme/storefront", "acme/store front", "-x/y", ""]) {
      expect(repoRef(input), input).toBeNull();
    }
  });
});

describe("pushedAgo", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  it("reads minutes, hours, yesterday, days and weeks, then the date", () => {
    expect(pushedAgo("2026-10-21T11:59:31Z", now)).toBe("just now");
    expect(pushedAgo("2026-10-21T11:15:00Z", now)).toBe("45m ago");
    expect(pushedAgo("2026-10-21T10:00:00Z", now)).toBe("2h ago");
    expect(pushedAgo("2026-10-20T11:00:00Z", now)).toBe("yesterday");
    expect(pushedAgo("2026-10-18T12:00:00Z", now)).toBe("3d ago");
    expect(pushedAgo("2026-10-07T12:00:00Z", now)).toBe("2w ago");
    expect(pushedAgo("2026-03-12T09:00:00Z", now)).toBe("12 Mar 2026");
  });
});

describe("diskSize", () => {
  it("reads KB as MB, or GB from 1024 MB", () => {
    expect(diskSize(0)).toBe("<1 MB");
    expect(diskSize(4911)).toBe("5 MB");
    expect(diskSize(49_152)).toBe("48 MB");
    expect(diskSize(2_621_440)).toBe("2.5 GB");
  });
});

describe("matchingRepos", () => {
  const repos = ["acme/storefront", "acme/storefront-admin", "acme/payments-api", "sam-rivera/store-locator", "acme/web", "acme/store-1", "acme/store-2", "acme/store-3"].map((repo) => ({ repo }));

  it("keeps those whose owner/repo holds the text, in any case, up to 6", () => {
    expect(matchingRepos(repos, "STORE").map((r) => r.repo)).toEqual(["acme/storefront", "acme/storefront-admin", "sam-rivera/store-locator", "acme/store-1", "acme/store-2", "acme/store-3"]);
    expect(matchingRepos(repos, "sam-").map((r) => r.repo)).toEqual(["sam-rivera/store-locator"]);
    expect(matchingRepos(repos, "  ").map((r) => r.repo)).toEqual(["acme/storefront", "acme/storefront-admin", "acme/payments-api", "sam-rivera/store-locator", "acme/web", "acme/store-1"]);
  });

  it("names the owners in the list", () => {
    expect(repoOwners(matchingRepos(repos, "store"))).toBe("acme, sam-rivera");
    expect(repoOwners([])).toBe("");
  });
});

describe("cloneParent", () => {
  beforeEach(() => localStorage.clear());

  it("starts at ~/moonlet, then remembers the last parent of each host", () => {
    expect(cloneParent("local")).toBe("~/moonlet");
    rememberCloneParent("local", "~/code");
    rememberCloneParent("devbox", "~/src");
    expect(cloneParent("local")).toBe("~/code");
    expect(cloneParent("devbox")).toBe("~/src");
    expect(cloneParent("studio-mini")).toBe("~/moonlet");
  });

  it("starts at ~/moonlet when what was stored cannot be read", () => {
    localStorage.setItem("moonlet.cloneParents", "{not json");
    expect(cloneParent("local")).toBe("~/moonlet");
  });
});

describe("clone progress", () => {
  const event = (step: CloneProgress["step"], current: number, total: number, size: string | null = null, speed: string | null = null): CloneProgress => ({
    id: "clone-1",
    repo: "acme/storefront",
    path: "/Users/alex/moonlet/storefront",
    step,
    current,
    total,
    size,
    speed,
  });

  it("reads nothing yet as three waiting steps at 0%", () => {
    expect(cloneStepRows({})).toEqual([
      { text: "Counting objects", state: "waiting" },
      { text: "Receiving objects", state: "waiting" },
      { text: "Resolving deltas", state: "waiting" },
    ]);
    expect(clonePercent({})).toBe(0);
  });

  it("checks a finished step, spins the running one, with git's counts, size and speed", () => {
    const steps = [event("counting", 1, 2935), event("counting", 2935, 2935), event("receiving", 8213, 12840, "21.40 MiB", "6.20 MiB/s")].reduce(afterCloneProgress, {});
    expect(cloneStepRows(steps)).toEqual([
      { text: "Counting objects 2,935", state: "done" },
      { text: "Receiving objects 8,213/12,840 · 21.40 MiB · 6.20 MiB/s", state: "running" },
      { text: "Resolving deltas", state: "waiting" },
    ]);
    // 10 + 80 × 8213/12840 = 61.17
    expect(clonePercent(steps)).toBe(61);
  });

  it("counts a step git skipped as done once a later one starts", () => {
    const steps = [event("receiving", 3, 3), event("resolving", 1, 4)].reduce(afterCloneProgress, {});
    expect(cloneStepRows(steps).map((r) => r.state)).toEqual(["done", "done", "running"]);
    // 10 + 80 + 10 × 1/4
    expect(clonePercent(steps)).toBe(92);
    expect(clonePercent(afterCloneProgress(steps, event("resolving", 4, 4)))).toBe(100);
  });
});

describe("dialog messages", () => {
  const signedIn = { installed: true, login: "sam-rivera" };
  const signedOut = { installed: true, login: null };

  it("says who cannot see a repository, and asks to sign in when gh is not", () => {
    expect(cantSee("This Mac", "acme/nope", signedIn)).toEqual({
      title: "This Mac can't see acme/nope",
      body: "It doesn't exist, or sam-rivera has no access to it.",
      signIn: false,
    });
    expect(cantSee("devbox", "acme/infra-terraform", signedOut)).toEqual({
      title: "devbox can't see acme/infra-terraform",
      body: "gh isn't signed in on devbox, so only public repositories can be cloned there. Sign in once on that host, then try again.",
      signIn: true,
    });
    expect(cantSee("devbox", "acme/infra-terraform", { installed: false, login: null })).toEqual({
      title: "devbox can't see acme/infra-terraform",
      body: "gh isn't installed on devbox, so only public repositories can be cloned there. Install gh and sign in once on that host, then try again.",
      signIn: true,
    });
  });

  it("tells whether gh is signed in, signed out or missing on the host", () => {
    expect(ghLine("This Mac", signedIn)).toEqual({ text: "gh signed in on This Mac", ok: true });
    expect(ghLine("devbox", signedOut)).toEqual({ text: "gh not signed in on devbox", ok: false });
    expect(ghLine("devbox", { installed: false, login: null })).toEqual({ text: "gh is not installed on devbox", ok: false });
    // A daemon from before X59 does not know repo.gh_status.
    expect(ghLine("devbox", "too-old")).toEqual({ text: "devbox's moonletd is too old to clone from GitHub. Update moonlet there.", ok: false });
  });

  it("offers the existing clone or a free name when the folder is taken", () => {
    const free = { path: "/Users/alex/code/storefront", exists: false, same_repo: false, branch: null, free_name: "storefront" };
    expect(targetTaken(free, "acme/storefront", "~/code/storefront")).toBeNull();
    expect(targetTaken({ ...free, exists: true, same_repo: true, branch: "main", free_name: "storefront-2" }, "acme/storefront", "~/code/storefront")).toEqual({
      path: "~/code/storefront",
      body: "It's already a clone of acme/storefront, on main. Add that folder as the project, or pick another name to clone fresh.",
      addExisting: true,
      useName: "storefront-2",
    });
    expect(targetTaken({ ...free, exists: true, free_name: "storefront-3" }, "acme/storefront", "~/code/storefront")).toEqual({
      path: "~/code/storefront",
      body: "It isn't a clone of acme/storefront. Pick another name to clone fresh.",
      addExisting: false,
      useName: "storefront-3",
    });
  });
});

describe("clone runs", () => {
  const job = { id: "clone-1", repo: "acme/storefront", path: "/Users/alex/code/storefront" };
  const started = { "local/clone-1": { host: "local", job, steps: {}, parent: "~/code", workspace: "ws-acme" } };
  const project = { id: "p-9", name: "storefront", path: "/Users/alex/code/storefront", base_branch: "main" };
  const done = (d: Partial<CloneDone>): CloneDone => ({ ...job, project: null, error: null, cancelled: false, ...d });

  it("follows the progress of a clone, also one another window started", () => {
    const p: CloneProgress = { ...job, step: "receiving", current: 5, total: 10, size: null, speed: null };
    expect(runsAfterProgress(started, "local", p)["local/clone-1"].steps).toEqual({ receiving: { current: 5, total: 10, size: null, speed: null } });
    expect(runsAfterProgress({}, "devbox", p)).toEqual({ "devbox/clone-1": { host: "devbox", job, steps: { receiving: { current: 5, total: 10, size: null, speed: null } } } });
  });

  it("adds the project: a toast, the parent remembered, the composer when the dialog watched", () => {
    expect(afterCloneDone(started, "local", done({ project }), "local/clone-1")).toEqual({
      runs: {},
      open: { host: "local", project, workspace: "ws-acme" },
      toast: { text: "Added storefront", kind: "info" },
      remember: { host: "local", parent: "~/code" },
    });
    expect(afterCloneDone(started, "local", done({ project }), null)).toEqual({
      runs: {},
      toast: { text: "Added storefront", kind: "info" },
      remember: { host: "local", parent: "~/code" },
    });
  });

  it("keeps a failure for the dialog that watches it, else says it in a toast", () => {
    const failed = done({ error: "repository 'https://github.com/acme/storefront.git/' not found" });
    expect(afterCloneDone(started, "local", failed, "local/clone-1")).toEqual({
      runs: { "local/clone-1": { ...started["local/clone-1"], error: "repository 'https://github.com/acme/storefront.git/' not found" } },
    });
    expect(afterCloneDone(started, "local", failed, null)).toEqual({
      runs: {},
      toast: { text: "Cloning acme/storefront failed: repository 'https://github.com/acme/storefront.git/' not found", kind: "error" },
    });
  });

  it("forgets a cancelled clone quietly", () => {
    expect(afterCloneDone(started, "local", done({ cancelled: true }), "local/clone-1")).toEqual({ runs: {} });
  });
});

describe("repository and folder strings", () => {
  it("splits owner/repo in one place", () => {
    expect(repoParts("acme/storefront")).toEqual({ owner: "acme", name: "storefront" });
  });

  it("joins Clone into's parent and name as typed", () => {
    expect(clonePath("~/code", "storefront")).toBe("~/code/storefront");
    expect(clonePath(" ~/code/ ", " storefront ")).toBe("~/code/storefront");
  });

  it("explains Clone into for This Mac and for a remote host", () => {
    expect(cloneIntoHint(true, "This Mac")).toBe("The parent folder is remembered for the next clone.");
    expect(cloneIntoHint(false, "devbox")).toBe("A path on devbox. No Browse… for remote hosts.");
  });
});

describe("cloneTabState", () => {
  const signedIn = { installed: true, login: "sam-rivera" };
  const free = { path: "/Users/alex/moonlet/storefront", exists: false, same_repo: false, branch: null, free_name: "storefront" };
  const base = { text: "", gh: signedIn, found: false, target: null, cloning: false, busy: false };

  it("lists the user's repositories for text that is not a repository, only with gh signed in", () => {
    expect(cloneTabState({ ...base, text: "store" }).listing).toBe(true);
    expect(cloneTabState({ ...base, text: "" }).listing).toBe(true);
    expect(cloneTabState({ ...base, text: "acme/storefront" }).listing).toBe(false);
    expect(cloneTabState({ ...base, text: "store", gh: { installed: true, login: null } }).listing).toBe(false);
    expect(cloneTabState({ ...base, text: "store", gh: null }).listing).toBe(false);
    expect(cloneTabState({ ...base, text: "store", cloning: true }).listing).toBe(false);
  });

  it("can clone a found repository into a free folder, once", () => {
    expect(cloneTabState({ ...base, text: "acme/storefront", found: true, target: free }).canClone).toBe(true);
    expect(cloneTabState({ ...base, text: "acme/storefront", found: true, target: { ...free, exists: true } }).canClone).toBe(false);
    expect(cloneTabState({ ...base, text: "acme/storefront", found: true, target: null }).canClone).toBe(false);
    expect(cloneTabState({ ...base, text: "acme/storefront", found: false, target: free }).canClone).toBe(false);
    expect(cloneTabState({ ...base, text: "acme/storefront", found: true, target: free, busy: true }).canClone).toBe(false);
  });
});

describe("moveHighlight", () => {
  it("moves with the arrow keys and wraps around", () => {
    expect(moveHighlight(0, "ArrowDown", 3)).toBe(1);
    expect(moveHighlight(2, "ArrowDown", 3)).toBe(0);
    expect(moveHighlight(0, "ArrowUp", 3)).toBe(2);
  });
});
