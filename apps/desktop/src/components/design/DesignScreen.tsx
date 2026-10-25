// A workspace design's screen (X65): its agent's chat on the left, and the
// canvas with its page tabs, viewport, zoom, bar and the page in a sandboxed
// frame on a host of its own.

import { ArrowRight, ChevronDown, LayoutGrid, Loader2, MoreHorizontal, PanelLeftClose, PanelLeftOpen, SwatchBook, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { errorToast, toast, updateSettings, useStore } from "../../lib/store";
import type { Design } from "../../lib/protocol";
import { briefShown, designSubtitle } from "../../lib/design";
import { askAgent, latestOf, pageRevOf, problemsOf, removeDesign, saveViewport, stopAgent, systemNameOf, systemsOf, useDesign } from "../../lib/designStore";
import { pageUrl } from "../../lib/designView";
import { VIEWPORTS, canvasKey, canvasScale, canvasZoom, customViewports, fitBox, parseViewport, sizeOf, sizeText, viewportLabel, viewportText, withCustomViewport, type Size } from "../../lib/designViewport";
import { canvasPage, writingPage } from "../../lib/designCanvas";
import { pageFile, pagePath } from "../../lib/designPage";
import { barProblems, chatOpensOn, designBar, pageFixMessage, type Bar, type BarAction, type PageProblem } from "../../lib/designBars";
import { claimKeys } from "../../lib/keys";
import { askConfirm } from "../../lib/confirm";
import { NEAR_ROOT, useNear } from "../../lib/useNear";
import { cx } from "../../lib/cx";
import { AgentIcon, Button, Dialog, Field, IconButton, inputCls } from "../ui";
import { Menu } from "../Menu";
import { AgentView } from "../AgentView";
import { useSize } from "../../lib/useSize";
import { CardFrame, ZoomBar } from "./Frame";

/** A design's viewport until it has one: Desktop. */
const DEFAULT_VIEWPORT = VIEWPORTS[0].size;

/** The design screen of `design`, in workspace `workspace` of `host`. */
export function DesignScreen({ host, workspace, design, inset }: { host: string; workspace: string; design: Design; inset: number }) {
  const systems = useDesign((d) => systemsOf(d, host, workspace));
  const system = systems?.find((s) => s.slug === design.system);
  // Its name, also once it was removed; its slug when never listed.
  const systemName = useDesign((d) => systemNameOf(d, host, workspace, design.system)) ?? design.system;
  const agent = useStore((s) => (design.agent !== null && s.terminals[host]?.[design.agent]?.chat ? design.agent : null));
  const working = useStore((s) => agent !== null && s.terminals[host]?.[agent]?.agent_state === "working" && !s.terminals[host]?.[agent]?.exit);
  const lastWritten = useDesign((d) => latestOf(d, host, workspace, design.slug));
  const problems = useDesign((d) => problemsOf(d, host, workspace, design.slug));
  const [chatOpen, setChatOpen] = useState(true);
  // The page shown, or null for Overview.
  const [picked, setPicked] = useState<string | null>("index");
  const [zoom, setZoom] = useState<number | null>(null);
  const [details, setDetails] = useState(false);
  const [custom, setCustom] = useState(false);
  const [canvasRef, [cw, ch]] = useSize<HTMLDivElement>();

  const names = design.pages.map((p) => p.name);
  // A page that went away shows the first one; before any, index (being written).
  const page = canvasPage(picked, names);
  const viewport = parseViewport(design.viewport) ?? DEFAULT_VIEWPORT;
  const scale = canvasScale(zoom, viewport, fitBox([cw, ch]));
  const writing = writingPage(lastWritten, working);
  const bar = designBar({ working, needsYou: design.needs_you, page, problems, system: systemName, systemRemoved: !!systems && !system });

  // The chat opens when the agent starts to ask; folded meanwhile, it stays so.
  const asked = useRef(design.needs_you);
  useEffect(() => {
    if (chatOpensOn(asked.current, design.needs_you)) setChatOpen(true);
    asked.current = design.needs_you;
  }, [design.needs_you]);

  // ⌘0 fits, ⌘= and ⌘- zoom, ⌘\ folds the chat, while this screen is shown.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  useEffect(
    () =>
      claimKeys((id) => {
        const k = canvasKey(id);
        if (k === "fit") setZoom(null);
        else if (k === "in" || k === "out") setZoom(canvasZoom(scaleRef.current || 1, k === "in" ? 1 : -1));
        else if (k === "chat") setChatOpen((o) => !o);
        return k !== null;
      }),
    [],
  );

  const setViewport = (size: Size) => {
    setZoom(null);
    void saveViewport(host, workspace, design.slug, viewportText(size)).catch(errorToast);
  };
  const remove = async () => {
    const ok = await askConfirm({ title: `Remove ${design.name}?`, message: `Its folder, designs/${design.slug}, its pages and its agent's chat are deleted.`, action: "Remove", variant: "danger" });
    if (ok) void removeDesign(host, workspace, design.slug).catch(errorToast);
  };
  const onBarAction = (a: BarAction) => {
    if (a === "stop" && agent !== null) void stopAgent(host, agent).catch(errorToast);
    else if (a === "details") setDetails(true);
    else if (a === "fix") {
      const check = barProblems(page, problems);
      if (!check) return;
      if (agent === null) return toast("The design's agent is not running", "error");
      void askAgent(host, agent, pageFixMessage(check.page, check.problems)).then(() => toast("Asked the agent to fix it"), errorToast);
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      {chatOpen ? (
        <section aria-label={`Design · ${design.name}`} className="flex w-[360px] shrink-0 flex-col border-r border-border">
          <header data-tauri-drag-region className="drag flex h-[52px] shrink-0 items-center gap-1.5 border-b border-border bg-panel pr-2" style={{ paddingLeft: inset + 16 }}>
            <div className="min-w-0 flex-1">
              <h1 className="truncate ui-text-14 font-semibold text-fg">{design.name}</h1>
              <p className="truncate ui-text-12 text-muted">{designSubtitle(systemName, design.pages.length)}</p>
            </div>
            <span title="Build it comes with a later entry of Design mode: it starts a session with this design attached" className="no-drag">
              <Button size="sm" disabled>
                Build it <ArrowRight size={12} />
              </Button>
            </span>
            <Menu
              align="right"
              trigger={(open) => (
                <IconButton title="More" className="no-drag" onClick={open}>
                  <MoreHorizontal size={14} />
                </IconButton>
              )}
              items={[{ label: "Remove design…", icon: <Trash2 size={14} />, danger: true, onSelect: () => void remove() }]}
            />
            <IconButton title="Hide chat (⌘\)" className="no-drag" onClick={() => setChatOpen(false)}>
              <PanelLeftClose size={14} />
            </IconButton>
          </header>
          <div className="min-h-0 flex-1">
            {agent !== null ? (
              <AgentView
                host={host}
                id={agent}
                wsId=""
                focused
                visible
                lead={
                  <p className="mb-3 flex items-start gap-2 rounded-lg border border-border px-3 py-2 ui-text-12.5 text-muted">
                    <SwatchBook size={13} className="mt-0.5 shrink-0" /> The brief went with the design system's README.md and the design rules.
                  </p>
                }
                userText={(text) => briefShown(text, design.brief)}
              />
            ) : (
              <p className="p-5 ui-text-13 text-muted">This design's agent is not running. Remove the design and make it again to start one.</p>
            )}
          </div>
        </section>
      ) : (
        <div className="flex w-11 shrink-0 flex-col items-center gap-2 border-r border-border" style={{ paddingTop: inset ? 60 : 14 }}>
          <IconButton title="Show chat (⌘\)" onClick={() => setChatOpen(true)}>
            <PanelLeftOpen size={14} />
          </IconButton>
          <AgentIcon agent="claude" size={14} />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div data-tauri-drag-region className="drag flex h-[52px] shrink-0 items-center gap-1 border-b border-border bg-panel px-3" style={{ paddingLeft: chatOpen ? 12 : inset + 12 }}>
          <nav aria-label="Pages" className="no-drag flex min-w-0 items-center gap-0.5 overflow-x-auto">
            {(names.length ? names : ["index"]).map((name) => (
              <button
                key={name}
                aria-current={page === name ? "page" : undefined}
                onClick={() => setPicked(name)}
                className={cx("flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 ui-text-13", page === name ? "bg-raised text-fg" : "text-muted hover:bg-panel-2 hover:text-fg")}
              >
                {!names.includes(name) && <Loader2 size={11} className="animate-spin" />}
                {name}
                {writing === name && <span aria-label="Claude is writing it" className="h-1.5 w-1.5 rounded-full bg-accent" />}
              </button>
            ))}
            <span className="mx-1.5 h-4 w-px bg-border" />
            <button
              aria-current={page === null ? "page" : undefined}
              onClick={() => setPicked(null)}
              className={cx("flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 ui-text-13", page === null ? "bg-raised text-fg" : "text-muted hover:bg-panel-2 hover:text-fg")}
            >
              <LayoutGrid size={13} /> Overview
            </button>
          </nav>
        </div>
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 ui-text-12">
          <ViewportMenu viewport={viewport} onPick={setViewport} onCustom={() => setCustom(true)} />
          <ZoomBar scale={scale} fitted={zoom === null} max={2} keys onZoom={setZoom} />
        </div>
        {bar && <BarView bar={bar} onAct={onBarAction} />}
        <div className="flex h-9 shrink-0 items-center gap-2 px-4 ui-text-12">
          {page === null ? (
            <span className="text-muted">Every page at the same viewport. Click a page to open it.</span>
          ) : (
            <>
              <span className="font-mono text-fg">{pageFile(page)}</span>
              <span className="truncate text-faint">
                {names.includes(page) ? "View: the page runs as in a browser, so its links, menus and scripts work" : "not written yet"}
              </span>
            </>
          )}
        </div>
        <div
          ref={canvasRef}
          {...{ [NEAR_ROOT]: "" }}
          className="flex min-h-0 flex-1 overflow-auto bg-bg [background-image:radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px]"
        >
          {page === null ? (
            <Overview host={host} workspace={workspace} design={design} viewport={viewport} onOpen={setPicked} />
          ) : scale > 0 && names.includes(page) ? (
            <PageFrame host={host} workspace={workspace} design={design} page={page} viewport={viewport} scale={scale} />
          ) : (
            scale > 0 && (
              <div className="m-auto flex shrink-0 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border-strong p-6 text-center" style={{ width: viewport[0] * scale, height: viewport[1] * scale }}>
                <Loader2 size={16} className="animate-spin text-muted" />
                <p className="ui-text-13 text-fg">Claude is writing {pageFile(page)}</p>
                <p className="max-w-sm ui-text-12 text-muted">The canvas shows it as soon as the file is saved, and reloads on every change</p>
              </div>
            )
          )}
        </div>
      </div>
      {details && <DetailsDialog page={page} problems={problems} onClose={() => setDetails(false)} />}
      {custom && (
        <CustomViewport
          viewport={viewport}
          onClose={() => setCustom(false)}
          onApply={(size) => {
            setCustom(false);
            // The user's custom sizes are kept in the app's settings, for every design.
            updateSettings({ designViewports: withCustomViewport(useStore.getState().settings.designViewports, size) });
            setViewport(size);
          }}
        />
      )}
    </div>
  );
}

/** The shown page at the viewport, at `scale`, in a frame that runs its own
 *  scripts but never reaches the app, on a host of its own (X64, X65). */
function PageFrame({ host, workspace, design, page, viewport, scale }: { host: string; workspace: string; design: Design; page: string; viewport: Size; scale: number }) {
  const rev = useDesign((d) => pageRevOf(d, host, workspace, design.slug, page));
  return (
    <div className="m-auto shrink-0 rounded-md border border-border-strong shadow-2xl">
      <CardFrame url={pageUrl(workspace, design.slug, page, rev)} title={pageFile(page)} viewport={viewport} scale={scale} interactive />
    </div>
  );
}

/** Overview: every page at the same viewport, each framed only near the screen. */
function Overview({ host, workspace, design, viewport, onOpen }: { host: string; workspace: string; design: Design; viewport: Size; onOpen: (page: string) => void }) {
  if (design.pages.length === 0) return <p className="m-auto ui-text-13 text-muted">No pages yet.</p>;
  return (
    <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(280px,1fr))] content-start gap-6 p-8">
      {design.pages.map((p) => (
        <OverviewTile key={p.name} host={host} workspace={workspace} design={design} page={p.name} label={p.label} viewport={viewport} onOpen={() => onOpen(p.name)} />
      ))}
    </div>
  );
}

function OverviewTile({ host, workspace, design, page, label, viewport, onOpen }: { host: string; workspace: string; design: Design; page: string; label: string | null; viewport: Size; onOpen: () => void }) {
  const [ref, [width]] = useSize<HTMLDivElement>();
  const near = useNear(ref);
  const rev = useDesign((d) => pageRevOf(d, host, workspace, design.slug, page));
  const scale = width ? width / viewport[0] : 0;
  return (
    <button aria-label={pageFile(page)} onClick={onOpen} className="flex min-w-0 flex-col text-left">
      <span className="mb-2 flex w-full items-center gap-2 ui-text-12.5">
        <span className="font-mono text-fg">{pageFile(page)}</span>
        {label && <span className="truncate text-muted">{label}</span>}
        {/* Each page's open comments come with comments (entry 8). */}
      </span>
      <div ref={ref} className="w-full overflow-hidden rounded-md border border-border-strong hover:border-accent">
        {scale > 0 && <CardFrame url={pageUrl(workspace, design.slug, page, rev)} title={pageFile(page)} viewport={viewport} scale={scale} live={near} />}
      </div>
    </button>
  );
}

const BAR_TONES: Record<Bar["tone"], { box: string; dot: string }> = {
  orange: { box: "bg-accent/[0.08]", dot: "bg-accent" },
  red: { box: "bg-error/[0.08]", dot: "bg-error" },
  grey: { box: "bg-panel-2", dot: "bg-idle" },
};

const BAR_ACTIONS: Record<BarAction, string> = { stop: "Stop", details: "Details", fix: "Ask the agent to fix" };

function BarView({ bar, onAct }: { bar: Bar; onAct: (a: BarAction) => void }) {
  const tone = BAR_TONES[bar.tone];
  return (
    <div role="status" data-tone={bar.tone} className={cx("flex min-h-10 shrink-0 items-center gap-2.5 border-b border-border px-4 py-1.5 ui-text-12.5", tone.box)}>
      <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", tone.dot)} />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-fg">{bar.text}</span>
        {bar.detail && (
          <>
            {" "}
            <span className="ml-1 font-mono ui-text-12 text-muted">{bar.detail}</span>
          </>
        )}
      </span>
      {bar.actions.map((a) => (
        <Button key={a} size="sm" variant={a === "details" ? "ghost" : "subtle"} onClick={() => onAct(a)}>
          {BAR_ACTIONS[a]}
        </Button>
      ))}
    </div>
  );
}

function ViewportMenu({ viewport, onPick, onCustom }: { viewport: Size; onPick: (size: Size) => void; onCustom: () => void }) {
  const label = viewportLabel(viewport);
  const saved = useStore((s) => s.settings.designViewports);
  const customs = useMemo(() => customViewports(saved), [saved]);
  const current = viewportText(viewport);
  return (
    <Menu
      trigger={(open) => (
        <button aria-label="Viewport" onClick={open} className="flex h-7 items-center gap-1.5 rounded-md border border-border-strong px-2 text-fg hover:bg-panel-2">
          {label.name} <span className="font-mono text-faint">{label.size}</span>
          <ChevronDown size={12} className="text-faint" />
        </button>
      )}
      items={[
        ...VIEWPORTS.map((v) => ({ label: v.name, hint: sizeText(v.size), checked: viewportText(v.size) === current, onSelect: () => onPick(v.size) })),
        { kind: "divider" as const },
        ...customs.map((size) => ({ label: "Custom", hint: sizeText(size), checked: viewportText(size) === current, onSelect: () => onPick(size) })),
        { label: "Custom size…", onSelect: onCustom },
      ]}
    />
  );
}

function CustomViewport({ viewport, onClose, onApply }: { viewport: Size; onClose: () => void; onApply: (size: Size) => void }) {
  const [w, setW] = useState(String(viewport[0]));
  const [h, setH] = useState(String(viewport[1]));
  const size = sizeOf(w, h);
  return (
    <Dialog
      title="Custom viewport"
      width={340}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!size} onClick={() => size && onApply(size)}>
            Use this size
          </Button>
        </>
      }
    >
      <div className="flex items-end gap-2">
        <Field label="Width">
          <input autoFocus aria-label="Width" className={inputCls} value={w} inputMode="numeric" onChange={(e) => setW(e.target.value.trim())} onKeyDown={(e) => e.key === "Enter" && size && onApply(size)} />
        </Field>
        <span className="mb-4 text-faint">×</span>
        <Field label="Height">
          <input aria-label="Height" className={inputCls} value={h} inputMode="numeric" onChange={(e) => setH(e.target.value.trim())} onKeyDown={(e) => e.key === "Enter" && size && onApply(size)} />
        </Field>
      </div>
    </Dialog>
  );
}

function DetailsDialog({ page, problems, onClose }: { page: string | null; problems: PageProblem[]; onClose: () => void }) {
  const check = barProblems(page, problems);
  return (
    <Dialog title="Check problems" width={560} onClose={onClose}>
      {check ? (
        <>
          <p className="mb-3 font-mono ui-text-12.5 text-fg">{pagePath(check.page)}</p>
          {check.problems.map((p) => (
            <div key={`${p.line}-${p.message}`} className="mb-2 rounded-md border border-error/40 bg-error/[0.06] p-2.5">
              <p className="font-mono ui-text-11.5 text-faint">
                line {p.line} · {p.kind.replace(/_/g, " ")}
              </p>
              <p className="selectable mt-1 ui-text-12.5 text-fg">{p.message}</p>
            </div>
          ))}
        </>
      ) : (
        <p className="ui-text-13 text-muted">No problems.</p>
      )}
    </Dialog>
  );
}
