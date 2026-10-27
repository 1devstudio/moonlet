// The Update button of a tailnet host (X69), on its Settings row and its
// sidebar notice, and the toast offering Update all once per app version.

import { useEffect } from "react";
import { Loader2 } from "lucide-react";
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

/** Offers Update all once per app version, when hosts run an older moonlet. */
export function OlderHostsAnnouncer() {
  const hosts = useStore((s) => s.hosts);
  const appVersion = useStore((s) => s.appVersion) ?? "";
  useEffect(() => announceOlderHosts(Object.values(hosts), appVersion), [hosts, appVersion]);
  return null;
}
