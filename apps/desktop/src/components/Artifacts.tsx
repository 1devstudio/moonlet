// Artifacts (X114): the sidebar's list of a workspace's plans and designs,
// and the artifact view in the main area.

import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpFromLine, Check, Layers, MoreHorizontal, Paperclip, Pencil, Plus, Search, X } from "lucide-react";
import { rpc } from "../lib/daemon";
import { M, type ArtifactInfo, type ArtifactText } from "../lib/protocol";
import { copyRefusal, designFor, markParts, moveRefusal, planReadOnly, stateLabel, unreachableLine, versionLine, type ArtifactKind } from "../lib/artifacts";
import { KindTile, useArtifactRows } from "./ArtifactChips";
import { addChip, artifactDesigns, loadArtifactDesigns, loadPlans, searchPlans, useArtifacts, watchArtifacts } from "../lib/artifactStore";
import { adoptDesign, loadDesigns, openSessionDesign, showDesign, useDesign } from "../lib/designStore";
import { LIBRARY } from "../lib/designLibrary";
import { placeOfDesign } from "../lib/designPlace";
import { pageUrl, projectPageUrl } from "../lib/designView";
import { viewportOf } from "../lib/designViewport";
import { setMode } from "../lib/mode";
import { useNear } from "../lib/useNear";
import { useSize } from "../lib/useSize";
import { errorToast, selectSession, shownWorkspace, toast, useStore } from "../lib/store";
import { shortAge } from "../lib/design";
import { RadioList, Segmented } from "./settings/controls";
import { Markdown } from "./AgentView";
import { Menu } from "./Menu";
import { Button, Dialog, IconButton, cx } from "./ui";
import { ScrollArea } from "./ScrollArea";
import { CardFrame } from "./design/Frame";

const KINDS = [
  { id: "all", label: "All" },
  { id: "plan", label: "Plans" },
  { id: "design", label: "Designs" },
] as const satisfies readonly { id: ArtifactKind; label: string }[];

/** The sidebar's list, in place of the sessions, while Artifacts is on. */
export function ArtifactsList() {
  const { rows, workspace, hosts } = useArtifactRows();
  const kind = useArtifacts((s) => s.kind);
  const shown = useArtifacts((s) => s.shown);
  const [query, setQuery] = useState(useArtifacts.getState().query);
  useEffect(() => {
    if (!workspace) return;
    const load = (h: string) => {
      void loadPlans(h, workspace).catch(() => {});
      loadArtifactDesigns(h, workspace);
    };
    hosts.forEach(load);
    watchArtifacts((h) => {
      const ws = shownWorkspace(useStore.getState())?.id;
      if (!ws) return;
      void loadPlans(h, ws).catch(() => {});
      // A changed plan may now match the query, or no longer.
      const q = useArtifacts.getState().query;
      if (q.trim()) void searchPlans([h], ws, q);
    });
  }, [workspace, hosts]);
  const away = useStore((s) => unreachableLine(Object.fromEntries(Object.entries(s.hosts).map(([id, h]) => [id, { label: h.label, status: h.status }]))));
  // Plan text is searched on each host, a moment after the last key.
  useEffect(() => {
    if (!workspace) return;
    const t = setTimeout(() => void searchPlans(hosts, workspace, query), 150);
    return () => clearTimeout(t);
  }, [query, workspace, hosts]);
  const searching = query.trim() !== "";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 px-3 pb-2">
        <label className="relative flex items-center">
          <Search size={13} className="pointer-events-none absolute left-2.5 text-faint" />
          <input
            aria-label="Search artifacts"
            className="h-ui-30 w-full rounded-md border border-border bg-raised pl-8 pr-2 ui-text-13 text-fg outline-none placeholder:text-faint focus:border-border-strong"
            placeholder="Search names and plan text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span id="artifact-kinds" className="sr-only">Kind</span>
        <Segmented value={kind} options={KINDS} onChange={(k) => useArtifacts.setState({ kind: k })} labelledBy="artifact-kinds" />
      </div>
      <ScrollArea tone="window" className="px-2 pb-3">
        {away && <div className="px-2 pb-1 pt-2 ui-text-11.5 text-faint">{away}</div>}
        {searching && <div className="px-2 pb-1 pt-2 ui-text-11.5 text-faint">{rows.length === 1 ? "1 result" : `${rows.length} results`} for "{query.trim()}"</div>}
        {rows.length === 0 && !searching && <div className="px-3 py-2 ui-text-13 text-faint">No artifacts yet. Plans your agents propose and designs show here.</div>}
        {rows.map((r) => (
          <button
            key={r.host + r.info.id}
            aria-current={shown?.id === r.info.id && shown.host === r.host}
            onClick={() => useArtifacts.setState({ shown: { host: r.host, id: r.info.id } })}
            className={cx(
              "flex w-full gap-2.5 rounded-md px-2 py-2 text-left hover:bg-tab-hover",
              shown?.id === r.info.id && shown.host === r.host && "bg-raised shadow-[inset_0_0_0_1px_var(--color-border-strong)]",
            )}
          >
            <KindTile kind={r.info.kind} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate ui-text-13.5 text-fg">{r.info.name}</span>
              {r.snippet && (
                <span className="truncate ui-text-12 text-muted">
                  {markParts(r.snippet, query).map((p, i) => (p.mark ? <mark key={i} className="bg-transparent font-semibold text-accent-2">{p.text}</mark> : <span key={i}>{p.text}</span>))}
                </span>
              )}
              <span className="flex gap-1.5 truncate ui-text-11.5 text-faint">
                <span className="truncate">{r.home}</span>
                <span className="shrink-0">· {r.age}</span>
                {r.usedBy && <span className="shrink-0 text-muted">· {r.usedBy}</span>}
              </span>
            </span>
          </button>
        ))}
      </ScrollArea>
    </div>
  );
}

