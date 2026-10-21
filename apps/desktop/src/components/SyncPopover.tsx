// Keep in sync (X60): the mark after a session's name in the sidebar, and
// its popover with the copy's status, files that differ and actions.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight, ChevronDown, X } from "lucide-react";
import { hostsApi, rpc } from "../lib/daemon";
import { M, type Copy, type FileContent, type Session } from "../lib/protocol";
import { errorToast, sesKey, useStore } from "../lib/store";
import { markTone, syncLine, tilde, tooBigLine } from "../lib/sync";
import { dismissSyncNote, resolveSync, retrySync, runSetup, askSetup, stopSync, useCentralBranch, useSync } from "../lib/syncStore";
import { workspaceOpenTargets } from "../lib/openIn";
import { Menu } from "./Menu";
import { Button, IconButton, cx } from "./ui";

const TONE = { muted: "text-faint", accent: "text-accent-2", plain: "text-muted" } as const;

/** The mark after a session's name while it is kept in sync; a click opens the popover. */
export function SyncMark({ host, s }: { host: string; s: Session }) {
  const key = sesKey(host, s.id);
  const copy = useSync((st) => st.copies[key]);
  const open = useSync((st) => st.popover === key);
  const home = useStore((st) => st.hosts.local?.home ?? null);
  const anchor = useRef<HTMLButtonElement>(null);
  if (!copy) return null;
  const line = syncLine(copy, { branch: s.branch, home }).text;
  return (
    <>
      <button
        ref={anchor}
        aria-label={`Keep in sync: ${line}`}
        title={line}
        data-sync-tone={markTone(copy)}
        className={cx("flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-hover", TONE[markTone(copy)])}
        onClick={(e) => {
          e.stopPropagation();
          useSync.setState({ popover: open ? null : key });
        }}
      >
        <ArrowLeftRight size={12} />
      </button>
      {open && anchor.current && <SyncPopover copy={copy} s={s} anchor={anchor.current} />}
    </>
  );
}

