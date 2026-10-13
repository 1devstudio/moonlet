// The Chat tab (X40): the conversation, a waiting ask docked above the
// composer, and the footer with context, cost, model and mode.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ListChecks, MessageCircleQuestion, Plus, Square, SquareTerminal } from "lucide-react";
import { rpc } from "@desktop/lib/daemon";
import { askQuestions, chatBlocks, chatKey, loadChat, questionAnswers, turnRunning, useChat } from "@desktop/lib/chat";
import { CLAUDE_MODELS, CLAUDE_MODES, EFFORTS } from "@desktop/lib/agents";
import { M, type PermissionAsk, type Session } from "@desktop/lib/protocol";
import { showScreen, useApp } from "../lib/app";
import { answerAsk, answerQuestion } from "../lib/answers";
import { ageText, askHeadline } from "../lib/cards";
import { chatFooter, sessionChat } from "../lib/chatView";
import { ChatBlockView } from "../components/chat";
import { Sheet } from "../components/Sheet";
import { Btn, cx } from "../components/ui";
import { useNow } from "./Inbox";

function DockedAsk({ host, terminal, ask }: { host: string; terminal: number; ask: PermissionAsk }) {
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [telling, setTelling] = useState(false);
  const [message, setMessage] = useState("");
  const answer = async (d: "allow" | "always" | "deny", msg?: string) => {
    setBusy(true);
    try {
      await answerAsk(host, terminal, ask.id, d, msg);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Waiting for your approval" className="flex flex-col gap-2.5 border-t border-[rgba(242,201,76,0.28)] bg-panel px-4 pt-3 pb-2">
      <div className="flex items-center gap-2 text-[14px] font-medium">
        <SquareTerminal size={16} className="text-blocked" />
        {askHeadline(ask.tool)}
        <span className="flex-1" />
        {ask.asked_at && <span className="text-[12px] font-normal text-faint">Waiting {ageText(ask.asked_at, now)}</span>}
      </div>
      {ask.summary && <code className="scroll max-h-24 rounded-[8px] bg-raised px-3 py-2 font-mono text-[12.5px] break-all whitespace-pre-wrap">{ask.summary}</code>}
      {telling ? (
        <div className="flex flex-col gap-2">
          <textarea autoFocus rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Tell Claude what to do instead…" className="rounded-[10px] border border-border-strong bg-bg p-2.5 text-[14.5px] outline-none" />
          <div className="grid grid-cols-2 gap-2">
            <Btn tone="ghost" onClick={() => setTelling(false)}>
              Back
            </Btn>
            <Btn tone="primary" disabled={busy || !message.trim()} onClick={() => void answer("deny", message.trim())}>
              Deny and send
            </Btn>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Btn tone="ghost" disabled={busy} onClick={() => void answer("deny")}>
              Deny
            </Btn>
            <Btn disabled={busy || !ask.can_always} onClick={() => void answer("always")}>
              Always
            </Btn>
            <Btn tone="primary" disabled={busy} onClick={() => void answer("allow")}>
              Allow
            </Btn>
          </div>
          <button type="button" onClick={() => setTelling(true)} className="flex h-9 items-center gap-2 text-[13.5px] text-muted">
            <Plus size={16} /> Deny and tell Claude what to do…
          </button>
        </>
      )}
    </section>
  );
}

function DockedQuestion({ host, terminal, ask }: { host: string; terminal: number; ask: PermissionAsk }) {
  const qs = askQuestions(ask.input);
  const [picks, setPicks] = useState(() => qs.map(() => ({ labels: [] as string[], other: "" })));
  const answers = questionAnswers(qs, picks);
  const toggle = (qi: number, label: string, multi: boolean) =>
    setPicks((p) => p.map((x, i) => (i !== qi ? x : { ...x, labels: multi ? (x.labels.includes(label) ? x.labels.filter((l) => l !== label) : [...x.labels, label]) : [label] })));
  return (
    <section aria-label="Claude has a question" className="scroll flex max-h-[55vh] flex-col gap-3 border-t border-[rgba(242,201,76,0.28)] bg-panel px-4 pt-3 pb-2">
      {qs.map((q, qi) => (
        <div key={q.question} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[14px] font-medium">
            <MessageCircleQuestion size={16} className="text-blocked" />
            {q.question}
          </div>
          {q.options.map((o) => (
            <button
              key={o.label}
              type="button"
              onClick={() => toggle(qi, o.label, q.multiSelect)}
              className={cx("flex flex-col rounded-[10px] border px-3 py-2 text-left", picks[qi].labels.includes(o.label) ? "border-accent bg-selected" : "border-border-strong bg-raised")}
            >
              <span className="text-[14px]">{o.label}</span>
              {o.description && <span className="text-[12.5px] text-muted">{o.description}</span>}
            </button>
          ))}
          <input
            value={picks[qi].other}
            onChange={(e) => setPicks((p) => p.map((x, i) => (i === qi ? { ...x, other: e.target.value } : x)))}
            placeholder="Other…"
            className="h-10 rounded-[10px] border border-border-strong bg-bg px-3 text-[14px] outline-none"
          />
        </div>
      ))}
      <Btn tone="primary" disabled={!answers} onClick={() => answers && void answerQuestion(host, terminal, ask.id, answers).catch(console.error)}>
        Answer
      </Btn>
    </section>
  );
}

function Composer({ host, terminal, running }: { host: string; terminal: number; running: boolean }) {
  const [text, setText] = useState("");
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    await rpc(host, M.chatSend, { id: terminal, text: t, images: [] }).catch((e) => {
      console.error(e);
      setText(t);
    });
  };
  return (
    <div className="flex items-end gap-2 border-t border-border px-3 pt-2 pb-1">
      <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder={running ? "Queue a message…" : "Message Claude…"} className="max-h-32 min-h-10 flex-1 resize-none rounded-[20px] border border-border-strong bg-panel px-3.5 py-2 text-[15px] outline-none" />
      {running && !text.trim() ? (
        <button type="button" aria-label="Stop" onClick={() => void rpc(host, M.chatInterrupt, { id: terminal }).catch(console.error)} className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-raised">
          <Square size={14} fill="currentColor" />
        </button>
      ) : (
        <button type="button" aria-label="Send" disabled={!text.trim()} onClick={() => void send()} className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-fg text-bg disabled:opacity-30">
          <ArrowUp size={18} />
        </button>
      )}
    </div>
  );
}

