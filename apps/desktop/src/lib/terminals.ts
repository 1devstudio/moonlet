// xterm.js instances live outside React so switching tabs or sessions
// never re-attaches or loses scrollback. A terminal renders with WebGL
// only while it is on screen (WebKit caps live WebGL contexts), and falls
// back to the DOM renderer if WebGL is unavailable (T1).

import { Terminal, type IDisposable, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import { registerSink, rpc, sendInput } from "./daemon";
import { M } from "./protocol";

export interface TermSettings {
  fontFamily: string;
  fontSize: number;
  optionIsMeta: boolean;
  allowOsc52: boolean;
  webgl: boolean;
  /** New shells keep their own prompt instead of Warp mode (T7). */
  classicPrompt: boolean;
}

export const defaultTermSettings: TermSettings = {
  fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Monaco, monospace',
  fontSize: 13,
  optionIsMeta: true,
  allowOsc52: false,
  classicPrompt: false,
  webgl: true,
};

/** How much the structured agent view scales its text: the terminal font
 * size relative to the default, so both views follow one setting (X6). */
export function chatScale(fontSize: number): number {
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize / defaultTermSettings.fontSize : 1;
}

const THEME = {
  background: "#121212",
  foreground: "#e2e2e2",
  cursor: "#d0d0d0",
  cursorAccent: "#121212",
  selectionBackground: "#d9775740",
  // Same quiet slider as the rest of the app's scrollbars (jaunt.css).
  scrollbarSliderBackground: "#2a2a2a",
  scrollbarSliderHoverBackground: "#3a3a3a",
  scrollbarSliderActiveBackground: "#4a4a4a",
  black: "#1c1f26",
  red: "#ef6b73",
  green: "#8fd18e",
  yellow: "#e8c46b",
  blue: "#7aa7ff",
  magenta: "#c49bff",
  cyan: "#6fd3e0",
  white: "#c8ccd4",
  brightBlack: "#5c6370",
  brightRed: "#ff8a91",
  brightGreen: "#a6e3a1",
  brightYellow: "#f5d58a",
  brightBlue: "#9cbcff",
  brightMagenta: "#d6b8ff",
  brightCyan: "#94e2ec",
  brightWhite: "#f2f4f8",
};

/** One OSC 133 command block: prompt, command and output (T3, T4). */
export interface CommandBlock {
  prompt: IMarker;
  output?: IMarker;
  end?: IMarker;
  exit?: number;
  command?: string;
  /** Working directory at the `C` mark (OSC 7). */
  cwd?: string;
  /** App clock at the `C` and `D` marks; absent for replayed blocks. */
  startedAt?: number;
  endedAt?: number;
  header?: IDisposable;
}

/** Where a block's header comes from: the user's home and the session. */
export interface BlockContext {
  home: string | null;
  worktree?: string;
  branch?: string;
}

/** `~`-shortens a path under `home`. */
export function shortPath(p: string, home: string | null): string {
  if (home && (p === home || p.startsWith(home + "/"))) return "~" + p.slice(home.length);
  return p;
}

function duration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(3)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** The grey line above a command (T8): `~/src/app git:(main) (0.053s)`,
 * with `exit 1` before the duration when the command failed. */
export function blockHeader(
  b: { cwd?: string; exit?: number; startedAt?: number; endedAt?: number; end?: unknown },
  ctx: BlockContext,
): { place: string; exit: string | null; duration: string | null; running: boolean } {
  const cwd = b.cwd ?? "";
  const inside = !!ctx.worktree && (cwd === ctx.worktree || cwd.startsWith(ctx.worktree + "/"));
  const place = shortPath(cwd, ctx.home) + (inside && ctx.branch ? ` git:(${ctx.branch})` : "");
  const timed = !!b.end && b.startedAt !== undefined && b.endedAt !== undefined;
  return {
    place,
    exit: b.end && b.exit ? `exit ${b.exit}` : null,
    duration: timed ? `(${duration(b.endedAt! - b.startedAt!)})` : null,
    running: !b.end,
  };
}

/** Background rectangles, in viewport rows, for the blocks on screen (T8).
 * A block spans from its header row up to the row of its end mark. */
export function blockRects(
  blocks: readonly { start: number; end?: number; exit?: number }[],
  top: number,
  rows: number,
): { top: number; height: number; kind: "failed" }[] {
  const out: { top: number; height: number; kind: "failed" }[] = [];
  for (const b of blocks) {
    if (b.end === undefined || !b.exit) continue;
    const from = Math.max(b.start, top);
    const to = Math.min(b.end, top + rows);
    if (to > from) out.push({ top: from - top, height: to - from, kind: "failed" });
  }
  return out;
}

export interface FileLinkHandler {
  (path: string, line?: number): void;
}

const PATH_RE = /(?:^|[\s"'`(\[])((?:~|\.{1,2})?\/?(?:[\w.@-]+\/)*[\w@-][\w.@-]*\.[A-Za-z0-9]{1,8})(?::(\d+))?(?::\d+)?/g;

export class TermEntry {
  readonly term: Terminal;
  readonly el: HTMLDivElement;
  private fit = new FitAddon();
  readonly search = new SearchAddon();
  private webgl: WebglAddon | null = null;
  private ready = false;
  private parent: HTMLElement | null = null;
  private resizeObs: ResizeObserver | null = null;
  private resizeTimer = 0;
  private lastSize = "";
  private disposables: IDisposable[] = [];
  private unregister: () => void;
  blocks: CommandBlock[] = [];
  cwd = "";
  /** The shell draws no prompt; the app's editor is the input (T7). */
  warp = false;
  private replaying = false;
  private disposed = false;
  onTitle?: (title: string) => void;
  onFileLink?: FileLinkHandler;
  /** Set while the input editor is shown: printable keys typed into the
   * terminal go there instead (T6). */
  redirect?: (ch: string) => void;
  /** Home and session for block headers (T8). */
  context: BlockContext = { home: null };
  /** Block backgrounds drawn over the grid (T8); xterm decorations vanish
   * once their first row leaves the viewport. */
  private backdrop = document.createElement("div");

  constructor(
    readonly host: string,
    readonly session: number,
    private settings: TermSettings,
  ) {
    this.el = document.createElement("div");
    this.el.className = "jaunt-term";
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: 1.15,
      cursorBlink: true,
      macOptionIsMeta: settings.optionIsMeta,
      macOptionClickForcesSelection: true,
      // Same depth as the daemon, so in-view search finds what it keeps.
      scrollback: 10_000,
      theme: THEME,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 1,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = "11";
    this.term.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri)));
    this.term.open(this.el);
    this.backdrop.className = "jaunt-block-backdrop";
    this.term.element?.querySelector(".xterm-screen")?.appendChild(this.backdrop);

    // Cmd shortcuts belong to the app; xterm never sees them, so they can
    // never leak into an agent's input (T2). Native copy/paste still work.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.metaKey) return false;
      if (this.redirect && e.type === "keydown" && e.key.length === 1 && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        this.redirect(e.key);
        return false;
      }
      return true;
    });

    this.disposables.push(
      this.term.onData((d) => void sendInput(host, session, d)),
      this.term.onBinary((d) => void sendInput(host, session, d)),
      this.term.onResize(({ cols, rows }) => this.sendResize(cols, rows)),
      this.term.onTitleChange((t) => this.onTitle?.(t)),
      this.term.parser.registerOscHandler(133, (data) => this.onOsc133(data)),
      this.term.parser.registerOscHandler(7, (data) => {
        const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
        if (m) this.cwd = decodeURIComponent(m[1]);
        return false;
      }),
      this.term.parser.registerOscHandler(52, (data) => this.onOsc52(data)),
      this.term.onRender(() => this.paintBackdrop()),
      this.term.onScroll(() => this.paintBackdrop()),
      this.term.registerLinkProvider({
        provideLinks: (y, cb) => cb(this.fileLinks(y)),
      }),
    );

    this.unregister = registerSink(host, session, {
      reset: (data) => {
        this.blocks = [];
        this.term.reset();
        // Marks replayed from the snapshot carry no timing.
        this.replaying = true;
        this.term.write(data, () => (this.replaying = false));
        this.ready = true;
      },
      write: (data) => {
        if (this.ready) this.term.write(data);
      },
    });
  }

  /** Requests a snapshot; output starts flowing after the reset record. */
  async attach() {
    this.ready = false;
    const { cols, rows } = this.term;
    try {
      await rpc(this.host, M.terminalAttach, { id: this.session, cols, rows });
    } catch (e) {
      // No snapshot is coming: keep showing live output rather than freezing,
      // and try again shortly (reconnects re-attach everything anyway). A
      // terminal that no longer exists, or a closed entry, is not retried.
      this.ready = true;
      const gone = e instanceof Error && /no such terminal/i.test(e.message);
      if (!gone && !this.disposed) window.setTimeout(() => !this.disposed && void this.attach().catch(() => {}), 2000);
      throw e;
    }
    this.lastSize = `${cols}x${rows}`;
  }

  mount(parent: HTMLElement) {
    if (this.parent === parent && parent.contains(this.el)) return;
    this.parent = parent;
    parent.appendChild(this.el);
    if (this.settings.webgl && !this.webgl) {
      try {
        this.webgl = new WebglAddon();
        this.webgl.onContextLoss(() => {
          this.webgl?.dispose();
          this.webgl = null;
        });
        this.term.loadAddon(this.webgl);
      } catch {
        this.webgl = null; // DOM renderer fallback
      }
    }
    this.resizeObs?.disconnect();
    this.resizeObs = new ResizeObserver(() => this.refit());
    this.resizeObs.observe(parent);
    requestAnimationFrame(() => this.refit());
  }

  unmount() {
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.webgl?.dispose();
    this.webgl = null;
    if (this.el.parentElement) this.el.parentElement.removeChild(this.el);
    this.parent = null;
  }

  refit() {
    if (!this.parent || this.parent.clientWidth < 20 || this.parent.clientHeight < 20) return;
    try {
      this.fit.fit();
    } catch {
      /* not laid out yet */
    }
  }

  private sendResize(cols: number, rows: number) {
    const key = `${cols}x${rows}`;
    if (key === this.lastSize) return;
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.lastSize = key;
      void rpc(this.host, M.terminalResize, { id: this.session, cols, rows }).catch(() => {});
    }, 60);
  }

  focus() {
    this.term.focus();
  }

  applySettings(s: TermSettings) {
    this.settings = s;
    this.term.options.fontFamily = s.fontFamily;
    this.term.options.fontSize = s.fontSize;
    this.term.options.macOptionIsMeta = s.optionIsMeta;
    this.refit();
  }

  private onOsc133(data: string): boolean {
    const [mark, ...rest] = data.split(";");
    const marker = this.term.registerMarker(0);
    if (!marker) return true;
    const last = this.blocks[this.blocks.length - 1];
    switch (mark) {
      case "A":
        this.blocks.push({ prompt: marker });
        if (this.blocks.length > 2000) this.blocks.shift();
        break;
      case "B":
        break;
      case "C": {
        // No open block when the prompt came before we attached (snapshots
        // carry no marks): the command is on the line above the cursor.
        let last = this.blocks[this.blocks.length - 1];
        if (!last || last.output) {
          // In Warp mode the header row sits above the command (T8).
          const prompt = this.term.registerMarker(this.warp ? -2 : -1);
          if (prompt) {
            last = { prompt };
            this.blocks.push(last);
          }
        }
        if (last) {
          last.output = marker;
          last.cwd = this.cwd;
          if (this.warp) {
            // The prompt is one empty header row; the command follows it.
            const rows: string[] = [];
            for (let y = last.prompt.line + 1; y < marker.line; y++) rows.push(this.lineText(y));
            last.command = rows.join("\n").trim();
          } else last.command = this.lineText(last.prompt.line).replace(/^.*?[$%#❯>]\s/, "").trim();
          if (!this.replaying) last.startedAt = Date.now();
          if (this.warp) this.header(last);
        }
        break;
      }
      case "D":
        if (last) {
          last.end = marker;
          const code = Number(rest[0]);
          last.exit = Number.isFinite(code) ? code : undefined;
          if (!this.replaying && last.startedAt !== undefined) last.endedAt = Date.now();
          this.decorate(last);
          if (this.warp) this.header(last);
        }
        break;
    }
    return true;
  }

  private decorate(block: CommandBlock) {
    const d = this.term.registerDecoration({ marker: block.prompt, x: 0, width: 1, overviewRulerOptions: { color: block.exit ? "#ef5f5f" : "#333333" } });
    d?.onRender((el) => {
      // Warp mode shows the status in the block header instead (T8).
      if (this.warp) return;
      el.classList.add("jaunt-block-mark");
      el.classList.toggle("failed", !!block.exit);
      el.title = block.exit ? `exit ${block.exit}` : "ok";
    });
  }

  /** Separator and header on a block's header row (T8). They reach into
   * the pane's padding (`.jaunt-term` inset) so the separator spans it. */
  private header(block: CommandBlock) {
    block.header?.dispose();
    const d = this.term.registerDecoration({ marker: block.prompt, x: 0, width: this.term.cols, layer: "top" });
    d?.onRender((el) => {
      el.classList.add("jaunt-block-head");
      el.style.left = "-28px";
      el.style.width = "calc(100% + 40px)";
      const h = blockHeader(block, this.context);
      const key = JSON.stringify(h);
      if (el.dataset.key === key) return;
      el.dataset.key = key;
      const span = (cls: string, text: string) => Object.assign(document.createElement("span"), { className: cls, textContent: text });
      // xterm sets the element's `display`, so the layout lives in a row inside.
      const row = Object.assign(document.createElement("div"), { className: "row" });
      row.append(
        span("place", h.place),
        ...(h.exit ? [span("exit", ` · ${h.exit}`)] : []),
        ...(h.duration ? [span("duration", ` ${h.duration}`)] : []),
        ...(h.running ? [span("running", "")] : []),
      );
      el.replaceChildren(row);
    });
    block.header = d ?? undefined;
    this.paintBackdrop();
  }

  private paintBackdrop() {
    const screen = this.backdrop.parentElement;
    if (!screen || !this.warp || this.term.buffer.active.type === "alternate") {
      this.backdrop.replaceChildren();
      return;
    }
    const cell = screen.clientHeight / this.term.rows;
    const spans = this.blocks
      .filter((b) => b.prompt.line >= 0)
      .map((b) => ({ start: b.prompt.line, end: b.end && b.end.line >= 0 ? b.end.line : undefined, exit: b.exit }));
    const rects = blockRects(spans, this.term.buffer.active.viewportY, this.term.rows);
    this.backdrop.replaceChildren(
      ...rects.map((r) => {
        const el = document.createElement("div");
        el.className = `jaunt-block-bg ${r.kind}`;
        el.style.top = `${r.top * cell}px`;
        el.style.height = `${r.height * cell}px`;
        return el;
      }),
    );
  }

  /** Warp mode hides the terminal's cursor while the editor has the input. */
  setEditorActive(active: boolean) {
    this.term.options.cursorInactiveStyle = active ? "none" : "outline";
    this.term.options.cursorBlink = !active;
  }

  private onOsc52(data: string): boolean {
    if (!this.settings.allowOsc52) return true; // swallowed: clipboard writes need opt-in
    const [, payload] = data.split(";");
    if (!payload || payload === "?") return true;
    try {
      void navigator.clipboard.writeText(new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))));
    } catch {
      /* ignore malformed payloads */
    }
    return true;
  }

  lineText(y: number): string {
    return this.term.buffer.active.getLine(y)?.translateToString(true) ?? "";
  }

  /** Jumps to the previous/next command prompt (T4). */
  jumpBlock(delta: -1 | 1) {
    const buf = this.term.buffer.active;
    const top = buf.viewportY;
    const lines = this.blocks.map((b) => b.prompt.line).filter((l) => l >= 0);
    const target = delta < 0 ? [...lines].reverse().find((l) => l < top) : lines.find((l) => l > top);
    if (target !== undefined) this.term.scrollToLine(target);
  }

  /** Output of the most recent finished command. */
  lastOutput(): string {
    const b = [...this.blocks].reverse().find((x) => x.output && x.end);
    if (!b?.output || !b.end) return "";
    const out: string[] = [];
    for (let y = b.output.line; y < b.end.line; y++) out.push(this.lineText(y));
    return out.join("\n").trimEnd();
  }

  rerunLast() {
    const b = [...this.blocks].reverse().find((x) => x.command);
    if (b?.command) void sendInput(this.host, this.session, b.command + "\r");
  }

  private fileLinks(y: number) {
    const text = this.lineText(y - 1);
    const links = [];
    PATH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PATH_RE.exec(text))) {
      const path = m[1];
      if (/^\d+(\.\d+)+$/.test(path) || path.startsWith("http")) continue;
      const start = m.index + m[0].indexOf(path);
      const full = path + (m[2] ? `:${m[2]}` : "");
      const line = m[2] ? Number(m[2]) : undefined;
      links.push({
        range: { start: { x: start + 1, y }, end: { x: start + full.length, y } },
        text: full,
        decorations: { underline: true, pointerCursor: true },
        activate: (e: MouseEvent) => {
          if (!e.metaKey) return; // Cmd+click, like other terminals (F3)
          this.onFileLink?.(path, line);
        },
      });
    }
    return links;
  }

  dispose() {
    this.disposed = true;
    this.unmount();
    this.unregister();
    this.disposables.forEach((d) => d.dispose());
    this.term.dispose();
  }
}

const entries = new Map<string, TermEntry>();
let settings = defaultTermSettings;

export function getEntry(host: string, session: number): TermEntry {
  const key = `${host}:${session}`;
  let e = entries.get(key);
  if (!e) {
    e = new TermEntry(host, session, settings);
    entries.set(key, e);
    void e.attach().catch(() => {});
  }
  return e;
}

export function findEntry(host: string, session: number): TermEntry | undefined {
  return entries.get(`${host}:${session}`);
}

export function disposeEntry(host: string, session: number) {
  const key = `${host}:${session}`;
  entries.get(key)?.dispose();
  entries.delete(key);
}

/** After a reconnect the daemon has forgotten our subscriptions. */
export function reattachHost(host: string) {
  for (const e of entries.values()) if (e.host === host) void e.attach().catch(() => {});
}

export function setTermSettings(s: TermSettings) {
  settings = s;
  for (const e of entries.values()) e.applySettings(s);
}
