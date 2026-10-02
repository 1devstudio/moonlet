import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Eye, EyeOff, File, FileText, Folder, FolderOpen } from "lucide-react";
import { rpc } from "../lib/daemon";
import { M, type DirEntry, type Workspace } from "../lib/protocol";
import { useStore } from "../lib/store";
import { IconButton, cx } from "./ui";

const CodeViewer = lazy(() => import("./CodeViewer"));

function isMarkdown(p: string) {
  return /\.(md|markdown|mdx)$/i.test(p);
}

function Dir({ host, path, depth, showIgnored, version, onOpen, selected }: { host: string; path: string; depth: number; showIgnored: boolean; version: number; onOpen: (e: DirEntry) => void; selected: string | null }) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let live = true;
    void rpc<DirEntry[]>(host, M.fsList, { path, show_ignored: showIgnored })
      .then((e) => live && setEntries(e))
      .catch(() => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [host, path, showIgnored, version]);
  if (!entries) return <div className="py-0.5 text-[11px] text-faint" style={{ paddingLeft: 14 + depth * 12 }}>…</div>;
  return (
    <>
      {entries.map((e) => (
        <div key={e.path}>
          <div
            className={cx(
              "flex cursor-default items-center gap-1 py-[2px] pr-2 text-[12.5px]",
              selected === e.path ? "bg-raised text-fg" : "hover:bg-panel-2",
              e.ignored ? "text-faint" : "text-[#c5c9d1]",
            )}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => (e.is_dir ? setOpen((o) => ({ ...o, [e.path]: !o[e.path] })) : onOpen(e))}
          >
            {e.is_dir ? (
              <>
                {open[e.path] ? <ChevronDown size={11} className="text-faint" /> : <ChevronRight size={11} className="text-faint" />}
                {open[e.path] ? <FolderOpen size={13} className="text-accent/80" /> : <Folder size={13} className="text-accent/80" />}
              </>
            ) : (
              <>
                <span className="w-[11px]" />
                {isMarkdown(e.name) ? <FileText size={13} className="text-muted" /> : <File size={13} className="text-faint" />}
              </>
            )}
            <span className="truncate">{e.name}</span>
          </div>
          {e.is_dir && open[e.path] && (
            <Dir host={host} path={e.path} depth={depth + 1} showIgnored={showIgnored} version={version} onOpen={onOpen} selected={selected} />
          )}
        </div>
      ))}
    </>
  );
}

export function FilesPanel({ host, ws }: { host: string; ws: Workspace }) {
  const [showIgnored, setShowIgnored] = useState(false);
  const openFile = useStore((s) => s.openFile);
  const version = useStore((s) => s.fsVersion[`${host}|${ws.path}`] ?? 0);
  const current = openFile && openFile.host === host ? openFile : null;
  const onOpen = useCallback(
    (e: DirEntry) => {
      if (isMarkdown(e.path)) useStore.setState({ preview: { host, path: e.path }, rightTab: "files" });
      else useStore.setState({ openFile: { host, path: e.path } });
    },
    [host],
  );
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-[12px] text-muted">
        <span className="truncate font-mono text-[11px]" title={ws.path}>
          {ws.path.split("/").slice(-2).join("/")}
        </span>
        <IconButton title={showIgnored ? "Hide ignored files" : "Show ignored files"} className="ml-auto" onClick={() => setShowIgnored(!showIgnored)}>
          {showIgnored ? <EyeOff size={12} /> : <Eye size={12} />}
        </IconButton>
      </div>
      <div className={cx("overflow-y-auto py-1", current ? "max-h-[40%] shrink-0 border-b border-border" : "flex-1")}>
        <Dir host={host} path={ws.path} depth={0} showIgnored={showIgnored} version={version} onOpen={onOpen} selected={current?.path ?? null} />
      </div>
      {current && (
        <div className="min-h-0 flex-1">
          <Suspense fallback={null}>
            <CodeViewer key={current.path} host={host} path={current.path} line={current.line} onClose={() => useStore.setState({ openFile: null })} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
