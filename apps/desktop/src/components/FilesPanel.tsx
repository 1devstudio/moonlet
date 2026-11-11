import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Copy, Eye, EyeOff, FilePlus, FolderPlus, Pencil, Plus, SquareTerminal, Trash2 } from "lucide-react";
import { hostsApi, rpc } from "../lib/daemon";
import { M, type DirEntry, type Session } from "../lib/protocol";
import { errorToast, sesKey, toast, useStore, hostPath } from "../lib/store";
import { deleteEntry, draftToAgent, moveEntry, newTabIn, openFileTab } from "../lib/actions";
import { fileMention } from "../lib/chat";
import { dropTarget, nameProblem, offersFileActions, parentOf, renameSelection, terminalFolder } from "../lib/fileActions";
import { movedPath } from "../lib/layout";
import { openInChoices, syncedOpenIn, type OpenTarget } from "../lib/openIn";
import { useSync } from "../lib/syncStore";
import { FileIcon } from "./FileIcon";
import { Menu, MenuItems, type MenuItem } from "./Menu";
import { IconButton, cx } from "./ui";
import { ScrollArea } from "./ScrollArea";

/** A name being typed in the tree (X98): a new entry in a folder, or a rename. */
type Editing = { kind: "new"; folder: string; dir: boolean } | { kind: "rename"; path: string };

/** What a row needs from the panel: where it lives and what its actions do. */
interface Tree {
  host: string;
  ws: Session;
  root: string;
  showIgnored: boolean;
  version: number;
  selected: string | null;
  targets: OpenTarget[];
  onOpen: (e: DirEntry) => void;
  /** Expanded folders. */
  open: Record<string, boolean>;
  setOpen: (path: string, open: boolean) => void;
  editing: Editing | null;
  setEditing: (e: Editing | null) => void;
  /** The file actions (X98) are offered: not in a copy of another host's session. */
  changes: boolean;
  /** The folder a dragged row would move into, highlighted. */
  dropOn: string | null;
  setDropOn: (path: string | null) => void;
  /** The path of the row being dragged. */
  dragging: React.MutableRefObject<string | null>;
  onMenu: (ev: React.MouseEvent, e: DirEntry | null) => void;
  /** After a rename or move: expanded folders follow. */
  moved: (from: string, to: string) => void;
}

/** New file, Rename, Duplicate, Delete and the rest, for an entry or (null) the session's root (X98). */
function entryItems(e: DirEntry | null, tree: Tree): MenuItem[] {
  const { host, ws } = tree;
  const folder = e ? (e.is_dir ? e.path : parentOf(e.path)) : tree.root;
  const create = (dir: boolean) => {
    if (folder !== tree.root) tree.setOpen(folder, true);
    tree.setEditing({ kind: "new", folder, dir });
  };
  const terminal: MenuItem = { label: "Open terminal here", icon: <SquareTerminal size={14} className="text-muted" />, onSelect: () => void newTabIn(e ? terminalFolder(e) : tree.root) };
  const news: MenuItem[] = [
    { label: "New file", icon: <FilePlus size={14} className="text-muted" />, onSelect: () => create(false) },
    { label: "New folder", icon: <FolderPlus size={14} className="text-muted" />, onSelect: () => create(true) },
  ];
  if (!e) return [...news, { kind: "divider" }, terminal];
  return [
    ...news,
    { kind: "divider" },
    { label: "Rename", icon: <Pencil size={14} className="text-muted" />, onSelect: () => tree.setEditing({ kind: "rename", path: e.path }) },
    {
      label: "Duplicate",
      icon: <Copy size={14} className="text-muted" />,
      onSelect: () =>
        void rpc<{ path: string }>(host, M.fsDuplicate, { root: ws.path, path: e.path })
          .then((r) => tree.setEditing({ kind: "rename", path: r.path }))
          .catch(errorToast),
    },
    terminal,
    { kind: "divider" },
    { label: "Delete", icon: <Trash2 size={14} />, danger: true, onSelect: () => void deleteEntry(host, ws, e) },
  ];
}

/** Add to chat and Open in, shown on the hovered row (X25). */
function RowActions({ e, tree }: { e: DirEntry; tree: Tree }) {
  const kind = useStore((s) => s.hosts[tree.host]?.kind) ?? (tree.host === "local" ? "local" : "ssh");
  // A session kept in sync opens its copy on this Mac (X60).
  const sessionId = useStore((s) => s.sessions[tree.host]?.find((w) => w.path === tree.root)?.id);
  const copyPath = useSync((s) => (sessionId ? s.copies[sesKey(tree.host, sessionId)]?.path || null : null));
  const synced = syncedOpenIn(tree.targets, e.is_dir, { copy: copyPath, session: tree.root }, e.path);
  const choices = synced?.choices ?? openInChoices(tree.targets, { dir: e.is_dir, kind });
  const open = (t: OpenTarget) => (synced ? hostsApi.openIn(t.id, synced.path) : hostsApi.openIn(t.id, e.path, tree.host));
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
          ...choices.map((t) => ({ label: t.label, onSelect: () => void open(t).catch(errorToast) })),
          ...(tree.changes ? [{ kind: "divider" } as MenuItem, ...entryItems(e, tree)] : []),
        ]}
      />
    </span>
  );
}

