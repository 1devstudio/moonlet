import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, FileDiff, Folder, FolderOpen, List, ListTree, Minus, Plus, RotateCcw, SquareDot, SquareMinus, SquarePlus, Undo2 } from "lucide-react";
import { rpc } from "../lib/daemon";
import { changeCount, changeList, changeTree, type ChangeNode } from "../lib/changes";
import { NOT_COMMITTED, changesGroups } from "../lib/changesGroups";
import { sessionDesignsOf, useDesign } from "../lib/designStore";
import { M, type FileChange, type GitStatus, type Session } from "../lib/protocol";
import { errorToast, refreshGit, useStore, sesKey } from "../lib/store";
import { openDiffTab } from "../lib/actions";
import type { DiffMode } from "../lib/layout";
import { askConfirm } from "../lib/confirm";
import { Button, Empty, IconButton, cx } from "./ui";
import { ScrollArea } from "./ScrollArea";

type FileAction = "stage" | "unstage" | "revert";

function StatusBox({ status }: { status: FileChange["status"] }) {
  const p = { size: 14, strokeWidth: 1.5 };
  if (status === "added" || status === "untracked") return <SquarePlus {...p} className="shrink-0 text-add" />;
  if (status === "deleted" || status === "conflicted") return <SquareMinus {...p} className="shrink-0 text-del" />;
  return <SquareDot {...p} className="shrink-0 text-blocked" />;
}

function SummaryLine({ status }: { status: GitStatus }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-5 py-3 ui-text-14 text-muted">
      <span>
        {status.files.length} file{status.files.length === 1 ? "" : "s"} changed
      </span>
      {status.base_missing && (
        <span className="ui-text-12 text-blocked" title={`"${status.base_missing}" was not found (not fetched?), so only uncommitted changes against HEAD are shown.`}>
          base not found · showing HEAD
        </span>
      )}
      <span className="ml-auto font-mono ui-text-12.5 tabular-nums">
        <span className="text-add">+{status.additions}</span> <span className="text-del">−{status.deletions}</span>
      </span>
    </div>
  );
}

/** Left padding of a tree row at `depth`, and how far each level indents (X28). */
const PAD = 12;
const INDENT = 18;

/** A changed file's row: status, name, counts, and stage/unstage/discard on hover. */
function FileRow({ f, depth = 0, children, onSelect, onAction }: { f: FileChange; depth?: number; children: ReactNode; onSelect: (path: string) => void; onAction: (f: FileChange, a: FileAction) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}
      className="group mx-2 flex h-[34px] cursor-default items-center gap-3 rounded-md pr-3 text-left outline-none hover:bg-raised focus-visible:bg-raised"
      style={{ paddingLeft: PAD + depth * INDENT }}
      onClick={() => onSelect(f.path)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect(f.path);
        }
      }}
    >
      <span className={cx("flex min-w-0 flex-1 ui-text-14", f.status === "deleted" && "line-through")}>{children}</span>
      {f.staged && <Check size={12} className="shrink-0 text-done" aria-label="staged" />}
      <span className="hidden shrink-0 items-center gap-0.5 group-focus-within:flex group-hover:flex" onClick={(e) => e.stopPropagation()}>
        {(f.unstaged || f.status === "untracked") && (
          <IconButton title="Stage file" onClick={() => onAction(f, "stage")}>
            <Plus size={12} />
          </IconButton>
        )}
        {f.staged && (
          <IconButton title="Unstage file" onClick={() => onAction(f, "unstage")}>
            <Minus size={12} />
          </IconButton>
        )}
        <IconButton title="Discard changes" onClick={() => onAction(f, "revert")}>
          <Undo2 size={12} />
        </IconButton>
      </span>
      <span className="flex shrink-0 items-center gap-2 group-focus-within:hidden group-hover:hidden">
        <span className="font-mono ui-text-12 tabular-nums">
          {changeCount(f)
            .split(" ")
            .map((c) => (
              <span key={c} className={cx("ml-1.5", c.startsWith("+") ? "text-add" : c.startsWith("−") ? "text-del" : "text-muted")}>
                {c}
              </span>
            ))}
        </span>
        <StatusBox status={f.status} />
      </span>
    </div>
  );
}