/** The artifact open in the main area. */
export function ArtifactView() {
  const shown = useArtifacts((s) => s.shown);
  const { rows } = useArtifactRows();
  const row = shown ? rows.find((r) => r.host === shown.host && r.info.id === shown.id) : undefined;
  if (!shown || !row) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg bg-bg ui-text-13 text-faint">
        <span className="flex items-center gap-2">
          <Layers size={14} /> Pick an artifact to open it.
        </span>
      </div>
    );
  }
  return row.info.kind === "plan" ? <PlanView key={row.host + row.info.id} host={row.host} info={row.info} home={row.home} /> : <DesignView key={row.host + row.info.id} host={row.host} info={row.info} home={row.home} />;
}

function Header({ info, children, menu }: { info: ArtifactInfo; children?: ReactNode; menu?: { label: string; disabled?: string; onSelect: () => void }[] }) {
  return (
    <div className="flex h-ui-52 shrink-0 items-center gap-3 border-b border-border px-5">
      <span className="flex min-w-0 items-center gap-2 ui-text-14 font-semibold">
        <KindTile kind={info.kind} size={20} />
        <span className="truncate">{info.name}</span>
        <span className="ui-text-11.5 font-normal text-faint">{info.kind === "plan" ? "Plan" : "Design"}</span>
      </span>
      <span className="flex-1" />
      {children}
      {menu && menu.length > 0 && (
        <Menu
          align="right"
          trigger={(open) => (
            <IconButton title="More" onClick={open}>
              <MoreHorizontal size={16} />
            </IconButton>
          )}
          items={menu.map((m) => ({ label: m.label, disabled: m.disabled, onSelect: m.onSelect }))}
        />
      )}
    </div>
  );
}

/** Copy to workspace… or Move to workspace… (X114): the other workspaces
 *  of the artifact's host, Copy or Move. Only a workspace's own artifact
 *  moves; a session's is copied. */
