//! Daemon-side terminal state. Every byte a PTY prints is fed through a
//! headless `vt100` emulator so a client that (re)attaches can be given a
//! snapshot of scrollback, screen, cursor and modes (S2).
//!
//! The emulator's callbacks also surface the terminal-level signals used
//! for agent state (A1): title changes, bells, OSC 7 (cwd), OSC 133 (shell
//! prompt marks) and OSC 9 / OSC 777 desktop notifications.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

pub const DEFAULT_SCROLLBACK: usize = 10_000;
/// Prompt marks kept for snapshots (S2): three per block for 2,000 blocks.
const MAX_MARKS: usize = 6_000;
/// Smallest size the emulator accepts; tiny grids trip edge cases in vt100.
const MIN_ROWS: u16 = 2;
const MIN_COLS: u16 = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Signal {
    Title(String),
    Bell,
    Cwd(String),
    /// OSC 133 mark: `A` prompt start, `B` command start, `C` output start, `D` finished.
    Prompt {
        mark: char,
        exit: Option<i32>,
    },
    Notify {
        title: Option<String>,
        body: String,
    },
    /// `OSC 1337 ; MoonletNodePath=<path>` from moonlet's prompt hook (T8): where
    /// `node` is on PATH; empty when there is none any more.
    NodePath(String),
    /// `OSC 1337 ; MoonletPath=<PATH>` from moonlet's prompt hook (T8): the
    /// shell's PATH, when it changed.
    Path(String),
    /// `OSC 1337 ; MoonletCommand=<percent-encoded>` from moonlet's preexec
    /// hook (X31): the command line about to run.
    Command(String),
}

/// Raw output of the last command kept for an agent to read (X31); beyond
/// this its start is dropped.
const CAPTURE_LIMIT: usize = 8 * 1024 * 1024;

/// The most recent command a shell ran (X31), from its OSC 133 marks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastCommand {
    pub command: Option<String>,
    pub exit: Option<i32>,
    /// No `D` mark yet.
    pub running: bool,
    /// The output as printed, at most the asked number of lines.
    pub text: String,
}

struct Capture {
    command: Option<String>,
    exit: Option<i32>,
    running: bool,
    bytes: Vec<u8>,
    dropped: bool,
}

/// Where each OSC 133 sequence in `data` ends, so the bytes after a `C`
/// mark can be told from those before it.
fn mark_ends(data: &[u8]) -> Vec<usize> {
    let mut ends = Vec::new();
    let mut i = 0;
    while let Some(at) = find(&data[i..], b"\x1b]133;") {
        let start = i + at + 6;
        let Some(len) = data[start..].iter().position(|&b| b == 0x07 || b == 0x1b) else {
            break;
        };
        let end = start + len + if data[start + len] == 0x1b { 2 } else { 1 };
        let end = end.min(data.len());
        ends.push(end);
        i = end;
    }
    ends
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// An OSC 133 mark on the primary screen, kept so a snapshot can put it
/// back on its row (S2).
#[derive(Debug, Clone)]
struct Mark {
    /// The row's number: rows ever pushed into the scrollback when the mark
    /// came, plus the cursor's screen row.
    row: u64,
    mark: char,
    exit: Option<i32>,
    /// The shell's directory when the mark came, for a `C`.
    cwd: Option<String>,
    /// From a replayed snapshot: how long ago the daemon that wrote it saw
    /// the mark, in ms.
    age: Option<u64>,
    /// When the mark came; set by `process_at`.
    at: Option<Instant>,
}

#[derive(Default)]
pub struct Signals {
    pending: Vec<Signal>,
    marks: Vec<Mark>,
    /// The last directory OSC 7 reported.
    cwd: Option<String>,
}

impl Signals {
    /// Remembers where an OSC 133 mark was printed, unless a full-screen
    /// program has the alternate screen.
    fn mark(&mut self, screen: &vt100::Screen, params: &[&[u8]]) {
        if screen.alternate_screen() {
            return;
        }
        let Some(Signal::Prompt { mark, exit }) = parse_osc(params) else {
            return;
        };
        let age = params[2..]
            .iter()
            .find_map(|p| text(p).strip_prefix("moonlet_age=")?.parse().ok());
        let (row, _) = screen.cursor_position();
        self.marks.push(Mark {
            row: screen.scrolled_rows() + u64::from(row),
            mark,
            exit,
            cwd: (mark == 'C').then(|| self.cwd.clone()).flatten(),
            age,
            at: None,
        });
    }
}

impl vt100::Callbacks for Signals {
    fn audible_bell(&mut self, _: &mut vt100::Screen) {
        self.pending.push(Signal::Bell);
    }

    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        self.pending
            .push(Signal::Title(String::from_utf8_lossy(title).into_owned()));
    }

    fn set_window_icon_name(&mut self, _: &mut vt100::Screen, _: &[u8]) {}

    fn unhandled_osc(&mut self, screen: &mut vt100::Screen, params: &[&[u8]]) {
        if let Some(signal) = parse_osc(params) {
            match &signal {
                Signal::Cwd(cwd) => self.cwd = Some(cwd.clone()),
                Signal::Prompt { .. } => self.mark(screen, params),
                _ => {}
            }
            self.pending.push(signal);
        }
    }
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn parse_osc(params: &[&[u8]]) -> Option<Signal> {
    let code = std::str::from_utf8(params.first()?).ok()?;
    match code {
        "7" => {
            // OSC 7 ; file://host/path
            let url = text(&params[1..].join(&b';'));
            let rest = url.strip_prefix("file://")?;
            let path = &rest[rest.find('/')?..];
            Some(Signal::Cwd(percent_decode(path)))
        }
        "133" => {
            let mark = text(params.get(1)?).chars().next()?;
            let exit = if mark == 'D' {
                params.get(2).and_then(|p| text(p).parse().ok())
            } else {
                None
            };
            Some(Signal::Prompt { mark, exit })
        }
        "9" => {
            let body = text(&params[1..].join(&b';'));
            // OSC 9;4 is ConEmu progress, not a notification.
            if body.starts_with("4;") || body.is_empty() {
                return None;
            }
            Some(Signal::Notify { title: None, body })
        }
        "1337" => {
            let rest = text(&params[1..].join(&b';'));
            // `Jaunt*` from shells jaunt's integration set up (X27).
            let (name, value) = rest.split_once('=')?;
            match name {
                "MoonletPath" | "JauntPath" => Some(Signal::Path(value.to_string())),
                "MoonletNodePath" | "JauntNodePath" => Some(Signal::NodePath(value.to_string())),
                "MoonletCommand" => Some(Signal::Command(percent_decode(value))),
                _ => None,
            }
        }
        "777" if params.get(1).map(|p| *p == b"notify").unwrap_or(false) => Some(Signal::Notify {
            title: params.get(2).map(|p| text(p)),
            body: params
                .get(3..)
                .map(|r| text(&r.join(&b';')))
                .unwrap_or_default(),
        }),
        _ => None,
    }
}

/// A path for an OSC 7 URL: bytes other than unreserved ones and `/`
/// percent-encoded, as `percent_decode` and the app read them back.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(v) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub struct TermState {
    parser: vt100::Parser<Signals>,
    title: String,
    scrollback: usize,
    /// Prompt marks, oldest first, for snapshots (S2).
    marks: VecDeque<Mark>,
    /// The command line the preexec hook reported, until its `C` mark.
    next_command: Option<String>,
    last: Option<Capture>,
    capture_limit: usize,
}

