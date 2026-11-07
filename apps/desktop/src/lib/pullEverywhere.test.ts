import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseStatus, HostInfo, Project, ProjectIdentity } from "./protocol";
import { pullBase, pullBaseEverywhere, useStore } from "./store";

const daemon = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./daemon", async (original) => ({ ...(await original<typeof import("./daemon")>()), rpc: daemon.rpc }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));

const identity = { origin: "github.com/acme/ledger", root: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" };
const shop = { origin: "github.com/acme/shop", root: "1111111111111111111111111111111111111111" };
const host = (id: string, label: string, status: HostInfo["status"] = "connected") => ({ id, label, remote: id !== "local", status, message: null, daemon_version: null, hostname: null, home: null }) as HostInfo;
const project = (id: string, path: string, i: ProjectIdentity = identity): Project => ({ id, name: "ledger", path, base_branch: "main", identity: i });
const behind = (n: number, ahead = 0): BaseStatus =>
  ({ branch: "main", upstream: "origin/main", ahead, behind: n, commits: [], checkout: null, fetch_error: null }) as BaseStatus;

/** Each host's daemon: how far main is behind origin there as last
 *  fetched, how far after a fetch (`fetched`), and what a pull does. */
type Daemon = { behind: number; ahead?: number; fetched?: number; fetchError?: string; head?: string };
function daemons(state: Record<string, Daemon>) {
  daemon.rpc.mockImplementation(async (h: string, method: string, params: { fetch?: boolean }) => {
    const s = state[h];
    if (method === "git.base_status") {
      if (params.fetch && s.fetchError) return { ...behind(s.behind, s.ahead ?? 0), fetch_error: s.fetchError };
      if (params.fetch && s.fetched !== undefined) s.behind = s.fetched;
      return behind(s.behind, s.ahead ?? 0);
    }
    if (method === "git.pull_base") {
      if (s.ahead) throw new Error("main has diverged from origin/main");
      const pulled = s.behind;
      s.behind = 0;
      return { pulled, head: s.head ?? "9c41e2a0" };
    }
    return null;
  });
}

const shown = () => useStore.getState().toasts.map((t) => t.text);

describe("pulling a project's base branch on every host that has it", () => {
  beforeEach(() => {
    daemon.rpc.mockReset();
    useStore.setState({
      toasts: [],
      base: {},
      gitSettings: {},
      hosts: { local: host("local", "This Mac"), mini: host("mini", "studio-mini"), vps: host("vps", "build-box") },
      projects: {
        local: [project("p1", "/Users/me/ledger")],
        mini: [project("m7", "/Users/me/src/ledger")],
        // Another repository first, so the match is by identity.
        vps: [project("v3", "/home/me/shop", shop), project("v4", "/home/me/ledger")],
      },
    });
  });

  it("pulls on the other hosts too and says so in one toast", async () => {
    daemons({ local: { behind: 3 }, mini: { behind: 2 }, vps: { behind: 0 } });
    await pullBaseEverywhere("local", "p1");
    expect(shown()).toEqual(["Pulled 3 commits into main. New sessions start from 9c41e2a. studio-mini: pulled 2 commits. build-box: already up to date."]);
  });

  it("fetches on the other host first, as its last fetch may be old", async () => {
    daemons({ local: { behind: 3 }, mini: { behind: 0, fetched: 3 }, vps: { behind: 0 } });
    await pullBaseEverywhere("local", "p1");
    expect(shown()).toEqual(["Pulled 3 commits into main. New sessions start from 9c41e2a. studio-mini: pulled 3 commits. build-box: already up to date."]);
  });

  it("leaves a copy with commits of its own alone and says so", async () => {
    daemons({ local: { behind: 3 }, mini: { behind: 2, ahead: 1 }, vps: { behind: 0 } });
    await pullBaseEverywhere("local", "p1");
    expect(shown()).toEqual(["Pulled 3 commits into main. New sessions start from 9c41e2a. studio-mini: main can't be fast-forwarded, nothing changed. build-box: already up to date."]);
    expect(useStore.getState().base["mini/m7"]).toMatchObject({ pulling: false, status: { ahead: 1, behind: 2 } });
  });

  it("says a host that couldn't fetch didn't pull, rather than that it is up to date", async () => {
    daemons({ local: { behind: 3 }, mini: { behind: 0, fetchError: "Could not resolve host: github.com" }, vps: { behind: 0 } });
    await pullBaseEverywhere("local", "p1");
    expect(shown()).toEqual(["Pulled 3 commits into main. New sessions start from 9c41e2a. studio-mini: couldn't pull: couldn't fetch origin/main. build-box: already up to date."]);
  });

  it("skips a host that is not connected", async () => {
    daemons({ local: { behind: 3 }, mini: { behind: 2 }, vps: { behind: 0 } });
    useStore.setState((s) => ({ hosts: { ...s.hosts, mini: host("mini", "studio-mini", "reconnecting") } }));
    await pullBaseEverywhere("local", "p1");
    expect(shown()).toEqual(["Pulled 3 commits into main. New sessions start from 9c41e2a. build-box: already up to date."]);
  });

  it("pulls a project without a root commit only where it was clicked", async () => {
    daemons({ local: { behind: 3 }, mini: { behind: 2 }, vps: { behind: 0 } });
    const alone = { origin: null, root: null };
    useStore.setState({ projects: { local: [project("p1", "/Users/me/ledger", alone)], mini: [project("m7", "/Users/me/src/ledger", alone)] } });
    await pullBaseEverywhere("local", "p1");
    expect(shown()).toEqual(["Pulled 3 commits into main. New sessions start from 9c41e2a."]);
  });

  it("still pulls on the other hosts when the clicked one fails", async () => {
    daemons({ local: { behind: 3, ahead: 1 }, mini: { behind: 2 }, vps: { behind: 0 } });
    await pullBaseEverywhere("local", "p1");
    expect(useStore.getState().toasts.map((t) => [t.kind, t.text])).toEqual([
      ["error", "main has diverged from origin/main"],
      ["info", "studio-mini: pulled 2 commits. build-box: already up to date."],
    ]);
  });
});

describe("pulling on one host (X55's automatic fast-forward)", () => {
  it("leaves the other hosts' copies alone", async () => {
    useStore.setState({
      toasts: [],
      base: {},
      hosts: { local: host("local", "This Mac"), mini: host("mini", "studio-mini") },
      projects: { local: [project("p1", "/Users/me/ledger")], mini: [project("m7", "/Users/me/src/ledger")] },
    });
    daemons({ local: { behind: 3 }, mini: { behind: 2 } });
    await pullBase("local", "p1");
    expect(shown()).toEqual(["Pulled 3 commits into main. New sessions start from 9c41e2a."]);
  });
});
