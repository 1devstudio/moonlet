//! A design's page read as HTML, for the canvas's red "did not load" bar
//! (X65): where the page's markup swallows the editor bridge, and its line.
//!
//! Only what can swallow the rest of the page counts: a quote, a comment,
//! a tag or a `<script>`, `<style>` or `<title>` never closed, so the page
//! ends inside it, or that closes only after the bridge, which it then
//! swallows. And only when it is open at the byte where the scheme
//! puts the bridge, first in the page's `<head>` (`with_script` in the
//! app's design_scheme.rs), found by reading the page up to that byte: one
//! that opens after it, on the same line too, leaves the bridge running,
//! and the page loads. The tokenizer's other errors (a stray `<` or quote
//! in a tag, no space after a quoted value, an attribute given twice) and
//! the tree builder's (an unclosed `<p>`, a stray `</div>`, no doctype)
//! are left out: browsers recover from them, and every real page has some.

use std::cell::{Cell, RefCell};

use html5ever::tokenizer::states::RawKind;
use html5ever::tokenizer::{
    BufferQueue, EndTag, Token, TokenSink, TokenSinkResult, Tokenizer, TokenizerOpts,
};
use moonlet_proto::methods::DesignParseError;

/// Where the page's markup swallows the bridge, or none. It is on the line
/// where what swallows it starts, so a quote never closed is found where it
/// opened, not at the end of the page; one closed only after the bridge,
/// such as by the next quote in the page, is said to be not closed before
/// the tag the bridge follows.
pub fn first_parse_error(html: &str) -> Option<DesignParseError> {
    // What is open where the bridge goes in, the page read up to that byte.
    let (at, tag) = bridge_at(html);
    let open = open_at_end(&html[..at])?;
    let message = if open_at_end(html).as_ref() == Some(&open) {
        format!("{} is never closed", open.what)
    } else {
        format!("{} is not closed before {tag}", open.what)
    };
    Some(DesignParseError {
        line: u32::try_from(open.line).unwrap_or(u32::MAX),
        message,
    })
}

/// What a page is inside of, where it opens.
#[derive(Debug, PartialEq)]
struct Open {
    line: u64,
    what: What,
}

/// What can swallow the rest of a page, said plainly.
#[derive(Debug, PartialEq)]
enum What {
    Quote,
    Comment,
    Doctype,
    Tag,
    /// A `<script>`, `<style>`, `<title>`… whose text is read raw.
    Raw(String),
}

impl std::fmt::Display for What {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            What::Quote => f.write_str("an attribute's quote"),
            What::Comment => f.write_str("a comment"),
            What::Doctype => f.write_str("the doctype"),
            What::Tag => f.write_str("a tag"),
            What::Raw(name) => write!(f, "<{name}>"),
        }
    }
}

/// What `html` ends inside of, a quote, a comment, a tag, the doctype or a
/// raw-text element, with the line where it opens; none when it ends in
/// the page's text.
fn open_at_end(html: &str) -> Option<Open> {
    let sink = Sink {
        first: RefCell::new(None),
        last_line: Cell::new(1),
        raw: RefCell::new(None),
    };
    let tokenizer = Tokenizer::new(sink, TokenizerOpts::default());
    let input = BufferQueue::default();
    input.push_back(html.into());
    let _ = tokenizer.feed(&input);
    tokenizer.end();
    tokenizer.sink.first.take()
}

/// The byte the scheme puts the bridge at, and the tag it follows: just
/// after the `>` of the first `<head`, else of `<html`, else of the
/// doctype, else the start, as `with_script` finds them, in the bytes.
fn bridge_at(html: &str) -> (usize, &'static str) {
    let lower = html.to_ascii_lowercase();
    let after = |tag: &str| {
        let mut from = 0;
        while let Some(i) = lower[from..].find(tag).map(|i| from + i) {
            let next = lower.as_bytes().get(i + tag.len()).copied();
            if matches!(next, Some(b'>' | b'/' | b' ' | b'\t' | b'\n' | b'\r')) {
                return lower[i..].find('>').map(|j| i + j + 1);
            }
            from = i + tag.len();
        }
        None
    };
    [
        ("<head", "<head>"),
        ("<html", "<html>"),
        ("<!doctype", "the doctype"),
    ]
    .into_iter()
    .find_map(|(tag, said)| after(tag).map(|at| (at, said)))
    .unwrap_or((0, "the page"))
}

