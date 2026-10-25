import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { runAction } from "../lib/actions";
import { ACTIONS, assignShortcut, effectiveKeys, filterActions, highlight, keyId, keyLabel, match, recordKey } from "../lib/runActions";
import { goToAgent, selectSession, toast, updateSettings, useStore } from "../lib/store";
import { agentPlace } from "../lib/alerts";
import { Button, Kbd, StateGlyph, cx } from "./ui";
import type { AgentState } from "../lib/protocol";

/** A blocked agent or a session, listed under the actions. */
interface Extra {
  id: string;
  label: string;
  hint: string;
  state?: AgentState | null;
  run: () => void;
}

type Row = { kind: "action"; id: string; label: string; group: string; hits: number[] } | ({ kind: "extra" } & Extra);

const actionLabel = (id: string) => ACTIONS.find((a) => a.id === id)?.label.replace("…", "") ?? id;

/** ⌘K: run an action or give it a shortcut (X19), then blocked agents (A5) and sessions (T5). */
export function CommandPalette() {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  // Recording a shortcut: the action, a key waiting for Replace, the last refusal.
  const [rec, setRec] = useState<string | null>(null);
  const [pending, setPending] = useState<{ keys: string; other: string } | null>(null);
  const [recErr, setRecErr] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const terminals = useStore((s) => s.terminals);
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const shortcuts = useStore((s) => s.settings.shortcuts);
  const keys = effectiveKeys(shortcuts);
  useEffect(() => input.current?.focus(), []);
  const close = () => useStore.setState({ dialog: null });

  const extras = useMemo<Extra[]>(() => {
    const out: Extra[] = [];
    // Approval inbox: every blocked agent across hosts.
    for (const [host, terms] of Object.entries(terminals)) {
      for (const x of Object.values(terms)) {
        if (x.kind !== "agent" || x.exit || (x.agent_state !== "blocked" && x.agent_state !== "error")) continue;
        const ws = sessions[host]?.find((w) => w.id === x.session_id);
        // A design's agent is `Design · <name>`, and opens its design (X65).
        out.push({
          id: `agent-${host}-${x.id}`,
          label: `${agentPlace(x, ws?.name).label}: ${x.agent_message ?? (x.agent_state === "blocked" ? "needs input" : "failed")}`,
          hint: host === "local" ? (x.agent ?? "") : `${x.agent} · ${host}`,
          state: x.agent_state,
          run: () => goToAgent(host, x.id),
        });
      }
    }
    for (const [host, wss] of Object.entries(sessions)) {
      for (const w of wss) {
        if (w.archived) continue;
        const repo = projects[host]?.find((r) => r.id === w.project_id);
        out.push({ id: `ws-${host}-${w.id}`, label: `Go to ${w.name}`, hint: `${repo?.name ?? ""} · ${w.branch}${host !== "local" ? ` · ${host}` : ""}`, run: () => selectSession(host, w.id) });
      }
    }
    return out;
  }, [terminals, sessions, projects]);

  const actionRows = filterActions(q);
  const rows: Row[] = [
    ...actionRows.map(({ action, hits }): Row => ({ kind: "action", id: action.id, label: action.label, group: action.group, hits })),
    ...extras
      .map((x) => ({ x, score: match(q, `${x.label} ${x.hint}`).score }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ x }): Row => ({ kind: "extra", ...x })),
  ];
  const selected = rows[sel];

  const cancelRec = () => {
    setRec(null);
    setPending(null);
    setRecErr("");
    input.current?.focus();
  };
  const startRec = (id: string) => {
    setRec(id);
    setPending(null);
    setRecErr("");
  };
  const assign = (action: string, keys: string, takeFrom?: string) => {
    updateSettings({ shortcuts: assignShortcut(useStore.getState().settings.shortcuts, action, keys, takeFrom) });
    toast(`${keyLabel(keys)} now runs ${actionLabel(action)}`);
    cancelRec();
  };

  // While recording, every key goes to the recorder, not the input or the app.
  useEffect(() => {
    if (!rec) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return cancelRec();
      if (pending) {
        if (e.key === "Enter") assign(rec, pending.keys, pending.other);
        return;
      }
      const r = recordKey(keyId(e), rec, useStore.getState().settings.shortcuts);
      if (r.kind === "error") setRecErr(r.message);
      else if (r.kind === "conflict") {
        setPending({ keys: r.keys, other: r.other });
        setRecErr("");
      } else if (r.kind === "ok") assign(rec, r.keys);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  useEffect(() => {
    list.current?.querySelector(`[data-row="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (row: Row | undefined) => {
    if (!row) return;
    close();
    if (row.kind === "action") runAction(row.id);
    else row.run();
  };

  const selectedKeys = selected?.kind === "action" ? keys[selected.id] : "";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[14vh]" onMouseDown={() => (rec ? cancelRec() : close())}>
      <div
        role="dialog"
        aria-label="Run action"
        className="overflow-hidden rounded-xl border border-border-strong bg-panel shadow-2xl"
        style={{ width: "min(560px, 90vw)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search size={15} className="shrink-0 text-faint" />
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
              setRec(null);
              setPending(null);
              setRecErr("");
            }}
            onKeyDown={(e) => {
              if (rec) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((v) => Math.min(v + 1, rows.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((v) => Math.max(v - 1, 0));
              } else if (e.key === "Enter" && e.altKey) {
                e.preventDefault();
                if (selected?.kind === "action") startRec(selected.id);
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(selected);
              } else if (e.key === "Escape") {
                close();
              }
            }}
            placeholder="Run an action…"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-3 ui-text-14 text-fg outline-none placeholder:text-faint"
          />
          <span className="shrink-0 font-mono ui-text-11 text-faint">{q ? `${actionRows.length} of ${ACTIONS.length}` : `${ACTIONS.length} actions`}</span>
        </div>

        <div ref={list} className="overflow-y-auto py-1" style={{ maxHeight: "min(50vh, 420px)" }}>
          {rows.map((r, i) => {
            const recording = r.kind === "action" && rec === r.id;
            const k = r.kind === "action" ? keys[r.id] : "";
            return (
              <div
                key={r.id}
                data-row={i}
                className="cursor-default px-4 ui-text-13"
                style={{ background: recording ? "var(--color-panel-2)" : i === sel ? "var(--color-raised)" : undefined }}
                onMouseEnter={() => !rec && setSel(i)}
                onClick={() => !rec && run(r)}
              >
                <div className="flex items-center gap-2" style={{ minHeight: 32 }}>
                  {r.kind === "extra" && r.state !== undefined && <StateGlyph state={r.state} size={12} />}
                  <span className="min-w-0 truncate">
                    {r.kind === "action"
                      ? highlight(r.label, r.hits).map((p, j) => (
                          <span key={j} className={p.hit ? "font-semibold text-accent" : "text-fg"}>
                            {p.text}
                          </span>
                        ))
                      : r.label}
                  </span>
                  <span className="shrink-0 truncate ui-text-11.5 text-faint">{r.kind === "action" ? r.group : r.hint}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {r.kind === "action" && !recording && (k ? (
                      <Kbd>{keyLabel(k)}</Kbd>
                    ) : (
                      <button
                        className={cx("rounded px-1 ui-text-12 hover:text-accent", i === sel ? "text-muted" : "text-faint")}
                        title="Assign a keyboard shortcut"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSel(i);
                          startRec(r.id);
                        }}
                      >
                        Set shortcut
                      </button>
                    ))}
                    {recording && (
                      <Fragment>
                        <span className={cx("flex h-[22px] items-center gap-1.5 rounded-md border border-dashed border-accent px-2 font-mono ui-text-11.5", pending ? "text-fg" : "text-accent")}>
                          {pending ? keyLabel(pending.keys) : "Press keys…"}
                        </span>
                        <button
                          className="ui-text-12 text-faint hover:text-fg"
                          onClick={(e) => {
                            e.stopPropagation();
                            cancelRec();
                          }}
                        >
                          Cancel
                        </button>
                      </Fragment>
                    )}
                  </span>
                </div>
                {recording && !pending && <div className="pb-2 ui-text-11.5 text-faint">{recErr || "Press a combination with ⌘. Esc cancels."}</div>}
                {recording && pending && (
                  <div className="flex items-center gap-2 pb-2">
                    <span className="min-w-0 flex-1 ui-text-12 text-muted">
                      <span className="font-mono text-fg">{keyLabel(pending.keys)}</span> is already used by <span className="text-fg">{actionLabel(pending.other)}</span>.
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPending(null);
                      }}
                    >
                      Try another
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        assign(r.id, pending.keys, pending.other);
                      }}
                    >
                      Replace
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
          {rows.length === 0 && <div className="px-4 py-3 ui-text-12.5 text-faint">No actions match “{q}”.</div>}
        </div>

        <div className="flex items-center gap-4 border-t border-border px-4 py-2 ui-text-11.5 text-faint">
          <span className="flex items-center gap-1.5">
            <Kbd>↑↓</Kbd> select
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> run
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>⌥↵</Kbd> {selectedKeys ? "change shortcut" : "set shortcut"}
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <Kbd>esc</Kbd> {rec ? "cancel" : "close"}
          </span>
        </div>
      </div>
    </div>
  );
}
