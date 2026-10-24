import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CloudMachine, CloudMachines } from "./protocol";
import { loadCloud, startCloud, useCloud } from "./cloudStore";

/** What the daemon answers, by method; a function may wait. */
const answers = vi.hoisted(() => ({}) as Record<string, (params: unknown) => unknown>);
const events = vi.hoisted(() => ({ emit: (_e: { host: string; name: string; data: unknown }) => {} }));

vi.mock("./daemon", () => ({
  rpc: vi.fn((_host: string, method: string, params: unknown) => {
    const answer = answers[method];
    return answer ? Promise.resolve().then(() => answer(params)) : Promise.reject(new Error(`no ${method}`));
  }),
  onDaemonEvent: (cb: (e: { host: string; name: string; data: unknown }) => void) => ((events.emit = cb), Promise.resolve(() => {})),
  onHostStatus: () => Promise.resolve(() => {}),
}));
vi.mock("./store", () => ({
  toast: vi.fn(),
  notify: vi.fn(() => Promise.resolve()),
  errorToast: vi.fn(),
  useStore: { getState: () => ({ hosts: {} }) },
}));
vi.mock("./syncStore", () => ({ useSync: { getState: () => ({ central: null }), subscribe: () => () => {} } }));

const machine = (id: string, state: CloudMachine["state"]): CloudMachine => ({
  id,
  name: `moonlet-shop-${id}`,
  project: "shop",
  project_key: "k",
  provider: "hetzner",
  type: "cpx41",
  location: "fsn1",
  state,
  since: 0,
  steps: [],
  running: 0,
});
const machines = (...ms: CloudMachine[]): CloudMachines => ({ machines: ms, removed: [], hours_this_month: 0, max_hours_month: 40, max_machines: 2 });
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeAll(() => {
  answers["cloud.machines"] = () => machines();
  startCloud();
});

describe("the cloud machines the app keeps (X63)", () => {
  it("a late cloud.machines answer never replaces a newer cloud.changed", async () => {
    let answer: (m: CloudMachines) => void = () => {};
    answers["cloud.machines"] = () => new Promise<CloudMachines>((r) => (answer = r));
    loadCloud();
    await settle();
    events.emit({ host: "local", name: "cloud.changed", data: machines(machine("m1", "removing")) });
    answer(machines(machine("m1", "ready")));
    await settle();
    expect(useCloud.getState().machines?.machines.map((m) => m.state)).toEqual(["removing"]);
  });
});
