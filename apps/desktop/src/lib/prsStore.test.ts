import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonError } from "./daemon";
import type { KnownPr, PullRequest, Session } from "./protocol";
import { loadKnownPrs, refreshPrs, useStore } from "./store";

const daemon = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./daemon", async (original) => ({ ...(await original<typeof import("./daemon")>()), rpc: daemon.rpc }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));

const session = (id: string): Session => ({ id, project_id: "p", name: id, branch: `moonlet/${id}`, base: "main", path: `/w/${id}`, agent: null, archived: false, created_at: 0, workspace_id: "personal", terminals: [], layout: null });
const pr = (number: number, state: string): PullRequest => ({ number, url: `https://github.com/acme/web/pull/${number}`, state, title: "Gift cards", checks: [], review_decision: null, draft: false });

/** A host with `ids` sessions whose daemon saved `known` and answers
 *  `gh.pr_status` with `answer`; returns the paths `gh.pr_status` was asked. */
function host(name: string, ids: string[], known: Record<string, KnownPr> | Error, answer: () => PullRequest | null = () => null) {
  useStore.setState((s) => ({ sessions: { ...s.sessions, [name]: ids.map(session) } }));
  const asked: string[] = [];
  daemon.rpc.mockImplementation(async (_host: string, method: string, params: { path: string }) => {
    if (method === "gh.pr_known") {
      if (known instanceof Error) throw known;
      return known;
    }
    if (method === "gh.pr_status") {
      asked.push(params.path);
      return answer();
    }
    throw new DaemonError({ code: "unknown_method", message: method });
  });
  return asked;
}

afterEach(() => {
  daemon.rpc.mockReset();
  vi.useRealTimers();
});

describe("saved PR states (X108)", () => {
  it("show what the daemon saved, then poll only the PRs that can still change", async () => {
    const now = Date.now();
    const asked = host("studio", ["s1", "s2", "s3", "s4"], {
      s1: { pr: pr(11, "merged"), checked_at: now - 86_400_000 },
      s2: { pr: pr(12, "open"), checked_at: now - 60_000 },
      s3: { pr: null, checked_at: now - 60_000 },
    });
    await loadKnownPrs("studio");
    const prs = useStore.getState().prs;
    expect([prs["studio/s1"]?.state, prs["studio/s2"]?.state, prs["studio/s3"], prs["studio/s4"]]).toEqual(["merged", "open", null, undefined]);
    await refreshPrs("studio");
    expect(asked.sort()).toEqual(["/w/s2", "/w/s4"]);
  });

  it("leave a daemon from before them polling every session", async () => {
    const asked = host("old-mini", ["s1", "s2"], new DaemonError({ code: "unknown_method", message: "unknown method gh.pr_known" }));
    await loadKnownPrs("old-mini");
    expect(useStore.getState().prs["old-mini/s1"]).toBeUndefined();
    await refreshPrs("old-mini");
    expect(asked.sort()).toEqual(["/w/s1", "/w/s2"]);
  });

  it("ask again on the next 5-minute poll about every session with no PR, however late in the poll it was asked", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
    const ids = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
    // Each answer takes 30 s, so the last sessions are asked a minute in.
    const asked = host("devbox", ids, {}, () => {
      vi.setSystemTime(Date.now() + 30_000);
      return null;
    });
    await refreshPrs("devbox");
    expect(asked).toHaveLength(8);
    vi.setSystemTime(1_000_000 + 300_000);
    asked.length = 0;
    await refreshPrs("devbox");
    expect(asked).toHaveLength(8);
  });
});
