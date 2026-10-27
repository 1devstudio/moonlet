// Updates running on tailnet hosts (X69): starts them, follows each host's
// status until it runs the new version, and announces older hosts once per
// app version.

import { create } from "zustand";
import { DaemonError, hostsApi } from "./daemon";
import { followUpdate, olderHosts, olderHostsText, updateFailed, type HostUpdate } from "./hostUpdate";
import type { HostInfo } from "./protocol";
import { readStored, writeStored } from "./storage";
import { toast, useStore } from "./store";

const FOLLOW_MS = 2_000;
const ANNOUNCED_KEY = "olderHostsAnnouncedFor";

export const useHostUpdates = create<{ updates: Record<string, HostUpdate> }>(() => ({ updates: {} }));

function put(id: string, u: HostUpdate | null) {
  useHostUpdates.setState((s) => {
    const updates = { ...s.updates };
    if (u) updates[id] = u;
    else delete updates[id];
    return { updates };
  });
}

/** Updates `h` to `version`, then follows it until it is back. */
export async function updateHost(h: HostInfo, version: string) {
  if (useHostUpdates.getState().updates[h.id]?.phase === "updating") return;
  put(h.id, { phase: "updating", to: version, since: Date.now() });
  try {
    await hostsApi.update(h.id, version);
  } catch (e) {
    const err = e instanceof DaemonError ? { code: e.code, message: e.message } : { code: "failed", message: String(e) };
    put(h.id, updateFailed(h, err));
    return;
  }
  // The minute to come back counts from the reply, not the click: the
  // download before it can take minutes.
  put(h.id, { phase: "updating", to: version, since: Date.now() });
  const timer = setInterval(() => {
    const u = useHostUpdates.getState().updates[h.id];
    const now = useStore.getState().hosts[h.id];
    if (!u || !now) {
      clearInterval(timer);
      return;
    }
    const { next, reconnect } = followUpdate(u, now, Date.now());
    if (next !== u) put(h.id, next);
    if (reconnect) void hostsApi.reconnect(h.id).catch(() => {});
    if (next?.phase !== "updating") clearInterval(timer);
  }, FOLLOW_MS);
}

/** Updates every older host at once; one failing leaves the others going. */
export function updateAll(hosts: HostInfo[], appVersion: string) {
  for (const h of olderHosts(hosts, appVersion)) void updateHost(h, appVersion);
}

/** The toast offering Update all, once per app version. */
export function announceOlderHosts(hosts: HostInfo[], appVersion: string) {
  if (!appVersion || readStored(ANNOUNCED_KEY) === appVersion) return;
  const text = olderHostsText(hosts, appVersion);
  if (!text) return;
  writeStored(ANNOUNCED_KEY, appVersion);
  toast(text, "info", { label: "Update all", run: () => updateAll(Object.values(useStore.getState().hosts), appVersion) });
}
