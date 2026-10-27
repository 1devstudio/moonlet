import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "./store";
import { useEditor } from "./designEditor";
import { checkBundle } from "./bundleRelaunch";

const app = vi.hoisted(() => ({ onDisk: null as string | null, relaunched: 0 }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => ((app.relaunched += 1), Promise.resolve()) }));
vi.mock("./daemon", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hostsApi: { bundleVersion: () => Promise.resolve(app.onDisk) },
}));

beforeEach(() => {
  app.relaunched = 0;
  useStore.setState({ appVersion: "0.1.33", dirtyFiles: {}, update: { phase: "idle" } });
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

  it("relaunches into a newer bundle on disk", async () => {
    app.onDisk = "0.1.34";
    await checkBundle();
    expect(app.relaunched).toBe(1);
  });
});
