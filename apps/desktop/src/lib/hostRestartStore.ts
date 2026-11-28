// Restarts running on tailnet hosts (X120): starts them, and asks the
// host's daemon.info until a daemon with another pid answers.

import { create } from "zustand";
import { DaemonError, hostsApi, rpc } from "./daemon";
import { followRestart, restartedText, type HostRestart } from "./hostRestart";
import type { HostInfo } from "./protocol";
import { toast, useStore } from "./store";

const FOLLOW_MS = 2_000;

export const useHostRestarts = create<{ restarts: Record<string, HostRestart> }>(() => ({ restarts: {} }));

function put(id: string, r: HostRestart | null) {
  useHostRestarts.setState((s) => {
    const restarts = { ...s.restarts };
    if (r) restarts[id] = r;
    else delete restarts[id];
    return { restarts };
  });
}

/** A failed `host_restart`'s message: Tauri hands the command's error back
 * as a plain object. */
function message(e: unknown): string {
  if (e instanceof DaemonError) return e.message;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
  return String(e);
}

/** Restarts `h`'s daemon, then follows it until a fresh one answers. */
export async function restartHost(h: HostInfo) {
  if (useHostRestarts.getState().restarts[h.id]?.phase === "restarting") return;
  let from: number;
  try {
    ({ pid: from } = await hostsApi.restart(h.id));
  } catch (e) {
    put(h.id, { phase: "failed", text: message(e) });
    return;
  }
  put(h.id, { phase: "restarting", from, since: Date.now() });
  // A slow daemon.info must not overlap the next one.
  let asking = false;
  const timer = setInterval(() => {
    if (asking) return;
    asking = true;
    void (async () => {
      const r = useHostRestarts.getState().restarts[h.id];
      const now = useStore.getState().hosts[h.id];
      if (!r || !now) {
        put(h.id, null);
        clearInterval(timer);
        return;
      }
      const info = await rpc<{ pid: number }>(h.id, "daemon.info").catch(() => null);
      const { next, reconnect } = followRestart(r, now, info, Date.now());
      if (next !== r) put(h.id, next);
      if (reconnect) void hostsApi.reconnect(h.id).catch(() => {});
      if (next?.phase === "restarting") return;
      clearInterval(timer);
      if (next === null) toast(restartedText(now), "info");
    })().finally(() => {
      asking = false;
    });
  }, FOLLOW_MS);
}
