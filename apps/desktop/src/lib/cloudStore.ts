// Cloud machines (X63) as the app keeps them: the central host's, from
// `cloud.machines` and `cloud.changed`. A removal that starts failing gets a
// toast with Retry and a system notification.

import { create } from "zustand";
import { onDaemonEvent, onHostStatus, rpc } from "./daemon";
import { newRemovalErrors, providerName, removalToast } from "./cloudSettings";
import { EV, M, type CloudMachines } from "./protocol";
import { errorToast, notify, toast, useStore } from "./store";
import { useSync } from "./syncStore";

interface CloudState {
  /** The host whose machines these are: this Mac's central host, or this Mac. */
  host: string;
  machines: CloudMachines | null;
}

export const useCloud = create<CloudState>(() => ({ host: "local", machines: null }));

/** The host the Cloud workers page and the machines belong to. */
function centralHost(): string {
  const central = useSync.getState().central;
  const hosts = Object.values(useStore.getState().hosts);
  return hosts.find((h) => h.kind === "tailnet" && h.id === central)?.id ?? "local";
}

/** `cloud.down` on a machine being removed tries again now. */
export const retryRemoval = (host: string, machine: string) => void rpc(host, M.cloudDown, { machine }).catch(errorToast);

function show(host: string, next: CloudMachines) {
  const prev = useCloud.getState();
  const failing = newRemovalErrors(prev.host === host ? (prev.machines?.machines ?? null) : null, next.machines);
  useCloud.setState({ host, machines: next });
  for (const m of failing) {
    const text = removalToast(m, providerName(m.provider));
    toast(text, "error", { label: "Retry", run: () => retryRemoval(host, m.id) });
    void notify("A cloud machine is still billed", text);
  }
}

export function loadCloud() {
  const host = centralHost();
  if (useCloud.getState().host !== host) useCloud.setState({ host, machines: null });
  void rpc<CloudMachines>(host, M.cloudMachines).then(
    (m) => centralHost() === host && show(host, m),
    () => {},
  );
}

let started = false;

export function startCloud() {
  if (started) return;
  started = true;
  void onDaemonEvent((e) => {
    if (e.name === EV.cloudChanged && e.host === useCloud.getState().host) show(e.host, e.data as CloudMachines);
  });
  void onHostStatus((h) => {
    if (h.status === "connected" && h.id === centralHost()) loadCloud();
  });
  useSync.subscribe((s, p) => s.central !== p.central && loadCloud());
  loadCloud();
}