function SyncPopover({ copy, s, anchor }: { copy: Copy; s: Session; anchor: HTMLElement }) {
  const home = useStore((st) => st.hosts.local?.home ?? null);
  const noteSeen = useSync((st) => st.noteSeen);
  const dataDir = useSync((st) => st.dataDir);
  const panel = useRef<HTMLDivElement>(null);
  const [targets, setTargets] = useState<{ id: string; label: string }[]>([]);
  const [log, setLog] = useState<string | null>(null);
  useEffect(() => void hostsApi.openTargets().then(setTargets, () => {}), []);
  useEffect(() => {
    const close = () => useSync.setState({ popover: null });
    const onDown = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor]);
  // Settings or a dialog over the window closes it, as a click elsewhere does.
  const covered = useStore((st) => !!st.settingsPage || !!st.dialog || !!st.confirm);
  useEffect(() => {
    if (covered) useSync.setState({ popover: null });
  }, [covered]);
  const r = anchor.getBoundingClientRect();
  const style: React.CSSProperties = { position: "fixed", left: Math.min(r.left, window.innerWidth - 372), top: Math.min(r.bottom + 6, window.innerHeight - 200), width: 360 };
  const setup = copy.setup;
  const paused = copy.state.kind === "paused";
  const showLog = async () => {
    if (log !== null) return setLog(null);
    const path = `${dataDir ?? `${home}/.moonlet`}/sync/logs/${copy.id}.log`;
    const f = await rpc<FileContent>("local", M.fsRead, { path }).catch(() => null);
    setLog(f?.content?.split("\n").slice(-40).join("\n") || "No output.");
  };
  return createPortal(
    <div ref={panel} role="dialog" aria-label="Keep in sync" style={style} className="z-50 flex max-h-[70vh] flex-col gap-3 overflow-y-auto rounded-xl border border-border-strong bg-[#232323] p-3 shadow-2xl">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 ui-text-13 text-fg">{syncLine(copy, { branch: s.branch, home, path: false }).text}</span>
        {paused && (
          <Button size="sm" onClick={() => void retrySync(copy)}>
            Retry
          </Button>
        )}
      </div>
      {!noteSeen && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-panel-2 px-2.5 py-2 ui-text-12 text-muted">
          <span className="flex-1">Files here come from the agent on {copy.host}. Your editor's workspace trust applies.</span>
          <IconButton title="Got it" className="h-5 w-5" onClick={dismissSyncNote}>
            <X size={11} />
          </IconButton>
        </div>
      )}
      {copy.path && (
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate font-mono ui-text-12 text-muted" title={copy.path}>
            {tilde(copy.path, home)}
          </span>
          <Button size="sm" onClick={() => void hostsApi.openIn("reveal", copy.path).catch(errorToast)}>
            Reveal in Finder
          </Button>
          <Menu
            align="right"
            width={200}
            trigger={(toggle) => (
              <Button size="sm" onClick={toggle}>
                Open in… <ChevronDown size={11} />
              </Button>
            )}
            items={workspaceOpenTargets(targets, "local")
              .filter((t) => t.id !== "finder")
              .map((t) => ({ label: t.label, onSelect: () => void hostsApi.openIn(t.id, copy.path).catch(errorToast) }))}
          />
        </div>
      )}
      {copy.differs.length > 0 && (
        <div role="group" aria-label="Files that differ" className="flex flex-col gap-1.5">
          <span className="ui-text-12 font-medium text-accent-2">Changed on both machines</span>
          {copy.differs.map((p) => (
            <div key={p} className="flex flex-col gap-1 rounded-lg bg-panel-2 px-2.5 py-2">
              <span className="truncate font-mono ui-text-12 text-fg" title={p}>
                {p}
              </span>
              <span className="flex gap-1.5">
                <Button size="sm" onClick={() => void resolveSync(copy, p, "central")}>
                  Keep {copy.host}'s
                </Button>
                <Button size="sm" onClick={() => void resolveSync(copy, p, "worker")}>
                  Keep this Mac's
                </Button>
                <Button size="sm" variant="ghost" onClick={() => {
                    useSync.setState({ popover: null });
                    useStore.setState({ dialog: { kind: "sync-compare", host: copy.host, session: copy.session, path: p } });
                  }}>
                  Compare
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}
      {copy.too_big.length > 0 && (
        <div className="flex flex-col gap-0.5 ui-text-12 text-muted">
          {copy.too_big.map((p) => (
            <span key={p}>{tooBigLine(p)}</span>
          ))}
        </div>
      )}
      {copy.diverged && (
        <Button size="sm" className="self-start" onClick={() => void useCentralBranch(copy)}>
          Use {copy.host}'s branch
        </Button>
      )}
      {setup && (
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 ui-text-12 text-muted">
            Setup <code className="min-w-0 flex-1 truncate font-mono text-fg">{setup.command}</code>
          </span>
          <span className="flex gap-1.5">
            {setup.state.kind !== "needs_approval" && setup.state.kind !== "skipped" && (
              <Button size="sm" variant="ghost" onClick={() => void showLog()}>
                {log === null ? "Show output" : "Hide output"}
              </Button>
            )}
            {setup.state.kind !== "running" && (
              <Button
                size="sm"
                onClick={() => void (setup.state.kind === "done" || setup.state.kind === "failed" ? runSetup(copy, setup.command) : askSetup(copy, setup.command))}
              >
                {setup.state.kind === "done" || setup.state.kind === "failed" ? "Run setup again" : "Run setup"}
              </Button>
            )}
          </span>
          {log !== null && <pre className="max-h-48 overflow-auto rounded-lg bg-[#1a1a1a] p-2 font-mono ui-text-11.5 text-muted">{log}</pre>}
        </div>
      )}
      <div className="border-t border-border pt-2">
        <Button size="sm" variant="ghost" className={cx("text-error")} onClick={() => void stopSync(copy)}>
          Stop keeping in sync
        </Button>
      </div>
    </div>,
    document.body,
  );
}
