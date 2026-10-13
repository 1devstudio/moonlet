// The plan approval sheet (X40, X20): the plan in full, approve it, or say
// what should change.

import { useState } from "react";
import { ListChecks, X } from "lucide-react";
import { planOf } from "@desktop/lib/chat";
import { type Screen, showScreen, useApp } from "../lib/app";
import { answerPlan } from "../lib/answers";
import { ageText } from "../lib/cards";
import { Markdown } from "../components/Markdown";
import { AgentIcon, Btn } from "../components/ui";
import { useNow } from "./Inbox";

export function PlanSheet({ host, terminal, ask: askId, from }: { host: string; terminal: number; ask: string; from?: Screen }) {
  const d = useApp((s) => s.data[host]);
  const hostLabel = useApp((s) => s.hosts[host]?.label ?? host);
  const now = useNow();
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const ask = d?.chats[terminal]?.pending.find((a) => a.id === askId);
  const plan = ask && planOf(ask);
  const session = d?.sessions.find((s) => s.id === d.terminals[terminal]?.session_id) ?? null;
  const project = d?.projects.find((p) => p.id === session?.project_id)?.name;
  const close = () => showScreen(from ?? null);

  const choose = async (choice: "approve" | "ask" | "keepPlanning") => {
    setBusy(true);
    try {
      if (await answerPlan(host, terminal, askId, choice, feedback)) close();
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={close} aria-hidden="true" />
      <section role="dialog" aria-label="Claude has a plan" className="relative flex max-h-[92%] flex-col rounded-t-[22px] border-t border-border-strong bg-panel" style={{ paddingBottom: "max(var(--safe-bottom), 12px)" }}>
        <div className="flex justify-center pt-2 pb-1">
          <span className="h-[5px] w-9 rounded-full bg-border-strong" />
        </div>
        <div className="flex flex-col gap-1 px-4 pb-3">
          <div className="flex items-center gap-2">
            <ListChecks size={17} className="text-blocked" />
            <span className="text-[17px] font-semibold">Claude has a plan</span>
            <span className="flex-1" />
            <button type="button" aria-label="Close" onClick={close} className="flex h-8 w-8 items-center justify-center rounded-full bg-raised text-muted">
              <X size={16} />
            </button>
          </div>
          <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
            <AgentIcon agent="claude" size={13} />
            {[project, hostLabel, ask?.asked_at ? `waiting ${ageText(ask.asked_at, now)}` : null].filter(Boolean).join(" · ")}
          </span>
        </div>
        <div className="scroll min-h-0 flex-1 border-y border-border px-4 py-3">
          {plan ? <Markdown text={plan.plan} /> : <p className="text-muted">This plan was answered.</p>}
          {plan?.file && <div className="mt-3 font-mono text-[11.5px] text-faint">{plan.file}</div>}
        </div>
        {plan && (
          <div className="flex flex-col gap-2 px-4 pt-3">
            {revising ? (
              <>
                <label htmlFor="fb" className="text-[13px] text-muted">
                  What should change in the plan?
                </label>
                <textarea id="fb" rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Use a feature flag instead…" className="rounded-[10px] border border-border-strong bg-bg p-3 text-[14.5px] outline-none" />
                <div className="grid grid-cols-2 gap-2">
                  <Btn tone="ghost" onClick={() => setRevising(false)}>
                    Back
                  </Btn>
                  <Btn tone="primary" disabled={busy || !feedback.trim()} onClick={() => void choose("keepPlanning")}>
                    Send feedback
                  </Btn>
                </div>
              </>
            ) : (
              <>
                <Btn tone="primary" disabled={busy} onClick={() => void choose("approve")}>
                  Approve, auto mode
                </Btn>
                <div className="grid grid-cols-2 gap-2">
                  <Btn disabled={busy} onClick={() => void choose("ask")}>
                    Ask before edits
                  </Btn>
                  <Btn disabled={busy} onClick={() => setRevising(true)}>
                    Keep planning
                  </Btn>
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
