import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "./store";
import { useEditor } from "./designEditor";
import { checkBundle } from "./bundleRelaunch";
import { noteChatAttachments, saveChatDraft } from "./chat";

const app = vi.hoisted(() => ({ onDisk: null as string | null, relaunched: 0 }));
// A relaunch that fails, so the next test starts from a running app.
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => ((app.relaunched += 1), Promise.reject(new Error("test"))) }));
vi.mock("./daemon", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hostsApi: { bundleVersion: () => Promise.resolve(app.onDisk) },
}));

beforeEach(() => {
  app.relaunched = 0;
  useStore.setState({ appVersion: "0.1.33", dirtyFiles: {}, update: { phase: "idle" }, updateError: null });
  useEditor.setState({ unsaved: {} });
});

describe("following an update another Mac made here (X69)", () => {
  it("keeps the app as it is while the bundle on disk is this version", async () => {
    app.onDisk = "0.1.33";
    await checkBundle();
    expect(app.relaunched).toBe(0);
    expect(useStore.getState().update).toEqual({ phase: "idle" });
  });

  it("offers Restart to update while a file tab or a design has unsaved edits", async () => {
    app.onDisk = "0.1.34";
    useStore.setState({ dirtyFiles: { "local|/src/app.ts": true } });
    await checkBundle();
    expect(app.relaunched).toBe(0);
    expect(useStore.getState().update).toEqual({ phase: "ready", version: "0.1.34" });

    useStore.setState({ dirtyFiles: {}, update: { phase: "idle" } });
    useEditor.setState({ unsaved: { "local|ws|cart": "Moved section m24" } });
    await checkBundle();
    expect(useStore.getState().update).toEqual({ phase: "ready", version: "0.1.34" });
  });

  it("offers Restart to update while a chat has unsent text, and clears an old check's error", async () => {
    app.onDisk = "0.1.34";
    useStore.setState({ updateError: "offline" });
    saveChatDraft("local", 7, "and then add tests");
    await checkBundle();
    saveChatDraft("local", 7, "");
    expect(app.relaunched).toBe(0);
    expect(useStore.getState().update).toEqual({ phase: "ready", version: "0.1.34" });
    expect(useStore.getState().updateError).toBeNull();
  });

  it("offers Restart to update while a chat has an image attached and no text", async () => {
    app.onDisk = "0.1.34";
    noteChatAttachments("local", 8, 1);
    await checkBundle();
    noteChatAttachments("local", 8, 0);
    expect(app.relaunched).toBe(0);
    expect(useStore.getState().update).toEqual({ phase: "ready", version: "0.1.34" });
  });

  it("relaunches once into a newer bundle on disk, however many checks overlap", async () => {
    app.onDisk = "0.1.34";
    await Promise.all([checkBundle(), checkBundle(), checkBundle()]);
    expect(app.relaunched).toBe(1);
  });
});
