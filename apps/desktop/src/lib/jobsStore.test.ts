import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "./protocol";
import { loadJobs, loadOutput, startJobs, useJobs } from "./jobsStore";

/** What the daemon answers, by method; a function may throw or wait. */
const answers = vi.hoisted(() => ({}) as Record<string, (params: unknown) => unknown>);
const events = vi.hoisted(() => ({ emit: (_e: { host: string; name: string; data: unknown }) => {} }));
const hostStatus = vi.hoisted(() => ({ emit: (_h: { id: string; status: string }) => {} }));

vi.mock("./daemon", () => {
  class DaemonError extends Error {
    code: string;
    constructor(e: { code: string; message: string }) {
      super(e.message);
      this.code = e.code;
    }
  }
  return {
    DaemonError,
    rpc: vi.fn((_host: string, method: string, params: unknown) => {
      const answer = answers[method];
      return answer ? Promise.resolve().then(() => answer(params)) : Promise.reject(new DaemonError({ code: "unknown", message: `no ${method}` }));
    }),
    onDaemonEvent: (cb: (e: { host: string; name: string; data: unknown }) => void) => ((events.emit = cb), Promise.resolve(() => {})),
    onHostStatus: (cb: (h: { id: string; status: string }) => void) => ((hostStatus.emit = cb), Promise.resolve(() => {})),
  };
});

const job = (id: string, extra: Partial<Job> = {}): Job =>
  ({ id, session: "s1", command: "pnpm test", state: { kind: "running", worker: "devbox" }, started_at: 0, phases: [], timeline: [], brought: [], outputs: [], leftovers: [], env: [], output_bytes: 0, ...extra }) as Job;
const settle = () => new Promise((r) => setTimeout(r, 0));
const ids = (host: string, session: string) => (useJobs.getState().jobs[`${host}/${session}`] ?? []).map((j) => `${j.id}:${j.state.kind}`);

beforeAll(() => startJobs());
beforeEach(() => {
  useJobs.setState({ jobs: {}, output: {} });
  for (const k of Object.keys(answers)) delete answers[k];
});

describe("the jobs the app keeps (X62)", () => {
  it("reads a host's jobs again when it reconnects", async () => {
    answers["job.list"] = () => [job("j1")];
    loadJobs("h1", "s1");
    await settle();
    expect(ids("h1", "s1")).toEqual(["j1:running"]);
    // The daemon restarted meanwhile: the job was lost.
    answers["job.list"] = () => [job("j1", { state: { kind: "lost" } })];
    hostStatus.emit({ id: "h1", status: "connected" });
    await settle();
    await settle();
    expect(ids("h1", "s1")).toEqual(["j1:lost"]);
  });

  it("reads a list that failed while the host was away once it reconnects", async () => {
    loadJobs("h3", "s1");
    await settle();
    expect(ids("h3", "s1")).toEqual([]);
    answers["job.list"] = () => [job("j1")];
    hostStatus.emit({ id: "h3", status: "connected" });
    await settle();
    await settle();
    expect(ids("h3", "s1")).toEqual(["j1:running"]);
  });

  it("reads again the jobs of a host whose id has a slash, as an SSH host reached through a phone's Mac", async () => {
    answers["job.list"] = () => [job("j1")];
    loadJobs("mac/devbox", "s1");
    await settle();
    answers["job.list"] = () => [job("j1", { state: { kind: "lost" } })];
    hostStatus.emit({ id: "mac/devbox", status: "connected" });
    await settle();
    await settle();
    expect(ids("mac/devbox", "s1")).toEqual(["j1:lost"]);
  });

  it("keeps a job that changes while the list is read", async () => {
    let answer: (list: Job[]) => void = () => {};
    answers["job.list"] = () => new Promise<Job[]>((r) => (answer = r));
    loadJobs("h2", "s1");
    await settle();
    events.emit({ host: "h2", name: "job.changed", data: job("j2") });
    answer([job("j1", { state: { kind: "done", exit: 0 } })]);
    await settle();
    await settle();
    expect(ids("h2", "s1")).toEqual(["j2:running", "j1:done"]);
  });

  it("reads a dropped job's output as none, without an error", async () => {
    const { DaemonError } = (await import("./daemon")) as unknown as { DaemonError: new (e: { code: string; message: string }) => Error };
    answers["job.output"] = () => {
      throw new DaemonError({ code: "not_found", message: "no such job" });
    };
    await expect(loadOutput("h3", "gone")).resolves.toBeUndefined();
    expect(useJobs.getState().output.gone).toBeUndefined();
  });

  it("forgets the output of a job dropped past the fifty kept", async () => {
    answers["job.list"] = () => Array.from({ length: 50 }, (_, i) => job(`old${49 - i}`, { state: { kind: "done", exit: 0 } }));
    loadJobs("h4", "s1");
    await settle();
    answers["job.output"] = () => ({ chunks: [{ stream: 1, text: "ok\n" }], next: 3, more: false });
    await loadOutput("h4", "old0");
    expect(useJobs.getState().output.old0).toBeDefined();
    events.emit({ host: "h4", name: "job.changed", data: job("new") });
    expect(useJobs.getState().output.old0).toBeUndefined();
  });
});
