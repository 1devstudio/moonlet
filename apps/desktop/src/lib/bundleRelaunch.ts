// The app relaunches into its bundle on disk once that is newer than itself,
// as after another Mac updated this one (X69), unless there is work a
// relaunch would lose.

import { relaunch } from "@tauri-apps/plugin-process";
import { hasChatDrafts } from "./chat";
import { hostsApi } from "./daemon";
import { editsInFlight } from "./designEditor";
import { errorToast, useStore } from "./store";
import { afterBundleCheck } from "./updater";

let relaunching = false;
/** The check running now, which later calls join and then run once more. */
let running: Promise<void> | null = null;
let again = false;

/** Whether a relaunch would lose something: a file tab or a design with
 * edits not saved, or a chat with text not sent. */
const unsavedWork = () => Object.keys(useStore.getState().dirtyFiles).length > 0 || editsInFlight() || hasChatDrafts();

/** Compares the bundle on disk with this app, and acts on it. One check at a
 * time; a call during one runs it again once it ends. */
export function checkBundle(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await checkOnce();
    } while (again);
  })().finally(() => (running = null));
  return running;
}

async function checkOnce() {
  if (relaunching) return;
  const onDisk = await hostsApi.bundleVersion().catch(() => null);
  const { appVersion, update } = useStore.getState();
  switch (afterBundleCheck(appVersion ?? "", onDisk, unsavedWork(), update.phase)) {
    case "relaunch":
      relaunching = true;
      try {
        await relaunch();
      } catch (e) {
        // Not again in this run: one error, not one per overlapping call.
        relaunching = false;
        again = false;
        errorToast(e);
      }
      break;
    case "offer":
      // The footer's Restart to update (X35); an older check's error no
      // longer applies.
      if (onDisk) useStore.setState({ update: { phase: "ready", version: onDisk }, updateError: null });
      break;
  }
}