struct Sink {
    first: RefCell<Option<Open>>,
    /// The line of the last token: where a tag or comment being read starts.
    last_line: Cell<u64>,
    /// The element whose text is read raw (`<script>`, `<style>`, `<title>`…),
    /// and its line, until its end tag.
    raw: RefCell<Option<(String, u64)>>,
}

impl Sink {
    fn found(&self, line: u64, what: What) {
        let mut first = self.first.borrow_mut();
        if first.is_none() {
            *first = Some(Open { line, what });
        }
    }
}

impl TokenSink for Sink {
    type Handle = ();

    fn process_token(&self, token: Token, line: u64) -> TokenSinkResult<()> {
        match token {
            Token::ParseError(e) => {
                // Where what swallows the page starts: the last token's line.
                if let Some(what) = swallowed_by(&e) {
                    self.found(self.last_line.get(), what);
                }
                return TokenSinkResult::Continue;
            }
            Token::TagToken(tag) => {
                let name = tag.name.to_string();
                if tag.kind == EndTag {
                    let closes = self.raw.borrow().as_ref().is_some_and(|(r, _)| *r == name);
                    if closes {
                        *self.raw.borrow_mut() = None;
                    }
                } else if let Some(kind) = raw_kind(&name) {
                    // What the tree builder would tell the tokenizer: this
                    // element's text is not markup.
                    *self.raw.borrow_mut() = Some((name, line));
                    self.last_line.set(line);
                    return TokenSinkResult::RawData(kind);
                }
            }
            Token::EOFToken => {
                if let Some((name, at)) = self.raw.borrow_mut().take() {
                    self.found(at, What::Raw(name));
                }
            }
            _ => {}
        }
        self.last_line.set(line);
        TokenSinkResult::Continue
    }
}

/// How the text of an element named `name` is read, when not as markup.
fn raw_kind(name: &str) -> Option<RawKind> {
    match name {
        "script" => Some(RawKind::ScriptData),
        "style" | "xmp" | "iframe" | "noembed" | "noframes" | "noscript" => Some(RawKind::Rawtext),
        "title" | "textarea" => Some(RawKind::Rcdata),
        _ => None,
    }
}

