import { describe, expect, it } from "vitest";
import {
  cloudChanges,
  cloudDraft,
  cloudErrors,
  machineTypeLabel,
  newRemovalErrors,
  policyAddress,
  reachWarning,
  policySnippet,
  projectCloudFooter,
  projectCloudChange,
  projectCloudDraft,
  projectCloudErrors,
  projectCloudKey,
  providerForm,
  providerName,
  providerStatus,
  removalError,
  removalToast,
  removeProviderPrompt,
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

  it("puts the central host's Tailscale address in the policy", () => {
    expect(policyAddress({ port: 47428, listening: ["127.0.0.1:47428", "100.101.102.103:47428"] }, "studio-mini")).toBe("100.101.102.103:47428");
    expect(policyAddress({ port: 47428, listening: [] }, "studio-mini")).toBe("studio-mini:47428");
    expect(policyAddress({ port: 0, listening: [] }, "studio-mini")).toBe("studio-mini:47428");
  });

  it("warns while the central host takes no tailnet connections", () => {
    expect(reachWarning({ listening: [] }, "studio-mini")).toBe(
      "studio-mini does not accept connections from your tailnet, so a cloud machine cannot pair with it. Turn on Allow connections from my tailnet in Hosts.",
    );
    expect(reachWarning({ listening: ["100.101.102.103:47428"] }, "studio-mini")).toBeNull();
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

  it("toasts a removal error once, when it starts", () => {
    const failing = machine({ state: "removing", error: "503 Service Unavailable" });
    expect(newRemovalErrors(null, [failing])).toEqual([]);
    expect(newRemovalErrors([machine({ state: "removing" })], [failing]).map((m) => m.name)).toEqual(["moonlet-shop-x81c"]);
    expect(newRemovalErrors([failing], [{ ...failing, error_at: 2 }])).toEqual([]);
  });

  it("asks before removing a provider, naming its machines", () => {
    expect(removeProviderPrompt("Hetzner Cloud", 2, "studio-mini")).toEqual({
      title: "Remove Hetzner Cloud?",
      message: "Its 2 machines are removed first, once their commands end. studio-mini forgets the token after the last one is gone.",
      action: "Remove",
      variant: "danger",
    });
    expect(removeProviderPrompt("Hetzner Cloud", 0, "studio-mini").message).toBe("studio-mini forgets the token.");
  });

  it("the removal toast", () => {
    const m = machine({ state: "removing", error: "503 Service Unavailable" });
    expect(providerName("hetzner")).toBe("Hetzner");
    expect(removalToast(m, "Hetzner")).toBe("Could not remove moonlet-shop-x81c at Hetzner: 503 Service Unavailable. It is billed until removed.");
  });
});

describe("a project's cloud workers (X63)", () => {
  it("names a machine type as the design does", () => {
    expect(machineTypeLabel({ name: "cpx41", cores: 8, memory_gb: 16, arch: "x86" })).toBe("cpx41 · 8 cores · 16 GB · x86");
    expect(machineTypeLabel({ name: "cax11", cores: 2, memory_gb: 4, arch: "arm" })).toBe("cax11 · 2 cores · 4 GB · arm");
  });

  it("keys a project by its origin and root commit, as the central host does", () => {
    const root = "3f1c9a0b7d2e4f6a8b0c1d2e3f4a5b6c7d8e9f0a";
    expect(projectCloudKey({ origin: "git@github.com:acme/shop.git", root })).toBe("git@github.com:acme/shop.git 3f1c9a0b7d2e4f6a8b0c1d2e3f4a5b6c7d8e9f0a");
    expect(projectCloudKey({ origin: null, root })).toBe(" 3f1c9a0b7d2e4f6a8b0c1d2e3f4a5b6c7d8e9f0a");
    expect(projectCloudKey({ origin: null, root: null })).toBeNull();
    expect(projectCloudKey({ origin: null, root: "abc" })).toBeNull();
  });

  it("saves a project's cloud setting, and None removes it", () => {
    const key = " 3f1c9a0b7d2e4f6a8b0c1d2e3f4a5b6c7d8e9f0a";
    const shop = { overflow: true, provider: "hetzner", type: "cpx41", location: "fsn1", image: "ubuntu-24.04" };
    const none = projectCloudDraft(info(), key);
    expect(none).toEqual({ overflow: false, provider: "", type: "", location: "", image: "ubuntu-24.04" });
    expect(projectCloudChange(info(), key, none)).toBeNull();
    expect(projectCloudChange(info(), key, { ...none, provider: "hetzner", type: "cpx41", location: "fsn1", overflow: true })).toEqual({ projects: { [key]: shop } });
    const saved = info({ projects: { [key]: shop } });
    expect(projectCloudDraft(saved, key)).toEqual(shop);
    expect(projectCloudChange(saved, key, { ...shop, provider: "" })).toEqual({ projects: { [key]: null } });
  });

  it("says what a project's cloud setting misses", () => {
    expect(projectCloudErrors({ overflow: true, provider: "hetzner", type: "", location: " ", image: "" })).toEqual({
      type: "Pick a machine type.",
      location: "Name a location, such as fsn1.",
      image: "Name an image, such as ubuntu-24.04.",
    });
    expect(projectCloudErrors({ overflow: false, provider: "", type: "", location: "", image: "" })).toEqual({});
  });

  it("the footer counts the project's machines and their commands", () => {
    const ms = [machine({ running: 2 }), machine({ id: "m2" }), machine({ id: "m3", project: "payments-api", running: 1 })];
    expect(projectCloudFooter(ms, "shop")).toBe("2 machines for shop · 2 running commands");
    expect(projectCloudFooter([machine({ running: 1 })], "shop")).toBe("1 machine for shop · 1 running command");
    expect(projectCloudFooter([], "shop")).toBe("No machines for shop");
  });
});
