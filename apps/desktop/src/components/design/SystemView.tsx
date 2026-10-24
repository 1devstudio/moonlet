// A design system's view and its card page (X64): the cards by group, each
// rendered in a sandboxed frame on the moonlet-design:// scheme, and one card
// with where it was made from, its check problems and its snippets.

import { ChevronLeft, Copy, RotateCw, ShieldAlert } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { errorToast, toast, useStore } from "../../lib/store";
import { rpc } from "../../lib/daemon";
import { M, type DesignCard, type DesignSystem } from "../../lib/protocol";
import type { RowLabel } from "../../lib/design";
import { cardGroups, cardUrl, changedBanner, fitScale, fixMessage, headerLine, variantsLabel, visibleCards } from "../../lib/designView";
import { cardsOf, loadCards, openCard, revOf, shownCard, useDesign } from "../../lib/designStore";
import { workspaceProjects } from "../../lib/tasksStore";
import { useNow } from "../../lib/useNow";
import { cx } from "../../lib/cx";
import { AgentIcon, Button } from "../ui";
import { AgentView } from "../AgentView";
import { useShallow } from "zustand/react/shallow";

const TONES: Record<RowLabel["tone"], string> = { attention: "text-blocked", changed: "text-accent", error: "text-error", muted: "text-faint" };

/** A card rendered at `scale`: its viewport, in a frame that may run its own
 *  scripts but never reach the app (no `allow-same-origin`). */
function CardFrame({ url, title, viewport, scale, interactive = false }: { url: string; title: string; viewport: [number, number]; scale: number; interactive?: boolean }) {
  const [w, h] = viewport;
  return (
    <div className="relative overflow-hidden" style={{ width: w * scale, height: h * scale }}>
      <iframe
        title={title}
        src={url}
        sandbox="allow-scripts"
        className={cx("absolute left-0 top-0 border-0 bg-transparent", !interactive && "pointer-events-none")}
        style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: "0 0" }}
      />
    </div>
  );
}

