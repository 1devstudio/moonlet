//! A design's page read as HTML, for the canvas's red "did not load" bar
//! (X65): the first place where the page goes wrong as HTML, and its line.
//!
//! Only the tokenizer's errors count: a quote, a comment or a `<script>`
//! never closed, a stray `<` or quote in a tag. They are the ones that can
//! swallow the rest of a page, the editor bridge with it. The tree
//! builder's (an unclosed `<p>`, a stray `</div>`, no doctype) are left
//! out: browsers fix them silently, and every real page has some.

use std::cell::{Cell, RefCell};

use html5ever::tokenizer::states::RawKind;
use html5ever::tokenizer::{
    BufferQueue, EndTag, Token, TokenSink, TokenSinkResult, Tokenizer, TokenizerOpts,
};
use moonlet_proto::methods::DesignParseError;

/// The page's first parse error, or none. An error inside a tag, a comment
/// or the doctype is on the line where that starts, so a quote never closed
/// is found where it opened, not at the end of the page.
pub fn first_parse_error(html: &str) -> Option<DesignParseError> {
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

struct Sink {
    first: RefCell<Option<DesignParseError>>,
    /// The line of the last token: where a tag or comment being read starts.
    last_line: Cell<u64>,
    /// The element whose text is read raw (`<script>`, `<style>`, `<title>`…),
    /// and its line, until its end tag.
    raw: RefCell<Option<(String, u64)>>,
}

impl Sink {
    fn found(&self, line: u64, message: String) {
        let mut first = self.first.borrow_mut();
        if first.is_none() {
            *first = Some(DesignParseError {
                line: u32::try_from(line).unwrap_or(u32::MAX),
                message,
            });
        }
    }
}

impl TokenSink for Sink {
    type Handle = ();

    fn process_token(&self, token: Token, line: u64) -> TokenSinkResult<()> {
        match token {
            Token::ParseError(e) => {
                let (message, in_tag) = plain(&e);
                self.found(if in_tag { self.last_line.get() } else { line }, message);
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
                    self.found(at, format!("<{name}> is never closed"));
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

/// html5ever's error said plainly, and whether it is inside a tag, a
/// comment or the doctype. Its errors read "Saw <what> in state <state>".
fn plain(error: &str) -> (String, bool) {
    if error == "Duplicate attribute" {
        return ("an attribute given twice".into(), false);
    }
    let Some((saw, state)) = error
        .strip_prefix("Saw ")
        .and_then(|r| r.split_once(" in state "))
    else {
        return (error.to_string(), false);
    };
    let in_text = ["Data", "Plaintext", "Raw", "ScriptData", "Cdata"]
        .iter()
        .any(|s| state.starts_with(s));
    let unquoted = state == "AttributeValue(Unquoted)";
    let in_name = matches!(
        state,
        "BeforeAttributeName" | "AttributeName" | "AfterAttributeName"
    ) || unquoted;
    let message = match saw {
        "EOF" if state.starts_with("AttributeValue") && !unquoted => {
            "an attribute's quote is never closed".to_string()
        }
        "EOF" if state.contains("Comment") || state == "MarkupDeclarationOpen" => {
            "a comment is never closed".into()
        }
        "EOF" if state.contains("Doctype") => "the doctype is never closed".into(),
        "EOF" if !in_text => "a tag is never closed".into(),
        "<" if in_name => "a stray < inside a tag".into(),
        q @ ("\"" | "'") if in_name => format!("a stray {q} inside a tag"),
        _ if state == "AfterAttributeValueQuoted" => {
            "no space after an attribute's quoted value".into()
        }
        _ => error.to_string(),
    };
    (message, !in_text)
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
    fn an_attribute_quote_never_closed_is_reported_on_the_line_of_its_tag() {
        let page = "<!doctype html>\n<html>\n<body>\n<p>Hi\n<div class=\"x\n<p>more</p>\n</body>\n</html>\n";
        assert_eq!(
            first_parse_error(page),
            error(5, "an attribute's quote is never closed")
        );
    }

    #[test]
    fn a_stray_lt_in_a_tag_is_reported_on_the_line_its_tag_starts() {
        let page = "<!doctype html>\n<body>\n<div\n  class=\"a\"\n  <span>x</span>\n</body>\n";
        assert_eq!(first_parse_error(page), error(3, "a stray < inside a tag"));
    }

    #[test]
    fn a_quote_closed_lines_later_is_reported_on_the_line_of_its_tag() {
        let page = "<!doctype html>\n<html lang=\"en>\n<head>\n<meta charset=\"utf-8\">\n<title>x</title>\n</head>\n<body><p>Hi</p></body>\n</html>\n";
        assert_eq!(
            first_parse_error(page),
            error(2, "no space after an attribute's quoted value")
        );
    }

    #[test]
    fn a_comment_or_a_script_never_closed_is_reported_where_it_opens() {
        let comment = "<!doctype html>\n<body>\n<!-- the nav\n<nav>x</nav>\n</body>\n";
        assert_eq!(
            first_parse_error(comment),
            error(3, "a comment is never closed")
        );
        let script = "<!doctype html>\n<head><title>x</title>\n<script>\nlet a = 1;\n</head>\n<body><p>x</p>\n";
        assert_eq!(
            first_parse_error(script),
            error(3, "<script> is never closed")
        );
    }

    #[test]
    fn a_page_with_only_errors_a_browser_fixes_as_it_builds_the_page_has_none() {
        // No doctype, an unclosed <p>, a stray </div>, misnested tags, a bare
        // &, and a < in a script and a > in a style: what every real page has.
        let page = "<html><head><script>if (a < b && c) {}</script><style>a>b{}</style></head>\n<body><p>Tom & Jerry\n</div>\n<p>x<b>y</p></b>\n</body>\n";
        assert_eq!(first_parse_error(page), None);
    }
}
