import { useEffect, useState } from "react";
import { rpc } from "../lib/daemon";
import { M, type ReadRequest } from "../lib/protocol";
import { errorToast, useStore } from "../lib/store";
import { readPrompt, shownRead } from "../lib/terminalRead";
import { ConfirmDialog } from "./ui";

/** Asks the user before an agent reads a terminal of the session in view (X31). */
export function ReadHost() {
  const reads = useStore((s) => s.reads);
  const selected = useStore((s) => s.selected);
  const confirmOpen = useStore((s) => !!s.confirm);
  const shown = shownRead(reads, selected, confirmOpen);
  return shown ? <ReadDialog key={`${shown.host}:${shown.request.request_id}`} host={shown.host} request={shown.request} /> : null;
}

function ReadDialog({ host, request }: { host: string; request: ReadRequest }) {
  const name = useStore((s) => s.sessions[host]?.find((w) => w.id === request.session_id)?.name ?? "this session");
  const [remember, setRemember] = useState(false);
  const [before] = useState(() => document.activeElement);
  useEffect(
    () => () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    },
    [before],
  );
  const [sent, setSent] = useState(false);
  const answer = (allow: boolean) => {
    // The daemon's `terminal.read_done` closes the modal, in every window.
    if (sent) return;
    setSent(true);
    void rpc(host, M.terminalReadAnswer, { request_id: request.request_id, allow, remember: allow && remember }).catch(errorToast);
  };
  const prompt = readPrompt(request, name);
  return (
    <ConfirmDialog
      title={prompt.title}
      message={prompt.message}
      action="Allow"
      cancel="Deny"
      checkbox="Allow for the rest of this session"
      checked={remember}
      onCheck={setRemember}
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
      wide
    >
      <pre className="selectable mt-3 max-h-[290px] overflow-auto rounded-md border border-border bg-panel-2 px-3 py-2 font-mono ui-text-12 leading-[1.5] text-muted">
        {request.text}
      </pre>
    </ConfirmDialog>
  );
}