/** The width an element has, kept up to date. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function CardTile({ workspace, slug, rev, card, onOpen }: { workspace: string; slug: string; rev: number; card: DesignCard; onOpen: () => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const problems = card.problems.length;
  // At card scale: the tile's width, never larger than the card itself.
  const scale = width ? Math.min(width / card.viewport[0], 1) : 0;
  return (
    <button
      aria-label={card.name}
      onClick={onOpen}
      className={cx("flex min-w-0 flex-col overflow-hidden rounded-lg border bg-panel text-left hover:border-border-strong", problems ? "border-blocked/60" : "border-border")}
    >
      <div className="flex h-10 w-full shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="truncate ui-text-13 font-medium text-fg">{card.name}</span>
        <span className="truncate font-mono ui-text-11.5 text-faint">{variantsLabel(card)}</span>
        {problems > 0 && (
          <span title={`${problems} check problem${problems === 1 ? "" : "s"}`} className="ml-auto flex items-center gap-1 rounded bg-blocked/15 px-1.5 ui-text-11.5 text-blocked">
            <ShieldAlert size={11} /> {problems}
          </span>
        )}
      </div>
      <div ref={ref} className="max-h-[320px] w-full overflow-hidden">
        {scale > 0 && <CardFrame url={cardUrl(workspace, slug, card.path, rev)} title={card.name} viewport={card.viewport} scale={scale} />}
      </div>
    </button>
  );
}

/** A design system: its header, the sources-changed banner, its groups and cards, or one card's page; its agent's chat docked on the right. */
export function DesignSystemView({ host, workspace, sys, label, inset }: { host: string; workspace: string; sys: DesignSystem; label: RowLabel; inset: number }) {
  const listed = useDesign((d) => cardsOf(d, host, workspace, sys.slug));
  // A system that cannot be read shows its error, never cards listed before.
  const cards = sys.error ? undefined : listed;
  const open = useDesign((d) => shownCard(d, host, workspace, sys.slug));
  const rev = useDesign((d) => revOf(d, host, workspace, sys.slug));
  const projectList = useStore(useShallow((s) => workspaceProjects(s, host, workspace)));
  const projects = useMemo(() => projectList.map((p) => ({ path: p.path, name: p.name })), [projectList]);
  const agent = useStore((s) => (sys.agent !== null && s.terminals[host]?.[sys.agent]?.chat ? sys.agent : null));
  const [hidden, setHidden] = useState(false);
  const [group, setGroup] = useState("");
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const now = useNow(true);
  const local = host === "local";

  useEffect(() => {
    if (local) void loadCards(host, workspace, sys.slug).catch(errorToast);
  }, [host, workspace, sys.slug, local]);

  const card = open ? cards?.find((c) => c.path === open) : undefined;
  const problems = (cards ?? []).reduce((n, c) => n + c.problems.length, 0);
  const banner = cards ? changedBanner(sys, cards) : null;
  const groups = useMemo(() => cardGroups(cards ?? []), [cards]);
  const view = visibleCards(cards ?? [], { group, onlyProblems, onlyChanged });
  const shown = view.cards;
  const sync = () => void rpc(host, M.designSystemSync, { workspace, slug: sys.slug }).catch(errorToast);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {card ? (
          <CardPage host={host} workspace={workspace} sys={sys} rev={rev} card={card} agent={agent} inset={inset} />
        ) : (
          <>
            <header data-tauri-drag-region className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-border bg-panel pr-3" style={{ paddingLeft: inset + 20 }}>
              <div className="min-w-0 flex-1">
                <h1 className="truncate ui-text-14 font-semibold text-fg">{sys.name}</h1>
                <p className="truncate ui-text-12 text-muted">
                  {headerLine(sys, projects, cards?.length ?? 0, now)}
                  <span className={cx("ml-2", TONES[label.tone])}>{label.text}</span>
                </p>
              </div>
              {problems > 0 && (
                <button
                  aria-pressed={view.onlyProblems}
                  onClick={() => setOnlyProblems(!view.onlyProblems)}
                  className={cx("no-drag flex items-center gap-1.5 rounded-md border px-2 py-1 ui-text-12 text-blocked", view.onlyProblems ? "border-blocked bg-blocked/15" : "border-blocked/40 bg-blocked/10")}
                >
                  <ShieldAlert size={12} /> {problems} check problem{problems === 1 ? "" : "s"}
                </button>
              )}
              <Button size="sm" className="no-drag" onClick={sync}>
                <RotateCw size={12} /> Sync
              </Button>
              {agent !== null && hidden && (
                <Button size="sm" variant="ghost" className="no-drag" onClick={() => setHidden(false)}>
                  Show agent
                </Button>
              )}
            </header>
            {(sys.needs_you || sys.step || sys.error) && (
              <p className={cx("shrink-0 border-b border-border px-5 py-2 ui-text-12.5", sys.error ? "text-error" : sys.needs_you ? "text-blocked" : "text-muted")}>
                {sys.error ??
                  (sys.needs_you
                    ? `Claude ${sys.needs_you.kind === "question" ? "asks" : "needs your approval"}: ${sys.needs_you.text}`
                    : `${sys.step![0].toUpperCase()}${sys.step!.slice(1)}${sys.step_summary ? ` · ${sys.step_summary}` : ""}`)}
              </p>
            )}
            {banner && (
              <div className="flex shrink-0 items-center gap-2 border-b border-border bg-blocked/[0.06] px-5 py-2 ui-text-12.5 text-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-blocked" />
                <span className="min-w-0 flex-1">{banner}</span>
                <Button size="sm" variant="ghost" aria-pressed={view.onlyChanged} onClick={() => setOnlyChanged(!view.onlyChanged)}>
                  {view.onlyChanged ? "Show all cards" : "Show cards"}
                </Button>
              </div>
            )}
            {!local ? (
              <p className="p-6 ui-text-13 text-muted">Cards render on the Mac their design system is on. Open this workspace's Design mode there.</p>
            ) : (
              <div className="flex min-h-0 flex-1">
                <nav aria-label="Groups" className="w-[200px] shrink-0 overflow-y-auto border-r border-border p-2">
                  {groups.map((g) => (
                    <button
                      key={g.key}
                      aria-current={g.key === group ? "true" : undefined}
                      onClick={() => setGroup(g.key)}
                      className={cx("flex h-[30px] w-full items-center gap-2 rounded-md px-2.5 text-left ui-text-13", g.key === group ? "bg-raised text-fg" : "text-muted hover:bg-panel-2 hover:text-fg")}
                    >
                      <span className="min-w-0 flex-1 truncate">{g.name}</span>
                      {g.problem && <span aria-label="has a check problem" className="h-1.5 w-1.5 rounded-full bg-blocked" />}
                      <span className="tabular-nums ui-text-11.5 text-faint">{g.count}</span>
                    </button>
                  ))}
                </nav>
                <div className="min-w-0 flex-1 overflow-y-auto p-6">
                  {cards?.length === 0 && <p className="ui-text-13 text-muted">No cards yet. The sync agent writes them in the Cards step.</p>}
                  {groups
                    .slice(1)
                    .filter((g) => shown.some((c) => c.group === g.key))
                    .map((g) => (
                      <section key={g.key} aria-label={g.name} className="mb-8">
                        <h2 className="mb-3 ui-text-11.5 uppercase tracking-[0.08em] text-faint">{g.name}</h2>
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-4">
                          {shown
                            .filter((c) => c.group === g.key)
                            .map((c) => (
                              <CardTile key={c.path} workspace={workspace} slug={sys.slug} rev={rev} card={c} onOpen={() => openCard(host, workspace, sys.slug, c.path)} />
                            ))}
                        </div>
                      </section>
                    ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {agent !== null && !hidden && (
        <section aria-label={`Design · ${sys.name}`} className="flex w-[440px] shrink-0 flex-col border-l border-border">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 ui-text-12.5">
            <AgentIcon agent="claude" size={13} />
            <span className="min-w-0 flex-1 truncate text-muted">Writes only in systems/{sys.slug}</span>
            <Button size="sm" variant="ghost" onClick={() => setHidden(true)}>
              Hide agent
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <AgentView host={host} id={agent} wsId="" focused visible />
          </div>
        </section>
      )}
    </div>
  );
}

/** One card (X64): the card at its viewport and zoom, and where it was made
 *  from, its marker, its check problems and its snippets. */
function CardPage({ host, workspace, sys, rev, card, agent, inset }: { host: string; workspace: string; sys: DesignSystem; rev: number; card: DesignCard; agent: number | null; inset: number }) {
  const canvas = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<[number, number]>([0, 0]);
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const measure = () => setBox([el.clientWidth - 96, el.clientHeight - 96]);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  const scale = box[0] > 0 && box[1] > 0 ? fitScale(card.viewport, box) : 0;
  const [asking, setAsking] = useState(false);
  const askToFix = async () => {
    if (asking) return;
    setAsking(true);
    try {
      // With no agent chat, Sync starts one; the request follows its first message.
      const id = agent ?? (await rpc<{ agent: number }>(host, M.designSystemSync, { workspace, slug: sys.slug })).agent;
      await rpc(host, M.chatSend, { id, text: fixMessage(card), images: [] });
      toast("Asked the sync agent to fix it");
    } catch (e) {
      errorToast(e);
    } finally {
      setAsking(false);
    }
  };
  const copy = (id: string) => void navigator.clipboard.writeText(id).then(() => toast(`Copied ${id}`));
  const label = "mb-2 ui-text-11.5 uppercase tracking-[0.08em] text-faint";
  return (
    <>
      <header data-tauri-drag-region className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-border bg-panel pr-3" style={{ paddingLeft: inset + 12 }}>
        <button aria-label="Back to the design system" className="no-drag rounded p-1 text-muted hover:bg-panel-2 hover:text-fg" onClick={() => openCard(host, workspace, sys.slug, null)}>
          <ChevronLeft size={15} />
        </button>
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 ui-text-13">
          <span className="truncate text-muted">{sys.name}</span>
          <span className="text-faint">/</span>
          <span className="truncate text-muted">{card.group}</span>
          <span className="text-faint">/</span>
          <span className="truncate text-fg">{card.name}</span>
        </nav>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 ui-text-12">
            <span className="rounded-md border border-border-strong px-2 py-0.5 text-fg">
              Card viewport <span className="font-mono text-faint">{`${card.viewport[0]}×${card.viewport[1]}`}</span>
            </span>
            <span className="font-mono text-faint">{scale ? `${Math.round(scale * 100)}%` : ""}</span>
          </div>
          <div ref={canvas} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-bg [background-image:radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px]">
            {scale > 0 && (
              <div className="rounded-md border border-border-strong shadow-2xl">
                <CardFrame url={cardUrl(workspace, sys.slug, card.path, rev)} title={card.name} viewport={card.viewport} scale={scale} interactive />
              </div>
            )}
          </div>
        </div>
        <aside aria-label="Card" className="w-[300px] shrink-0 overflow-y-auto border-l border-border">
          <section className="border-b border-border p-4">
            <h3 className={label}>Made from</h3>
            {card.source.length === 0 && <p className="ui-text-12.5 text-faint">No source: made by moonlet or by hand.</p>}
            {card.source.map((s) => (
              <p key={s} className="truncate font-mono ui-text-12 text-fg" title={s}>
                {s}
              </p>
            ))}
            {card.changed_sources.length > 0 && (
              <p className="mt-2 flex items-center gap-1.5 ui-text-12 text-blocked">
                <span className="h-1.5 w-1.5 rounded-full bg-blocked" /> Changed since the sync{sys.synced_commit ? ` at ${sys.synced_commit}` : ""}
              </p>
            )}
            <pre className="selectable mt-3 whitespace-pre-wrap break-all rounded-md bg-panel-2 p-2.5 font-mono ui-text-11 text-muted">{card.marker}</pre>
          </section>
          <section className="border-b border-border p-4">
            <h3 className={label}>
              Check <span className={card.problems.length ? "text-blocked" : "text-faint"}>{card.problems.length}</span>
            </h3>
            {card.problems.length === 0 && <p className="ui-text-12.5 text-faint">No problems.</p>}
            {card.problems.map((p) => (
              <div key={`${p.line}-${p.message}`} className="mb-2 rounded-md border border-blocked/40 bg-blocked/[0.06] p-2.5">
                <p className="font-mono ui-text-11.5 text-faint">
                  line {p.line} · {p.kind.replace(/_/g, " ")}
                </p>
                <p className="selectable mt-1 ui-text-12.5 text-fg">{p.message}</p>
              </div>
            ))}
            {card.problems.length > 0 && (
              <Button size="sm" className="w-full justify-center" disabled={asking} onClick={() => void askToFix()}>
                Ask the sync agent to fix
              </Button>
            )}
          </section>
          <section className="p-4">
            <h3 className={label}>Snippets</h3>
            {card.snippets.length === 0 && <p className="ui-text-12.5 text-faint">None.</p>}
            {card.snippets.map((id) => (
              <div key={id} className="flex h-8 items-center gap-2">
                <span className="selectable min-w-0 flex-1 truncate font-mono ui-text-12 text-fg">{id}</span>
                <button aria-label={`Copy ${id}`} title="Copy" className="rounded p-1 text-faint hover:bg-panel-2 hover:text-fg" onClick={() => copy(id)}>
                  <Copy size={13} />
                </button>
              </div>
            ))}
          </section>
        </aside>
      </div>
    </>
  );
}