impl TermState {
    pub fn new(rows: u16, cols: u16) -> Self {
        Self::with_scrollback(rows, cols, DEFAULT_SCROLLBACK)
    }

    pub fn with_scrollback(rows: u16, cols: u16, scrollback: usize) -> Self {
        Self {
            parser: vt100::Parser::new_with_callbacks(
                rows.max(MIN_ROWS),
                cols.max(MIN_COLS),
                scrollback,
                Signals::default(),
            ),
            title: String::new(),
            scrollback,
            marks: VecDeque::new(),
            next_command: None,
            last: None,
            capture_limit: CAPTURE_LIMIT,
        }
    }

    /// Feeds PTY output; returns the signals it produced. Output between a
    /// command's `C` and `D` marks is also kept, for [`Self::last_command`].
    pub fn process(&mut self, bytes: &[u8]) -> Vec<Signal> {
        self.process_at(bytes, Instant::now())
    }

    /// `process`, with the time the output came (prompt marks keep it).
    pub fn process_at(&mut self, bytes: &[u8], now: Instant) -> Vec<Signal> {
        let mut signals = Vec::new();
        let mut from = 0;
        for end in mark_ends(bytes).into_iter().chain([bytes.len()]) {
            if end > from {
                signals.extend(self.process_part(&bytes[from..end], now));
            }
            from = end;
        }
        signals
    }

    fn process_part(&mut self, bytes: &[u8], now: Instant) -> Vec<Signal> {
        if let Some(c) = self.last.as_mut().filter(|c| c.running) {
            c.bytes.extend_from_slice(bytes);
            if c.bytes.len() > self.capture_limit {
                let keep = self.capture_limit * 3 / 4;
                c.bytes.drain(..c.bytes.len() - keep);
                c.dropped = true;
            }
        }
        let signals = self.feed(bytes, now);
        for s in &signals {
            match s {
                Signal::Command(c) => self.next_command = Some(c.clone()),
                Signal::Prompt { mark: 'C', .. } => {
                    self.last = Some(Capture {
                        command: self.next_command.take(),
                        exit: None,
                        running: true,
                        bytes: Vec::new(),
                        dropped: false,
                    });
                }
                Signal::Prompt { mark: 'D', exit } => {
                    if let Some(c) = self.last.as_mut().filter(|c| c.running) {
                        c.running = false;
                        c.exit = *exit;
                    }
                }
                _ => {}
            }
        }
        signals
    }

