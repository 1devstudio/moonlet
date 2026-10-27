// Inbox (X40): every ask waiting for the user across hosts, answerable in
// place.

import { useState } from "react";
import { ListChecks, MessageCircleQuestion, Server, SquareTerminal, Terminal } from "lucide-react";
import { planOf } from "@desktop/lib/chat";
import { showScreen, useApp } from "../lib/app";
import { answerAsk, answerPlan, answerRead } from "../lib/answers";
import { ageText, askHeadline, planBlurb, readMessage } from "../lib/cards";
import { type InboxCard, buildInbox, summaryLine } from "../lib/inbox";
import { useBusy } from "../lib/busy";
import { useNow } from "../lib/now";
import { AgentIcon, Btn, Moon, StateGlyph, Title } from "../components/ui";
import { Sheet } from "../components/Sheet";
import { AskerLine } from "../components/chat";
import { WorkspacePill } from "../components/WorkspacePill";


export function useInbox() {
  const hosts = useApp((s) => s.hosts);
  const data = useApp((s) => s.data);
  const workspace = useApp((s) => s.settings.workspace);
  return buildInbox(hosts, data, workspace);
}

function Meta({ card }: { card: InboxCard }) {
  return (
    <div className="flex items-center gap-1.5 text-[12.5px] text-muted">
      <AgentIcon agent={card.agent} size={13} />
      {card.project && (
        <>
          <span>{card.project}</span>
          <span className="text-faint">·</span>
        </>
      )}
      {card.remote && <Server size={12} />}
      <span>{card.hostLabel}</span>
    </div>
  );
}

function PermissionCard({ card, now }: { card: InboxCard; now: number }) {
  const ask = card.ask!;
  const { busy, run } = useBusy();
  const answer = (d: "allow" | "always" | "deny") => run(() => answerAsk(card.host, card.terminal, ask.id, d));
  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-[rgba(242,201,76,0.28)] bg-panel p-3.5">
      <div className="flex items-center gap-2">
        <StateGlyph state="blocked" />
        <button type="button" onClick={() => card.session && showScreen({ kind: "session", host: card.host, id: card.session.id, tab: "chat" })} className="min-w-0 flex-1 truncate text-left text-[15px] font-medium">
          {card.title}
        </button>
        <span className="text-[12px] text-faint">{ageText(card.askedAt, now)}</span>
      </div>
      <Meta card={card} />
      <div className="flex flex-col gap-1.5 rounded-[10px] bg-raised px-3 py-2.5">
        {card.asker && <AskerLine name={card.asker} />}
        <div className="flex items-center gap-[7px] text-[13px] font-medium">
          <SquareTerminal size={14} className="text-blocked" />
          {askHeadline(ask.tool)}
        </div>
        {ask.summary && <code className="font-mono text-[12.5px] break-all whitespace-pre-wrap">{ask.summary}</code>}
        {ask.reason && <span className="text-[12.5px] text-muted">{ask.reason}</span>}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Btn tone="primary" disabled={busy} onClick={() => void answer("allow")}>
          Allow
        </Btn>
        <Btn disabled={busy || !ask.can_always} onClick={() => void answer("always")}>
          Always
        </Btn>
        <Btn tone="ghost" disabled={busy} onClick={() => void answer("deny")}>
          Deny
        </Btn>
      </div>
    </div>
  );
}

function PlanCard({ card, now }: { card: InboxCard; now: number }) {
  const ask = card.ask!;
  const plan = planOf(ask);
  const { busy, run } = useBusy();
  return (
    <div className="flex flex-col gap-2.5 rounded-[14px] border border-border-strong bg-panel p-3.5">
      <div className="flex items-center gap-2">
        <ListChecks size={16} className="text-blocked" />
        <span className="min-w-0 flex-1 text-[15px] font-medium">Claude has a plan</span>
        <span className="text-[12px] text-faint">{ageText(card.askedAt, now)}</span>
      </div>
      <div className="text-[13.5px] leading-[1.45] text-muted">
        <span className="text-fg">{ask.summary || "Plan"}</span>
        {plan && ` — ${planBlurb(plan.plan)}`}
      </div>
      <Meta card={card} />
      <div className="grid grid-cols-2 gap-2">
        <Btn tone="primary" onClick={() => showScreen({ kind: "plan", host: card.host, terminal: card.terminal, ask: ask.id })}>
          Review plan
        </Btn>
        <Btn disabled={busy} onClick={() => void run(() => answerPlan(card.host, card.terminal, ask.id, "approve"))}>
          Approve, auto
        </Btn>
      </div>
    </div>
  );
}

