import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Eye, EyeOff, Plus } from "lucide-react";
import { hostsApi, rpc } from "../lib/daemon";
import { M, type DirEntry, type Session } from "../lib/protocol";
import { errorToast, sesKey, useStore } from "../lib/store";
import { draftToAgent, openFileTab } from "../lib/actions";
import { fileMention } from "../lib/chat";
import { openInChoices, type OpenTarget } from "../lib/openIn";
import { FileIcon } from "./FileIcon";
import { Menu } from "./Menu";
import { IconButton, cx } from "./ui";

/** What a row needs from the panel: where it lives and what its actions do. */
interface Tree {
  host: string;
  root: string;
  showIgnored: boolean;
  version: number;
  selected: string | null;
  targets: OpenTarget[];
  onOpen: (e: DirEntry) => void;
}

/** Add to chat and Open in, shown on the hovered row (X25). */
function RowActions({ e, tree }: { e: DirEntry; tree: Tree }) {
  const tailnet = useStore((s) => s.hosts[tree.host]?.kind === "tailnet");
  const choices = openInChoices(tree.targets, { dir: e.is_dir, remote: tree.host !== "local", tailnet });
  return (
    <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100" onClick={(ev) => ev.stopPropagation()}>
      {!e.is_dir && (
        <IconButton title="Add to chat" onClick={() => void draftToAgent(fileMention(tree.root, e.path))}>
          <Plus size={14} />
        </IconButton>
      )}
      <Menu
        align="right"
        width={200}
        trigger={(toggle) => (
          <IconButton title="Open in…" onClick={toggle}>
            <ChevronDown size={14} />
          </IconButton>
        )}
        items={[
          { kind: "label", label: "Open in" },
          ...choices.map((t) => ({ label: t.label, onSelect: () => void hostsApi.openIn(t.id, e.path, tree.host).catch(errorToast) })),
        ]}
      />
    </span>
  );
}

function Dir({ path, depth, tree }: { path: string; depth: number; tree: Tree }) {
  const { host, showIgnored, version, selected, onOpen } = tree;
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
  if (!entries) return <div className="py-1 font-mono ui-text-12 text-faint" style={{ paddingLeft: 18 + depth * 16 }}>…</div>;
  return (
    <>
      {entries.map((e) => (
        <div key={e.path}>
          <div
            role="treeitem"
            aria-expanded={e.is_dir ? !!open[e.path] : undefined}
            aria-selected={selected === e.path}
            title={e.path}
            className={cx(
              "group mx-2 flex h-[30px] cursor-default items-center gap-2.5 rounded-md pr-1 font-mono ui-text-14",
              selected === e.path ? "bg-raised" : "hover:bg-panel-2",
              e.ignored ? "text-faint" : "text-fg",
            )}
            style={{ paddingLeft: 10 + depth * 16 }}
            onClick={() => (e.is_dir ? setOpen((o) => ({ ...o, [e.path]: !o[e.path] })) : onOpen(e))}
          >
            <FileIcon name={e.name} dir={e.is_dir} open={!!open[e.path]} />
            <span className="min-w-0 truncate">{e.name}</span>
            <RowActions e={e} tree={tree} />
          </div>
          {e.is_dir && open[e.path] && <Dir path={e.path} depth={depth + 1} tree={tree} />}
        </div>
      ))}
    </>
  );
}

export function FilesPanel({ host, ws }: { host: string; ws: Session }) {
  const [showIgnored, setShowIgnored] = useState(false);
  const version = useStore((s) => s.fsVersion[`${host}|${ws.path}`] ?? 0);
  // The file of the active editor tab (X26).
  const selected = useStore((s) => {
    const l = s.layouts[sesKey(host, ws.id)];
    const root = l?.tabs.find((t) => t.id === l.active)?.root;
    return root?.type === "file" ? root.path : null;
  });
  const [targets, setTargets] = useState<OpenTarget[]>([]);
  useEffect(() => {
    void hostsApi.openTargets().then(setTargets).catch(() => {});
  }, []);
  const onOpen = useCallback((e: DirEntry) => openFileTab(host, ws.id, e.path), [host, ws.id]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 ui-text-12 text-muted">
        <span className="truncate font-mono ui-text-11" title={ws.path}>
          {ws.path.split("/").slice(-2).join("/")}
        </span>
        <IconButton title={showIgnored ? "Hide ignored files" : "Show ignored files"} className="ml-auto" onClick={() => setShowIgnored(!showIgnored)}>
          {showIgnored ? <EyeOff size={12} /> : <Eye size={12} />}
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
        <div role="tree" aria-label="Files">
          <Dir path={ws.path} depth={0} tree={{ host, root: ws.path, showIgnored, version, selected, targets, onOpen }} />
        </div>
      </div>
    </div>
  );
}
