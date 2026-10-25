// A workspace design's screen (X65): its agent's chat on the left, the
// canvas with its page tabs, viewport, zoom, mode, bar and the page in a
// sandboxed frame on a host of its own, with its comments pinned over it or
// its selection in Edit mode, and the right rail's Layers and Comments tabs.

import { ArrowRight, ChevronDown, LayoutGrid, Loader2, Lock, MessageSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, PanelRight, SwatchBook, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { errorToast, toast, updateSettings, useStore } from "../../lib/store";
import { chatKey, useChat } from "../../lib/chat";
import type { Design, DesignComment } from "../../lib/protocol";
import { briefShown, designSubtitle } from "../../lib/design";
import {
  addPageMid,
  askAgent,
  commentsOf,
  editComment,
  keepComment,
  latestOf,
  loadComments,
  midsOf,
  pageRevOf,
  problemsOf,
  reloadPage,
  removeDesign,
  resolveComment,
  saveViewport,
  sendComments,
  sendingOf,
  setPageMids,
  stopAgent,
  systemNameOf,
  systemsOf,
  useDesign,
} from "../../lib/designStore";
import { copyElementOf, dismissUnsaved, editPage, loadPageSource, pasteInto, pendingOf, redoEdit, sendWithEdits, undoEdit, undoOf, unsavedOf, useEditor } from "../../lib/designEditor";
import { EditRefused, editsChip, readEditsMessage, type EditOp } from "../../lib/designEdits";
import { pageUrl } from "../../lib/designView";
import { VIEWPORTS, canvasKey, canvasScale, canvasZoom, customViewports, fitBox, parseViewport, sizeOf, sizeText, viewportLabel, viewportText, withCustomViewport, type Size } from "../../lib/designViewport";
import { breadcrumb, canvasPage, canvasStep, isTyping, keyAct, layerStep, modeEntered, modeHint, writingPage, type CanvasAct, type CanvasMode, type CanvasState, type EditKey, type ModeKeyPress, type RailTab } from "../../lib/designCanvas";
import { chatCardLookup, commentCards, commentCardSelector, commentsTab, keepAction, openCommentsLabel, pageCounts, sendAll } from "../../lib/designComments";
import { bridgeMessage, editMessage, helloMessage, modeMessage, pinsMessage, scrollMessage, selectMessage, type Layer, type PickedElement, type Rect } from "../../lib/designBridge";
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
import { CommentBox, CommentCards, CommentsTab, PinLayer, type BoxTarget } from "./Comments";
import { Breadcrumb, EditsChip, EditsMessage, LayersTab } from "./Editor";

const NO_PINS: DesignComment[] = [];
const NO_LAYERS: Layer[] = [];

/** A key event as the canvas reads it. */
const pressOf = (e: KeyboardEvent, typing: boolean): ModeKeyPress => ({ key: e.key, code: e.code, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, typing });

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
  const [mode, setMode] = useState<CanvasMode>("view");
  const [railOpen, setRailOpen] = useState(false);
  const [railTab, setRailTab] = useState<RailTab>("comments");
  // Edit mode: the element selected on the shown page, and the page's tree.
  const [selected, setSelected] = useState<string | null>(null);
  const [layers, setLayers] = useState<Layer[]>(NO_LAYERS);
  // Talks to the shown page's bridge (PageFrame sets it).
  const bridge = useRef<((message: unknown) => void) | null>(null);
  const pending = useEditor((e) => pendingOf(e, host, workspace, design.slug));
  const unsaved = useEditor((e) => unsavedOf(e, host, workspace, design.slug));
  const canUndo = useEditor((e) => undoOf(e, host, workspace, design.slug).done.length > 0);
  // The comment box, pinned to an element of its page, shown with that page.
  const [box, setBox] = useState<(BoxTarget & { page: string }) | null>(null);
  const [canvasRef, [cw, ch]] = useSize<HTMLDivElement>();
  const comments = useDesign((d) => commentsOf(d, host, workspace, design.slug));
  const mids = useDesign((d) => midsOf(d, host, workspace, design.slug));
  const sending = useDesign((d) => sendingOf(d, host, workspace, design.slug));
  const chatRef = useRef<HTMLElement>(null);

  const names = design.pages.map((p) => p.name);
  // A page that went away shows the first one; before any, index (being written).
  const page = canvasPage(picked, names);
  const viewport = parseViewport(design.viewport) ?? DEFAULT_VIEWPORT;
  const scale = canvasScale(zoom, viewport, fitBox([cw, ch]));
  const writing = writingPage(lastWritten, working);
  const bar = designBar({ working, needsYou: design.needs_you, page, problems, system: systemName, systemRemoved: !!systems && !system, unsaved });
  const chip = editsChip(pending);

  useEffect(() => {
    void loadComments(host, workspace, design.slug).catch(() => {});
  }, [host, workspace, design.slug]);
  useEffect(() => setBox(null), [design.slug]);
  // Another page or design: nothing selected, and its tree comes with it.
  useEffect(() => {
    setSelected(null);
    setLayers(NO_LAYERS);
  }, [design.slug, page]);

  // C, Esc and the mode buttons, as canvasStep decides.
  // V, C, Esc and the mode buttons, as canvasStep decides; Edit is locked
  // while the agent works, and left when it starts.
  const canvas = useRef<CanvasState>({ mode, box: box !== null, rail: railOpen });
  canvas.current = { mode, box: box !== null, rail: railOpen };
  const workingRef = useRef(working);
  workingRef.current = working;
  const step = useCallback((act: CanvasAct) => {
    const before = canvas.current.mode;
    const next = canvasStep(canvas.current, act, workingRef.current);
    setMode(next.mode);
    setRailOpen(next.rail);
    if (!next.box) setBox(null);
    const entered = modeEntered(before, next.mode);
    if (entered.tab) setRailTab(entered.tab);
    if (entered.foldChat) setChatOpen(false);
    if (next.mode !== "edit") setSelected(null);
  }, []);
  useEffect(() => {
    if (working) step("lock");
  }, [working, step]);

  // The editor: the selection, and each edit by hand made on the page's
  // source, saved, and made on the live page too so it shows at once.
  // The page is told the selection once it is in Edit mode (PageFrame).
  const select = setSelected;
  const runEdit = (op: EditOp) => {
    if (page === null) return;
    try {
      const edit = editPage(host, workspace, design.slug, page, op, selected);
      if (edit.live) bridge.current?.(editMessage(edit.live));
      select(edit.select);
    } catch (e) {
      if (e instanceof EditRefused) toast(e.message, "info");
      else errorToast(e);
    }
  };
  const travel = (back: boolean) =>
    void (back ? undoEdit : redoEdit)(host, workspace, design.slug).then((to) => {
      if (!to) return;
      setPicked(to.page);
      select(to.select);
    }, errorToast);
  // A key on the canvas or in its page: true when it did something.
  const onKeyAct = (k: ReturnType<typeof keyAct>): boolean => {
    if (k === null) return false;
    if (k === "toggle" || k === "toggleEdit") {
      step(k);
      return true;
    }
    if (k === "escape") {
      // Esc selects the parent, and past the body nothing; else leaves the mode.
      if (mode === "edit" && selected) select(layerStep(layers, selected, "parent"));
      else step("escape");
      return true;
    }
    if (mode !== "edit" || page === null) return false;
    return editKey(k);
  };
  const editKey = (k: EditKey): boolean => {
    if (k === "undo" || k === "redo") {
      travel(k === "undo");
      return true;
    }
    if (k === "paste") {
      try {
        const edit = pasteInto(host, workspace, design.slug, page!, selected);
        if (!edit) return toast("Copy an element with ⌘C first", "info"), true;
        if (edit.live) bridge.current?.(editMessage(edit.live));
        select(edit.select);
      } catch (e) {
        if (e instanceof EditRefused) toast(e.message, "info");
        else errorToast(e);
      }
      return true;
    }
    if (!selected) return false;
    if (k === "next" || k === "prev") select(layerStep(layers, selected, k));
    else if (k === "copy") {
      if (copyElementOf(host, workspace, design.slug, page!, selected)) toast(`Copied ${selected}; ⌘V pastes it on any page of ${design.name}`, "info");
    } else runEdit({ kind: k, mid: selected });
    return true;
  };
  const keyRef = useRef(onKeyAct);
  keyRef.current = onKeyAct;
  // A text edited in place on the page; one the source cannot take is put
  // back by loading the page again.
  const onText = (mid: string, text: string) => {
    if (page === null) return;
    try {
      editPage(host, workspace, design.slug, page, { kind: "text", mid, text }, selected);
    } catch (e) {
      reloadPage(host, workspace, design.slug, page);
      if (e instanceof EditRefused) toast(e.message, "info");
      else errorToast(e);
    }
  };
  const textRef = useRef(onText);
  textRef.current = onText;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { dialog, confirm, settingsPage } = useStore.getState();
      if (dialog || confirm || settingsPage || e.metaKey) return;
      const typing = isTyping(e.target instanceof Element ? e.target : null);
      if (keyRef.current(keyAct(pressOf(e, typing)))) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
      claimKeys((id, e) => {
        const k = canvasKey(id);
        if (k === "fit") setZoom(null);
        else if (k === "in" || k === "out") setZoom(canvasZoom(scaleRef.current || 1, k === "in" ? 1 : -1));
        else if (k === "chat") setChatOpen((o) => !o);
        if (k !== null) return true;
        // The editor's ⌘ keys; ⌘C copies text selected anywhere as usual.
        const { dialog, confirm, settingsPage } = useStore.getState();
        if (dialog || confirm || settingsPage) return false;
        const typing = isTyping(e.target instanceof Element ? e.target : null) || (id === "cmd+c" && !(window.getSelection()?.isCollapsed ?? true));
        return keyRef.current(keyAct(pressOf(e, typing)));
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
  const sendPins = (pins: DesignComment[]) => {
    if (agent === null) return toast("The design's agent is not running", "error");
    void sendComments(host, workspace, design.slug, agent, pins).catch(errorToast);
  };
  const keep = async (target: BoxTarget & { page: string }, comment: string): Promise<DesignComment> => {
    const action = keepAction(target.pin, comment);
    if (action === "new" || !target.pin) return keepComment(host, workspace, design.slug, { page: target.page, ...target.element, comment });
    return action === "unchanged" ? target.pin : editComment(host, workspace, design.slug, target.pin.n, comment);
  };
  const onKeep = (comment: string) => {
    if (!box) return;
    const target = box;
    setBox(null);
    void keep(target, comment).catch(errorToast);
  };
  const onSend = (comment: string) => {
    if (!box || agent === null) return;
    const target = box;
    setBox(null);
    void keep(target, comment)
      .then((pin) => sendComments(host, workspace, design.slug, agent, [pin]))
      .catch(errorToast);
  };
  const onSendAll = () => {
    sendPins(sendAll(comments, mids));
  };
  // Show in chat: the chat opens, then scrolls to the pin's last card, once
  // its messages have loaded (chatCardLookup).
  const [shownPin, setShownPin] = useState<{ n: number; at: number } | null>(null);
  const chatLoaded = useChat((c) => agent !== null && !!c.chats[chatKey(host, agent)]);
  const showInChat = (pin: DesignComment) => {
    setChatOpen(true);
    setShownPin({ n: pin.n, at: Date.now() });
  };
  useEffect(() => {
    if (!shownPin || !chatOpen) return;
    let ringed: HTMLElement | null = null;
    let done: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      const cards = chatRef.current?.querySelectorAll<HTMLElement>(commentCardSelector(shownPin.n));
      const card = cards?.[cards.length - 1];
      const step = chatCardLookup({ found: !!card, loaded: chatLoaded, waitedMs: Date.now() - shownPin.at });
      if (step === "wait") return;
      clearInterval(again);
      if (!card) return toast("Its message is not in the chat any more", "info");
      card.scrollIntoView({ block: "center" });
      card.classList.add("ring-2", "ring-accent");
      ringed = card;
      done = setTimeout(() => card.classList.remove("ring-2", "ring-accent"), 1500);
    };
    const again = setInterval(look, 100);
    look();
    return () => {
      clearInterval(again);
      clearTimeout(done);
      ringed?.classList.remove("ring-2", "ring-accent");
    };
  }, [shownPin, chatOpen, chatLoaded]);
  // A pin picked in the rail: its page, with its box open.
  const openPin = (pin: DesignComment) => {
    if (!pin.page) return;
    setPicked(pin.page);
    setBox({ page: pin.page, element: { mid: pin.mid, tag: pin.tag, text: pin.text }, rect: { x: 0, y: 0, w: 0, h: 0 }, pin });
  };
  const onPick = useCallback(
    (el: PickedElement) => {
      if (mode === "edit") setSelected(el.mid);
      else setBox(page === null ? null : { page, element: { mid: el.mid, tag: el.tag, text: el.text }, rect: el.rect, pin: null });
    },
    [page, mode],
  );
  const onPage = useMemo(() => commentsTab(comments, { tab: "open", page }, mids), [comments, page, mids]);
  const pagePins = page === null ? NO_PINS : onPage.shown;

  const onBarAction = (a: BarAction) => {
    if (a === "stop" && agent !== null) void stopAgent(host, agent).catch(errorToast);
    else if (a === "details") setDetails(true);
    else if (a === "dismiss") dismissUnsaved(host, workspace, design.slug);
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
        <section ref={chatRef} aria-label={`Design · ${design.name}`} className="flex w-[360px] shrink-0 flex-col border-r border-border">
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
                userText={(text, first) => briefShown(text, design.brief, first)}
                userView={(text) => {
                  const edits = readEditsMessage(text);
                  if (edits) return <EditsMessage edits={edits.edits} text={edits.text} />;
                  const cards = commentCards(text, comments);
                  return cards && <CommentCards cards={cards} />;
                }}
                sendText={(text, images) => sendWithEdits(host, workspace, design.slug, agent, text, images)}
              />
            ) : (
              <p className="p-5 ui-text-13 text-muted">This design's agent is not running.</p>
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
          {chip && <EditsChip text={chip} />}
          <IconButton title="Undo (⌘Z)" className="ml-auto" disabled={!canUndo} onClick={() => travel(true)}>
            <Undo2 size={14} />
          </IconButton>
          <div role="group" aria-label="Canvas mode" className="flex h-7 items-center rounded-md border border-border-strong p-0.5">
            {(["view", "comment", "edit"] as const).map((m) => {
              const locked = m === "edit" && working;
              return (
                <button
                  key={m}
                  aria-pressed={mode === m}
                  disabled={locked}
                  title={locked ? "Edit opens when Claude stops" : m === "comment" ? "Comment (C)" : m === "edit" ? "Edit (V)" : "View"}
                  onClick={() => step(m)}
                  className={cx("flex h-full items-center gap-1.5 rounded px-2.5 disabled:text-faint", mode === m ? "bg-raised text-fg" : "text-muted hover:text-fg")}
                >
                  {m === "comment" ? "Comment" : m === "edit" ? "Edit" : "View"}
                  {m === "comment" && <kbd className="font-mono ui-text-11 text-faint">C</kbd>}
                  {m === "edit" && (locked ? <Lock size={11} aria-label="Locked while Claude works" /> : <kbd className="font-mono ui-text-11 text-faint">V</kbd>)}
                </button>
              );
            })}
          </div>
          <IconButton title="Right rail" aria-pressed={railOpen} onClick={() => setRailOpen((o) => !o)}>
            <PanelRight size={14} />
          </IconButton>
        </div>
        {bar && <BarView bar={bar} onAct={onBarAction} />}
        <div className="flex h-9 shrink-0 items-center gap-2 px-4 ui-text-12">
          {page === null ? (
            <span className="text-muted">Every page at the same viewport. Click a page to open it.</span>
          ) : mode === "edit" && selected && breadcrumb(layers, selected).length ? (
            <Breadcrumb path={breadcrumb(layers, selected)} hint={modeHint(mode)} onSelect={select} />
          ) : (
            <>
              <span className="font-mono text-fg">{pageFile(page)}</span>
              <span className="truncate text-faint">{names.includes(page) ? modeHint(mode) : "not written yet"}</span>
            </>
          )}
        </div>
        <div
          ref={canvasRef}
          {...{ [NEAR_ROOT]: "" }}
          className="flex min-h-0 flex-1 overflow-auto bg-bg [background-image:radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px]"
        >
          {page === null ? (
            <Overview host={host} workspace={workspace} design={design} viewport={viewport} counts={pageCounts(comments)} onOpen={setPicked} />
          ) : scale > 0 && names.includes(page) ? (
            <PageFrame
              host={host}
              workspace={workspace}
              design={design}
              page={page}
              viewport={viewport}
              scale={scale}
              mode={mode}
              selected={selected}
              bridge={bridge}
              onTree={setLayers}
              onSelected={setSelected}
              onText={(mid, text) => textRef.current(mid, text)}
              pins={pagePins}
              box={box?.page === page ? box : null}
              canSend={agent !== null}
              onPick={onPick}
              onOpenPin={openPin}
              onKey={(k) => keyRef.current(k)}
              onKeep={onKeep}
              onSend={onSend}
              onCloseBox={() => setBox(null)}
            />
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
      {railOpen && (
        <aside aria-label="Right rail" className="flex w-[300px] shrink-0 flex-col border-l border-border bg-panel">
          <div role="tablist" className="flex h-[52px] shrink-0 items-end gap-4 border-b border-border px-4">
            {(["layers", "comments"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={railTab === t}
                onClick={() => setRailTab(t)}
                className={cx("flex h-full items-center gap-1.5 border-b-2 ui-text-13", railTab === t ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg")}
              >
                {t === "layers" ? "Layers" : "Comments"}
                {t === "comments" && <span className="rounded bg-raised px-1 font-mono ui-text-11 text-muted">{onPage.open}</span>}
              </button>
            ))}
          </div>
          {railTab === "layers" ? (
            <LayersTab
              layers={page === null ? NO_LAYERS : layers}
              selected={selected}
              onSelect={(mid) => {
                if (canvas.current.mode !== "edit") step("edit");
                select(mid);
              }}
            />
          ) : (
          <CommentsTab
            pins={comments}
            mids={mids}
            pages={names}
            sending={sending}
            canSend={agent !== null}
            onSend={(p) => sendPins([p])}
            onSendAll={onSendAll}
            onResolve={(p) => void resolveComment(host, workspace, design.slug, p.n).catch(errorToast)}
            onShowInChat={showInChat}
            onPick={openPin}
          />
          )}
        </aside>
      )}
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
 *  scripts but never reaches the app, on a host of its own (X64, X65), with
 *  the comment bridge: the open pins of the page over it, and the comment
 *  box pinned to its element. Each load reports the page's data-mids, and is
 *  told the mode and the pins again, so the pins follow a reload; once it
 *  listens, the app asks for them too, in case the page reported first. */
function PageFrame({
  host,
  workspace,
  design,
  page,
  viewport,
  scale,
  mode,
  selected,
  bridge,
  onTree,
  onSelected,
  onText,
  pins,
  box,
  canSend,
  onPick,
  onOpenPin,
  onKey,
  onKeep,
  onSend,
  onCloseBox,
}: {
  host: string;
  workspace: string;
  design: Design;
  page: string;
  viewport: Size;
  scale: number;
  mode: CanvasMode;
  selected: string | null;
  /** Set to talk to the page's bridge. */
  bridge: MutableRefObject<((message: unknown) => void) | null>;
  onTree: (layers: Layer[]) => void;
  onSelected: (mid: string | null) => void;
  onText: (mid: string, text: string) => void;
  pins: DesignComment[];
  box: BoxTarget | null;
  canSend: boolean;
  onPick: (el: PickedElement) => void;
  onOpenPin: (pin: DesignComment) => void;
  onKey: (act: ReturnType<typeof keyAct>) => void;
  onKeep: (comment: string) => void;
  onSend: (comment: string) => void;
  onCloseBox: () => void;
}) {
  const rev = useDesign((d) => pageRevOf(d, host, workspace, design.slug, page));
  const frame = useRef<HTMLIFrameElement>(null);
  const [rects, setRects] = useState<Record<string, Rect>>({});
  // The elements whose boxes the page reports: the pins', and the open box's.
  const wanted = useMemo(() => [...pins.map((p) => p.mid), ...(box ? [box.element.mid] : [])], [pins, box]);
  const wantedKey = wanted.join(" ");
  const latest = useRef({ mode, wanted, selected, rev, onPick, onKey, onTree, onSelected, onText });
  latest.current = { mode, wanted, selected, rev, onPick, onKey, onTree, onSelected, onText };
  const tell = (message: unknown) => frame.current?.contentWindow?.postMessage(message, "*");
  bridge.current = tell;
  // Where the page was scrolled, and the load of it the bridge last
  // reported from: a reload comes back there, with the selection.
  const scrolled = useRef({ x: 0, y: 0 });
  const reported = useRef(-1);

  useEffect(() => {
    setRects({});
    scrolled.current = { x: 0, y: 0 };
  }, [page]);
  // The page's source for the editor, read as the frame loads it.
  useEffect(() => void loadPageSource(host, workspace, design.slug, page).catch(() => {}), [host, workspace, design.slug, page, rev]);
  useEffect(() => void tell(modeMessage(mode)), [mode]);
  useEffect(() => void tell(pinsMessage(wanted)), [wantedKey]);
  useEffect(() => {
    if (mode === "edit") tell(selectMessage(selected));
  }, [selected, mode]);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only this page's frame, and only a message the bridge sends.
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      const m = bridgeMessage(e.data);
      if (!m) return;
      if (m.type === "mids") {
        setPageMids(host, workspace, design.slug, page, m.mids);
        tell(modeMessage(latest.current.mode));
        tell(pinsMessage(latest.current.wanted));
        // The first report of a load: back where it was scrolled, with the
        // selection, as before the reload.
        if (reported.current !== latest.current.rev) {
          reported.current = latest.current.rev;
          if (scrolled.current.x || scrolled.current.y) tell(scrollMessage(scrolled.current.x, scrolled.current.y));
          if (latest.current.mode === "edit") tell(selectMessage(latest.current.selected));
        }
      } else if (m.type === "tree") latest.current.onTree(m.layers);
      else if (m.type === "scroll") scrolled.current = { x: m.x, y: m.y };
      else if (m.type === "selected") {
        if (m.mid !== latest.current.selected) latest.current.onSelected(m.mid);
      } else if (m.type === "text") latest.current.onText(m.mid, m.text);
      else if (m.type === "rects") setRects(Object.fromEntries(m.rects.map(({ mid, ...r }) => [mid, r])));
      else if (m.type === "pick") {
        addPageMid(host, workspace, design.slug, page, m.element.mid);
        latest.current.onPick(m.element);
      } else if (m.type === "key") {
        // A key pressed in the page, where the bridge already left out typing.
        latest.current.onKey(keyAct({ key: m.key, meta: m.meta, ctrl: false, alt: m.alt, shift: m.shift, typing: false }));
      }
    };
    window.addEventListener("message", onMessage);
    // The page may have reported its ids before this listened: ask again.
    tell(helloMessage());
    return () => window.removeEventListener("message", onMessage);
  }, [host, workspace, design.slug, page]);

  return (
    <div className="relative m-auto shrink-0 rounded-md border border-border-strong shadow-2xl">
      <CardFrame url={pageUrl(workspace, design.slug, page, rev, true)} title={pageFile(page)} viewport={viewport} scale={scale} interactive frameRef={frame} />
      <PinLayer pins={pins} rects={rects} scale={scale} size={[viewport[0] * scale, viewport[1] * scale]} open={box?.pin?.n ?? null} onOpen={onOpenPin} />
      {box && (
        <CommentBox
          key={box.pin ? `pin-${box.pin.n}` : `new-${box.element.mid}`}
          target={box}
          rect={rects[box.element.mid] ?? box.rect}
          scale={scale}
          size={[viewport[0] * scale, viewport[1] * scale]}
          canSend={canSend}
          onKeep={onKeep}
          onSend={onSend}
          onClose={onCloseBox}
        />
      )}
    </div>
  );
}

/** Overview: every page at the same viewport, each framed only near the screen. */
function Overview({ host, workspace, design, viewport, counts, onOpen }: { host: string; workspace: string; design: Design; viewport: Size; counts: Record<string, number>; onOpen: (page: string) => void }) {
  if (design.pages.length === 0) return <p className="m-auto ui-text-13 text-muted">No pages yet.</p>;
  return (
    <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(280px,1fr))] content-start gap-6 p-8">
      {design.pages.map((p) => (
        <OverviewTile key={p.name} host={host} workspace={workspace} design={design} page={p.name} label={p.label} comments={counts[p.name] ?? 0} viewport={viewport} onOpen={() => onOpen(p.name)} />
      ))}
    </div>
  );
}

function OverviewTile({
  host,
  workspace,
  design,
  page,
  label,
  comments,
  viewport,
  onOpen,
}: {
  host: string;
  workspace: string;
  design: Design;
  page: string;
  label: string | null;
  comments: number;
  viewport: Size;
  onOpen: () => void;
}) {
  const [ref, [width]] = useSize<HTMLDivElement>();
  const near = useNear(ref);
  const rev = useDesign((d) => pageRevOf(d, host, workspace, design.slug, page));
  const scale = width ? width / viewport[0] : 0;
  return (
    <button aria-label={pageFile(page)} onClick={onOpen} className="flex min-w-0 flex-col text-left">
      <span className="mb-2 flex w-full items-center gap-2 ui-text-12.5">
        <span className="font-mono text-fg">{pageFile(page)}</span>
        {label && <span className="truncate text-muted">{label}</span>}
        {comments > 0 && (
          <span title={openCommentsLabel(comments)} className="ml-auto flex shrink-0 items-center gap-1 text-muted">
            <MessageSquare size={12} /> {comments}
          </span>
        )}
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
  yellow: { box: "bg-[rgba(242,201,76,0.10)]", dot: "bg-[#f2c94c]" },
  grey: { box: "bg-panel-2", dot: "bg-idle" },
};

const BAR_ACTIONS: Record<BarAction, string> = { stop: "Stop", details: "Details", fix: "Ask the agent to fix", dismiss: "Dismiss" };

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