/**
 * The name field of a new entry or a rename (X98): Enter saves, Esc
 * cancels, and so does leaving it with the name unchanged or empty.
 */
function NameField({ initial, dir, onSave, onCancel }: { initial: string; dir: boolean; onSave: (name: string) => Promise<boolean>; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const [bad, setBad] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(...renameSelection(initial, dir));
  }, []);
  const save = async () => {
    const name = value.trim();
    if (!name || name === initial) {
      done.current = true;
      return onCancel();
    }
    const problem = nameProblem(name);
    if (problem) {
      setBad(true);
      return toast(problem);
    }
    done.current = true;
    if (!(await onSave(name))) {
      done.current = false;
      setBad(true);
      input.current?.focus();
    }
  };
  return (
    <input
      ref={input}
      aria-label={initial ? `Rename ${initial}` : dir ? "New folder name" : "New file name"}
      value={value}
      spellCheck={false}
      className={cx("h-[22px] min-w-0 flex-1 rounded border bg-panel px-1.5 font-mono ui-text-13 text-fg outline-none", bad ? "border-error" : "border-accent")}
      onChange={(ev) => {
        setValue(ev.target.value);
        setBad(false);
      }}
      onClick={(ev) => ev.stopPropagation()}
      onKeyDown={(ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") void save();
        if (ev.key === "Escape") {
          done.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (!done.current) void save();
      }}
    />
  );
}

/** The row of a new entry's name, first in its folder (X98). */
function NewEntry({ folder, dir, depth, tree }: { folder: string; dir: boolean; depth: number; tree: Tree }) {
  const [name, setName] = useState("");
  const save = async (n: string) => {
    const path = `${folder}/${n}`;
    try {
      await rpc(tree.host, M.fsCreate, { root: tree.root, path, dir });
    } catch (e) {
      errorToast(e);
      return false;
    }
    tree.setEditing(null);
    if (!dir) openFileTab(tree.host, tree.ws.id, path);
    return true;
  };
  return (
    <div className="mx-2 flex h-[30px] items-center gap-2.5 rounded-md pr-1" style={{ paddingLeft: 10 + depth * 16 }} onInput={(ev) => setName((ev.target as HTMLInputElement).value)}>
      <FileIcon name={name} dir={dir} open={false} />
      <NameField initial="" dir={dir} onSave={save} onCancel={() => tree.setEditing(null)} />
    </div>
  );
}

function Dir({ path, depth, tree }: { path: string; depth: number; tree: Tree }) {
  const { host, showIgnored, version, selected, onOpen, open, editing } = tree;
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
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
  /** Where a row dragged over `e` would move: into it, or into a file's folder. */
  const over = (ev: React.DragEvent, e: DirEntry) => {
    const from = tree.dragging.current;
    const folder = e.is_dir ? e.path : parentOf(e.path);
    // Handled here, so the panel's own drop (to the root) doesn't also take it.
    ev.stopPropagation();
    if (!from || !dropTarget(from, folder)) return tree.setDropOn(null);
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    tree.setDropOn(folder);
  };
  const drop = (ev: React.DragEvent, e: DirEntry) => {
    ev.preventDefault();
    ev.stopPropagation();
    const from = tree.dragging.current;
    const to = from && dropTarget(from, e.is_dir ? e.path : parentOf(e.path));
    tree.setDropOn(null);
    tree.dragging.current = null;
    if (from && to) void moveEntry(host, tree.ws, from, to).then((ok) => ok && tree.moved(from, to));
  };
  return (
    <>
      {editing?.kind === "new" && editing.folder === path && <NewEntry folder={path} dir={editing.dir} depth={depth} tree={tree} />}
      {entries.map((e) => {
        const renaming = editing?.kind === "rename" && editing.path === e.path;
        return (
          <div key={e.path}>
            <div
              role="treeitem"
              aria-expanded={e.is_dir ? !!open[e.path] : undefined}
              aria-selected={selected === e.path}
              title={e.path}
              draggable={tree.changes && !renaming}
              className={cx(
                "group mx-2 flex h-[30px] cursor-default items-center gap-2.5 rounded-md pr-1 ui-text-14",
                selected === e.path || tree.dropOn === e.path ? "bg-raised" : "hover:bg-panel-2",
                e.ignored ? "text-faint" : "text-fg",
              )}
              style={{ paddingLeft: 10 + depth * 16 }}
              onClick={() => !renaming && (e.is_dir ? tree.setOpen(e.path, !open[e.path]) : onOpen(e))}
              onContextMenu={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                if (tree.changes) tree.onMenu(ev, e);
              }}
              onDragStart={(ev) => {
                tree.dragging.current = e.path;
                ev.dataTransfer.effectAllowed = "move";
                ev.dataTransfer.setData("text/plain", e.path);
              }}
              onDragEnd={() => {
                tree.dragging.current = null;
                tree.setDropOn(null);
              }}
              onDragOver={(ev) => over(ev, e)}
              onDrop={(ev) => drop(ev, e)}
            >
              <FileIcon name={e.name} dir={e.is_dir} open={!!open[e.path]} />
              {renaming ? (
                <NameField
                  initial={e.name}
                  dir={e.is_dir}
                  onSave={async (name) => {
                    const to = `${parentOf(e.path)}/${name}`;
                    if (!(await moveEntry(host, tree.ws, e.path, to))) return false;
                    tree.moved(e.path, to);
                    tree.setEditing(null);
                    return true;
                  }}
                  onCancel={() => tree.setEditing(null)}
                />
              ) : (
                <>
                  <span className="min-w-0 truncate">{e.name}</span>
                  <RowActions e={e} tree={tree} />
                </>
              )}
            </div>
            {e.is_dir && open[e.path] && <Dir path={e.path} depth={depth + 1} tree={tree} />}
          </div>
        );
      })}
    </>
  );
}

