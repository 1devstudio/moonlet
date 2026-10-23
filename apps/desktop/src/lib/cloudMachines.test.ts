import { describe, expect, it } from "vitest";
import { cloudOffered, cloudSummary, machineLine, removedLine, startupCard, waitingNote } from "./cloudMachines";
import type { CloudMachine, CloudMachines } from "./protocol";

const machine = (patch: Partial<CloudMachine> = {}): CloudMachine => ({
  id: "m1",
  name: "moonlet-shop-7k2q",
  project: "shop",
  project_key: "k",
  provider: "hetzner",
  type: "cpx41",
  location: "fsn1",
  state: "ready",
  since: 0,
  steps: [],
  running: 0,
  ...patch,
});

const all = (machines: CloudMachine[], patch: Partial<CloudMachines> = {}): CloudMachines => ({
  machines,
  removed: [],
  hours_this_month: 12.5,
  max_hours_month: 40,
  max_machines: 4,
  ...patch,
});

describe("the Workers page's cloud machines (X63)", () => {
  it("the summary line", () => {
    const four = [1, 2, 3, 4].map((i) => machine({ id: `m${i}` }));
    expect(cloudSummary(all(four))).toBe("4 of 4 machines: at the limit, so no new one starts · 12.5 of 40 machine-hours this month");
    expect(cloudSummary(all([machine()], { hours_this_month: 0.6, max_machines: 2 }))).toBe("1 of 2 machines · 0.6 of 40 machine-hours this month");
    expect(cloudSummary(all([], { hours_this_month: 40, max_machines: 2 }))).toBe("0 of 2 machines · 40 of 40 machine-hours this month: at the limit, so no new one starts");
  });

  it("the machine state lines", () => {
    const now = 1_000_000;
    const sessions = { s1: { name: "big-refactor", cloud: true }, s2: { name: "fix-cart", cloud: false } };
    expect(machineLine(machine({ running: 2 }), now, sessions)).toEqual({ tone: "done", text: "Running 2 · Hetzner cpx41 · fsn1 · shop", action: null });
    expect(machineLine(machine({ state: "starting", since: now - 40_000, for_session: "s1" }), now, sessions)).toEqual({
      tone: "accent",
      text: "Starting · 0:40 · for big-refactor, which asked for the cloud",
      action: null,
    });
    expect(machineLine(machine({ state: "creating", since: now - 5_000, for_session: "s2" }), now, sessions).text).toBe("Starting · 0:05 · for fix-cart");
    expect(machineLine(machine({ state: "starting", since: now - 65_000 }), now, sessions).text).toBe("Starting · 1:05");
    expect(machineLine(machine({ idle_until: now + 12 * 60_000 }), now, sessions)).toEqual({ tone: "muted", text: "Idle · removed in 12 min", action: "remove" });
    expect(machineLine(machine({ idle_until: now + 20_000 }), now, sessions).text).toBe("Idle · removed in 1 min");
    expect(machineLine(machine({ state: "removing" }), now, sessions)).toEqual({ tone: "muted", text: "Removing", action: null });
    expect(machineLine(machine({ state: "removing", error: "503 Service Unavailable" }), now, sessions)).toEqual({
      tone: "error",
      text: "Could not remove: Hetzner answered 503 Service Unavailable. Billed until removed.",
      action: "retry",
    });
  });

  it("a removed machine's line", () => {
    const at = new Date(2026, 9, 22, 10, 42).getTime();
    const gone = (reason: string, state: CloudMachine["state"] = "removed") => removedLine(machine({ name: "moonlet-shop-4hn0", state, since: at, reason }));
    expect(gone("removed after 15 min idle")).toBe("moonlet-shop-4hn0 removed after 15 min idle · 10:42");
    expect(gone("its provider was removed")).toBe("moonlet-shop-4hn0 removed: its provider was removed · 10:42");
    expect(gone("Hetzner refused the token. Check it in Settings › Cloud workers.", "failed")).toBe(
      "moonlet-shop-4hn0 failed: Hetzner refused the token. Check it in Settings › Cloud workers. · 10:42",
    );
  });
});

describe("a job waiting for a cloud machine (X63)", () => {
  it("the machine's startup checklist and deadline", () => {
    const m = machine({
      name: "moonlet-shop-m3x9",
      state: "starting",
      deadline: new Date(2026, 9, 22, 10, 59).getTime(),
      steps: [
        { step: "created", label: "Created at Hetzner Cloud", state: "done", took_ms: 4_000 },
        { step: "tailnet", label: "Joined your tailnet", state: "done", took_ms: 31_200 },
        { step: "machine_setup", label: "Machine setup scripts/ci-deps.sh", state: "running", took_ms: 18_000 },
        { step: "paired", label: "Paired with studio-mini", state: "pending" },
        { step: "copy", label: "Copied fix-cart and ran pnpm install", state: "failed", error: "exit 1" },
      ],
    });
    expect(startupCard(m)).toEqual({
      name: "moonlet-shop-m3x9",
      kind: "cpx41 · fsn1",
      steps: [
        { label: "Created at Hetzner Cloud", state: "done", took: "0:04", error: null },
        { label: "Joined your tailnet", state: "done", took: "0:31", error: null },
        { label: "Machine setup scripts/ci-deps.sh", state: "running", took: "0:18", error: null },
        { label: "Paired with studio-mini", state: "pending", took: null, error: null },
        { label: "Copied fix-cart and ran pnpm install", state: "failed", took: null, error: "exit 1" },
      ],
      deadline: "Removed if it isn't ready by 10:59.",
    });
    expect(startupCard(machine({ state: "ready" })).deadline).toBeNull();
  });

  it("says why the job waits", () => {
    expect(waitingNote("fix-cart", "studio-mini")).toBe("fix-cart runs its heavy commands in the cloud, so this one waits for its machine instead of running on studio-mini.");
  });
});

describe("the composer's cloud checkbox (X63)", () => {
  it("is offered only for a project with a cloud setting", () => {
    const root = "3f1c9a0b7d2e4f6a8b0c1d2e3f4a5b6c7d8e9f0a";
    const projects = { [` ${root}`]: { overflow: false, provider: "hetzner", type: "cpx41", location: "fsn1", image: "ubuntu-24.04" } };
    expect(cloudOffered(projects, { origin: null, root })).toBe(true);
    expect(cloudOffered(projects, { origin: "git@github.com:acme/shop.git", root })).toBe(false);
    expect(cloudOffered(projects, null)).toBe(false);
    expect(cloudOffered(null, { origin: null, root })).toBe(false);
  });
});
