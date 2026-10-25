import { describe, expect, it } from "vitest";
import { workerHost, workersPage } from "./workers";
import type { ExecStatus, LinkInfo, WorkerInfo } from "./protocol";

const worker = (id: string, name: string, extra: Partial<WorkerInfo> = {}): WorkerInfo => ({
  id,
  name,
  os: "macos",
  arch: "arm64",
  cores: 10,
  version: "0.1.30",
  slots: 2,
  heavy: true,
  connected_since: 0,
  rtt_ms: 6,
  load: 1.2,
  ...extra,
});

const status = (extra: Partial<ExecStatus> = {}): ExecStatus => ({
  host: { name: "studio-mini", os: "macos", cores: 12, load: 3.1, slots: 2, used: 0 },
  running: [],
  skips: [],
  routed: 0,
  ...extra,
});

const sessions = { s1: "fix-cart", s2: "add-search" };

describe("the Workers page (X62)", () => {
  it("a worker's row from worker.list and job.list", () => {
    const page = workersPage({
      workers: [worker("mbp", "Alex's MacBook Pro"), worker("off", "Old Mac", { heavy: false })],
      status: status({ running: [{ job: "j1", session: "s1", command: "pnpm test", worker: "Alex's MacBook Pro", started_at: 1000 }] }),
      me: "mbp",
      sessions,
    });
    // Only workers that take heavy commands, then the central host.
    expect(page.rows.map((r) => r.name)).toEqual(["Alex's MacBook Pro", "studio-mini"]);
    expect(page.rows[0]).toEqual({
      id: "mbp",
      name: "Alex's MacBook Pro",
      badges: ["This Mac"],
      line: { tone: "muted", text: "macOS · 10 cores" },
      load: { text: "1.2 / 10", fraction: 0.12, busy: false },
      slots: "1 of 2",
      rtt: "6 ms",
      running: [{ session: "fix-cart", command: "pnpm test", since: 1000 }],
      approve: null,
    });
    expect(page.rows[1]).toMatchObject({ name: "studio-mini", badges: ["Central host"], slots: "0 of 2", rtt: "–", line: { tone: "muted", text: "macOS · 12 cores" } });
    expect(page.empty).toBe(false);
  });

  it("skip reasons for a project", () => {
    const page = workersPage({
      workers: [worker("maya", "Maya's MacBook Air"), worker("devbox", "devbox", { os: "linux", cores: 16 })],
      status: status({
        host: { name: "studio-mini", os: "macos", cores: 12, load: 9.0, slots: 2, used: 2 },
        skips: [
          { worker: "maya", project: "shop", reason: "not_approved", detail: "this machine has not approved the project's heavy commands" },
          { worker: "devbox", project: "shop", reason: "missing_tool", detail: "missing pnpm" },
        ],
      }),
      me: null,
      sessions,
    });
    expect(page.rows[0].line).toEqual({ tone: "blocked", text: "Not approved for shop" });
    expect(page.rows[0].approve).toEqual({ project: "shop" });
    expect(page.rows[1].line).toEqual({ tone: "blocked", text: "Linux · 16 cores · skipped for shop: missing pnpm" });
    // A central host with no slot left, or loaded, takes what no one else can.
    expect(page.rows[2].line).toEqual({ tone: "blocked", text: "macOS · 12 cores · busy, takes commands no one else can" });
    expect(page.rows[2].load).toEqual({ text: "9.0 / 12", fraction: 0.75, busy: true });
  });

  it("the summary line counts running jobs and slots", () => {
    const run = (worker: string, n: number) => ({ job: `j${n}`, session: "s1", command: "pnpm test", worker, started_at: n });
    const page = workersPage({
      workers: [worker("mbp", "Alex's MacBook Pro"), worker("devbox", "devbox", { slots: 4 })],
      status: status({ host: { name: "studio-mini", os: "macos", cores: 12, load: 1, slots: 2, used: 2 }, running: [run("Alex's MacBook Pro", 1), run("studio-mini", 2), run("studio-mini", 3)] }),
      me: null,
      sessions,
    });
    expect(page.summary).toBe("3 commands running · 3 of 8 slots in use");
    expect(workersPage({ workers: [], status: status({ running: [run("studio-mini", 1)] }), me: null, sessions }).summary).toBe("1 command running · 1 of 2 slots in use");
    // No worker but the central host: the empty page.
    expect(workersPage({ workers: [], status: status(), me: null, sessions }).empty).toBe(true);
  });
});

describe("which host Approve on a worker's row goes to (X62)", () => {
  const link = (id: string) => ({ central: null, worker: { id, name: "devbox", enabled: true, slots: 2 }, state: { kind: "off" } }) as unknown as LinkInfo;

  it("the host whose own link names the worker, whatever the hosts are called", () => {
    const links = { local: link("mac-1"), "devbox-a": link("w1"), "devbox-b": link("w2") };
    expect(workerHost("w2", links)).toBe("devbox-b");
    expect(workerHost("mac-1", links)).toBe("local");
    expect(workerHost("w9", links)).toBeNull();
  });
});
