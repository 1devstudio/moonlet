// Link a session to a task (X76, the desktop's X46 dialog): suggested tasks
// first, then the rest by last update; Link sets the session's task.

import { useState } from "react";
import { Search, X } from "lucide-react";
import { rpc } from "@desktop/lib/daemon";
import { M, type Session } from "@desktop/lib/protocol";
import { useApp } from "../lib/app";
import { sessionBoards } from "../lib/board";
import { useBusy } from "../lib/busy";
import { type LinkRow, linkSheet } from "../lib/taskView";
import { CategoryGlyph } from "../screens/Tasks";
import { Sheet } from "./Sheet";
import { cx } from "./ui";

export function LinkSheet({ host, session, onClose }: { host: string; session: Session; onClose: () => void }) {
  const hosts = useApp((s) => s.hosts);
  const data = useApp((s) => s.data);
  const [q, setQ] = useState("");
  const { busy, error, run } = useBusy();
  const d = data[host];
  const boards = sessionBoards(hosts, data, host, session);
  if (!d) return null;
  const sheet = linkSheet(boards, d, session, q, Date.now());
  const link = (r: LinkRow) => void run(() => rpc(host, M.sessionUpdate, { id: session.id, task: { connection: r.task.connection, key: r.task.key, url: r.task.url } })).then((ok) => ok && onClose());

  const row = (r: LinkRow, suggested: boolean) => (
    <div key={r.id} className={cx("flex items-start gap-2.5 px-2.5 py-2.5", suggested ? "rounded-[12px] bg-raised" : "border-b border-border")}>
      <span className="pt-[3px]">
        <CategoryGlyph category={r.category} size={14} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="flex-none font-mono text-[13px] font-semibold">{r.key}</span>
          <span className="truncate text-[14.5px]">{r.title}</span>
        </span>
        <span className="text-[12.5px] text-muted">{r.line}</span>
      </span>
      <button type="button" disabled={busy} onClick={() => link(r)} className={cx("h-8 flex-none rounded-[8px] px-3 text-[13.5px]", suggested ? "bg-fg font-semibold text-bg" : "border border-border-strong")}>
        Link
      </button>
    </div>
  );

  return (
    <Sheet label={sheet.title} onClose={onClose}>
      <div className="flex items-start gap-3 px-[18px] pt-1 pb-3">
        <h2 className="m-0 min-w-0 flex-1 text-[19px] leading-tight font-semibold">{sheet.title}</h2>
        <button type="button" aria-label="Close" onClick={onClose} className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-raised text-muted">
          <X size={17} />
        </button>
      </div>
      <label className="mx-4 flex h-11 items-center gap-2.5 rounded-[12px] border border-border-strong bg-raised px-3">
        <Search size={17} className="text-faint" />
        <input aria-label="Search tasks" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks, or paste a key or URL" className="min-w-0 flex-1 bg-transparent text-[15px] outline-none" />
      </label>
      <div className="scroll flex flex-col gap-1 px-2 pt-3 pb-2">
        {!boards.length && <p className="px-3 text-[14px] text-muted">No boards in this workspace yet. Add one in moonlet on the Mac.</p>}
        {sheet.suggested.length > 0 && <div className="eyebrow px-2.5 pb-1">Suggested</div>}
        {sheet.suggested.map((r) => row(r, true))}
        {sheet.recent.length > 0 && <div className="eyebrow px-2.5 pt-3 pb-1">Recent</div>}
        {sheet.recent.map((r) => row(r, false))}
        {error && <p className="px-3 text-[13px] text-error">{error}</p>}
      </div>
      <p className="m-0 border-t border-border px-[18px] pt-3 text-[12.5px] text-faint">{sheet.note}</p>
    </Sheet>
  );
}
