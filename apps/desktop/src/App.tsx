import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, FolderPlus, Plus, Search, X } from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { SessionView } from "./components/SessionView";
import { RightPanel } from "./components/RightPanel";
import { Splitter } from "./components/Splitter";
import { Dialogs } from "./components/Dialogs";
import { ConfirmHost } from "./components/ConfirmHost";
import { ReadHost } from "./components/ReadHost";
import { CommandPalette } from "./components/CommandPalette";
import { Button, IconButton, Kbd, cx } from "./components/ui";
import { selectedSession, startStore, useStore } from "./lib/store";
import { installShortcuts } from "./lib/keys";
import { terminalSearch } from "./lib/actions";
import { uiScale } from "./lib/uiScale";

function FindBar({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [miss, setMiss] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const go = (back = false) => setMiss(!terminalSearch(q, back));
  return (
    <div className="absolute right-6 top-[62px] z-30 flex items-center gap-1 rounded-lg border border-border-strong bg-panel-2 px-2 py-1 shadow-xl">
      <Search size={12} className="text-faint" />
      <input
        ref={ref}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setMiss(!terminalSearch(e.target.value));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") go(e.shiftKey);
          if (e.key === "Escape") onClose();
        }}
        placeholder="Find in terminal"
        className={cx("w-52 bg-transparent ui-text-12.5 outline-none", miss && q && "text-error")}
      />
      <IconButton title="Previous (⇧↵)" onClick={() => go(true)}>
        <ChevronUp size={12} />
      </IconButton>
      <IconButton title="Next (↵)" onClick={() => go()}>
        <ChevronDown size={12} />
      </IconButton>
      <IconButton title="Close" onClick={onClose}>
        <X size={12} />
      </IconButton>
    </div>
  );
}

function Home() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const hasRepos = useStore((s) => Object.values(s.projects).some((r) => r.length > 0));
  const local = useStore((s) => s.hosts.local);
  return (
    <div className="flex h-full flex-col bg-bg">
      <div data-tauri-drag-region className="drag h-[52px] shrink-0 bg-panel" style={{ paddingLeft: sidebarOpen ? 0 : 84 }} />
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <div className="font-mono ui-text-22 tracking-tight">
          <span className="text-accent">❯</span> moonlet
        </div>
        <div className="max-w-md ui-text-13.5 text-muted">Group projects into sections; every session runs its agent in its own worktree. They keep running when you close the app.</div>
        {local && local.status !== "connected" && (
          <div className="ui-text-12 text-blocked">{local.status === "error" ? `Daemon: ${local.message}` : "Starting the moonlet daemon…"}</div>
        )}
        <div className="flex gap-2">
          {hasRepos ? (
            <Button variant="primary" onClick={() => useStore.setState({ dialog: { kind: "new-session" } })}>
              <Plus size={14} /> New session <Kbd>⇧⌘N</Kbd>
            </Button>
          ) : null}
          <Button onClick={() => useStore.setState({ dialog: { kind: "add-project" } })}>
            <FolderPlus size={14} /> Add project
          </Button>
        </div>
        <div className="mt-2 font-mono ui-text-11.5 text-faint">
          <Kbd>⌘K</Kbd> run action · <Kbd>⌘T</Kbd> new terminal · <Kbd>⌘D</Kbd> split · <Kbd>⇧⌘D</Kbd> changes
        </div>
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed right-4 top-[60px] z-[60] flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            "selectable pointer-events-auto max-w-[560px] rounded-lg border px-3 py-2 ui-text-12.5 shadow-xl",
            t.kind === "error" ? "border-[#5a2a2e] bg-[#2a1416] text-[#ffb3b8]" : "border-border-strong bg-panel-2 text-fg",
          )}
        >
          {t.text}
          {t.action && (
            <button
              className="ml-3 rounded px-1.5 py-0.5 font-medium text-accent hover:bg-hover"
              onClick={() => {
                t.action?.run();
                useStore.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }));
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const s = useStore();
  const ws = selectedSession(s);
  const host = s.selected?.host;
  const [finding, setFinding] = useState(false);
  const scale = uiScale(s.settings.term.fontSize);

  useEffect(() => {
    void startStore();
    const off = installShortcuts();
    const onFind = () => setFinding(true);
    window.addEventListener("moonlet:find", onFind);
    return () => {
      off();
      window.removeEventListener("moonlet:find", onFind);
    };
  }, []);

  // All app text scales with the font size setting (ui-text-* in moonlet.css).
  useEffect(() => {
    document.documentElement.style.setProperty("--ui-scale", String(scale));
  }, [scale]);

  const clampSide = (w: number) => Math.max(200, Math.min(420, w));
  const clampRight = (w: number) => Math.max(320, Math.min(window.innerWidth * 0.6, w));

  return (
    <div className="flex h-full w-full">
      {s.sidebarOpen && (
        <>
          <div style={{ width: s.sidebarWidth }} className="shrink-0">
            <Sidebar />
          </div>
          <Splitter dir="row" onDrag={(d) => useStore.setState((st) => ({ sidebarWidth: clampSide(st.sidebarWidth + d) }))} />
        </>
      )}
      <main className="relative min-w-0 flex-1">
        {ws && host && !ws.archived ? <SessionView key={host + ws.id} host={host} ws={ws} /> : <Home />}
        {finding && ws && <FindBar onClose={() => setFinding(false)} />}
      </main>
      {s.rightOpen && ws && host && !ws.archived && (
        <>
          <Splitter dir="row" onDrag={(d) => useStore.setState((st) => ({ rightWidth: clampRight(st.rightWidth - d) }))} />
          <div style={{ width: s.rightWidth }} className="shrink-0">
            <RightPanel host={host} ws={ws} />
          </div>
        </>
      )}
      <Dialogs />
      {s.dialog?.kind === "palette" && <CommandPalette />}
      <ConfirmHost />
      <ReadHost />
      <Toasts />
    </div>
  );
}
