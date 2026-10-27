import { describe, expect, it } from "vitest";
import type { Job } from "@desktop/lib/protocol";
import { jobFooter, sessionTabs } from "./jobsView";

const job = (extra: Partial<Job> = {}): Job => ({
  id: "j1",
  session: "s1",
  command: "pnpm test",
  tool_use_id: "toolu_1",
  state: { kind: "running", worker: "Alex's MacBook Pro" },
  started_at: 1000,
  ended_at: null,
  phases: [],
  timeline: [],
  worker: { name: "Alex's MacBook Pro", kind: "mac", load: 1.2, cores: 10, slot: 1, slots: 2, rtt_ms: 6, copy: null },
  brought: [],
  outputs: [],
  leftovers: [],
  env: [],
  summary: null,
  output_bytes: 0,
  ...extra,
});

describe("sessionTabs (X62)", () => {
  it("adds Jobs only while the session has jobs", () => {
    expect(sessionTabs([])).toEqual(["chat", "terminal", "changes", "pr"]);
    expect(sessionTabs([job()])).toEqual(["chat", "terminal", "changes", "pr", "jobs"]);
  });
});

describe("jobFooter (X62, X63)", () => {
  it("stops a running job, whose changes so far still come back", () => {
    expect(jobFooter(job(), "Fix checkout", "studio-mini")).toEqual({ note: null, runHere: null, stop: "Changes made so far still come back." });
  });

  it("runs a job waiting for a cloud machine on the session's host now, or stops it", () => {
    expect(jobFooter(job({ state: { kind: "waiting", for: "moonlet-shop-m3x9" }, worker: null }), "Fix checkout", "studio-mini")).toEqual({
      note: "Fix checkout runs its heavy commands in the cloud, so this one waits for its machine instead of running on studio-mini.",
      runHere: "Run on studio-mini now",
      stop: "",
    });
  });

  it("offers nothing for a job that ended", () => {
    expect(jobFooter(job({ state: { kind: "done", exit: 1 }, ended_at: 9000 }), "Fix checkout", "studio-mini")).toBeNull();
  });
});