function Ring({ percent }: { percent: number }) {
  const c = 2 * Math.PI * 7;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="7" fill="none" stroke="#2e2e2e" strokeWidth="2.5" />
      <circle cx="9" cy="9" r="7" fill="none" stroke={percent > 80 ? "#f2c94c" : "#d97757"} strokeWidth="2.5" strokeDasharray={`${(c * percent) / 100} ${c}`} transform="rotate(-90 9 9)" />
    </svg>
  );
}

export function ChatTab({ host, session }: { host: string; session: Session }) {
  const d = useApp((s) => s.data[host]);
  const terminal = d ? sessionChat(d, session.id) : null;
  const st = useChat((s) => (terminal === null ? undefined : s.chats[chatKey(host, terminal)]));
  const [picker, setPicker] = useState<"model" | "mode" | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (terminal !== null) void loadChat(host, terminal).catch(console.error);
  }, [host, terminal]);
  const blocks = st ? chatBlocks(st.items, "collapsed") : [];
  // Follow the conversation's end as it grows.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks.length, st?.items[st.items.length - 1]?.text.length]);

  if (terminal === null) return <div className="p-6 text-[14px] text-muted">This session has no agent conversation. Its terminal is in the Terminal tab.</div>;
  if (!st) return <div className="p-6 text-[14px] text-muted">Loading the conversation…</div>;
  const ask = st.pending[0];
  const footer = chatFooter(st);
  const settings = (patch: object) => void rpc(host, M.chatSettings, { id: terminal, ...patch }).catch(console.error);

  return (
    <div className="flex h-full flex-col">
      <main ref={scroller} className="scroll flex min-h-0 flex-1 flex-col gap-2 px-4 py-3">
        {blocks.map((b) => (
          <ChatBlockView key={b.kind === "tools" ? b.id : b.item.id} block={b} cwd={session.path} />
        ))}
        {st.status === "working" && !ask && <div className="text-[13px] text-muted italic">Working…</div>}
      </main>
      {ask &&
        (ask.tool === "ExitPlanMode" ? (
          <section className="flex items-center gap-3 border-t border-[rgba(242,201,76,0.28)] bg-panel px-4 py-3">
            <ListChecks size={17} className="text-blocked" />
            <span className="flex-1 text-[14.5px] font-medium">Claude has a plan</span>
            <Btn tone="primary" onClick={() => showScreen({ kind: "plan", host, terminal, ask: ask.id, from: { kind: "session", host, id: session.id, tab: "chat" } })}>
              Review plan
            </Btn>
          </section>
        ) : ask.tool === "AskUserQuestion" ? (
          <DockedQuestion key={ask.id} host={host} terminal={terminal} ask={ask} />
        ) : (
          <DockedAsk key={ask.id} host={host} terminal={terminal} ask={ask} />
        ))}
      {!ask && <Composer host={host} terminal={terminal} running={turnRunning(st.status)} />}
      <footer className="flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-muted" style={{ paddingBottom: "max(var(--safe-bottom), 8px)" }}>
        {footer.context !== null && (
          <span className="flex items-center gap-1">
            <Ring percent={footer.context} />
            {footer.context}%
          </span>
        )}
        {footer.cost && <span>{footer.cost}</span>}
        <span className="flex-1" />
        <button type="button" onClick={() => setPicker("model")} className="h-8 rounded-full border border-border-strong px-2.5">
          {footer.model}
        </button>
        <button type="button" onClick={() => setPicker("mode")} className="h-8 rounded-full border border-border-strong px-2.5">
          {footer.mode}
        </button>
      </footer>
      {picker && (
        <Sheet label={picker === "model" ? "Model" : "Mode"} onClose={() => setPicker(null)}>
          <div className="scroll flex flex-col px-2 pb-2">
            {(picker === "model" ? CLAUDE_MODELS.map((m) => ({ id: m.id, label: m.label, patch: { model: m.id } })) : CLAUDE_MODES.map((m) => ({ id: m.id, label: m.label, patch: { mode: m.id } }))).map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  settings(o.patch);
                  setPicker(null);
                }}
                className={cx("flex min-h-12 items-center rounded-[10px] px-3 text-left text-[15px]", (picker === "model" ? st.model : st.mode) === o.id && "text-accent")}
              >
                {o.label}
              </button>
            ))}
            {picker === "model" && (
              <>
                <div className="eyebrow px-3 pt-2">Effort</div>
                {EFFORTS.map((e) => (
                  <button key={e.id} type="button" onClick={() => (settings({ effort: e.id }), setPicker(null))} className={cx("flex min-h-11 items-center rounded-[10px] px-3 text-left text-[15px]", st.effort === e.id && "text-accent")}>
                    {e.label}
                  </button>
                ))}
              </>
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
}
