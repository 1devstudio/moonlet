// A session's Design tab (X65): its session design's canvas, with the same
// page tabs, toolbar, modes, bars and right rail as the design screen. Its
// chat is the session's own, beside it, which the tab neither folds nor
// opens; the file above the page is its path in the worktree.

import { useEffect, useMemo, useState, type RefObject } from "react";
import { ArrowLeft, ChevronDown, Columns2, PenTool } from "lucide-react";
import { rpc } from "../../lib/daemon";
import { M } from "../../lib/protocol";
import { builtFile, designBuild, type BuildRow as BuildRowView } from "../../lib/designBuild";
import { designUrl, pageUrl } from "../../lib/designView";
import { useSize } from "../../lib/useSize";
import { CardFrame } from "./Frame";
import type { Design, Session } from "../../lib/protocol";
import { designCanvasKey, commentsOf, loadComments, openSessionDesign, pageRevOf, sessionDesignsOf, showSessionDesign, shownSessionDesign, systemsOf, useDesign, builtRevOf } from "../../lib/designStore";
import { projectOf, useStore } from "../../lib/store";
import { sendWithEdits, type ToldDesign } from "../../lib/designEditor";
import { designSystemFooter, inWorktree, opensDesignView, specReplies, worktreeFile } from "../../lib/sessionDesign";
import { chatKey, useChat, type SuggestedReply } from "../../lib/chat";
import { Empty } from "../ui";
import { Menu } from "../Menu";
import { AgentView } from "../AgentView";
import { designMessage } from "./Comments";
import { DesignCanvas, useDesignBasics, type CanvasChat } from "./DesignScreen";

/** Where Show in chat looks for a comment's card in a session: the session's
 *  chat is in its panes, not beside the canvas, so the whole document. */
const WHOLE_DOCUMENT: RefObject<HTMLElement | null> = {
  get current() {
    return document.body;
  },
};

/** The session's chat is always there: the tab neither folds nor opens it. */
const SESSION_CHAT: CanvasChat = { open: true, setOpen: () => {}, root: WHOLE_DOCUMENT };

export function SessionDesignTab({ host, ws }: { host: string; ws: Session }) {
  const design = useDesign((d) => shownSessionDesign(d, host, ws.id));
  // The canvas, or the PR's Design and build: each page beside its built screen.
  const [build, setBuild] = useState(false);
  if (!design) {
    return (
      <Empty icon={<PenTool size={20} className="text-faint" />} title="No design in this session">
        /moonlet-design in the chat prototypes a page here, in this session's Design tab.
      </Empty>
    );
  }
  // Another session's design of the same slug is another canvas.
  const key = designCanvasKey(host, { session: ws.id }, design.slug);
  if (build) return <DesignAndBuild key={key} host={host} ws={ws} design={design} onBack={() => setBuild(false)} />;
  return <SessionCanvas key={key} host={host} ws={ws} design={design} onBuild={() => setBuild(true)} />;
}

/** The PR's Design and build (X65): each page of the session design beside
 *  the screenshot of its built screen the agent saved after implementing it
 *  (`.moonlet/design/<slug>/built/<page>.png`), both framed on hosts of
 *  their own, or "Not built yet". Looked for again as the design's files
 *  change, the screenshots' folder included. */
function DesignAndBuild({ host, ws, design, onBack }: { host: string; ws: Session; design: Design; onBack: () => void }) {
  const place = useMemo(() => ({ session: ws.id }), [ws.id]);
  // Looked for again as its agent saves screenshots in built/.
  const builtRev = useDesign((d) => builtRevOf(d, host, place, design.slug));
  const [found, setFound] = useState<Record<string, boolean>>({});
  const pages = JSON.stringify(design.pages.map((p) => p.name));
  useEffect(() => {
    let live = true;
    for (const page of JSON.parse(pages) as string[]) {
      void rpc(host, M.designFile, { session: ws.id, path: builtFile(design.slug, page) }).then(
        () => live && setFound((f) => ({ ...f, [page]: true })),
        () => live && setFound((f) => ({ ...f, [page]: false })),
      );
    }
    return () => {
      live = false;
    };
  }, [host, ws.id, design.slug, pages, builtRev]);
  const view = designBuild(design, ws.path, found);
  return (
    <section aria-label="Design and build" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[42px] shrink-0 items-center gap-2.5 border-b border-border px-4">
        <span className="ui-text-13.5 font-medium text-fg">{view.title}</span>
        <span className="min-w-0 truncate ui-text-12.5 text-muted">{view.line}</span>
        <span className="flex-1" />
        <button onClick={onBack} className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 ui-text-12.5 text-muted hover:bg-panel-2 hover:text-fg">
          <ArrowLeft size={12} /> Canvas
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {view.rows.map((r) => (
          <BuildRow key={r.page} host={host} place={place} slug={design.slug} row={r} viewport={view.viewport} builtRev={builtRev} />
        ))}
      </div>
    </section>
  );
}