function ToWorkspaceDialog({ host, info, start, onClose }: { host: string; info: ArtifactInfo; start: "copy" | "move"; onClose: () => void }) {
  const here = useStore((s) => shownWorkspace(s)?.id);
  const workspaces = useStore((s) => s.workspaces[host]) ?? [];
  const movable = moveRefusal(info) === null;
  const [how, setHow] = useState<"copy" | "move">(movable ? start : "copy");
  const others = workspaces.filter((w) => w.id !== here);
  const [to, setTo] = useState(others[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const name = workspaces.find((w) => w.id === to)?.name ?? "";
  const go = async () => {
    if (!to) return;
    setBusy(true);
    try {
      await rpc(host, how === "copy" ? M.artifactCopy : M.artifactMove, { id: info.id, workspace: to });
      toast(`${how === "copy" ? "Copied" : "Moved"} ${info.name} to ${name}`);
      if (how === "move") useArtifacts.setState({ shown: null });
      if (here) {
        void loadPlans(host, here).catch(() => {});
        void loadDesigns(host, here, true).catch(() => {});
      }
      onClose();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`${info.name} to another workspace`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!to || busy} onClick={() => void go()}>
            {how === "copy" ? "Copy" : "Move"} to {name || "…"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <span id="to-workspace-how" className="sr-only">Copy or move</span>
        <span id="to-workspace-where" className="sr-only">Workspace</span>
        <Segmented
          value={how}
          options={[
            { id: "copy", label: "Copy" },
            ...(movable ? [{ id: "move" as const, label: "Move" }] : []),
          ]}
          onChange={setHow}
          labelledBy="to-workspace-how"
        />
        <p className="ui-text-12.5 text-muted">
          {how === "copy"
            ? `A copy is a new ${info.kind} of that workspace${info.kind === "design" ? ", with its pages, labels, brief, assets and comments; snapshots stay here" : ", with its latest version"}. Sessions here keep using this one.`
            : "It leaves this workspace. Sessions that use it keep reading it."}
        </p>
        {others.length ? (
          <RadioList value={to} options={others.map((w) => ({ id: w.id, label: w.name, description: "" }))} onChange={setTo} labelledBy="to-workspace-where" />
        ) : (
          <p className="ui-text-12.5 text-faint">There is no other workspace on this host.</p>
        )}
        {!movable && <p className="ui-text-12 text-faint">{moveRefusal(info)}.</p>}
      </div>
    </Dialog>
  );
}

/** A session design other sessions use (X114): it changes only in its
 *  session; Move to workspace gives it its own agent (X104). */
function UsedByBanner({ host, info, session, slug, workspace }: { host: string; info: ArtifactInfo; session: string; slug: string; workspace: string }) {
  const [hidden, setHidden] = useState(false);
  const sessionName = useStore((s) => s.sessions[host]?.find((w) => w.id === session)?.name ?? "its session");
  if (hidden || info.used_by.length === 0) return null;
  const move = async () => {
    try {
      const moved = await adoptDesign(host, session, slug);
      await loadDesigns(host, workspace, true);
      void loadPlans(host, workspace).catch(() => {});
      useArtifacts.setState({ shown: { host, id: `design:workspace:${workspace}:${moved}` } });
    } catch (e) {
      errorToast(e);
    }
  };
  const n = info.used_by.length;
  return (
    <div className="mx-5 mt-3 flex items-start gap-3 rounded-lg border border-border-strong bg-panel-2 p-3">
      <Layers size={16} className="mt-0.5 shrink-0 text-merged" />
      <div className="flex min-w-0 flex-1 flex-col gap-1 ui-text-12.5 leading-[1.45] text-muted">
        <span className="font-medium text-fg">
          Used by {n} other session{n === 1 ? "" : "s"}
        </span>
        <span>It changes only in {sessionName}, and becomes a workspace design when that session is archived. Move it to the workspace to give it its own agent now.</span>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="ghost" size="sm" onClick={() => setHidden(true)}>
          Not now
        </Button>
        <Button size="sm" onClick={() => void move()}>
          <ArrowUpFromLine size={13} /> Move to workspace
        </Button>
      </div>
    </div>
  );
}

/** The ⋯ menu's Copy and Move items, and their dialog (X114). */
function useToWorkspace(host: string, info: ArtifactInfo) {
  const [open, setOpen] = useState<"copy" | "move" | null>(null);
  const items = [
    { label: "Copy to workspace…", disabled: copyRefusal(info) ?? undefined, onSelect: () => setOpen("copy") },
    { label: "Move to workspace…", disabled: moveRefusal(info) ?? undefined, onSelect: () => setOpen("move") },
  ];
  const dialog = open && <ToWorkspaceDialog host={host} info={info} start={open} onClose={() => setOpen(null)} />;
  return { items, dialog };
}

/** Start session: the New session composer, the artifact its source, in
 *  its project (X114). */
function StartSession({ host, info }: { host: string; info: ArtifactInfo }) {
  const workspace = useStore((s) => shownWorkspace(s)?.id);
  return (
    <Button
      variant="primary"
      onClick={() =>
        useStore.setState({
          showArtifacts: false,
          dialog: { kind: "new-session", host, project: info.home.project, workspace, artifact: { host, id: info.id, name: info.name, kind: info.kind } },
        })
      }
    >
      <Plus size={13} /> Start session
    </Button>
  );
}

/** Attach to session…: the workspace's open sessions on the artifact's host,
 *  but its home; picking one adds the artifact to that session's next
 *  message and shows the session (X114). */
function AttachToSession({ host, info }: { host: string; info: ArtifactInfo }) {
  const sessions = useStore((s) => s.sessions[host]);
  const workspace = useStore((s) => shownWorkspace(s)?.id);
  const [query, setQuery] = useState("");
  const items = (sessions ?? [])
    .filter((w) => !w.archived && w.workspace_id === workspace && w.id !== info.home.session && w.name.toLowerCase().includes(query.trim().toLowerCase()))
    .map((w) => ({
      label: w.name,
      onSelect: () => {
        addChip(host, w.id, { host, id: info.id, name: info.name, kind: info.kind });
        useStore.setState({ showArtifacts: false });
        selectSession(host, w.id);
      },
    }));
  return (
    <Menu
      align="right"
      search={{ placeholder: "Find a session", query, onQuery: setQuery }}
      trigger={(open) => (
        <Button onClick={open}>
          <Paperclip size={13} /> Attach to session…
        </Button>
      )}
      items={items.length ? items : [{ kind: "label", label: "No other open session" }]}
    />
  );
}

function SideTitle({ children }: { children: ReactNode }) {
  return <div className="mb-2 ui-text-11.5 text-faint">{children}</div>;
}

/** The sessions that refer to an artifact, each opening its session. */
function UsedBy({ host, info }: { host: string; info: ArtifactInfo }) {
  const sessions = useStore((s) => s.sessions[host]);
  return (
    <div>
      <SideTitle>Used by</SideTitle>
      {info.used_by.length === 0 && <p className="ui-text-12 text-faint">No other session uses it.</p>}
      {info.used_by.map((id) => (
        <button
          key={id}
          onClick={() => {
            useStore.setState({ showArtifacts: false });
            selectSession(host, id);
          }} className="flex w-full truncate rounded-md px-2 py-1.5 text-left ui-text-12.5 text-fg hover:bg-tab-hover">
          {sessions?.find((x) => x.id === id)?.name ?? id}
        </button>
      ))}
    </div>
  );
}

/** A page of a design, drawn small. */
function PageThumb({ url, title, viewport }: { url: string; title: string; viewport: [number, number] }) {
  const [ref, [width]] = useSize<HTMLDivElement>();
  const near = useNear(ref);
  const scale = width ? width / viewport[0] : 0;
  return (
    <div ref={ref} className="relative w-full overflow-hidden rounded-lg border border-border-strong bg-panel" style={{ aspectRatio: `${viewport[0]} / ${viewport[1]}` }}>
      {scale > 0 && <CardFrame url={url} title={title} viewport={viewport} scale={scale} live={near} />}
    </div>
  );
}

function PlanView({ host, info, home }: { host: string; info: ArtifactInfo; home: string }) {
  const [read, setRead] = useState<ArtifactText | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const toWorkspace = useToWorkspace(host, info);
  useEffect(() => {
    let live = true;
    rpc<ArtifactText>(host, M.artifactRead, { id: info.id, version }).then(
      (r) => live && setRead(r),
      (e) => live && errorToast(e),
    );
    return () => {
      live = false;
    };
  }, [host, info.id, info.version, version]);
  const latest = read?.versions.at(-1)?.n ?? null;
  const readOnly = planReadOnly(info.home, version, latest);
  const save = async () => {
    if (editing === null) return;
    try {
      await rpc(host, M.artifactEdit, { id: info.id, text: editing });
      setEditing(null);
      setVersion(null);
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <div className="flex h-full overflow-hidden rounded-lg bg-bg">
      <div className="flex min-w-0 flex-1 flex-col">
        <Header info={info} menu={[...(info.home.archived ? [] : [{ label: "Rename…", onSelect: () => setRenaming(true) }]), ...toWorkspace.items]}>
          {editing === null && <AttachToSession host={host} info={info} />}
          {editing === null && <StartSession host={host} info={info} />}
          {editing === null ? (
            <Button disabled={readOnly || !read?.text} onClick={() => setEditing(read?.text ?? "")}>
              <Pencil size={13} /> Edit
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void save()}>
                <Check size={13} /> Save
              </Button>
            </>
          )}
        </Header>
        {renaming && <RenameBar host={host} info={info} onDone={() => setRenaming(false)} />}
        {toWorkspace.dialog}
        <div className="flex flex-wrap items-center gap-2 px-5 pt-3 ui-text-12.5 text-muted">
          <span>Home</span>
          <span className="text-fg">{home}</span>
          {read && <span className="text-faint">·</span>}
          {read && <span>{versionLine(read, Date.now())}</span>}
        </div>
        <ScrollArea className="px-5 pb-8 pt-4">
          {editing !== null ? (
            <textarea aria-label="Plan text" className="h-[60vh] w-full max-w-[720px] resize-none rounded-md border border-border-strong bg-raised p-3 font-mono ui-text-12.5 text-fg outline-none" value={editing} onChange={(e) => setEditing(e.target.value)} />
          ) : (
            <div className="max-w-[720px]">{read?.text && <Markdown text={read.text} />}</div>
          )}
        </ScrollArea>
      </div>
      <aside className="flex w-[260px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-border bg-panel p-4">
        <div>
          <SideTitle>Versions</SideTitle>
          {[...(read?.versions ?? [])].reverse().map((v) => (
            <button
              key={v.n}
              onClick={() => setVersion(v.n === latest ? null : v.n)}
              className={cx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ui-text-12.5 text-fg", (version ?? latest) === v.n && "bg-raised")}
            >
              <span>v{v.n}</span>
              <span className={cx("rounded px-1.5 ui-text-11 bg-panel-2", v.state === "approved" ? "text-done" : v.state === "rejected" ? "text-error" : "text-muted")}>
                {stateLabel(v.state)}
              </span>
              <span className="ml-auto ui-text-11.5 text-faint">{shortAge(Math.max(0, Date.now() - v.at))}</span>
            </button>
          ))}
        </div>
        <UsedBy host={host} info={info} />
        <div>
          <SideTitle>References</SideTitle>
          <p className="ui-text-12 leading-[1.45] text-muted">Sessions that use this plan read it live: they always get the latest version, read only. It changes only in its home.</p>
        </div>
      </aside>
    </div>
  );
}

function RenameBar({ host, info, onDone }: { host: string; info: ArtifactInfo; onDone: () => void }) {
  const [name, setName] = useState(info.name);
  const done = async (save: boolean) => {
    if (save) await rpc(host, M.artifactRename, { id: info.id, name: name.trim() || null }).catch((e) => errorToast(e));
    onDone();
  };
  return (
    <div className="flex items-center gap-2 border-b border-border px-5 py-2">
      <input
        autoFocus
        aria-label="Plan name"
        className="h-ui-30 min-w-0 flex-1 rounded-md border border-border-strong bg-raised px-2 ui-text-13 text-fg outline-none"
        value={name}
        placeholder="The session's name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void done(true);
          if (e.key === "Escape") void done(false);
        }}
      />
      <IconButton title="Cancel" onClick={() => void done(false)}>
        <X size={14} />
      </IconButton>
    </div>
  );
}

function DesignView({ host, info, home }: { host: string; info: ArtifactInfo; home: string }) {
  const workspace = useStore((s) => shownWorkspace(s)?.id);
  const design = useDesign((s) => (workspace ? designFor(artifactDesigns(s, host, workspace), info.id, workspace) : undefined));
  const toWorkspace = useToWorkspace(host, info);
  const edit = () => {
    if (!design || !workspace) return;
    if (design.kind === "session" && design.session) void openSessionDesign(host, workspace, design.session, design.slug, true);
    else {
      setMode("design");
      showDesign(host, workspace, design.slug, !!design.shared);
    }
  };
  const viewport = design ? viewportOf(design) : ([1280, 800] as [number, number]);
  const urlOf = (page: string) => {
    if (!design || !workspace) return null;
    if (design.kind === "project") return design.project ? projectPageUrl(design.project, design.slug, page) : null;
    return pageUrl(design.shared ? LIBRARY : placeOfDesign(design, workspace), design.slug, page);
  };
  return (
    <div className="flex h-full overflow-hidden rounded-lg bg-bg">
      <div className="flex min-w-0 flex-1 flex-col">
        <Header info={info} menu={design?.kind === "project" ? [] : toWorkspace.items}>
          {design?.kind !== "project" && <AttachToSession host={host} info={info} />}
          {!info.home.merged && <StartSession host={host} info={info} />}
          <Button disabled={!design || design.kind === "project"} onClick={edit}>
            <Pencil size={13} /> Edit
          </Button>
        </Header>
        <div className="flex flex-wrap items-center gap-2 px-5 pt-3 ui-text-12.5 text-muted">
          <span>Home</span>
          <span className="text-fg">{home}</span>
          {design && <span className="text-faint">·</span>}
          {design && <span>{design.system} design system</span>}
        </div>
        {toWorkspace.dialog}
        {design?.kind === "session" && design.session && workspace && <UsedByBanner host={host} info={info} session={design.session} slug={design.slug} workspace={workspace} />}
        <ScrollArea className="px-5 pb-8 pt-4">
          <div className="grid max-w-[900px] grid-cols-2 gap-4">
            {(design?.pages ?? []).map((p) => (
              <div key={p.name} className="flex flex-col gap-2">
                {urlOf(p.name) ? <PageThumb url={urlOf(p.name)!} title={p.label ?? p.name} viewport={viewport} /> : <div className="aspect-[16/10] rounded-lg border border-border-strong bg-panel" />}
                <div className="flex gap-2 ui-text-12.5 text-fg">
                  <span>{p.label ?? p.name}</span>
                  <span className="font-mono ui-text-11.5 text-faint">pages/{p.name}</span>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
      <aside className="flex w-[260px] shrink-0 flex-col gap-5 overflow-y-auto border-l border-border bg-panel p-4">
        <div>
          <SideTitle>Pages</SideTitle>
          {(design?.pages ?? []).map((p) => (
            <div key={p.name} className="flex items-center gap-2 rounded-md px-2 py-1.5 ui-text-12.5 text-fg">
              <span className="truncate">{p.label ?? p.name}</span>
              <span className="ml-auto ui-text-11.5 text-faint">{p.name}</span>
            </div>
          ))}
        </div>
        <UsedBy host={host} info={info} />
        <div>
          <SideTitle>Edit</SideTitle>
          <p className="ui-text-12 leading-[1.45] text-muted">
            {design?.kind === "session" ? "Edit opens its session with this design in its Design tab." : design?.kind === "project" ? "Merged into the project, read only." : "Edit it in Design mode."}
          </p>
        </div>
      </aside>
    </div>
  );
}
