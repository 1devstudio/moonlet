//! Jira's Atlassian Document Format (descriptions, comments) as Markdown, so
//! a Jira issue reads like the others and its checklist becomes acceptance
//! criteria (X46).

use serde_json::{Value, json};

/// Markdown for an ADF document; unknown nodes keep their text.
pub fn to_markdown(doc: &Value) -> String {
    blocks(doc).join("\n\n")
}

fn children(node: &Value) -> impl Iterator<Item = &Value> {
    node["content"].as_array().into_iter().flatten()
}

/// The block-level nodes of `node` as Markdown blocks.
fn blocks(node: &Value) -> Vec<String> {
    children(node)
        .filter_map(|n| {
            let text = match n["type"].as_str()? {
                "paragraph" => inline(n),
                "heading" => {
                    let level = n["attrs"]["level"].as_u64().unwrap_or(1).clamp(1, 6) as usize;
                    format!("{} {}", "#".repeat(level), inline(n))
                }
                "bulletList" => list(n, |_| "- ".into()),
                "orderedList" => list(n, |i| format!("{}. ", i + 1)),
                "taskList" => children(n)
                    .map(|item| {
                        let done = item["attrs"]["state"].as_str() == Some("DONE");
                        format!("- [{}] {}", if done { "x" } else { " " }, inline(item))
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
                "codeBlock" => format!(
                    "```{}\n{}\n```",
                    n["attrs"]["language"].as_str().unwrap_or(""),
                    inline(n)
                ),
                "blockquote" => blocks(n)
                    .iter()
                    .map(|b| format!("> {b}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
                "rule" => "---".into(),
                _ => blocks(n).join("\n\n"),
            };
            (!text.is_empty()).then_some(text)
        })
        .collect()
}

/// A list's items, each its first line prefixed and nested blocks indented.
fn list(node: &Value, prefix: impl Fn(usize) -> String) -> String {
    children(node)
        .enumerate()
        .map(|(i, item)| {
            let mut parts = blocks(item).into_iter();
            let first = parts.next().unwrap_or_default();
            let rest: Vec<String> = parts
                .map(|p| {
                    p.lines()
                        .map(|l| format!("  {l}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .collect();
            std::iter::once(format!("{}{first}", prefix(i)))
                .chain(rest)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The inline content of `node` (text with marks, mentions, breaks).
fn inline(node: &Value) -> String {
    children(node)
        .map(|n| match n["type"].as_str() {
            Some("text") => {
                let mut t = n["text"].as_str().unwrap_or("").to_string();
                for m in n["marks"].as_array().into_iter().flatten() {
                    t = match m["type"].as_str() {
                        Some("strong") => format!("**{t}**"),
                        Some("em") => format!("*{t}*"),
                        Some("code") => format!("`{t}`"),
                        Some("strike") => format!("~~{t}~~"),
                        Some("link") => {
                            format!("[{t}]({})", m["attrs"]["href"].as_str().unwrap_or(""))
                        }
                        _ => t,
                    };
                }
                t
            }
            Some("hardBreak") => "\n".into(),
            Some("mention") => n["attrs"]["text"].as_str().unwrap_or("").into(),
            Some("emoji") => n["attrs"]["text"].as_str().unwrap_or("").into(),
            Some("inlineCard") => n["attrs"]["url"].as_str().unwrap_or("").into(),
            _ => inline(n),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_as_an_atlassian_document() {
        let md = "Retry **failed** deliveries, see [the runbook](https://example.com/runbook).\nThen `requeue`.\n\n- back off\n- *log* each try\n\n```\nretry(3)\n```";
        assert_eq!(
            from_markdown(md),
            json!({ "type": "doc", "version": 1, "content": [
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "Retry " },
                    { "type": "text", "text": "failed", "marks": [{ "type": "strong" }] },
                    { "type": "text", "text": " deliveries, see " },
                    { "type": "text", "text": "the runbook", "marks": [{ "type": "link", "attrs": { "href": "https://example.com/runbook" } }] },
                    { "type": "text", "text": "." },
                    { "type": "hardBreak" },
                    { "type": "text", "text": "Then " },
                    { "type": "text", "text": "requeue", "marks": [{ "type": "code" }] },
                    { "type": "text", "text": "." }
                ] },
                { "type": "bulletList", "content": [
                    { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "back off" }] }] },
                    { "type": "listItem", "content": [{ "type": "paragraph", "content": [
                        { "type": "text", "text": "log", "marks": [{ "type": "em" }] },
                        { "type": "text", "text": " each try" }
                    ] }] }
                ] },
                { "type": "codeBlock", "content": [{ "type": "text", "text": "retry(3)" }] }
            ] })
        );
    }

    #[test]
    fn markdown_with_accents_emoji_and_stray_marks_stays_text() {
        assert_eq!(
            from_markdown("Café **déjà vu** 🚀 *lone"),
            json!({ "type": "doc", "version": 1, "content": [{ "type": "paragraph", "content": [
                { "type": "text", "text": "Café " },
                { "type": "text", "text": "déjà vu", "marks": [{ "type": "strong" }] },
                { "type": "text", "text": " 🚀 *lone" }
            ] }] })
        );
        // An unclosed fence keeps its lines as code.
        assert_eq!(
            from_markdown("```\nretry(3)")["content"][0]["type"],
            "codeBlock"
        );
    }

    #[test]
    fn underscores_and_stars_inside_words_stay_text_and_nothing_empty_is_sent() {
        assert_eq!(
            from_markdown("snake_case_name and 2 * 3 * 4"),
            json!({ "type": "doc", "version": 1, "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "snake_case_name and 2 * 3 * 4" }] }] })
        );
        // An empty fence sends no code block; a link with no text shows its address.
        assert_eq!(
            from_markdown("```\n```\n\n[](https://example.com)"),
            json!({ "type": "doc", "version": 1, "content": [{ "type": "paragraph", "content": [
                { "type": "text", "text": "https://example.com", "marks": [{ "type": "link", "attrs": { "href": "https://example.com" } }] }
            ] }] })
        );
    }

    use serde_json::json;

    #[test]
    fn paragraphs_marks_lists_and_task_items() {
        let doc = json!({
            "type": "doc", "version": 1,
            "content": [
                {"type": "paragraph", "content": [
                    {"type": "text", "text": "Hand open PTYs to the "},
                    {"type": "text", "text": "new", "marks": [{"type": "strong"}]},
                    {"type": "text", "text": " daemon. See "},
                    {"type": "text", "text": "S3", "marks": [{"type": "link", "attrs": {"href": "https://example.com/s3"}}]},
                    {"type": "text", "text": " and "},
                    {"type": "text", "text": "moonletd", "marks": [{"type": "code"}]}
                ]},
                {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Acceptance criteria"}]},
                {"type": "bulletList", "content": [
                    {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Sessions never drop"}]}]},
                    {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Old daemon exits"}]}]}
                ]},
                {"type": "taskList", "attrs": {"localId": "a"}, "content": [
                    {"type": "taskItem", "attrs": {"localId": "b", "state": "DONE"}, "content": [{"type": "text", "text": "Spec updated"}]},
                    {"type": "taskItem", "attrs": {"localId": "c", "state": "TODO"}, "content": [{"type": "text", "text": "e2e test"}]}
                ]},
                {"type": "codeBlock", "attrs": {"language": "sh"}, "content": [{"type": "text", "text": "moonletd upgrade"}]}
            ]
        });
        assert_eq!(
            to_markdown(&doc),
            "Hand open PTYs to the **new** daemon. See [S3](https://example.com/s3) and `moonletd`\n\n\
             ## Acceptance criteria\n\n\
             - Sessions never drop\n\
             - Old daemon exits\n\n\
             - [x] Spec updated\n\
             - [ ] e2e test\n\n\
             ```sh\nmoonletd upgrade\n```"
        );
    }

    #[test]
    fn no_description_is_empty() {
        assert_eq!(to_markdown(&serde_json::Value::Null), "");
    }
}

/// An ADF document for Markdown (X52: a new Jira issue's description):
/// paragraphs with their line breaks, bullet lists, fenced code blocks, and
/// bold, italic, inline code and links; anything else stays as its text.
pub fn from_markdown(markdown: &str) -> Value {
    let mut content = Vec::new();
    let lines: Vec<&str> = markdown.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            i += 1;
        } else if line.trim_start().starts_with("```") {
            let mut code = Vec::new();
            i += 1;
            while i < lines.len() && !lines[i].trim_start().starts_with("```") {
                code.push(lines[i]);
                i += 1;
            }
            i += 1;
            // An empty fence sends nothing: ADF's text nodes can't be empty.
            if !code.is_empty() {
                content.push(json!({ "type": "codeBlock", "content": [{ "type": "text", "text": code.join("\n") }] }));
            }
        } else if bullet(line).is_some() {
            let mut items = Vec::new();
            while let Some(item) = lines.get(i).and_then(|l| bullet(l)) {
                items.push(json!({ "type": "listItem", "content": [{ "type": "paragraph", "content": marked_text(item) }] }));
                i += 1;
            }
            content.push(json!({ "type": "bulletList", "content": items }));
        } else {
            let mut nodes = Vec::new();
            while let Some(l) = lines.get(i).filter(|l| {
                !l.trim().is_empty() && bullet(l).is_none() && !l.trim_start().starts_with("```")
            }) {
                if !nodes.is_empty() {
                    nodes.push(json!({ "type": "hardBreak" }));
                }
                nodes.extend(marked_text(l));
                i += 1;
            }
            content.push(json!({ "type": "paragraph", "content": nodes }));
        }
    }
    json!({ "type": "doc", "version": 1, "content": content })
}

/// A bullet list item's text (`- ` or `* `).
fn bullet(line: &str) -> Option<&str> {
    let t = line.trim_start();
    t.strip_prefix("- ").or_else(|| t.strip_prefix("* "))
}

/// A line's text nodes with their marks: `**strong**`, `*em*` or `_em_`,
/// `` `code` ``, `[text](href)`.
fn marked_text(line: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut plain = String::new();
    let mut rest = line;
    // The character before `rest`, for marks that need a word boundary.
    let mut prev: Option<char> = None;
    let flush = |plain: &mut String, out: &mut Vec<Value>| {
        if !plain.is_empty() {
            out.push(json!({ "type": "text", "text": std::mem::take(plain) }));
        }
    };
    let word = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
    while let Some(c) = rest.chars().next() {
        // Emphasis opens before a non-space and closes after one; `_` and a lone
        // `*` also need a word boundary, so `snake_case` and `2 * 3` stay text.
        let marked =
            |open: &str, close: &str, bounded: bool, mark: Value| -> Option<(Value, usize)> {
                let body = rest.strip_prefix(open)?;
                if bounded && word(prev) || body.chars().next().is_none_or(char::is_whitespace) {
                    return None;
                }
                let end = body.find(close).filter(|&e| e > 0)?;
                let text = &body[..end];
                let after = body[end + close.len()..].chars().next();
                if text.chars().last().is_some_and(char::is_whitespace) || bounded && word(after) {
                    return None;
                }
                Some((
                    json!({ "type": "text", "text": text, "marks": [mark] }),
                    open.len() + end + close.len(),
                ))
            };
        let code = || -> Option<(Value, usize)> {
            let body = rest.strip_prefix('`')?;
            let end = body.find('`').filter(|&e| e > 0)?;
            Some((
                json!({ "type": "text", "text": &body[..end], "marks": [{ "type": "code" }] }),
                end + 2,
            ))
        };
        let link = || -> Option<(Value, usize)> {
            let body = rest.strip_prefix('[')?;
            let text_end = body.find("](")?;
            let href_end = body[text_end + 2..].find(')')?;
            let href = &body[text_end + 2..text_end + 2 + href_end];
            // A link with no text shows its address: ADF's text can't be empty.
            let text = if text_end == 0 {
                href
            } else {
                &body[..text_end]
            };
            let node = json!({ "type": "text", "text": text, "marks": [{ "type": "link", "attrs": { "href": href } }] });
            Some((node, 1 + text_end + 2 + href_end + 1))
        };
        let found = match c {
            '*' if rest.starts_with("**") => marked("**", "**", false, json!({ "type": "strong" })),
            '*' => marked("*", "*", true, json!({ "type": "em" })),
            '_' => marked("_", "_", true, json!({ "type": "em" })),
            '`' => code(),
            '[' => link(),
            _ => None,
        };
        match found {
            Some((node, len)) => {
                flush(&mut plain, &mut out);
                out.push(node);
                prev = rest[..len].chars().last();
                rest = &rest[len..];
            }
            None => {
                plain.push(c);
                prev = Some(c);
                rest = &rest[c.len_utf8()..];
            }
        }
    }
    flush(&mut plain, &mut out);
    out
}