/** One page of Design and build: the page as it is now, beside its built screenshot. */
function BuildRow({ host, place, slug, row, viewport, builtRev }: { host: string; place: { session: string }; slug: string; row: BuildRowView; viewport: [number, number]; builtRev: number }) {
  const rev = useDesign((d) => pageRevOf(d, host, place, slug, row.page));
  return (
    <article aria-label={`${row.page} design and build`} className="mb-5 grid grid-cols-2 gap-4">
      <BuildTile url={pageUrl(place, slug, row.page, rev)} title={`${row.page} design`} viewport={viewport} caption={["design", row.design]} />
      <BuildTile url={row.built && designUrl(place, row.built, builtRev)} title={`${row.page} built`} viewport={viewport} caption={["built", row.builtLabel ?? ""]} empty={row.builtLabel ?? ""} />
    </article>
  );
}

/** A page or its built screenshot, fitted to the column, and what it is under it. */
function BuildTile({ url, title, viewport, caption, empty = "" }: { url: string | null; title: string; viewport: [number, number]; caption: [string, string]; empty?: string }) {
  const [ref, [width]] = useSize<HTMLDivElement>();
  const scale = width ? width / viewport[0] : 0;
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1.5">
      <div ref={ref} className="relative w-full overflow-hidden rounded-md border border-border-strong bg-bg" style={{ aspectRatio: `${viewport[0]} / ${viewport[1]}` }}>
        {url && scale > 0 ? <CardFrame url={url} title={title} viewport={viewport} scale={scale} /> : <span className="absolute inset-0 flex items-center justify-center ui-text-12.5 text-faint">{empty}</span>}
      </div>
      <figcaption className="truncate ui-text-12 text-muted">
        <span className="font-mono text-fg">{caption[0]}</span> · {caption[1]}
      </figcaption>
    </figure>
  );
}

/** The canvas of the design a session's Design tab shows. */
function SessionCanvas({ host, ws, design, onBuild }: { host: string; ws: Session; design: Design; onBuild: () => void }) {
  const designs = useDesign((d) => sessionDesignsOf(d, host, ws.id));
  const workspace = ws.workspace_id ?? "";
  const { agent, systemName } = useDesignBasics(host, workspace, design);
  // One object per session, as the canvas's effects follow it.
  const place = useMemo(() => ({ session: ws.id }), [ws.id]);
  const peers = useMemo(() => sharing(designs, design.agent, ws), [designs, design.agent, ws]);
  // Several designs: the tab shows one, picked here.
  const pick =
    designs.length > 1 ? (
      <Menu
        align="right"
        items={designs.map((d) => ({ label: d.name, hint: d.slug, checked: d.slug === design.slug, onSelect: () => showSessionDesign(host, ws.id, d.slug) }))}
        trigger={(open) => (
          <button aria-label="Design" onClick={open} className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 ui-text-13 text-muted hover:bg-panel-2 hover:text-fg">
            {design.name} <ChevronDown size={12} className="text-faint" />
          </button>
        )}
      />
    ) : null;
  // The PR's Design and build, at the end of the page tabs (X65).
  const picker = (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      <button title="Each page beside a screenshot of its built screen" onClick={onBuild} className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 ui-text-13 text-muted hover:bg-panel-2 hover:text-fg">
        <Columns2 size={13} /> Design and build
      </button>
      {pick}
    </span>
  );
  return (
    <div className="flex h-full min-h-0">
      <DesignCanvas
        host={host}
        place={place}
        workspace={workspace}
        design={design}
        agent={agent}
        systemName={systemName}
        inset={0}
        chat={SESSION_CHAT}
        fileOf={(page) => worktreeFile(ws.path, design, page)}
        aside={picker}
        peers={peers}
      />
    </div>
  );
}

