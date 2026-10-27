// The app relaunches into its bundle on disk once that is newer than itself,
// as after another Mac updated this one (X69), unless there are unsaved edits.

import { relaunch } from "@tauri-apps/plugin-process";
import { hostsApi } from "./daemon";
import { useEditor } from "./designEditor";
import { errorToast, useStore } from "./store";
import { afterBundleCheck } from "./updater";

let relaunching = false;

/** Compares the bundle on disk with this app, and acts on it. */
export async function checkBundle() {
  if (relaunching) return;
  const running = useStore.getState().appVersion ?? "";
  const onDisk = await hostsApi.bundleVersion().catch(() => null);
  const unsaved = Object.keys(useStore.getState().dirtyFiles).length > 0 || Object.values(useEditor.getState().unsaved).some((u) => u !== null);
  switch (afterBundleCheck(running, onDisk, unsaved)) {
    case "relaunch":
      relaunching = true;
      void relaunch().catch((e) => {
        relaunching = false;
        errorToast(e);
      });
      break;
    case "offer":
      // The footer's Restart to update (X35).
      if (onDisk) useStore.setState({ update: { phase: "ready", version: onDisk } });
      break;
  }
}
