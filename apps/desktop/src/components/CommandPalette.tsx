import { useEffect, useMemo, useRef, useState } from "react";
import { archiveSession, closeFocused, focusedEntry, newTab, runScript, split } from "../lib/actions";
import { focusTerminal, selectSession, toast, useStore } from "../lib/store";
import { Kbd, StateGlyph, cx } from "./ui";
import type { AgentState } from "../lib/protocol";

interface Item {
  id: string;
  label: string;
  hint?: string;
  keys?: string;
  state?: AgentState | null;
  run: () => void;
}

function score(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const query = q.toLowerCase();
  if (t.includes(query)) return 100 - t.indexOf(query);
  let i = 0;
  for (const c of t) if (c === query[i]) i++;
  return i === query.length ? 10 : 0;
}

/** ⌘K: commands, sessions and blocked agents in one list (T5, A5). */
export function CommandPalette() {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const s = useStore();
  useEffect(() => input.current?.focus(), []);
  const close = () => useStore.setState({ dialog: null });

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    // Approval inbox first: every blocked agent across hosts.
    for (const [host, sessions] of Object.entries(s.terminals)) {
      for (const x of Object.values(sessions)) {
        if (x.kind !== "agent" || x.exit || (x.agent_state !== "blocked" && x.agent_state !== "error")) continue;
        const ws = s.sessions[host]?.find((w) => w.id === x.session_id);
        list.push({
          id: `agent-${host}-${x.id}`,
          label: `${ws?.name ?? x.title}: ${x.agent_message ?? (x.agent_state === "blocked" ? "needs input" : "failed")}`,
          hint: host === "local" ? x.agent : `${x.agent} · ${host}`,
          state: x.agent_state,
          run: () => focusTerminal(host, x.id),
        });
      }
    }
    list.push(
      { id: "new-session", label: "New session…", keys: "⇧⌘N", run: () => useStore.setState({ dialog: { kind: "new-session" } }) },
      { id: "new-ws", label: "New workspace…", run: () => useStore.setState({ dialog: { kind: "new-workspace" } }) },
      { id: "add-project", label: "Add project…", run: () => useStore.setState({ dialog: { kind: "add-project" } }) },
      { id: "new-tab", label: "New terminal tab", keys: "⌘T", run: () => void newTab() },
      { id: "split-r", label: "Split pane right", keys: "⌘D", run: () => void split("row") },
      { id: "split-d", label: "Split pane down", keys: "⌥⌘D", run: () => void split("col") },
      { id: "close", label: "Close pane", keys: "⌘W", run: () => void closeFocused() },
      { id: "run", label: "Run script", keys: "⌘R", run: () => void runScript("run") },
      { id: "setup", label: "Re-run setup script", run: () => void runScript("setup") },
      { id: "changes", label: "Show changes", keys: "⇧⌘D", run: () => useStore.setState({ rightTab: "changes", rightOpen: true }) },
      { id: "files", label: "Show files", keys: "⇧⌘E", run: () => useStore.setState({ rightTab: "files", rightOpen: true }) },
      { id: "checks", label: "Show review (PR, checks, commits)", run: () => useStore.setState({ rightTab: "review", rightOpen: true }) },
      { id: "commit", label: "Commit…", run: () => useStore.setState({ dialog: { kind: "commit" } }) },
      { id: "pr", label: "Create pull request…", keys: "⇧⌘P", run: () => useStore.setState({ dialog: { kind: "create-pr" } }) },
      { id: "archive", label: "Archive session…", run: () => void archiveSession() },
      { id: "find", label: "Find in terminal", keys: "⌘F", run: () => window.dispatchEvent(new CustomEvent("jaunt:find")) },
      { id: "prev-cmd", label: "Jump to previous command", keys: "⌘↑", run: () => focusedEntry()?.jumpBlock(-1) },
      { id: "next-cmd", label: "Jump to next command", keys: "⌘↓", run: () => focusedEntry()?.jumpBlock(1) },
      {
        id: "copy-out",
        label: "Copy last command output",
        keys: "⇧⌘C",
        run: () => {
          const out = focusedEntry()?.lastOutput();
          if (out) void navigator.clipboard.writeText(out).then(() => toast("Copied output"));
          else toast("No finished command found (needs shell integration)", "error");
        },
      },
      { id: "rerun", label: "Re-run last command", run: () => focusedEntry()?.rerunLast() },
      { id: "history", label: "Show archived sessions", run: () => useStore.setState({ showHistory: true }) },
      { id: "settings", label: "Settings…", keys: "⌘,", run: () => useStore.setState({ dialog: { kind: "settings" } }) },
    );
    for (const [host, wss] of Object.entries(s.sessions)) {
      for (const w of wss) {
        if (w.archived) continue;
        const repo = s.projects[host]?.find((r) => r.id === w.project_id);
        list.push({ id: `ws-${host}-${w.id}`, label: `Go to ${w.name}`, hint: `${repo?.name ?? ""} · ${w.branch}${host !== "local" ? ` · ${host}` : ""}`, run: () => selectSession(host, w.id) });
      }
    }
    return list;
  }, [s.terminals, s.sessions, s.projects]);

  const filtered = items
    .map((it) => ({ it, sc: score(q, `${it.label} ${it.hint ?? ""}`) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .map((x) => x.it);

  const run = (it: Item | undefined) => {
    if (!it) return;
    close();
    it.run();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[14vh]" onMouseDown={close}>
      <div className="w-[560px] overflow-hidden rounded-xl border border-border-strong bg-panel shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((v) => Math.min(v + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((v) => Math.max(v - 1, 0));
            } else if (e.key === "Enter") {
              run(filtered[sel]);
            } else if (e.key === "Escape") {
              close();
            }
          }}
          placeholder="Search commands, sessions and agents…"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-[14px] outline-none placeholder:text-faint"
        />
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.map((it, i) => (
            <div
              key={it.id}
              className={cx("flex cursor-default items-center gap-2 px-4 py-1.5 text-[13px]", i === sel ? "bg-raised" : "")}
              onMouseEnter={() => setSel(i)}
              onClick={() => run(it)}
            >
              {it.state !== undefined && <StateGlyph state={it.state} size={12} />}
              <span className="truncate">{it.label}</span>
              {it.hint && <span className="truncate text-[11.5px] text-faint">{it.hint}</span>}
              {it.keys && (
                <span className="ml-auto">
                  <Kbd>{it.keys}</Kbd>
                </span>
              )}
            </div>
          ))}
          {filtered.length === 0 && <div className="px-4 py-3 text-[12.5px] text-faint">No matches.</div>}
        </div>
      </div>
    </div>
  );
}