/// What swallows the rest of the page, when html5ever's error is that
/// the page ends inside a tag, a quote, a comment or the doctype; none for
/// any other error, a browser recovering from those. html5ever gives its
/// errors as text only, "Saw EOF in state <state>"; its text is never
/// shown as it is.
fn swallowed_by(error: &str) -> Option<What> {
    let state = error.strip_prefix("Saw EOF in state ")?;
    let in_text = ["Data", "Plaintext", "Raw", "ScriptData", "Cdata"]
        .iter()
        .any(|s| state.starts_with(s));
    Some(match state {
        _ if in_text => return None,
        "AttributeValue(DoubleQuoted)" | "AttributeValue(SingleQuoted)" => What::Quote,
        s if s.contains("Comment") || s == "MarkupDeclarationOpen" => What::Comment,
        s if s.contains("Doctype") => What::Doctype,
        _ => What::Tag,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error(line: u32, message: &str) -> Option<DesignParseError> {
        Some(DesignParseError {
            line,
            message: message.into(),
        })
    }

    #[test]
    fn an_attribute_quote_never_closed_before_the_bridge_is_reported_on_the_line_of_its_tag() {
        // The bridge goes in after <head>, here inside the quote.
        let page = "<!doctype html>\n<html lang=\"en>\n<head><title>Settings</title></head>\n<body><h1>Settings</h1></body>\n</html>\n";
        assert_eq!(
            first_parse_error(page),
            error(2, "an attribute's quote is never closed")
        );
    }

    #[test]
    fn a_slip_a_browser_recovers_from_in_a_tag_is_not_reported() {
        for page in [
            // A stray < in a tag.
            "<!doctype html>\n<html><head></head>\n<body><div\n  class=\"a\"\n  <span>x</span></body>\n",
            // No space after a quoted value, and an attribute given twice.
            "<!doctype html>\n<html><head></head>\n<body><p class=\"a\"title=\"b\" id=x id=y>x</p></body>\n",
        ] {
            assert_eq!(first_parse_error(page), None, "{page}");
        }
    }

    #[test]
    fn a_comment_or_a_script_never_closed_before_the_bridge_is_reported_where_it_opens() {
        let comment = "<!doctype html>\n<!-- the head\n<html><head><title>x</title></head>\n<body><nav>x</nav></body>\n";
        assert_eq!(
            first_parse_error(comment),
            error(2, "a comment is never closed")
        );
        let script = "<!doctype html>\n<script>\nlet a = 1;\n<head><title>x</title></head>\n<body><p>x</p>\n";
        assert_eq!(
            first_parse_error(script),
            error(2, "<script> is never closed")
        );
    }

    #[test]
    fn a_comment_or_a_script_never_closed_after_the_bridge_is_not_reported() {
        // The bridge, first in <head>, runs: the page loads, whatever its body swallows.
        let comment = "<!doctype html>\n<html><head><title>x</title></head>\n<body>\n<!-- the nav\n<nav>x</nav>\n</body>\n";
        assert_eq!(first_parse_error(comment), None);
        let script = "<!doctype html>\n<head><title>x</title>\n<script>\nlet a = 1;\n</head>\n<body><p>x</p>\n";
        assert_eq!(first_parse_error(script), None);
    }

    #[test]
    fn a_quote_comment_or_script_closed_only_after_the_bridge_is_reported_where_it_opens() {
        // The bridge goes in after <head>, inside the quote that charset=" closes.
        let quote = "<!doctype html>\n<html lang=\"en>\n<head><meta charset=\"utf-8\"><title>x</title></head>\n<body><p>Hi</p></body>\n";
        assert_eq!(
            first_parse_error(quote),
            error(2, "an attribute's quote is not closed before <head>")
        );
        let comment =
            "<!doctype html>\n<!-- the old head\n<html><head>\n-->\n<body><p>Hi</p></body>\n";
        assert_eq!(
            first_parse_error(comment),
            error(2, "a comment is not closed before <head>")
        );
        let script = "<!doctype html>\n<html><script>\nlet head = \"<head>\";\n</script>\n<body><p>Hi</p></body>\n";
        assert_eq!(
            first_parse_error(script),
            error(2, "<script> is not closed before <head>")
        );
    }

    #[test]
    fn a_comment_or_a_script_opened_after_the_bridge_on_its_line_is_not_reported() {
        // The bridge goes in just after <head>, before what opens later on its line.
        let comment = "<!doctype html>\n<html><head><!-- the head\n<title>x</title>\n";
        assert_eq!(first_parse_error(comment), None);
        let script = "<!doctype html>\n<html><head><script>\nlet a = 1;\n</head>\n<body><p>x</p>\n";
        assert_eq!(first_parse_error(script), None);
    }

    #[test]
    fn a_page_with_only_errors_a_browser_fixes_as_it_builds_the_page_has_none() {
        // No doctype, an unclosed <p>, a stray </div>, misnested tags, a bare
        // &, and a < in a script and a > in a style: what every real page has.
        let page = "<html><head><script>if (a < b && c) {}</script><style>a>b{}</style></head>\n<body><p>Tom & Jerry\n</div>\n<p>x<b>y</p></b>\n</body>\n";
        assert_eq!(first_parse_error(page), None);
    }
}
