// A session's Design tab (X65): its session design's canvas, with the same
// page tabs, toolbar, modes, bars and right rail as the design screen. Its
// chat is the session's own, beside it, which the tab neither folds nor
// opens; the file above the page is its path in the worktree.

import { useMemo, type RefObject } from "react";
import { ChevronDown, PenTool } from "lucide-react";
import type { Design, Session } from "../../lib/protocol";
import { commentsOf, sessionDesignsOf, showSessionDesign, shownSessionDesign, systemsOf, useDesign } from "../../lib/designStore";
import { projectOf, useStore } from "../../lib/store";
import { sendWithEdits } from "../../lib/designEditor";
import { designSystemFooter, opensDesignView, worktreeFile } from "../../lib/sessionDesign";
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
  return <SessionCanvas key={design.slug} host={host} ws={ws} design={design} />;
}

/** The canvas of the design a session's Design tab shows. */
function SessionCanvas({ host, ws, design }: { host: string; ws: Session; design: Design }) {
  const designs = useDesign((d) => sessionDesignsOf(d, host, ws.id));
  const workspace = ws.workspace_id ?? "";
  const { agent, systemName } = useDesignBasics(host, workspace, design);
  // One object per session, as the canvas's effects follow it.
  const place = useMemo(() => ({ session: ws.id }), [ws.id]);
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
      />
    </div>
  );
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
 *  it; after the agent made a session design, a note says the Design view
 *  opened. Its slash menu lists /moonlet-design's forms, naming the design
 *  system it will use once the workspace's are listed. */
export function SessionChat({ host, id, wsId, focused, visible }: { host: string; id: number; wsId: string; focused: boolean; visible: boolean }) {
  const design = useDesign((d) => shownSessionDesign(d, host, wsId));
  const own = design !== null && design.agent === id ? design : null;
  const place = useMemo(() => ({ session: wsId }), [wsId]);
  const comments = useDesign((d) => commentsOf(d, host, place, own?.slug ?? ""));
  const session = useStore((s) => s.sessions[host]?.find((x) => x.id === wsId));
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
      userView={own ? (text) => designMessage(text, comments, true) : undefined}
      sendText={own ? (text, images) => sendWithEdits(host, place, own.slug, id, text, images) : undefined}
    />
  );
}
