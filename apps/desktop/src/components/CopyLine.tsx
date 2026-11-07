// The line at the top of a copy's session while the member running it is away
// (X86): read only, and Continue on <this Mac> once the central host can
// take the session over (X73).

import { useState } from "react";
import { continueFailed, continueOffer, continueWait, readOnlyLine } from "../lib/centralCopies";
import { parseCopyHost } from "../lib/copyHost";
import { rpc } from "../lib/daemon";
import { M } from "../lib/protocol";
import { selectSession, toast, useStore } from "../lib/store";
import { useSync } from "../lib/syncStore";
import { useNow } from "../lib/useNow";
import { Button } from "./ui";

export function CopyLine({ host }: { host: string }) {
  const copy = parseCopyHost(host);
  const s = useStore((st) => (copy ? st.sessions[host]?.[0] : undefined));
  const here = useSync((st) => st.meName) ?? "this Mac";
  const [busy, setBusy] = useState(false);
  const now = useNow(!!s && continueWait(s, Date.now()) > 0);
  if (!copy || !s) return null;
  const line = readOnlyLine(s, here);
  if (!line) return null;
  const offer = continueOffer(s, here, now);
  const ready = !!offer && continueWait(s, now) === 0;
  const go = async () => {
    setBusy(true);
    try {
      await rpc("local", M.sessionContinueHere, { session: s.id });
      selectSession("local", s.id);
    } catch (e) {
      toast(continueFailed(e, s, here), "error");
    } finally {
      setBusy(false);
    }
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