/** Changed files in path order, the folder dimmed and cut short before the name (X28). */
function ChangeListView({ files, onSelect, onAction }: { files: FileChange[]; onSelect: (path: string) => void; onAction: (f: FileChange, a: FileAction) => void }) {
  const rows = useMemo(() => changeList(files), [files]);
  return (
    <div className="py-2">
      {rows.map((f) => (
        <FileRow key={f.path} f={f} onSelect={onSelect} onAction={onAction}>
          <span className="min-w-0 truncate text-muted">{f.dir}</span>
          <span className={cx("max-w-full shrink-0 truncate", f.status === "deleted" ? "text-muted" : "text-fg")}>{f.name}</span>
        </FileRow>
      ))}
    </div>
  );
}

/** Changed files as a folder tree with indent guides; folders collapse (X28). */
function ChangeTreeView({ files, onSelect, onAction }: { files: FileChange[]; onSelect: (path: string) => void; onAction: (f: FileChange, a: FileAction) => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const tree = useMemo(() => changeTree(files), [files]);
  const render = (nodes: ChangeNode[], depth: number): ReactNode =>
    nodes.map((n) =>
      n.kind === "file" ? (
        <FileRow key={n.file.path} f={n.file} depth={depth} onSelect={onSelect} onAction={onAction}>
          <span className={cx("truncate", n.file.status === "deleted" ? "text-muted" : "text-fg")}>{n.name}</span>
        </FileRow>
      ) : (
        <div key={n.path}>
          <button
            className="mx-2 flex h-[34px] w-[calc(100%-16px)] items-center gap-1 rounded-md pr-3 text-left font-mono ui-text-13 text-muted hover:bg-raised hover:text-fg"
            style={{ paddingLeft: PAD + depth * INDENT }}
            title={n.path}
            onClick={() => setCollapsed((c) => ({ ...c, [n.path]: !c[n.path] }))}
          >
            <span className="flex w-[14px] shrink-0 justify-center">{collapsed[n.path] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
            {collapsed[n.path] ? <Folder size={14} strokeWidth={1.5} className="shrink-0" /> : <FolderOpen size={14} strokeWidth={1.5} className="shrink-0" />}
            <span className="ml-1 truncate">{n.name.split("/").join(" / ")}</span>
          </button>
          {!collapsed[n.path] && (
            <div className="relative">
              <span className="absolute bottom-0 top-0 w-px bg-border" style={{ left: 8 + PAD + depth * INDENT + 7 }} />
              {render(n.children, depth + 1)}
            </div>
          )}
        </div>
      ),
    );
  return <div className="py-2">{render(tree, 0)}</div>;
}

/** A session's changed files as Design, Spec and Code (X65), each group
 *  folding, in the panel's list or tree, then why comments and snapshots
 *  are not among them. */
function GroupedChanges({ groups, view, onSelect, onAction }: { groups: NonNullable<ReturnType<typeof changesGroups>>; view: "tree" | "list"; onSelect: (path: string) => void; onAction: (f: FileChange, a: FileAction) => void }) {
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  return (
    <div className="py-1">
      {groups.map((g) => (
        <section key={g.name} aria-label={g.name}>
          <button
            className="mx-2 mt-1 flex h-[30px] w-[calc(100%-16px)] items-center gap-1.5 rounded-md px-2 text-left ui-text-11.5 uppercase tracking-[0.08em] text-faint hover:bg-raised hover:text-fg"
            onClick={() => setFolded((f) => ({ ...f, [g.name]: !f[g.name] }))}
          >
            {folded[g.name] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            <span className="flex-1">{g.name}</span>
            <span className="font-mono tabular-nums normal-case tracking-normal">{g.files.length}</span>
          </button>
          {!folded[g.name] && (view === "tree" ? <ChangeTreeView files={g.files} onSelect={onSelect} onAction={onAction} /> : <ChangeListView files={g.files} onSelect={onSelect} onAction={onAction} />)}
        </section>
      ))}
      <p className="mx-4 mb-2 mt-1 ui-text-12 text-faint">{NOT_COMMITTED}</p>
    </div>
  );
}

export default function ChangesPanel({ host, ws }: { host: string; ws: Session }) {
  const status = useStore((s) => s.git[sesKey(host, ws.id)]);
  const view = useStore((s) => s.changesView);
  const [mode, setMode] = useState<DiffMode>("base");
  const [headStatus, setHeadStatus] = useState<typeof status>(undefined);
  const files = (mode === "base" ? status : headStatus)?.files ?? [];
  const fsVersion = useStore((s) => s.fsVersion[`${host}|${ws.path}`] ?? 0);

  useEffect(() => {
    if (mode !== "head") return;
    void rpc<NonNullable<typeof status>>(host, M.gitStatus, { path: ws.path }).then(setHeadStatus).catch(() => {});
  }, [mode, host, ws.path, fsVersion, status]);

  const refresh = () => void refreshGit(host, ws.id);

  // A changed file opens its diff in a tab of the main window (X77).
  const open = (path: string) => openDiffTab(host, ws.id, path, mode);

  const fileAction = async (f: FileChange, a: FileAction) => {
    if (a === "revert") {
      const ok = await askConfirm({ title: "Discard changes", message: `Discard all changes to ${f.path}? This cannot be undone.`, action: "Discard", variant: "danger" });
      if (!ok) return;
    }
    const method = a === "stage" ? M.gitStage : a === "unstage" ? M.gitUnstage : M.gitRevert;
    try {
      await rpc(host, method, { path: ws.path, files: [f.path] });
      refresh();
    } catch (e) {
      errorToast(e);
    }
  };

  const total = mode === "base" ? status : headStatus;
  // A session with a design groups its files as Design, Spec and Code (X65).
  const designs = useDesign((d) => sessionDesignsOf(d, host, ws.id));
  const groups = useMemo(() => changesGroups(files, ws.path, designs), [files, ws.path, designs]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 ui-text-12">
        <div className="flex rounded-md border border-border-strong p-0.5">
          {(["base", "head"] as DiffMode[]).map((m) => (
            <button
              key={m}
              className={cx("rounded px-2 py-0.5", mode === m ? "bg-raised text-fg" : "text-muted hover:text-fg")}
              onClick={() => setMode(m)}
              title={m === "base" ? `Everything since branching from ${ws.base}` : "Uncommitted changes only"}
            >
              {m === "base" ? `Against ${ws.base}` : "Uncommitted"}
            </button>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-1">
          {files.length > 0 && (
            <IconButton title={view === "tree" ? "Show as list" : "Show as tree"} onClick={() => useStore.setState({ changesView: view === "tree" ? "list" : "tree" })}>
              {view === "tree" ? <List size={12} /> : <ListTree size={12} />}
            </IconButton>
          )}
          <IconButton title="Refresh" onClick={refresh}>
            <RotateCcw size={12} />
          </IconButton>
          <Button size="sm" onClick={() => useStore.setState({ dialog: { kind: "commit" } })} disabled={!files.length}>
            Commit…
          </Button>
        </span>
      </div>
      {files.length === 0 ? (
        <Empty icon={<FileDiff size={20} className="text-faint" />} title="No changes yet">
          {mode === "base" ? `Nothing differs from ${ws.base}.` : "The working tree is clean."}
        </Empty>
      ) : (
        <ScrollArea>
          {total && <SummaryLine status={total} />}
          {groups ? (
            <GroupedChanges groups={groups} view={view} onSelect={open} onAction={(f, a) => void fileAction(f, a)} />
          ) : view === "tree" ? (
            <ChangeTreeView files={files} onSelect={open} onAction={(f, a) => void fileAction(f, a)} />
          ) : (
            <ChangeListView files={files} onSelect={open} onAction={(f, a) => void fileAction(f, a)} />
          )}
        </ScrollArea>
      )}
    </div>
  );
}
