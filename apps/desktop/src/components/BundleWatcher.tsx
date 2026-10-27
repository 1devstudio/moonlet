// Checks the bundle on disk whenever this Mac's daemon connects or changes
// state (a live upgrade reconnects it), so the app follows an update another
// Mac made here (X69).

import { useEffect } from "react";
import { checkBundle } from "../lib/bundleRelaunch";
import { useStore } from "../lib/store";

export function BundleWatcher() {
  const local = useStore((s) => s.hosts.local);
  const appVersion = useStore((s) => s.appVersion);
  useEffect(() => {
    if (appVersion) void checkBundle();
  }, [local?.status, local?.daemon_version, appVersion]);
  return null;
}
