import { describe, expect, it } from "vitest";
import {
  afterRemoving,
  billingNote,
  checkLine,
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
  tailscaleSteps,
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
  tailscale: { mode: "oauth", client_id: "kD3fQx7CNTRL", has_client_secret: true, has_auth_key: false, tag: "tag:moonlet-worker" },
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
      tailscale: { mode: "oauth", client_id: "kD3fQx7CNTRL", client_secret: "", auth_key: "", tag: "tag:moonlet-worker" },
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

  it("switches to a pasted auth key, sent only once typed", () => {
    const i = info();
    const d = cloudDraft(i);
    expect(cloudChanges(i, { ...d, tailscale: { ...d.tailscale, mode: "auth_key" } })).toEqual({ tailscale: { mode: "auth_key" } });
    expect(cloudChanges(i, { ...d, tailscale: { ...d.tailscale, mode: "auth_key", auth_key: " tskey-auth-new " } })).toEqual({
      tailscale: { mode: "auth_key", auth_key: "tskey-auth-new" },
    });
  });

  it("the steps for each way of joining the tailnet", () => {
    expect(tailscaleSteps("oauth", "tag:moonlet-worker")).toEqual([
      { text: "Open Tailscale's OAuth clients page.", link: "https://login.tailscale.com/admin/settings/oauth" },
      { text: "Generate a client with the Auth Keys scope (write) and the tag tag:moonlet-worker." },
      { text: "Paste its ID and secret below, then Check." },
      { text: "Add the lines below to your tailnet policy.", link: "https://login.tailscale.com/admin/acls/file" },
    ]);
    expect(tailscaleSteps("auth_key", "tag:moonlet-worker")).toEqual([
      { text: "Open Tailscale's keys page.", link: "https://login.tailscale.com/admin/settings/keys" },
      { text: "Generate an auth key that is reusable, ephemeral and pre-approved, with the tag tag:moonlet-worker." },
      { text: "Paste it below. It works until it expires, at most 90 days: then paste a new one." },
      { text: "Add the lines below to your tailnet policy.", link: "https://login.tailscale.com/admin/acls/file" },
    ]);
  });

  it("the line after Check", () => {
    expect(checkLine(true)).toEqual({ tone: "done", text: "Tailscale made and revoked a test key: machines can join." });
    expect(checkLine("Tailscale refused the OAuth client. Check it in Settings › Cloud workers.")).toEqual({
      tone: "error",
      text: "Tailscale refused the OAuth client. Check it in Settings › Cloud workers.",
    });
  });

  it("says what is wrong with the limits", () => {
    const d = cloudDraft(info());
    expect(cloudErrors({ ...d, idle_minutes: "1441", max_machines: "0", max_hours_month: "x" })).toEqual({
      idle_minutes: "From 0 to 1440 minutes.",
      max_machines: "At least 1 machine.",
      max_hours_month: "A whole number of hours.",
    });
    expect(cloudErrors({ ...d, tailscale: { ...d.tailscale, tag: "moonlet" } })).toEqual({ tag: "A tag is tag: then letters, digits and dashes, such as tag:moonlet-worker." });
    // The copied policy quotes the tag: nothing that would end the quote.
    expect(cloudErrors({ ...d, tailscale: { ...d.tailscale, tag: 'tag:worker"' } })).toEqual({ tag: "A tag is tag: then letters, digits and dashes, such as tag:moonlet-worker." });
    expect(cloudErrors(d)).toEqual({});
  });

  it("a provider added without its secret cannot be saved", () => {
    const i = info({ providers: {} });
    const d = cloudDraft(i);
    const added = { ...d, providers: { hetzner: { token: "" } } };
    expect(cloudErrors(added, i)).toEqual({ "hetzner.token": "Paste the API token." });
    expect(cloudErrors({ ...d, providers: { hetzner: { token: "hc-new" } } }, i)).toEqual({});
    // A saved one keeps its secret until replaced.
    expect(cloudErrors(cloudDraft(info()), info())).toEqual({});
  });

  it("removing a provider keeps the page's other unsaved edits", () => {
    const two = info({ providers: { hetzner: { has_token: true }, other: {} }, kinds: [hetzner, { id: "other", label: "Other", fields: [] }] });
    const edited = { ...cloudDraft(two), idle_minutes: "0", tailscale: { mode: "oauth" as const, client_id: "new-id", client_secret: "typed", auth_key: "", tag: "tag:shop" } };
    // Gone at once: the provider leaves the form, the edits stay.
    expect(afterRemoving(edited, info({ providers: { hetzner: { has_token: true } } }), "other")).toEqual({ ...edited, providers: { hetzner: { token: "" } } });
    // Its machines still draining: it stays until they are gone.
    expect(afterRemoving(edited, two, "other").providers).toEqual({ hetzner: { token: "" }, other: {} });
  });

  it("says which providers keep an idle machine until its paid time ends", () => {
    const hourly = { ...hetzner, billing_unit_secs: 3600 };
    expect(billingNote([hourly], { hetzner: { has_token: true } })).toBe(
      "Hetzner Cloud bills every started hour, so an idle machine stays until the time paid for is about to end.",
    );
    // Its own unit, whatever it is.
    expect(billingNote([{ ...hetzner, billing_unit_secs: 7200 }], { hetzner: {} })).toBe(
      "Hetzner Cloud bills every started 2 hours, so an idle machine stays until the time paid for is about to end.",
    );
    expect(billingNote([{ ...hetzner, billing_unit_secs: 600 }], { hetzner: {} })).toBe(
      "Hetzner Cloud bills every started 10 minutes, so an idle machine stays until the time paid for is about to end.",
    );
    // A provider billing by the second leaves at the idle time.
    expect(billingNote([{ ...hetzner, billing_unit_secs: 1 }], { hetzner: {} })).toBeNull();
    // Only providers in use.
    expect(billingNote([hourly], {})).toBeNull();
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
    const ms = [machine({ running: 2 }), machine({ id: "m2" }), machine({ id: "m3", project: "payments-api", project_key: "p", running: 1 })];
    expect(projectCloudFooter(ms, "k", "shop")).toBe("2 machines for shop · 2 running commands");
    expect(projectCloudFooter([machine({ running: 1 })], "k", "shop")).toBe("1 machine for shop · 1 running command");
    expect(projectCloudFooter([], "k", "shop")).toBe("No machines for shop");
    // Another project of the same name is another project.
    expect(projectCloudFooter([machine({ project_key: "other-shop", running: 3 })], "k", "shop")).toBe("No machines for shop");
  });
});
