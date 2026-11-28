// The Update and Restart buttons of a tailnet host (X69, X120), on its Settings row and its
// sidebar notice, and the toast offering Update all once per app version.

import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { restartOffer } from "../lib/hostRestart";
import { restartHost, useHostRestarts } from "../lib/hostRestartStore";
import { updateOffer } from "../lib/hostUpdate";
import { announceOlderHosts, updateHost, useHostUpdates } from "../lib/hostUpdateStore";
import type { HostInfo } from "../lib/protocol";
import { useStore } from "../lib/store";
import { Button } from "./ui";

export function HostUpdateButton({ host }: { host: HostInfo }) {
  const appVersion = useStore((s) => s.appVersion) ?? "";
  const update = useHostUpdates((s) => s.updates[host.id]);
  if (update?.phase === "updating") {
    return (
      <Button size="sm" variant="primary" disabled>
        <Loader2 size={12} className="animate-spin" /> Updating…
      </Button>
    );
  }
  const offer = updateOffer(host, appVersion);
  if (!offer) return null;
  return (
    <Button size="sm" variant="primary" onClick={() => void updateHost(host, offer)}>
      Update to {offer}
    </Button>
  );
}

/** Restart of a tailnet host's daemon (X120), on its Settings row. */
export function HostRestartButton({ host }: { host: HostInfo }) {
  const restart = useHostRestarts((s) => s.restarts[host.id]);
  if (restart?.phase === "restarting") {
    return (
      <Button size="sm" variant="ghost" disabled>
        <Loader2 size={12} className="animate-spin" /> Restarting…
      </Button>
    );
  }
  if (!restartOffer(host)) return null;
  return (
    <Button size="sm" variant="ghost" onClick={() => void restartHost(host)}>
      Restart
    </Button>
  );
}

/** Offers Update all once per app version, when hosts run an older moonlet. */
export function OlderHostsAnnouncer() {
  const hosts = useStore((s) => s.hosts);
  const appVersion = useStore((s) => s.appVersion) ?? "";
  useEffect(() => announceOlderHosts(Object.values(hosts), appVersion), [hosts, appVersion]);
  return null;
}