function QuestionCard({ card, now }: { card: InboxCard; now: number }) {
  return (
    <button
      type="button"
      onClick={() => card.session && showScreen({ kind: "session", host: card.host, id: card.session.id, tab: "chat" })}
      className="flex flex-col gap-2.5 rounded-[14px] border border-border-strong bg-panel p-3.5 text-left"
    >
      <div className="flex items-center gap-2">
        <MessageCircleQuestion size={16} className="text-blocked" />
        <span className="min-w-0 flex-1 text-[15px] font-medium">Claude has a question</span>
        <span className="text-[12px] text-faint">{ageText(card.askedAt, now)}</span>
      </div>
      <div className="text-[13.5px] text-muted">
        In <span className="text-fg">{card.title}</span>. Open the chat to answer.
      </div>
      <Meta card={card} />
    </button>
  );
}

function ReadCard({ card, now }: { card: InboxCard; now: number }) {
  const req = card.read!;
  const { busy, run } = useBusy();
  const [preview, setPreview] = useState(false);
  const message = readMessage(req, card.title);
  return (
    <div className="flex flex-col gap-2.5 rounded-[14px] border border-border-strong bg-panel p-3.5">
      <div className="flex items-center gap-2">
        <Terminal size={16} className="text-blocked" />
        <span className="min-w-0 flex-1 text-[15px] font-medium">Let Claude read a terminal?</span>
        <span className="text-[12px] text-faint">{ageText(card.askedAt, now)}</span>
      </div>
      <div className="text-[13.5px] leading-[1.45] text-muted">{message}</div>
      <div className="grid grid-cols-2 gap-2">
        <Btn onClick={() => setPreview(true)}>Preview output</Btn>
        <Btn tone="ghost" disabled={busy} onClick={() => void run(() => answerRead(card.host, req.request_id, false))}>
          Deny
        </Btn>
      </div>
      {preview && (
        <Sheet label="Terminal output" onClose={() => setPreview(false)}>
          <div className="flex min-h-0 flex-col gap-3 px-4 pt-1">
            <div className="text-[13.5px] leading-[1.45] text-muted">{message}</div>
            <pre className="selectable scroll m-0 max-h-[50vh] rounded-[10px] bg-bg p-3 font-mono text-[12px] leading-[1.45] whitespace-pre-wrap">{req.text}</pre>
            <div className="grid grid-cols-2 gap-2">
              <Btn tone="ghost" disabled={busy} onClick={() => void run(async () => (await answerRead(card.host, req.request_id, false)) && setPreview(false))}>
                Deny
              </Btn>
              <Btn tone="primary" disabled={busy} onClick={() => void run(async () => (await answerRead(card.host, req.request_id, true)) && setPreview(false))}>
                Allow
              </Btn>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}

export function InboxScreen() {
  const inbox = useInbox();
  const now = useNow();
  return (
    <div className="scroll h-full">
      <Title icon={<Moon size={28} />} right={<WorkspacePill />} below={<div className="text-[13px] text-muted">{summaryLine(inbox)}</div>}>
        Inbox
      </Title>
      <div className="flex flex-col gap-2.5 px-4 pt-[18px] pb-6">
        {inbox.needs.length > 0 ? (
          <div className="flex items-center gap-2 text-[12px] font-semibold tracking-[0.08em] text-blocked uppercase">
            Needs you <span className="rounded-[9px] bg-[rgba(242,201,76,0.14)] px-[7px] py-px tracking-normal">{inbox.needs.length}</span>
          </div>
        ) : (
          <div className="rounded-[14px] border border-border bg-panel p-4 text-[14px] text-muted">Nothing needs you.</div>
        )}
        {inbox.needs.map((c) =>
          c.kind === "permission" ? (
            <PermissionCard key={c.key} card={c} now={now} />
          ) : c.kind === "plan" ? (
            <PlanCard key={c.key} card={c} now={now} />
          ) : c.kind === "question" ? (
            <QuestionCard key={c.key} card={c} now={now} />
          ) : (
            <ReadCard key={c.key} card={c} now={now} />
          ),
        )}
      </div>
    </div>
  );
}
