import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { baseChip } from "./baseSync";
import { gitSettingsOf } from "./gitSettings";
import type { BaseStatus, HostInfo, Project, ProjectIdentity } from "./protocol";
import { projKey, pullBase, pullBaseEverywhere, refreshBase, startStore, useStore } from "./store";

const daemon = vi.hoisted(() => ({ rpc: vi.fn(), emit: (_e: { host: string; name: string; data: unknown }) => {} }));
vi.mock("./daemon", async (original) => {
  const real = await original<typeof import("./daemon")>();
  return {
    ...real,
    rpc: daemon.rpc,
    onDaemonEvent: (cb: typeof daemon.emit) => ((daemon.emit = cb), Promise.resolve(() => {})),
    onHostStatus: () => Promise.resolve(() => {}),
    hostsApi: { ...real.hostsApi, list: () => Promise.resolve([]), appInfo: () => Promise.resolve({ version: "0.0.0" }) },
  };
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));

const identity = { origin: "github.com/acme/ledger", root: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" };
const shop = { origin: "github.com/acme/shop", root: "1111111111111111111111111111111111111111" };
const host = (id: string, label: string, status: HostInfo["status"] = "connected") => ({ id, label, remote: id !== "local", status, message: null, daemon_version: null, hostname: null, home: null }) as HostInfo;
const project = (id: string, path: string, i: ProjectIdentity = identity): Project => ({ id, name: "ledger", path, base_branch: "main", identity: i });
const status = (behind: number, ahead: number, fetch_error: string | null = null): BaseStatus => ({ branch: "main", upstream: "origin/main", ahead, behind, commits: [], checkout: null, fetch_error });

/** One host's daemon: how far main is behind origin as last fetched, how
 *  far after a fetch (`fetched`), a failed fetch, no origin/main at all,
 *  and a pull that waits for `hold`. */
type Daemon = { behind: number; ahead?: number; fetched?: number; fetchError?: string; noUpstream?: boolean; hold?: Promise<void>; holdFetch?: Promise<void> };

function daemons(state: Record<string, Daemon>) {
  daemon.rpc.mockImplementation(async (h: string, method: string, params: { path: string; fetch?: boolean }) => {
    const s = state[`${h}:${params.path}`] ?? state[h];
    if (method === "git.base_status") {
      if (s.noUpstream) return null;
      if (params.fetch && s.fetchError) return status(s.behind, s.ahead ?? 0, s.fetchError);
      if (params.fetch && s.fetched !== undefined) s.behind = s.fetched;
      const read = status(s.behind, s.ahead ?? 0);
      // The next fetch answers late, with what it read before.
      const late = params.fetch ? s.holdFetch : undefined;
      if (late) s.holdFetch = undefined;
      await late;
      return read;
    }
    if (method === "git.pull_base") {
      await s.hold;
      // As moonlet-core's pull_base refuses a diverged branch.
      if (s.ahead) throw new Error(`cannot fast-forward main: it has ${s.ahead} commit(s) that are not on origin/main`);
      const pulled = s.behind;
      s.behind = 0;
      return { pulled, head: "9c41e2a7d0b5f3c18e2a9b4c6d1f0e3a5b7c9d2e" };
    }
    return null;
  });
}

const shown = () => useStore.getState().toasts.map((t) => t.text);
const pulledHere = "Pulled 3 commits into main. New sessions start from 9c41e2a.";

beforeAll(() => startStore());

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

  it("pulls on the other hosts too, and they report in a toast of their own", async () => {
    daemons({ local: { behind: 3 }, mini: { behind: 2 }, vps: { behind: 0 } });
    await pullBaseEverywhere("local", "p1");
    expect(shown()).toEqual([pulledHere, "studio-mini: pulled 2 commits. build-box: already up to date."]);
  });

  it("shows the clicked host's toast without waiting for a slow host", async () => {
    let release = () => {};
    daemons({ local: { behind: 3 }, mini: { behind: 2, hold: new Promise<void>((r) => (release = r)) }, vps: { behind: 0 } });
    const all = pullBaseEverywhere("local", "p1");
    await vi.waitFor(() => expect(shown()).toEqual([pulledHere]));
    release();
    await all;
    expect(shown()).toEqual([pulledHere, "studio-mini: pulled 2 commits. build-box: already up to date."]);
  });

  it("fetches on the other host first, as its last fetch may be old", async () => {
    daemons({ local: { behind: 3 }, mini: { behind: 0, fetched: 3 }, vps: { behind: 0 } });
    await pullBaseEverywhere("local", "p1");
    expect(shown()).toEqual([pulledHere, "studio-mini: pulled 3 commits. build-box: already up to date."]);
  });

  it("leaves a copy with commits of its own alone and says so", async () => {
    daemons({ local: { behind: 3 }, mini: { behind: 2, ahead: 1 }, vps: { behind: 0 } });
    await pullBaseEverywhere("local", "p1");
    expect(shown()).toEqual([pulledHere, "studio-mini: main can't be fast-forwarded, nothing changed. build-box: already up to date."]);
  });

  it("says a host that couldn't fetch didn't pull, rather than that it is up to date", async () => {
    daemons({ local: { behind: 3 }, mini: { behind: 0, fetchError: "fatal: unable to access 'https://github.com/acme/ledger.git/': Could not resolve host: github.com" }, vps: { behind: 0 } });
    await pullBaseEverywhere("local", "p1");
    expect(shown()).toEqual([pulledHere, "studio-mini: couldn't pull: couldn't fetch origin/main. build-box: already up to date."]);
  });

  it("says when another host's copy has no origin branch to pull from", async () => {
    daemons({ local: { behind: 3 }, mini: { behind: 0, noUpstream: true }, vps: { behind: 0 } });
    await pullBaseEverywhere("local", "p1");
    expect(shown()).toEqual([pulledHere, "studio-mini: main has no origin/main to pull from. build-box: already up to date."]);
  });

  it("leaves a pull already running on another host to report itself", async () => {
    let release = () => {};
    daemons({ local: { behind: 3 }, mini: { behind: 2, hold: new Promise<void>((r) => (release = r)) }, vps: { behind: 0 } });
    const onMini = pullBase("mini", "m7");
    await pullBaseEverywhere("local", "p1");
    release();
    await onMini;
    expect(shown()).toEqual([pulledHere, "studio-mini: already pulling main. build-box: already up to date.", "Pulled 2 commits into main. New sessions start from 9c41e2a."]);
  });

  it("pulls every checkout of the project on another host, each named by its folder", async () => {
    daemons({ local: { behind: 3 }, mini: { behind: 2 }, "vps:/home/me/ledger": { behind: 1 }, "vps:/srv/ledger-ci": { behind: 0 } });
    useStore.setState((s) => ({ projects: { ...s.projects, vps: [project("v3", "/home/me/shop", shop), project("v4", "/home/me/ledger"), project("v5", "/srv/ledger-ci")] } }));
    await pullBaseEverywhere("local", "p1");
    expect(shown()).toEqual([pulledHere, "studio-mini: pulled 2 commits. build-box (ledger): pulled 1 commit. build-box (ledger-ci): already up to date."]);
  });

  it("does not pull again from a fetch that read the branch before the pull", async () => {
    let release = () => {};
    daemons({ local: { behind: 3 }, mini: { behind: 2, holdFetch: new Promise<void>((r) => (release = r)) }, vps: { behind: 0 } });
    useStore.setState({ gitSettings: { mini: { ...gitSettingsOf({}, "mini"), fast_forward_base: true } } });
    // studio-mini's timed fetch is under way, and answers after the pull.
    const timed = refreshBase("mini", "m7", { fetch: true });
    await pullBaseEverywhere("local", "p1");
    release();
    await timed;
    await new Promise((r) => setTimeout(r, 20));
    expect(shown()).toEqual([pulledHere, "studio-mini: pulled 2 commits. build-box: already up to date."]);
  });

  it("skips a host that is not connected", async () => {
    daemons({ local: { behind: 3 }, mini: { behind: 2 }, vps: { behind: 0 } });
    useStore.setState((s) => ({ hosts: { ...s.hosts, mini: host("mini", "studio-mini", "reconnecting") } }));
    await pullBaseEverywhere("local", "p1");
    expect(shown()).toEqual([pulledHere, "build-box: already up to date."]);
  });

  it("pulls a project without a root commit only where it was clicked", async () => {
    daemons({ local: { behind: 3 }, mini: { behind: 2 } });
    const alone = { origin: null, root: null };
    useStore.setState({ projects: { local: [project("p1", "/Users/me/ledger", alone)], mini: [project("m7", "/Users/me/src/ledger", alone)] } });
    await pullBaseEverywhere("local", "p1");
    expect(shown()).toEqual([pulledHere]);
  });

  it("still pulls on the other hosts when the clicked one fails", async () => {
    daemons({ local: { behind: 3, ahead: 1 }, mini: { behind: 2 }, vps: { behind: 0 } });
    await pullBaseEverywhere("local", "p1");
    expect(useStore.getState().toasts.map((t) => [t.kind, t.text])).toEqual([
      ["error", "cannot fast-forward main: it has 1 commit(s) that are not on origin/main"],
      ["info", "studio-mini: pulled 2 commits. build-box: already up to date."],
    ]);
  });

  it("leaves the other hosts alone when X55 fast-forwards after a fetch", async () => {
    daemons({ local: { behind: 0, fetched: 3 }, mini: { behind: 2 }, vps: { behind: 0 } });
    useStore.setState({ gitSettings: { local: { ...gitSettingsOf({}, "local"), fast_forward_base: true } } });
    await refreshBase("local", "p1", { fetch: true });
    await vi.waitFor(() => expect(shown()).toEqual([pulledHere]));
    await new Promise((r) => setTimeout(r, 20));
    expect(shown()).toEqual([pulledHere]);
  });

  it("clears this host's chip when another host pulled its copy, without fetching", async () => {
    // origin has moved on again since; only a fetch would see that.
    const state = { local: { behind: 1, fetched: 2 }, mini: { behind: 0 }, vps: { behind: 0 } };
    daemons(state);
    await refreshBase("local", "p1");
    const chip = () => {
      const b = useStore.getState().base[projKey("local", "p1")];
      return baseChip(b?.status, !!b?.pulling)?.text ?? null;
    };
    expect(chip()).toBe("1");
    // The MacBook pulled main here; this host's daemon says so.
    state.local.behind = 0;
    daemon.emit({ host: "local", name: "git.base_pulled", data: { path: "/Users/me/ledger", branch: "main", pulled: 1, head: "9c41e2a7d0b5f3c18e2a9b4c6d1f0e3a5b7c9d2e" } });
    await vi.waitFor(() => expect(chip()).toBeNull());
    expect(shown()).toEqual([]);
  });
});
