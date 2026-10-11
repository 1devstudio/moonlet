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

/** The preview: 12 px text on 18 px lines, at most 16 of them, plus its
 * 8 px padding and 1 px border on each side. */
const PREVIEW_LINE = 18;
const PREVIEW_MAX = 16 * PREVIEW_LINE + 2 * 8 + 2 * 1;

function ReadDialog({ host, request }: { host: string; request: ReadRequest }) {
  const font = useStore((s) => s.settings.term.fontFamily);
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
      <pre
        className="selectable mt-3 overflow-auto rounded-md border border-border bg-panel-2 text-muted"
        style={{ fontFamily: font, fontSize: 12, lineHeight: `${PREVIEW_LINE}px`, padding: "8px 12px", maxHeight: PREVIEW_MAX }}
      >
        {request.text}
      </pre>
    </ConfirmDialog>
  );
}
