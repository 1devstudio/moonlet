// The Terminal tab's command blocks (X40): a headless terminal fed with a
// shell's output, whose OSC 133 marks (T3) split it into commands, as the
// desktop's Blocks mode does (T8). The phone never resizes the PTY, which
// the Mac's window shares, so the terminal keeps the PTY's size.

import { Terminal, type IMarker } from "@xterm/headless";
import { blockLayout, commandFromRows, markTime } from "@desktop/lib/blockText";

export interface Block {
  command: string;
  output: string;
  /** Null while the command runs, or when the shell gave none. */
  exit: number | null;
  cwd: string | null;
  startedAt?: number;
  endedAt?: number;
  running: boolean;
}

interface Marks {
  prompt: IMarker;
  output?: IMarker;
  end?: IMarker;
  /** Column of the cursor at the `D` mark: output without a final newline. */
  endCol?: number;
  exit: number | null;
  cwd: string | null;
  startedAt?: number;
  endedAt?: number;
}

export class BlockReader {
  private term: Terminal;
  private marks: Marks[] = [];
  private cwd: string | null = null;
  /** Writes, resets and resizes, in the order they were asked for: xterm
   * parses writes later, and a reset must not land before earlier output. */
  private queue: Promise<void> = Promise.resolve();

  constructor(cols: number, rows: number, private now: () => number = Date.now) {
    this.term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    this.term.parser.registerOscHandler(133, (data) => this.onMark(data));
    this.term.parser.registerOscHandler(7, (data) => {
      try {
        this.cwd = decodeURIComponent(new URL(data).pathname);
      } catch {
        /* not a file URL */
      }
      return true;
    });
  }

  private then(f: () => void | Promise<void>): Promise<void> {
    this.queue = this.queue.then(f);
    return this.queue;
  }

  write(data: string | Uint8Array): Promise<void> {
    return this.then(() => new Promise((resolve) => this.term.write(data, resolve)));
  }

  /** Before an attach snapshot, which redraws everything. */
  reset(): Promise<void> {
    return this.then(() => {
      for (const m of this.marks) {
        m.prompt.dispose();
        m.output?.dispose();
        m.end?.dispose();
      }
      this.marks = [];
      this.term.reset();
    });
  }

  resize(cols: number, rows: number): Promise<void> {
    return this.then(() => this.term.resize(cols, rows));
  }

  private onMark(data: string): boolean {
    const [mark, ...rest] = data.split(";");
    const last = this.marks[this.marks.length - 1];
    const marker = this.term.registerMarker(0);
    if (!marker) return true;
    if (mark === "A") {
      this.marks.push({ prompt: marker, exit: null, cwd: null });
      if (this.marks.length > 500) this.marks.shift();
    } else if (mark === "C" && last && !last.output) {
      last.output = marker;
      last.cwd = this.cwd;
      last.startedAt = markTime(rest, false, this.now());
    } else if (mark === "D" && last?.output && !last.end) {
      last.end = marker;
      last.endCol = this.term.buffer.active.cursorX;
      const code = Number(rest[0]);
      last.exit = rest[0] !== undefined && Number.isFinite(code) && !rest[0].startsWith("moonlet_") ? code : null;
      last.endedAt = markTime(rest, false, this.now());
    } else {
      marker.dispose();
    }
    return true;
  }

  private row(y: number) {
    const line = this.term.buffer.active.getLine(y);
    return { text: line?.translateToString(false) ?? "", wrapped: !!line?.isWrapped };
  }

  blocks(): Block[] {
    const buf = this.term.buffer.active;
    const out: Block[] = [];
    for (const m of this.marks) {
      if (!m.output || m.prompt.line < 0 || m.output.line < 0) continue;
      const layout = blockLayout(m.prompt.line, m.output.line, (y) => !this.row(y).text.trim());
      const commandRows = [];
      for (let y = layout.commandFrom; y < m.output.line; y++) commandRows.push(this.row(y));
      // Output runs to the row of the D mark, that row too when the command
      // ended without a newline; while running, to the cursor's row.
      const last = m.end ? (m.endCol ? m.end.line : m.end.line - 1) : buf.baseY + buf.cursorY;
      const outputRows = [];
      for (let y = m.output.line; y <= last; y++) outputRows.push(this.row(y));
      out.push({
        command: commandFromRows(commandRows),
        output: commandFromRows(outputRows),
        exit: m.end ? m.exit : null,
        cwd: m.cwd,
        startedAt: m.startedAt,
        endedAt: m.end ? m.endedAt : undefined,
        running: !m.end,
      });
    }
    return out;
  }
}
