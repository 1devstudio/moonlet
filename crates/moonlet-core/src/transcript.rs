//! Claude Code's own transcript of a conversation (X72): where it keeps
//! it, which of its files a copy may hold, and how much of it is whole.
//!
//! Claude Code keeps a conversation as `<config>/projects/<folder>/<id>.jsonl`,
//! one JSON object per line, beside a `<id>/` folder for its subagents and
//! long tool results. `<folder>` is the working directory, resolved, with
//! every character but a letter or a digit as `-`: `/tmp/x` is
//! `-private-tmp-x` on macOS.

use std::path::Path;

/// The folder under `projects/` Claude Code uses for a working directory.
/// A path that exists is resolved first, as Claude Code does.
pub fn project_folder(path: &Path) -> String {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    path.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Whether `name` is one of conversation `id`'s transcript files, relative
/// to its project folder: `<id>.jsonl`, or a file below `<id>/` whose every
/// part is a plain name. `id` must be a UUID, never a path.
pub fn file_ok(name: &str, id: &str) -> bool {
    let plain = |part: &str| {
        !part.is_empty()
            && !part.starts_with('.')
            && part.len() <= 200
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    };
    if !is_uuid(id) {
        return false;
    }
    if name == format!("{id}.jsonl") {
        return true;
    }
    let Some(rest) = name.strip_prefix(&format!("{id}/")) else {
        return false;
    };
    let parts: Vec<&str> = rest.split('/').collect();
    parts.len() <= 4 && parts.iter().all(|p| plain(p))
}

/// Whether `id` is a UUID, as a Claude Code conversation id is.
pub fn is_uuid(id: &str) -> bool {
    id.len() == 36
        && id.chars().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// How many bytes of transcript `text` are whole for a checkpoint: up to
/// the end of the last line holding a tool's result, or, once the turn is
/// over, every complete line. Lines after a tool's result belong to a step
/// whose files may not be on disk yet.
pub fn checkpoint_len(text: &str, turn_over: bool) -> usize {
    let whole = text.rfind('\n').map_or(0, |i| i + 1);
    if turn_over {
        return whole;
    }
    let mut end = 0;
    let mut at = 0;
    for line in text[..whole].split_inclusive('\n') {
        at += line.len();
        if is_tool_result(line) {
            end = at;
        }
    }
    end
}

/// Whether a transcript line is a user message carrying a tool's result.
fn is_tool_result(line: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    v["type"] == "user"
        && v["message"]["content"]
            .as_array()
            .is_some_and(|c| c.iter().any(|b| b["type"] == "tool_result"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lines shaped as Claude Code 2.1.312 writes them (captured, trimmed to
    /// the fields that matter and with the account's details removed).
    const PROMPT: &str = r#"{"type":"user","message":{"role":"user","content":"Run the tests"},"uuid":"4373b715-43b3-4edb-aabf-d7737f6fbdbd","sessionId":"215b6667-af95-41f9-868a-7f5bec7956f5","cwd":"/Users/alex/.moonlet/worktrees/shop/fix-cart"}
"#;
    const TOOL_USE: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Bash","input":{"command":"pnpm test"}}]},"uuid":"c54d86db-44fe-44b7-9906-bb02b8c48557","sessionId":"215b6667-af95-41f9-868a-7f5bec7956f5"}
"#;
    const TOOL_RESULT: &str = r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01","type":"tool_result","content":"44 passed"}]},"toolUseResult":{"stdout":"44 passed"},"uuid":"9a1b2c3d-0000-4000-8000-000000000001","sessionId":"215b6667-af95-41f9-868a-7f5bec7956f5"}
"#;
    const ANSWER: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"All 44 pass."}]},"uuid":"9a1b2c3d-0000-4000-8000-000000000002","sessionId":"215b6667-af95-41f9-868a-7f5bec7956f5"}
"#;

    #[test]
    fn a_working_directory_maps_to_claude_codes_project_folder() {
        // Captured from ~/.claude/projects on a Mac, with the user's name
        // replaced.
        assert_eq!(
            project_folder(Path::new("/Users/alex/.moonlet/worktrees/shop/fix-cart")),
            "-Users-alex--moonlet-worktrees-shop-fix-cart"
        );
        assert_eq!(
            project_folder(Path::new("/private/tmp/claude-501/scratch")),
            "-private-tmp-claude-501-scratch"
        );
    }

    #[test]
    fn only_the_conversations_own_files_are_transcript_files() {
        let id = "215b6667-af95-41f9-868a-7f5bec7956f5";
        assert!(file_ok("215b6667-af95-41f9-868a-7f5bec7956f5.jsonl", id));
        assert!(file_ok(
            "215b6667-af95-41f9-868a-7f5bec7956f5/subagents/agent-a1.jsonl",
            id
        ));
        assert!(file_ok(
            "215b6667-af95-41f9-868a-7f5bec7956f5/tool-results/r1.txt",
            id
        ));
        assert!(!file_ok(
            "215b6667-af95-41f9-868a-7f5bec7956f5/../other.jsonl",
            id
        ));
        assert!(!file_ok("215b6667-af95-41f9-868a-7f5bec7956f5/.hidden", id));
        assert!(!file_ok("7855d4dc-6602-4a07-a4e8-7274d27b6c89.jsonl", id));
        assert!(!file_ok("../x.jsonl", "../x"));
    }

    #[test]
    fn a_checkpoint_ends_after_the_last_tool_result_while_a_turn_runs() {
        let text = [PROMPT, TOOL_USE, TOOL_RESULT, ANSWER].concat();
        let through_result = [PROMPT, TOOL_USE, TOOL_RESULT].concat().len();
        assert_eq!(checkpoint_len(&text, false), through_result);
        assert_eq!(checkpoint_len(&[PROMPT, TOOL_USE].concat(), false), 0);
    }

    #[test]
    fn a_finished_turn_checkpoints_every_whole_line() {
        let text = [PROMPT, TOOL_USE, TOOL_RESULT, ANSWER].concat();
        assert_eq!(checkpoint_len(&text, true), text.len());
        let half = format!("{text}{{\"type\":\"assist");
        assert_eq!(checkpoint_len(&half, true), text.len());
    }
}
