// A session's Design tab (X65): its session design's canvas, with the same
// page tabs, toolbar, modes, bars and right rail as the design screen. Its
// chat is the session's own, beside it, which the tab neither folds nor
// opens; the file above the page is its path in the worktree.

import { useEffect, useMemo, type RefObject } from "react";
import { ChevronDown, PenTool } from "lucide-react";
import type { Design, Session } from "../../lib/protocol";
import { designCanvasKey, commentsOf, loadComments, sessionDesignsOf, showSessionDesign, shownSessionDesign, systemsOf, useDesign } from "../../lib/designStore";
import { projectOf, useStore } from "../../lib/store";
import { sendWithEdits, type ToldDesign } from "../../lib/designEditor";
import { designSystemFooter, inWorktree, opensDesignView, worktreeFile } from "../../lib/sessionDesign";
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
  if (!design) {
    return (
      <Empty icon={<PenTool size={20} className="text-faint" />} title="No design in this session">
        /moonlet-design in the chat prototypes a page here, in this session's Design tab.
      </Empty>
    );
  }
  // Another session's design of the same slug is another canvas.
  return <SessionCanvas key={designCanvasKey(host, { session: ws.id }, design.slug)} host={host} ws={ws} design={design} />;
}

/** The canvas of the design a session's Design tab shows. */
function SessionCanvas({ host, ws, design }: { host: string; ws: Session; design: Design }) {
  const designs = useDesign((d) => sessionDesignsOf(d, host, ws.id));
  const workspace = ws.workspace_id ?? "";
  const { agent, systemName } = useDesignBasics(host, workspace, design);
  // One object per session, as the canvas's effects follow it.
  const place = useMemo(() => ({ session: ws.id }), [ws.id]);
  const peers = useMemo(() => sharing(designs, design.agent, ws), [designs, design.agent, ws]);
  // Several designs: the tab shows one, picked here.
  const picker =
    designs.length > 1 ? (
      <Menu
        align="right"
        items={designs.map((d) => ({ label: d.name, hint: d.slug, checked: d.slug === design.slug, onSelect: () => showSessionDesign(host, ws.id, d.slug) }))}
        trigger={(open) => (
          <button aria-label="Design" onClick={open} className="ml-auto flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 ui-text-13 text-muted hover:bg-panel-2 hover:text-fg">
            {design.name} <ChevronDown size={12} className="text-faint" />
          </button>
        )}
      />
    ) : null;
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
  return (
    <AgentView
      host={host}
      id={id}
      wsId={wsId}
      focused={focused}
      visible={visible}
      toolNote={(t) => (t.tool && opensDesignView(t.tool) ? <DesignOpenedNote /> : null)}
      designSlash={slash}
      userView={own ? (text) => designMessage(text, pinsOf, true) : undefined}
      sendText={own ? (text, images) => sendWithEdits(host, own.place, own.slug, id, text, images, peers) : undefined}
    />
  );
}