/** The right-click menu of a row, or of the panel's empty space, at the pointer (X98). */
function EntryMenu({ at, items, onClose }: { at: { x: number; y: number }; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onClose);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onClose);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  return createPortal(
    <div
      role="menu"
      aria-label="File actions"
      className="fixed z-50 w-56 rounded-xl border border-border-strong bg-[#232323] p-1 shadow-2xl"
      style={{ left: Math.min(at.x, window.innerWidth - 234), top: Math.min(at.y, window.innerHeight - 260) }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <MenuItems items={items} onClose={onClose} />
    </div>,
    document.body,
  );
}

export function FilesPanel({ host, ws }: { host: string; ws: Session }) {
  const [showIgnored, setShowIgnored] = useState(false);
  const version = useStore((s) => s.fsVersion[hostPath(host, ws.path)] ?? 0);
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
  const [open, setOpenState] = useState<Record<string, boolean>>({});
  const setOpen = useCallback((path: string, o: boolean) => setOpenState((s) => ({ ...s, [path]: o })), []);
  const moved = useCallback(
    (from: string, to: string) =>
      setOpenState((s) => Object.fromEntries(Object.entries(s).map(([p, o]) => [movedPath(p, from, to) ?? p, o]))),
    [],
  );
  const [editing, setEditing] = useState<Editing | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const dragging = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: DirEntry | null } | null>(null);
  const onMenu = useCallback((ev: React.MouseEvent, entry: DirEntry | null) => setMenu({ x: ev.clientX, y: ev.clientY, entry }), []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const changes = offersFileActions(host);
  const tree: Tree = { host, ws, root: ws.path, showIgnored, version, selected, targets, onOpen, open, setOpen, editing, setEditing, changes, dropOn, setDropOn, dragging, onMenu, moved };
  /** A drop on the panel's empty space moves the row to the session's root. */
  const toRoot = (ev: React.DragEvent) => {
    const from = dragging.current;
    if (!from || !dropTarget(from, ws.path)) return setDropOn(null);
    ev.preventDefault();
    setDropOn(ws.path);
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5 ui-text-12 text-muted">
        <span className="mr-auto truncate font-mono ui-text-11" title={ws.path}>
          {ws.path.split("/").slice(-2).join("/")}
        </span>
        {changes && (
          <>
            <IconButton title="New file" onClick={() => setEditing({ kind: "new", folder: ws.path, dir: false })}>
              <FilePlus size={12} />
            </IconButton>
            <IconButton title="New folder" onClick={() => setEditing({ kind: "new", folder: ws.path, dir: true })}>
              <FolderPlus size={12} />
            </IconButton>
          </>
        )}
        <IconButton title={showIgnored ? "Hide ignored files" : "Show ignored files"} onClick={() => setShowIgnored(!showIgnored)}>
          {showIgnored ? <EyeOff size={12} /> : <Eye size={12} />}
        </IconButton>
      </div>
      <ScrollArea className="py-1.5">
        <div
          role="tree"
          aria-label="Files"
          className={cx("min-h-full rounded-md", dropOn === ws.path && "bg-panel-2")}
          onContextMenu={(ev) => {
            ev.preventDefault();
            if (changes) onMenu(ev, null);
          }}
          onDragOver={toRoot}
          onDragLeave={(ev) => ev.currentTarget === ev.target && setDropOn(null)}
          onDrop={(ev) => {
            ev.preventDefault();
            const from = dragging.current;
            const to = from && dropTarget(from, ws.path);
            setDropOn(null);
            dragging.current = null;
            if (from && to) void moveEntry(host, ws, from, to).then((ok) => ok && moved(from, to));
          }}
        >
          <Dir path={ws.path} depth={0} tree={tree} />
        </div>
      </ScrollArea>
      {menu && <EntryMenu at={menu} items={entryItems(menu.entry, tree)} onClose={closeMenu} />}
    </div>
  );
}
