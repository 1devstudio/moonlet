// The Designs index (X65): every design of the workspace as a card with a
// thumbnail of its first page, in three groups: In sessions, Workspace
// designs and In projects. A thumbnail is framed only near the screen, as
// a design system's cards are; a project design's is read from its base
// branch's git objects, read only.

import { Loader2, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Design, DesignSystem } from "../../lib/protocol";
import { designsEmpty, shortAge } from "../../lib/design";
import { designsIndex, type CardAction, type IndexCard } from "../../lib/designsIndex";
import { designsOf, openNewDesign, openSessionDesign, pageRevReader, projectDesignsIn, sessionDesignsIn, showDesign, startFromProjectDesign, useDesign } from "../../lib/designStore";
import { viewportOf } from "../../lib/designViewport";
import { errorToast, useStore } from "../../lib/store";
import { NEAR_ROOT, useNear } from "../../lib/useNear";
import { useNow } from "../../lib/useNow";
import { useSize } from "../../lib/useSize";
import { workspaceProjects } from "../../lib/tasksStore";
import { Button } from "../ui";
import { CardFrame } from "./Frame";

const NO_DESIGNS: Design[] = [];

export function DesignsIndex({ host, workspace, name, systems, inset }: { host: string; workspace: string; name: string; systems: DesignSystem[] | undefined; inset: number }) {
  const own = useDesign((d) => designsOf(d, host, workspace));
  const inSessions = useDesign((d) => sessionDesignsIn(d, host, workspace)) ?? NO_DESIGNS;
  const inProjects = useDesign((d) => projectDesignsIn(d, host, workspace)) ?? NO_DESIGNS;
  const sessions = useStore((s) => s.sessions[host]);
  const projects = useStore(useShallow((s) => workspaceProjects(s, host, workspace)));
  const list = useMemo(() => (own ? [...inSessions, ...own, ...inProjects] : undefined), [own, inSessions, inProjects]);
  // A changed first page is framed again: its thumbnail's address carries its revision.
  const pageRevs = useDesign((d) => d.pageRevs);
  const groups = useMemo(
    () => designsIndex(list ?? [], { workspace, sessions: sessions ?? [], projects, systems: systems ?? [], pageRev: pageRevReader(pageRevs, host) }),
    [list, workspace, sessions, projects, systems, pageRevs, host],
  );
  const empty = designsEmpty(list, systems);
  const now = useNow(true);
  const [starting, setStarting] = useState<string | null>(null);
  // What each kind of card's button does.
  const acts: { [K in CardAction["kind"]]: (a: Extract<CardAction, { kind: K }>, key: string) => void } = {
    session: (a) => void openSessionDesign(host, workspace, a.session, a.slug, true),
    workspace: (a) => showDesign(host, workspace, a.slug),
    project: (a, key) => {
      setStarting(key);
      void startFromProjectDesign(host, workspace, a.design)
        .catch(errorToast)
        .finally(() => setStarting(null));
    },
  };
  const act = (c: IndexCard) => (acts[c.act.kind] as (a: CardAction, key: string) => void)(c.act, c.key);
  return (
    <section aria-label="Designs" className="flex min-h-0 flex-1 flex-col">
      <header data-tauri-drag-region className="drag flex h-[52px] shrink-0 items-center gap-2.5 border-b border-border bg-panel pr-4" style={{ paddingLeft: inset + 20 }}>
        <h1 className="ui-text-14 font-semibold text-fg">Designs</h1>
        <span className="truncate ui-text-12.5 text-muted">{name}</span>
        <span className="flex-1" />
        <Button size="sm" className="no-drag" disabled={!systems?.length} title={systems?.length ? undefined : "A design starts from a design system"} onClick={() => openNewDesign({ host, id: workspace })}>
          <Plus size={12} /> New design
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 pt-2" {...{ [NEAR_ROOT]: "" }}>
        {empty && <p className="py-10 text-center ui-text-13 text-muted">{empty}</p>}
        {groups.map((g) => (
          <section key={g.title} aria-label={g.title} className="mt-6">
            <h2 className="mb-3 flex items-baseline gap-3">
              <span className="ui-text-11.5 uppercase tracking-[0.08em] text-faint">{g.title}</span>
              <span className="ui-text-12.5 text-muted">{g.note}</span>
            </h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,300px))] gap-4">
              {g.cards.map((c) => (
                <IndexCardView key={c.key} card={c} now={now} busy={starting === c.key} onAct={() => act(c)} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function IndexCardView({ card, now, busy, onAct }: { card: IndexCard; now: number; busy: boolean; onAct: () => void }) {
  const [ref, [width]] = useSize<HTMLDivElement>();
  const near = useNear(ref);
  const viewport = viewportOf(card.design);
  const scale = width ? width / viewport[0] : 0;
  return (
    <article aria-label={card.name} className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-panel">
      <div ref={ref} className="relative w-full border-b border-border bg-bg" style={{ aspectRatio: `${viewport[0]} / ${viewport[1]}` }}>
        {card.thumb && scale > 0 && <CardFrame url={card.thumb} title={`${card.name} · first page`} viewport={viewport} scale={scale} live={near} />}
        {card.placeholder && <div className="absolute inset-0 flex items-center justify-center px-6 text-center ui-text-12 text-faint">{card.placeholder}</div>}
      </div>
      <div className="flex flex-col gap-1 px-3 pb-3 pt-2.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate ui-text-13.5 font-medium text-fg">{card.name}</span>
          {card.updated_at !== null && <span className="shrink-0 ui-text-11.5 text-faint">{shortAge(now - card.updated_at)}</span>}
        </div>
        <p className="ui-text-12.5 break-words text-muted">{card.line}</p>
        <button disabled={busy} onClick={onAct} className="mt-1 flex items-center gap-1.5 self-start ui-text-12.5 text-accent hover:underline disabled:opacity-60">
          {busy && <Loader2 size={12} className="spin" />}
          {card.act.label}
        </button>
      </div>
    </article>
  );
}
