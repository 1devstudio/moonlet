//! Daemon-side terminal state. Every byte a PTY prints is fed through a
//! headless `vt100` emulator so a client that (re)attaches can be given a
//! snapshot of scrollback, screen, cursor and modes (S2).
//!
//! The emulator's callbacks also surface the terminal-level signals used
//! for agent state (A1): title changes, bells, OSC 7 (cwd), OSC 133 (shell
//! prompt marks) and OSC 9 / OSC 777 desktop notifications.

pub const DEFAULT_SCROLLBACK: usize = 10_000;

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
}

#[derive(Default)]
pub struct Signals {
    pending: Vec<Signal>,
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

    fn unhandled_osc(&mut self, _: &mut vt100::Screen, params: &[&[u8]]) {
        if let Some(signal) = parse_osc(params) {
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
}

impl TermState {
    pub fn new(rows: u16, cols: u16) -> Self {
        Self::with_scrollback(rows, cols, DEFAULT_SCROLLBACK)
    }

    pub fn with_scrollback(rows: u16, cols: u16, scrollback: usize) -> Self {
        Self {
            parser: vt100::Parser::new_with_callbacks(
                rows.max(1),
                cols.max(1),
                scrollback,
                Signals::default(),
            ),
            title: String::new(),
        }
    }

    /// Feeds PTY output; returns the signals it produced.
    pub fn process(&mut self, bytes: &[u8]) -> Vec<Signal> {
        self.parser.process(bytes);
        let signals = std::mem::take(&mut self.parser.callbacks_mut().pending);
        for s in &signals {
            if let Signal::Title(t) = s {
                self.title = t.clone();
            }
        }
        signals
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.parser.screen_mut().set_size(rows.max(1), cols.max(1));
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
        let mut out = Vec::new();
        // Full reset of the receiving terminal, then default attributes.
        out.extend_from_slice(b"\x1bc\x1b[0m");
        let alternate = self.parser.screen().alternate_screen();
        if !alternate {
            self.write_scrollback(&mut out);
        } else {
            out.extend_from_slice(b"\x1b[?1049h");
        }
        let screen = self.parser.screen();
        out.extend_from_slice(&screen.contents_formatted());
        out.extend_from_slice(&screen.input_mode_formatted());
        out
    }

    fn write_scrollback(&mut self, out: &mut Vec<u8>) {
        let screen = self.parser.screen_mut();
        let (rows, cols) = screen.size();
        screen.set_scrollback(usize::MAX);
        let total = screen.scrollback();
        if total == 0 {
            screen.set_scrollback(0);
            return;
        }
        let mut offset = total;
        while offset > 0 {
            screen.set_scrollback(offset);
            let take = offset.min(rows as usize);
            for row in screen.rows_formatted(0, cols).take(take) {
                out.extend_from_slice(&row);
                out.extend_from_slice(b"\x1b[0m\r\n");
            }
            offset -= take;
        }
        screen.set_scrollback(0);
        // Push everything printed so far off the visible area into scrollback;
        // the screen redraw that follows starts with a clear.
        for _ in 0..rows {
            out.push(b'\n');
        }
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
}
