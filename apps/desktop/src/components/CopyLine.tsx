// The line at the top of a copy's session while the member running it is away
// (X88): read only, and Continue on <this Mac> once the central host can
// take the session over (X73).

import { useState } from "react";
import { continueOffer, continueWait, readOnlyLine } from "../lib/centralCopies";
import { parseCopyHost } from "../lib/copyHost";
import type { Session } from "../lib/protocol";
import { continueHere, useStore } from "../lib/store";
import { useSync } from "../lib/syncStore";
import { useNow } from "../lib/useNow";
import { Button } from "./ui";

/** The copy opened under `host` (X88), this Mac's name, and the read-only
 * line while its member is away; no session for any other host. */
export function useCopyReadOnly(host: string): { session?: Session; here: string; line: string | null } {
  const session = useStore((st) => (parseCopyHost(host) ? st.sessions[host]?.[0] : undefined));
  const here = useSync((st) => st.meName) ?? "this Mac";
  return { session, here, line: session ? readOnlyLine(session, here) : null };
}

export function CopyLine({ host }: { host: string }) {
  const { session: s, here, line } = useCopyReadOnly(host);
  const [busy, setBusy] = useState(false);
  const now = useNow(!!s && continueWait(s, Date.now()) > 0);
  if (!s || !line) return null;
  const offer = continueOffer(s, here, now);
  const ready = !!offer && continueWait(s, now) === 0;
  const go = async () => {
    setBusy(true);
    await continueHere(s, here);
    setBusy(false);
  };
  return (
    <div role="status" className="flex shrink-0 items-center gap-2 border-b border-border px-7 py-1.5 ui-text-12.5 text-muted">
      <span className="min-w-0 flex-1">{line}</span>
      {offer && (
        <Button size="sm" disabled={!ready || busy} onClick={() => void go()}>
          {offer}
        </Button>
      )}
    </div>
  );
}
