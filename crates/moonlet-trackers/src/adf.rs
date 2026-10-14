//! Jira's Atlassian Document Format (descriptions, comments) as Markdown, so
//! a Jira issue reads like the others and its checklist becomes acceptance
//! criteria (X46).

use serde_json::Value;

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