/** The designs of a session its agent `agent` works on, as its messages
 *  name them: by their folders in the worktree. */
function sharing(designs: Design[], agent: number | null, ws: Session): ToldDesign[] {
  return designs.filter((d) => agent !== null && d.agent === agent).map((d) => ({ place: { session: ws.id }, slug: d.slug, folder: inWorktree(ws.path, d.path) }));
}

/** The note after the agent's `design new --here`, which made the session
 *  design and opened its Design tab (X65). */
function DesignOpenedNote() {
  return (
    <p className="my-1.5 flex items-start gap-2 rounded-lg border border-border px-3 py-2 ui-text-12.5 text-muted">
      <PenTool size={13} className="mt-0.5 shrink-0" /> Design view opened. The design system is copied into the session for Claude to read
    </p>
  );
}

/** A session's chat (X65): its agent's structured view. When it is the
 *  agent of the design the session's Design tab shows, its comments show as
 *  Comment from the Design view cards and its edits by hand as their block,
 *  and what the user types goes with the edits by hand not told yet before
 *  it, every design's that shares the agent, each comment card read against
 *  the design its line's folder names; after the agent made a session design, a note says the Design view
 *  opened. Its slash menu lists /moonlet-design's forms, naming the design
 *  system it will use once the workspace's are listed. */
export function SessionChat({ host, id, wsId, focused, visible }: { host: string; id: number; wsId: string; focused: boolean; visible: boolean }) {
  const designs = useDesign((d) => sessionDesignsOf(d, host, wsId));
  const session = useStore((s) => s.sessions[host]?.find((x) => x.id === wsId));
  // The session's designs this chat's agent works on: every one's edits by
  // hand go with what the user types here.
  const peers = useMemo(() => (session ? sharing(designs, id, session) : []), [designs, id, session]);
  const own = peers[0] ?? null;
  // Each comment card is read against the design its line's folder names;
  // a change of any design's comments shows here again.
  useDesign((d) => d.comments);
  useEffect(() => {
    for (const p of peers) void loadComments(host, p.place, p.slug).catch(() => {});
  }, [host, peers]);
  const pinsOf = (folder: string | null) => {
    const p = peers.find((x) => x.folder === folder);
    return p ? commentsOf(useDesign.getState(), host, p.place, p.slug) : [];
  };
  const project = useStore((s) => (session ? projectOf(s, host, session)?.path : undefined));
  const systems = useDesign((d) => (session?.workspace_id ? systemsOf(d, host, session.workspace_id) : undefined));
  // The forms show at once; the footer once the workspace's systems are listed.
  const slash = useMemo(() => ({ footer: systems && project ? designSystemFooter(systems, project) : null }), [systems, project]);
  // Once its agent wrote a spec from the design: Implement it, Back to the design (X65).
  const items = useChat((s) => s.chats[chatKey(host, id)]?.items);
  const status = useChat((s) => s.chats[chatKey(host, id)]?.status);
  const replies = useMemo(() => (session ? specReplies(items ?? [], status, session.path, designs.length > 0) : null), [items, status, session, designs.length]);
  // The replies that are no message: Back to the design opens the Design tab.
  const onReply = (r: Exclude<SuggestedReply, { kind: "send" }>) => {
    switch (r.kind) {
      case "design": {
        const shown = shownSessionDesign(useDesign.getState(), host, wsId);
        if (session && shown) void openSessionDesign(host, session.workspace_id ?? "", wsId, shown.slug, false);
      }
    }
  };

  return (
    <AgentView
      host={host}
      id={id}
      wsId={wsId}
      focused={focused}
      visible={visible}
      toolNote={(t) => (t.tool && opensDesignView(t.tool) ? <DesignOpenedNote /> : null)}
      designSlash={slash}
      replies={replies}
      onReply={onReply}
      userView={own ? (text) => designMessage(text, pinsOf, true) : undefined}
      sendText={own ? (text, images) => sendWithEdits(host, own.place, own.slug, id, text, images, peers) : undefined}
    />
  );
}
