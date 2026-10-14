import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerConfirm } from "./confirm";
import { goSettings, setLeaveGuard } from "./settingsNavigation";
import { openProjectSettings, runAction } from "./actions";
import { useStore } from "./store";

vi.mock("./daemon", () => ({ rpc: vi.fn(), sendInput: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setBadgeCount: () => Promise.resolve() }) }));

const tick = () => new Promise((r) => setTimeout(r));

describe("moving around the settings page (X43)", () => {
  beforeEach(() => {
    setLeaveGuard(null);
    useStore.setState({ confirm: null, dialog: null, settingsPage: { page: "workspace", host: "local", id: "acme" } });
  });

  it("goes to another page at once when nothing is unsaved", async () => {
    await goSettings({ page: "general" });
    expect(useStore.getState().settingsPage).toEqual({ page: "general" });
  });

  it("asks before leaving unsaved changes, and stays on Keep editing", async () => {
    setLeaveGuard(() => ({ state: "ask", message: "Discard unsaved changes to Acme?" }));
    const going = goSettings(null);
    await tick();
    expect(useStore.getState().confirm?.options).toMatchObject({ title: "Discard changes", message: "Discard unsaved changes to Acme?", action: "Discard", cancel: "Keep editing" });
    answerConfirm(false, false);
    await going;
    expect(useStore.getState().settingsPage).toEqual({ page: "workspace", host: "local", id: "acme" });
  });

  it("leaves once the changes are discarded", async () => {
    setLeaveGuard(() => ({ state: "ask", message: "Discard unsaved changes to Acme?" }));
    const going = goSettings({ page: "hosts" });
    await tick();
    answerConfirm(true, false);
    await going;
    expect(useStore.getState().settingsPage).toEqual({ page: "hosts" });
  });

  it("asks before Settings… from the palette leaves unsaved changes", async () => {
    setLeaveGuard(() => ({ state: "ask", message: "Discard unsaved changes to Acme?" }));
    runAction("settings");
    await tick();
    expect(useStore.getState().confirm?.options.title).toBe("Discard changes");
    answerConfirm(false, false);
    await tick();
    expect(useStore.getState().settingsPage).toEqual({ page: "workspace", host: "local", id: "acme" });
  });

  it("stays put while a save is running", async () => {
    setLeaveGuard(() => ({ state: "wait", message: "" }));
    await goSettings(null);
    expect(useStore.getState().confirm).toBeNull();
    expect(useStore.getState().settingsPage).toEqual({ page: "workspace", host: "local", id: "acme" });
  });
});

describe("Project settings (X8, X43)", () => {
  beforeEach(() => {
    setLeaveGuard(null);
    useStore.setState({ confirm: null, dialog: null, settingsPage: null });
  });

  it("opens as a settings page at the project, focusing Run when asked", async () => {
    openProjectSettings({ host: "local", project: "storefront" }, "run");
    await tick();
    expect(useStore.getState().settingsPage).toEqual({ page: "project", host: "local", id: "storefront", focus: "run" });
    expect(useStore.getState().dialog).toBeNull();
  });
});