    /// The most recent command and the last `max` lines of its output (X31).
    pub fn last_command(&self, max: usize) -> Option<LastCommand> {
        let c = self.last.as_ref()?;
        let (rows, cols) = self.size();
        let mut render = TermState::with_scrollback(rows, cols, 100_000);
        render.feed(&c.bytes, Instant::now());
        let (lines, omitted) = render.tail_lines(max);
        let mut text = Vec::new();
        if c.dropped {
            text.push("… earlier output was not kept".to_string());
        } else if omitted > 0 {
            text.push(format!("… {omitted} earlier lines omitted"));
        }
        text.extend(lines);
        Some(LastCommand {
            command: c.command.clone(),
            exit: c.exit,
            running: c.running,
            text: text.join("\n"),
        })
    }

    fn feed(&mut self, bytes: &[u8], now: Instant) -> Vec<Signal> {
        let parser = &mut self.parser;
        let ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| parser.process(bytes)))
            .is_ok();
        if !ok {
            // An emulator bug must not take the session down: start a fresh
            // screen of the same size and keep streaming.
            tracing::error!("terminal emulator panicked; resetting screen state");
            let (rows, cols) = self.size();
            self.parser =
                vt100::Parser::new_with_callbacks(rows, cols, self.scrollback, Signals::default());
            self.marks.clear();
            return Vec::new();
        }
        for mut m in std::mem::take(&mut self.parser.callbacks_mut().marks) {
            // A replayed mark keeps the age it was given.
            let age = Duration::from_millis(m.age.take().unwrap_or(0));
            m.at = Some(now.checked_sub(age).unwrap_or(now));
            // A mark above earlier ones: the screen was cleared or redrawn
            // (`clear`), so the rows below it no longer hold what they marked.
            while self.marks.back().is_some_and(|last| last.row > m.row) {
                self.marks.pop_back();
            }
            self.marks.push_back(m);
        }
        while self.marks.len() > MAX_MARKS {
            self.marks.pop_front();
        }
        let signals = std::mem::take(&mut self.parser.callbacks_mut().pending);
        for s in &signals {
            if let Signal::Title(t) = s {
                self.title = t.clone();
            }
        }
        signals
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.parser
            .screen_mut()
            .set_size(rows.max(MIN_ROWS), cols.max(MIN_COLS));
    }

    pub fn size(&self) -> (u16, u16) {
        self.parser.screen().size()
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn screen(&self) -> &vt100::Screen {
        self.parser.screen()
    }

    /// Visible screen as plain text, for heuristics and tests.
    pub fn contents(&self) -> String {
        self.parser.screen().contents()
    }

    /// Escape sequence stream that reproduces the current state on a freshly
    /// reset terminal of the same size: scrollback lines first (so they land
    /// in the client's scrollback), then the screen, cursor and input modes.
    pub fn snapshot(&mut self) -> Vec<u8> {
        self.snapshot_at(Instant::now())
    }

    /// `snapshot`, with prompt marks aged as of `now`.
    pub fn snapshot_at(&mut self, now: Instant) -> Vec<u8> {
        let mut out = Vec::new();
        // Full reset of the receiving terminal, then default attributes.
        out.extend_from_slice(b"\x1bc\x1b[0m");
        let alternate = self.parser.screen().alternate_screen();
        if !alternate {
            self.write_rows(&mut out, now);
        } else {
            out.extend_from_slice(b"\x1b[?1049h");
        }
        let screen = self.parser.screen();
        let mut redraw = screen.contents_formatted();
        // The rows written above hold the screen already, with the marks
        // on them; erasing it first would make xterm drop those marks, so
        // the redraw goes over them from the top left instead.
        const CLEAR: &[u8] = b"\x1b[H\x1b[J";
        if !alternate && let Some(at) = redraw.windows(CLEAR.len()).position(|w| w == CLEAR) {
            redraw.drain(at + 3..at + CLEAR.len());
        }
        out.extend_from_slice(&redraw);
        out.extend_from_slice(&screen.input_mode_formatted());
        out
    }

    /// Scrollback and screen rows, oldest first, one line each, with the
    /// prompt marks (S2) at the start of the rows they were printed on. The
    /// screen redraw that follows draws the screen rows again, exactly, over
    /// these.
    fn write_rows(&mut self, out: &mut Vec<u8>, now: Instant) {
        let screen = self.parser.screen_mut();
        let (rows, cols) = screen.size();
        let total = screen.scrollback_rows();
        // The number of the first row the snapshot has.
        let first = screen.scrolled_rows() - total as u64;
        let mut marks = self.marks.iter().filter(|m| m.row >= first).peekable();
        let mut cwd: Option<&str> = None;
        // A `D` only ends a block whose `C` was kept; otherwise the app would
        // end the block before it again.
        let mut open = false;
        let mut line = 0u64;
        let mut row_out = |out: &mut Vec<u8>, row: Vec<u8>| {
            if line > 0 {
                out.extend_from_slice(b"\x1b[0m\r\n");
            }
            while let Some(m) = marks.next_if(|m| m.row == first + line) {
                match m.mark {
                    'C' => open = true,
                    'D' if !open => continue,
                    'D' => open = false,
                    _ => {}
                }
                if let Some(dir) = m.cwd.as_deref().filter(|d| cwd != Some(*d)) {
                    out.extend_from_slice(
                        format!("\x1b]7;file://{}\x07", percent_encode(dir)).as_bytes(),
                    );
                    cwd = Some(dir);
                }
                let age =
                    m.at.map_or(0, |at| now.saturating_duration_since(at).as_millis());
                let exit = m.exit.map(|e| format!("{e};")).unwrap_or_default();
                out.extend_from_slice(
                    format!("\x1b]133;{};{exit}moonlet_age={age}\x07", m.mark).as_bytes(),
                );
            }
            out.extend_from_slice(&row);
            line += 1;
        };
        let mut offset = total;
        while offset > 0 {
            screen.set_scrollback(offset);
            let take = offset.min(rows as usize);
            for row in screen.rows_formatted(0, cols).take(take) {
                row_out(out, row);
            }
            offset -= take;
        }
        screen.set_scrollback(0);
        for row in screen.rows_formatted(0, cols) {
            row_out(out, row);
        }
        drop(row_out);
        // The shell's directory now, which later commands start from.
        let current = self.parser.callbacks().cwd.as_deref();
        if let Some(dir) = current.filter(|d| cwd != Some(*d)) {
            out.extend_from_slice(format!("\x1b]7;file://{}\x07", percent_encode(dir)).as_bytes());
        }
        out.extend_from_slice(b"\x1b[0m");
    }

    /// Plain-text lines of scrollback followed by the screen, oldest first.
    pub fn all_lines(&mut self) -> Vec<String> {
        let screen = self.parser.screen_mut();
        let (rows, cols) = screen.size();
        screen.set_scrollback(usize::MAX);
        let total = screen.scrollback();
        let mut lines = Vec::new();
        let mut offset = total;
        while offset > 0 {
            screen.set_scrollback(offset);
            let take = offset.min(rows as usize);
            lines.extend(screen.rows(0, cols).take(take));
            offset -= take;
        }
        screen.set_scrollback(0);
        lines.extend(screen.rows(0, cols));
        lines
    }

    /// Scrollback and screen as printed lines, oldest first: rows the
    /// terminal wrapped are joined and trailing spaces dropped.
    fn logical_lines(&mut self) -> Vec<String> {
        let screen = self.parser.screen_mut();
        let (rows, cols) = screen.size();
        screen.set_scrollback(usize::MAX);
        let mut offset = screen.scrollback();
        let mut lines = vec![String::new()];
        let mut push = |screen: &vt100::Screen, take: usize| {
            for (i, row) in screen.rows(0, cols).take(take).enumerate() {
                let last = lines.last_mut().expect("never empty");
                last.push_str(&row);
                if !screen.row_wrapped(i as u16) {
                    let trimmed = last.trim_end().len();
                    last.truncate(trimmed);
                    lines.push(String::new());
                }
            }
        };
        while offset > 0 {
            screen.set_scrollback(offset);
            let take = offset.min(rows as usize);
            push(screen, take);
            offset -= take;
        }
        screen.set_scrollback(0);
        push(screen, rows as usize);
        lines
    }

    /// The last `n` printed lines as plain text (X31), and whether earlier
    /// lines were left out. Trailing blank lines do not count.
    pub fn tail_text(&mut self, n: usize) -> (String, bool) {
        let (lines, omitted) = self.tail_lines(n);
        (lines.join("\n"), omitted > 0)
    }

    /// The last `n` printed lines, without blank lines at either end, and
    /// how many came before them.
    fn tail_lines(&mut self, n: usize) -> (Vec<String>, usize) {
        let mut lines = self.logical_lines();
        while lines.last().is_some_and(|l| l.trim().is_empty()) {
            lines.pop();
        }
        let first = lines.iter().position(|l| !l.trim().is_empty()).unwrap_or(lines.len());
        let start = lines.len().saturating_sub(n).max(first);
        let tail = lines.split_off(start);
        (tail, start - first)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Replays `snapshot()` into a fresh emulator and checks it matches.
    fn assert_round_trip(term: &mut TermState) {
        let (rows, cols) = term.size();
        let snap = term.snapshot();
        let mut copy = TermState::new(rows, cols);
        copy.process(&snap);
        assert_eq!(copy.contents(), term.contents(), "visible text differs");
        assert_eq!(
            copy.screen().cursor_position(),
            term.screen().cursor_position(),
            "cursor differs"
        );
        assert_eq!(
            copy.screen().alternate_screen(),
            term.screen().alternate_screen()
        );
        assert_eq!(
            copy.screen().bracketed_paste(),
            term.screen().bracketed_paste()
        );
        assert_eq!(
            copy.screen().application_cursor(),
            term.screen().application_cursor()
        );
        for r in 0..rows {
            for c in 0..cols {
                let (a, b) = (
                    term.screen().cell(r, c).unwrap(),
                    copy.screen().cell(r, c).unwrap(),
                );
                assert_eq!(a.contents(), b.contents(), "cell {r},{c}");
                assert_eq!(a.fgcolor(), b.fgcolor(), "fg {r},{c}");
                assert_eq!(a.bgcolor(), b.bgcolor(), "bg {r},{c}");
                assert_eq!(a.bold(), b.bold(), "bold {r},{c}");
                assert_eq!(a.inverse(), b.inverse(), "inverse {r},{c}");
            }
        }
        let mut t_lines = term.all_lines();
        let mut c_lines = copy.all_lines();
        // The copy may carry extra blank lines pushed into scrollback.
        while t_lines.last().is_some_and(|l| l.trim().is_empty()) {
            t_lines.pop();
        }
        while c_lines.last().is_some_and(|l| l.trim().is_empty()) {
            c_lines.pop();
        }
        let t_text: Vec<_> = t_lines.iter().filter(|l| !l.trim().is_empty()).collect();
        let c_text: Vec<_> = c_lines.iter().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(t_text, c_text, "scrollback text differs");
    }

    #[test]
    fn plain_shell_output_with_scrollback() {
        let mut t = TermState::new(10, 40);
        for i in 0..100 {
            t.process(format!("line {i} \x1b[1;32mgreen\x1b[0m done\r\n").as_bytes());
        }
        t.process(b"$ ");
        assert_round_trip(&mut t);
        assert!(t.all_lines().iter().any(|l| l.starts_with("line 0 ")));
    }

    #[test]
    fn ink_style_redraw_like_claude_code() {
        // Ink redraws its frame by moving up and erasing lines.
        let mut t = TermState::new(12, 60);
        t.process(b"\x1b[?2004h\x1b[?25l");
        for frame in 0..30 {
            if frame > 0 {
                t.process(b"\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G");
            }
            t.process(
                format!("\x1b[38;2;215;119;87m✻\x1b[39m Thinking… ({frame}s)\r\n").as_bytes(),
            );
            t.process("╭──────────────╮\r\n│ > \x1b[7m \x1b[27m          │".as_bytes());
        }
        assert_round_trip(&mut t);
    }

    #[test]
    fn alternate_screen_tui() {
        let mut t = TermState::new(8, 30);
        t.process(b"before alt\r\n");
        t.process(
            b"\x1b[?1049h\x1b[?1h\x1b=\x1b[H\x1b[2J\x1b[44m top bar \x1b[0m\x1b[5;3Hcursor here",
        );
        assert_round_trip(&mut t);
    }

    #[test]
    fn wide_and_combining_chars() {
        let mut t = TermState::new(5, 20);
        t.process("日本語 e\u{301} 👍🏽 ok\r\n".as_bytes());
        assert_round_trip(&mut t);
    }

    #[test]
    fn tiny_sizes_are_clamped() {
        let mut t = TermState::new(0, 0);
        t.process("wide 日本 text that wraps\r\n".repeat(5).as_bytes());
        assert_eq!(t.size(), (MIN_ROWS, MIN_COLS));
    }

    #[test]
    fn surfaces_osc_signals() {
        let mut t = TermState::new(5, 20);
        let s = t.process(b"\x1b]0;my title\x07\x07\x1b]7;file://host/Users/me/my%20dir\x07\x1b]133;D;2\x07\x1b]777;notify;Claude;Needs approval\x07\x1b]9;done\x07");
        assert_eq!(
            s,
            vec![
                Signal::Title("my title".into()),
                Signal::Bell,
                Signal::Cwd("/Users/me/my dir".into()),
                Signal::Prompt {
                    mark: 'D',
                    exit: Some(2)
                },
                Signal::Notify {
                    title: Some("Claude".into()),
                    body: "Needs approval".into()
                },
                Signal::Notify {
                    title: None,
                    body: "done".into()
                },
            ]
        );
        assert_eq!(t.title(), "my title");
    }

    /// X31: what an agent reads is the text as printed, not screen rows.
    #[test]
    fn tail_text_joins_wrapped_rows_and_drops_trailing_blanks() {
        let mut t = TermState::new(4, 10);
        t.process(b"\x1b[31mred\x1b[0m   \r\n0123456789abcdef\r\nlast\r\n\r\n");
        assert_eq!(
            t.tail_text(10),
            ("red\n0123456789abcdef\nlast".to_string(), false)
        );
        assert_eq!(t.tail_text(2), ("0123456789abcdef\nlast".to_string(), true));
    }

    #[test]
    fn tail_text_reaches_into_scrollback() {
        let mut t = TermState::new(5, 20);
        for i in 1..=300 {
            t.process(format!("line {i}\r\n").as_bytes());
        }
        let (text, truncated) = t.tail_text(200);
        assert!(truncated);
        assert_eq!(text.lines().count(), 200);
        assert_eq!(text.lines().next(), Some("line 101"));
        assert_eq!(text.lines().last(), Some("line 300"));
    }

    /// X31: the last command is what the shell printed between its `C`
    /// and `D` marks, rendered, with the command line the hook reported.
    #[test]
    fn last_command_is_the_output_between_the_marks() {
        let mut t = TermState::new(5, 20);
        assert_eq!(t.last_command(2000), None);
        t.process(b"\x1b]133;A\x07$ pnpm test\r\n\x1b]1337;MoonletCommand=pnpm%20test\x07\x1b]133;C\x07");
        t.process(b"\r\nloading 10%\rloading 100%\r\n");
        assert_eq!(
            t.last_command(2000),
            Some(LastCommand {
                command: Some("pnpm test".into()),
                exit: None,
                running: true,
                text: "loading 100%".into(),
            })
        );
        t.process(b"FAIL src/login.test.ts\r\n\x1b]133;D;1\x07\x1b]133;A\x07$ ");
        assert_eq!(
            t.last_command(2000),
            Some(LastCommand {
                command: Some("pnpm test".into()),
                exit: Some(1),
                running: false,
                text: "loading 100%\nFAIL src/login.test.ts".into(),
            })
        );
        // The next command replaces it, and one without a reported line has none.
        t.process(b"\x1b]133;C\x07ok\r\n\x1b]133;D;0\x07");
        assert_eq!(
            t.last_command(2000),
            Some(LastCommand { command: None, exit: Some(0), running: false, text: "ok".into() })
        );
    }

    #[test]
    fn a_long_last_command_keeps_its_end() {
        let mut t = TermState::new(5, 20);
        t.process(b"\x1b]1337;MoonletCommand=seq\x07\x1b]133;C\x07");
        for i in 1..=2500 {
            t.process(format!("{i}\r\n").as_bytes());
        }
        t.process(b"\x1b]133;D;0\x07");
        let last = t.last_command(2000).unwrap();
        let lines: Vec<&str> = last.text.lines().collect();
        assert_eq!(lines.len(), 2001);
        assert_eq!(lines[0], "… 500 earlier lines omitted");
        assert_eq!(lines[1], "501");
        assert_eq!(lines[2000], "2500");
    }

    #[test]
    fn output_over_the_capture_limit_says_its_start_is_gone() {
        let mut t = TermState::new(5, 20);
        t.capture_limit = 64;
        t.process(b"\x1b]133;C\x07");
        for i in 1..=40 {
            t.process(format!("{i}\r\n").as_bytes());
        }
        t.process(b"\x1b]133;D;0\x07");
        let text = t.last_command(2000).unwrap().text;
        assert_eq!(text.lines().next(), Some("… earlier output was not kept"));
        assert_eq!(text.lines().last(), Some("40"));
    }

    /// X27: shells report with moonlet's markers; shells jaunt's
    /// integration set up still use the old ones.
    #[test]
    fn surfaces_path_markers_old_and_new() {
        let mut t = TermState::new(5, 20);
        let s = t.process(b"\x1b]1337;MoonletPath=/usr/bin:/bin\x07\x1b]1337;MoonletNodePath=/opt/node/bin/node\x07\x1b]1337;JauntPath=/bin\x07\x1b]1337;JauntNodePath=/n/node\x07");
        assert_eq!(
            s,
            vec![
                Signal::Path("/usr/bin:/bin".into()),
                Signal::NodePath("/opt/node/bin/node".into()),
                Signal::Path("/bin".into()),
                Signal::NodePath("/n/node".into()),
            ]
        );
    }

    /// The OSC 133 and OSC 7 sequences of a snapshot, each with the line it
    /// is written on (the `\n`s before it), as a client's buffer gets them.
    fn marks_by_line(snapshot: &[u8]) -> Vec<(usize, String)> {
        let text = String::from_utf8_lossy(snapshot);
        let mut out = Vec::new();
        for (at, _) in text.match_indices("\x1b]") {
            let rest = &text[at + 2..];
            let body = &rest[..rest.find('\x07').unwrap()];
            if body.starts_with("133;") || body.starts_with("7;") {
                out.push((text[..at].matches('\n').count(), body.to_string()));
            }
        }
        out
    }

    /// S2: a shell's blocks come back on attach, with their marks on the
    /// rows they were printed on, some in the scrollback, some on screen.
    #[test]
    fn snapshot_puts_prompt_marks_back_on_their_rows() {
        let t0 = std::time::Instant::now();
        let s = std::time::Duration::from_secs;
        let mut t = TermState::new(4, 20);
        // Blocks mode: the prompt is two empty rows, then the command.
        t.process_at(b"\x1b]133;A\x07\r\n\r\necho hi\r\n", t0);
        t.process_at(b"\x1b]133;C\x07hi\r\n", t0 + s(1));
        t.process_at(b"\x1b]133;D;0\x07\x1b]133;A\x07\r\n\r\n", t0 + s(3));
        assert_eq!(
            marks_by_line(&t.snapshot_at(t0 + s(10))),
            vec![
                (0, "133;A;moonlet_age=10000".to_string()),
                (3, "133;C;moonlet_age=9000".to_string()),
                (4, "133;D;0;moonlet_age=7000".to_string()),
                (4, "133;A;moonlet_age=7000".to_string()),
            ]
        );
    }

    /// S2: each block's directory comes back before its `C`, sent again only
    /// when it changed, then the shell's current one.
    #[test]
    fn snapshot_gives_each_block_its_directory() {
        let t0 = std::time::Instant::now();
        let mut t = TermState::new(10, 30);
        let cwd = |d: &str| format!("\x1b]7;file://host{d}\x07");
        let block =
            |cmd: &str| format!("\x1b]133;A\x07\r\n\r\n{cmd}\r\n\x1b]133;C\x07\x1b]133;D;0\x07");
        t.process_at(
            format!("{}{}{}", cwd("/Users/me/my app"), block("ls"), block("pwd")).as_bytes(),
            t0,
        );
        t.process_at(
            format!("{}{}", block("cd /tmp"), cwd("/tmp")).as_bytes(),
            t0,
        );
        assert_eq!(
            marks_by_line(&t.snapshot_at(t0)),
            vec![
                (0, "133;A;moonlet_age=0".to_string()),
                (3, "7;file:///Users/me/my%20app".to_string()),
                (3, "133;C;moonlet_age=0".to_string()),
                (3, "133;D;0;moonlet_age=0".to_string()),
                (3, "133;A;moonlet_age=0".to_string()),
                (6, "133;C;moonlet_age=0".to_string()),
                (6, "133;D;0;moonlet_age=0".to_string()),
                (6, "133;A;moonlet_age=0".to_string()),
                (9, "133;C;moonlet_age=0".to_string()),
                (9, "133;D;0;moonlet_age=0".to_string()),
                (9, "7;file:///tmp".to_string()),
            ]
        );
    }

    /// `A`, two prompt rows, the command, `C`, one output row, `D`: four rows.
    fn block(cmd: &str) -> String {
        format!("\x1b]133;A\x07\r\n\r\n{cmd}\r\n\x1b]133;C\x07out\r\n\x1b]133;D;0\x07")
    }

    /// S2: once the scrollback is full, marks still land on their rows, and
    /// marks whose rows it dropped are gone.
    #[test]
    fn snapshot_marks_follow_a_full_scrollback() {
        let t0 = std::time::Instant::now();
        // Four blocks are 16 rows and the cursor's; 3 + 4 of them are kept.
        let mut t = TermState::with_scrollback(4, 20, 3);
        t.process_at(
            format!("{}{}{}{}", block("a"), block("b"), block("c"), block("d")).as_bytes(),
            t0,
        );
        assert_eq!(
            marks_by_line(&t.snapshot_at(t0)),
            vec![
                (1, "133;C;moonlet_age=0".to_string()),
                (2, "133;D;0;moonlet_age=0".to_string()),
                (2, "133;A;moonlet_age=0".to_string()),
                (5, "133;C;moonlet_age=0".to_string()),
                (6, "133;D;0;moonlet_age=0".to_string()),
            ]
        );
    }

    /// S2: a full reset clears the screen and scrollback, and their marks.
    #[test]
    fn snapshot_drops_marks_after_a_full_reset() {
        let t0 = std::time::Instant::now();
        let mut t = TermState::new(10, 20);
        t.process_at(
            format!("{}\x1bcbanner\r\n{}", block("a"), block("b")).as_bytes(),
            t0,
        );
        assert_eq!(
            marks_by_line(&t.snapshot_at(t0)),
            vec![
                (1, "133;A;moonlet_age=0".to_string()),
                (4, "133;C;moonlet_age=0".to_string()),
                (5, "133;D;0;moonlet_age=0".to_string()),
            ]
        );
    }

    /// S2: marks printed while a full-screen program has the alternate
    /// screen are not kept, and a snapshot of the alternate screen has none.
    #[test]
    fn snapshot_keeps_no_marks_from_the_alternate_screen() {
        let t0 = std::time::Instant::now();
        let mut t = TermState::new(10, 20);
        t.process_at(format!("{}\x1b[?1049h", block("a")).as_bytes(), t0);
        assert_eq!(marks_by_line(&t.snapshot_at(t0)), vec![]);
        // Below block `a`'s rows, so a kept mark would show.
        t.process_at(format!("\x1b[6;1H{}\x1b[?1049l", block("b")).as_bytes(), t0);
        assert_eq!(
            marks_by_line(&t.snapshot_at(t0)),
            vec![
                (0, "133;A;moonlet_age=0".to_string()),
                (3, "133;C;moonlet_age=0".to_string()),
                (4, "133;D;0;moonlet_age=0".to_string()),
            ]
        );
    }

    /// S2: `clear` homes the cursor and erases the screen, so the marks on
    /// the erased rows go; the blocks before, in the scrollback, stay.
    #[test]
    fn snapshot_drops_marks_a_clear_erased() {
        let t0 = std::time::Instant::now();
        // Blocks `a` and `b` are rows 0 to 8; the screen is rows 3 to 8.
        let mut t = TermState::new(6, 20);
        t.process_at(format!("{}{}", block("a"), block("b")).as_bytes(), t0);
        // `clear` runs from row 8; its erase leaves the screen at rows 6 to 11.
        t.process_at(b"\x1b]133;A\x07\r\n\r\nclear\r\n\x1b]133;C\x07\x1b[H\x1b[2J\x1b]133;D;0\x07\x1b]133;A\x07\r\n\r\n", t0);
        assert_eq!(
            marks_by_line(&t.snapshot_at(t0)),
            vec![
                (0, "133;A;moonlet_age=0".to_string()),
                (3, "133;C;moonlet_age=0".to_string()),
                (4, "133;D;0;moonlet_age=0".to_string()),
                (4, "133;A;moonlet_age=0".to_string()),
                (6, "133;A;moonlet_age=0".to_string()),
            ]
        );
    }

    /// S2, S3: the live upgrade replays the snapshot into a new daemon's
    /// state; the marks, their directories and their ages carry over.
    #[test]
    fn replayed_snapshot_keeps_marks_and_ages() {
        let t0 = std::time::Instant::now();
        let s = std::time::Duration::from_secs;
        let mut t = TermState::new(4, 20);
        t.process_at(
            b"\x1b]7;file://host/srv/app\x07\x1b]133;A\x07\r\n\r\necho hi\r\n",
            t0,
        );
        t.process_at(b"\x1b]133;C\x07hi\r\n", t0 + s(1));
        t.process_at(b"\x1b]133;D;0\x07\x1b]133;A\x07\r\n\r\n", t0 + s(3));
        let mut copy = TermState::new(4, 20);
        copy.process_at(&t.snapshot_at(t0 + s(10)), t0 + s(10));
        assert_eq!(
            marks_by_line(&copy.snapshot_at(t0 + s(15))),
            vec![
                (0, "133;A;moonlet_age=15000".to_string()),
                (3, "7;file:///srv/app".to_string()),
                (3, "133;C;moonlet_age=14000".to_string()),
                (4, "133;D;0;moonlet_age=12000".to_string()),
                (4, "133;A;moonlet_age=12000".to_string()),
            ]
        );
    }

    /// S2: a client attaching with fewer rows (a smaller new window) still
    /// gets the newest rows and their marks: the rows above the cursor go to
    /// the scrollback, as in xterm, rather than the rows below being cut.
    #[test]
    fn shrinking_the_screen_keeps_the_newest_rows_and_marks() {
        let t0 = std::time::Instant::now();
        // Blocks `a` and `b` are rows 0 to 8, the cursor on row 8.
        let mut t = TermState::new(10, 20);
        t.process_at(format!("{}{}", block("a"), block("b")).as_bytes(), t0);
        t.resize(4, 20);
        assert_eq!(t.contents(), "\nb\nout");
        assert_eq!(
            marks_by_line(&t.snapshot_at(t0)),
            vec![
                (0, "133;A;moonlet_age=0".to_string()),
                (3, "133;C;moonlet_age=0".to_string()),
                (4, "133;D;0;moonlet_age=0".to_string()),
                (4, "133;A;moonlet_age=0".to_string()),
                (7, "133;C;moonlet_age=0".to_string()),
                (8, "133;D;0;moonlet_age=0".to_string()),
            ]
        );
    }

    /// S2: a client attaching with more rows (a taller new window) gets the
    /// rows from the scrollback back on screen, as in xterm, not empty rows
    /// under the old ones; every mark keeps its line.
    #[test]
    fn growing_the_screen_brings_rows_back_from_the_scrollback() {
        let t0 = std::time::Instant::now();
        // Blocks `a` and `b` are rows 0 to 8; rows 0 to 4 are in the scrollback.
        let mut t = TermState::new(4, 20);
        t.process_at(format!("{}{}", block("a"), block("b")).as_bytes(), t0);
        t.resize(10, 20);
        assert_eq!(t.contents(), "\n\na\nout\n\n\nb\nout");
        assert_eq!(t.screen().cursor_position(), (8, 0));
        assert_eq!(
            marks_by_line(&t.snapshot_at(t0)),
            vec![
                (0, "133;A;moonlet_age=0".to_string()),
                (3, "133;C;moonlet_age=0".to_string()),
                (4, "133;D;0;moonlet_age=0".to_string()),
                (4, "133;A;moonlet_age=0".to_string()),
                (7, "133;C;moonlet_age=0".to_string()),
                (8, "133;D;0;moonlet_age=0".to_string()),
            ]
        );
    }

    /// S2: xterm drops the markers on rows it erases, so once the marks are
    /// written the snapshot redraws the screen over its rows without an
    /// erase-in-display, and the newest blocks, on screen, keep their marks.
    #[test]
    fn snapshot_never_erases_the_rows_its_marks_are_on() {
        let mut t = TermState::new(10, 20);
        t.process(format!("{}{}", block("a"), block("b")).as_bytes());
        let snap = String::from_utf8_lossy(&t.snapshot()).into_owned();
        let after = &snap[snap.rfind("\x1b]133;").unwrap()..];
        assert!(
            !after.contains("\x1b[J") && !after.contains("\x1b[2J"),
            "{after:?}"
        );
        // The screen still comes back exactly.
        assert_round_trip(&mut t);
    }
}
