// A toast when this Mac's version of a copied file went to leftovers, as
// another Mac's won (X74).

import { hostsApi, onDaemonEvent } from "./daemon";
import { keptToast } from "./copiedFiles";
import { EV } from "./protocol";
import { errorToast, toast, useStore } from "./store";

let started = false;

export function startCopiedFiles() {
  if (started) return;
  started = true;
  void onDaemonEvent((e) => {
    if (e.name !== EV.filesKept || e.host !== "local") return;
    const k = e.data as { label: string; path: string; folder: string };
    toast(keptToast(k, useStore.getState().hosts.local?.home ?? null), "info", {
      label: "Show in Finder",
      run: () => void hostsApi.openIn("reveal", k.folder).catch(errorToast),
    });
  });
}
