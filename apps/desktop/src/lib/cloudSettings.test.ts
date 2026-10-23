import { describe, expect, it } from "vitest";
import {
  cloudChanges,
  cloudDraft,
  cloudErrors,
  machineTypeLabel,
  policySnippet,
  projectCloudFooter,
  providerForm,
  providerStatus,
  removalError,
  removalToast,
  usageLine,
} from "./cloudSettings";
import type { CloudInfo, CloudKind, CloudMachine } from "./protocol";

const hetzner: CloudKind = {
  id: "hetzner",
  label: "Hetzner Cloud",
  fields: [{ name: "token", label: "API token", secret: true, help: "It can create and delete anything in its Hetzner project, so use a project made for moonlet." }],
};

const info = (patch: Partial<CloudInfo> = {}): CloudInfo => ({
  host_id: "c3f1a9e2b7d04c55",
  providers: { hetzner: { has_token: true } },
  tailscale: { client_id: "kD3fQx7CNTRL", has_client_secret: true, tag: "tag:moonlet-worker" },
  idle_minutes: 15,
  max_machines: 2,
  max_hours_month: 40,
  projects: {},
  kinds: [hetzner],
  ...patch,
});

const machine = (patch: Partial<CloudMachine> = {}): CloudMachine => ({
  id: "m1",
  name: "moonlet-shop-x81c",
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

describe("Settings › Cloud workers (X63)", () => {
  it("the form from an adapter's description", () => {
    expect(providerForm(hetzner, { has_token: true })).toEqual({
      id: "hetzner",
      label: "Hetzner Cloud",
      rows: [
        {
          name: "token",
          label: "API token",
          help: "It can create and delete anything in its Hetzner project, so use a project made for moonlet.",
          secret: true,
          saved: true,
          value: "",
        },
      ],
    });
    expect(providerForm(hetzner, undefined).rows[0].saved).toBe(false);
  });

  it("sends only what changed, and a secret only once typed", () => {
    const i = info();
    const d = cloudDraft(i);
    expect(d).toEqual({
      providers: { hetzner: { token: "" } },
      tailscale: { client_id: "kD3fQx7CNTRL", client_secret: "", tag: "tag:moonlet-worker" },
      idle_minutes: "15",
      max_machines: "2",
      max_hours_month: "40",
    });
    expect(cloudChanges(i, d)).toBeNull();
    expect(cloudChanges(i, { ...d, idle_minutes: "0", tailscale: { ...d.tailscale, client_secret: "tskey-client-new" } })).toEqual({
      idle_minutes: 0,
      tailscale: { client_secret: "tskey-client-new" },
    });
    expect(cloudChanges(i, { ...d, providers: { hetzner: { token: "hc-new" } } })).toEqual({ providers: { hetzner: { token: "hc-new" } } });
  });

  it("says what is wrong with the limits", () => {
    const d = cloudDraft(info());
    expect(cloudErrors({ ...d, idle_minutes: "1441", max_machines: "0", max_hours_month: "x" })).toEqual({
      idle_minutes: "From 0 to 1440 minutes.",
      max_machines: "At least 1 machine.",
      max_hours_month: "A whole number of hours.",
    });
    expect(cloudErrors({ ...d, tailscale: { ...d.tailscale, tag: "moonlet" } })).toEqual({ tag: "A tag starts with tag:, such as tag:moonlet-worker." });
    expect(cloudErrors(d)).toEqual({});
  });

  it("the policy snippet with the tag and address", () => {
    expect(policySnippet("tag:moonlet-worker", "100.101.102.103:47428")).toBe(
      `"tagOwners": { "tag:moonlet-worker": ["autogroup:admin"] },
"acls": [
  { "action": "accept", "src": ["tag:moonlet-worker"], "dst": ["100.101.102.103:47428"] }
]`,
    );
  });

  it("the usage line", () => {
    expect(usageLine(12.5, 40)).toEqual({ text: "12.5 of 40 machine-hours this month", fraction: 0.3125 });
    expect(usageLine(40, 40)).toEqual({ text: "40 of 40 machine-hours this month", fraction: 1 });
    expect(usageLine(0.04, 40).text).toBe("0 of 40 machine-hours this month");
  });

  it("a provider's status line", () => {
    const ms = [machine(), machine({ id: "m2" }), machine({ id: "m3", project: "payments-api" }), machine({ id: "m4", provider: "other" })];
    expect(providerStatus("hetzner", ms)).toBe("3 machines · used by shop and payments-api");
    expect(providerStatus("hetzner", [machine()])).toBe("1 machine · used by shop");
    expect(providerStatus("hetzner", [])).toBe("No machines");
  });

  it("the last provider error with its time", () => {
    const at = (h: number, m: number) => new Date(2026, 9, 22, h, m).getTime();
    const m = machine({ state: "removing", error: "503 Service Unavailable", error_since: at(10, 9), error_at: at(10, 14) });
    expect(removalError(m, "Hetzner")).toEqual({
      text: "Could not remove moonlet-shop-x81c: Hetzner answered 503 Service Unavailable.",
      detail: "Last error at 10:14 · retrying since 10:09. It is billed until removed.",
    });
    expect(removalError(machine(), "Hetzner")).toBeNull();
  });

  it("the removal toast", () => {
    const m = machine({ state: "removing", error: "503 Service Unavailable" });
    expect(removalToast(m, "Hetzner")).toBe("Could not remove moonlet-shop-x81c at Hetzner: 503 Service Unavailable. It is billed until removed.");
  });
});

describe("a project's cloud workers (X63)", () => {
  it("names a machine type as the design does", () => {
    expect(machineTypeLabel({ name: "cpx41", cores: 8, memory_gb: 16, arch: "x86" })).toBe("cpx41 · 8 cores · 16 GB · x86");
    expect(machineTypeLabel({ name: "cax11", cores: 2, memory_gb: 4, arch: "arm" })).toBe("cax11 · 2 cores · 4 GB · arm");
  });

  it("the footer counts the project's machines and their commands", () => {
    const ms = [machine({ running: 2 }), machine({ id: "m2" }), machine({ id: "m3", project: "payments-api", running: 1 })];
    expect(projectCloudFooter(ms, "shop")).toBe("2 machines for shop · 2 running commands");
    expect(projectCloudFooter([machine({ running: 1 })], "shop")).toBe("1 machine for shop · 1 running command");
    expect(projectCloudFooter([], "shop")).toBe("No machines for shop");
  });
});
