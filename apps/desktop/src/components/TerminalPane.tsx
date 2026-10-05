import { useEffect, useMemo, useRef } from "react";
import { RotateCw, X } from "lucide-react";
import { rpc } from "../lib/daemon";
import { M } from "../lib/protocol";
import { draftToAgent, setClassic } from "../lib/actions";
import { errorToast, getLayout, sesKey, setLayout, toast, useStore } from "../lib/store";
import { findEntry, getEntry } from "../lib/terminals";
import { InputEditor } from "./InputEditor";
import { uncommitted } from "../lib/chips";
import { Button } from "./ui";

function resolvePath(base: string, p: string, home: string | null): string {
  if (p.startsWith("/")) return p;
  if (p.startsWith("~/") && home) return home + p.slice(1);
  const parts = (base + "/" + p).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

export function TerminalPane({ host, session, wsId, focused, visible }: { host: string; session: number; wsId: string; focused: boolean; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const info = useStore((s) => s.terminals[host]?.[session]);
  const home = useStore((s) => s.hosts[host]?.home ?? null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !visible) return;
    const entry = getEntry(host, session);
    entry.mount(el);
    // A block header's hover actions (T8).
    entry.onBlockAction = (action, block) => {
      if (action === "agent") {
        const text = entry.forAgent(block);
        if (text) void draftToAgent(text);
      } else if (action === "copy") {
        void navigator.clipboard.writeText(entry.copyText(block)).then(() => toast("Copied command and output"), errorToast);
      } else entry.rerun(block);
    };
    entry.onFileLink = (p, line) => {
      const cur = useStore.getState().terminals[host]?.[session];
      const base = entry.cwd || cur?.reported_cwd || cur?.cwd || "/";
      const path = resolvePath(base, p, home);
      const target = { host, path, line };
      if (path.endsWith(".md") || path.endsWith(".markdown")) useStore.setState({ preview: target, rightTab: "files", rightOpen: true });
      else useStore.setState({ openFile: target, rightTab: "files", rightOpen: true });
    };
    return () => entry.unmount();
  }, [host, session, visible, home]);

  // In Blocks mode the editor takes over input while the shell waits at a prompt
  // (T6), unless the tab is in classic mode (T7).
  const blockMode = !!info && info.kind === "shell" && info.prompt !== undefined && !info.classic && !info.exit;
  const editing = blockMode && info.prompt === true && !info.alt_screen;
  useEffect(() => {
    const entry = getEntry(host, session);
    entry.setBlockMode(blockMode);
    entry.setEditorActive(editing);
  }, [host, session, blockMode, editing]);
  const branch = useStore((s) => (info?.session_id ? s.sessions[host]?.find((x) => x.id === info.session_id)?.branch : undefined));
  const worktree = useStore((s) => (info?.session_id ? s.sessions[host]?.find((x) => x.id === info.session_id)?.path : undefined));
  const files = useStore((s) => (info?.session_id ? s.git[sesKey(host, info.session_id)]?.files : undefined));
  const nodeVersion = info?.node_version;
  const changes = useMemo(() => (files ? uncommitted(files) : undefined), [files]);
  useEffect(() => {
    getEntry(host, session).context = { home, worktree, branch, nodeVersion, changes };
  }, [host, session, home, worktree, branch, nodeVersion, changes]);
  // Snapshots carry no OSC 7, so a shell that reported its directory before
  // the app attached starts from the daemon's record (T8 block headers).
  const reportedCwd = info?.reported_cwd;
  useEffect(() => {
    if (reportedCwd) getEntry(host, session).seedCwd(reportedCwd);
  }, [host, session, reportedCwd]);

  useEffect(() => {
    if (focused && visible && !editing) getEntry(host, session).focus();
  }, [focused, visible, host, session, editing]);

  const exited = info?.exit;
  return (
    <div
      data-terminal-pane
      className="relative flex h-full w-full flex-col overflow-hidden bg-bg"
      onMouseDown={() => {
        const l = getLayout(host, wsId);
        if (l.focused !== session) setLayout(host, wsId, { ...l, focused: session });
      }}
    >
      <div className="relative min-h-0 flex-1">
        <div ref={ref} className="absolute inset-0" />
      </div>
      {editing && visible && (
        <InputEditor
          host={host}
          terminal={session}
          cwd={findEntry(host, session)?.cwd || info.reported_cwd || info.cwd}
          home={home}
          branch={branch}
          nodeVersion={info.node_version}
          files={files}
          focused={focused}
        />
      )}
      {info?.classic && info.kind === "shell" && !exited && visible && (
        <button
          className="absolute bottom-3 right-4 z-20 rounded-full border border-border-strong bg-panel/95 px-3 py-1 text-[12px] text-muted shadow-lg hover:text-fg"
          title="Use jaunt's input editor and hide the shell prompt"
          onClick={() => void setClassic(host, session, false)}
        >
          Blocks
        </button>
      )}
      {exited && (
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 border-t border-border bg-panel/95 px-3 py-1.5 text-[12px] text-muted">
          <span>
            Process exited
            {exited.code !== null ? ` with code ${exited.code}` : exited.signal !== null ? ` (signal ${exited.signal})` : ""}.
          </span>
          <span className="ml-auto flex gap-1.5">
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await rpc(host, M.terminalCreate, {
                    cwd: info.cwd,
                    command: info.command,
                    kind: info.kind,
                    title: info.title,
                    agent: info.agent,
                    session_id: info.session_id,
                    cols: info.cols,
                    rows: info.rows,
                  });
                  await rpc(host, M.terminalKill, { id: session, remove: true });
                } catch (e) {
                  errorToast(e);
                }
              }}
            >
              <RotateCw size={12} /> Restart
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void rpc(host, M.terminalKill, { id: session, remove: true })}>
              <X size={12} /> Close
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}
