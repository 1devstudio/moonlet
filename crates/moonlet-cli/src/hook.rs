//! Routing in moonlet's `PreToolUse` hook (X62): a Bash call that the daemon
//! says may run on another machine is rewritten to go through
//! `moonlet exec`.

use moonlet_proto::methods::RoutedLine;
use serde_json::{Value, json};

/// What the hook asks the daemon about one Bash call.
#[derive(Debug, Clone, PartialEq)]
pub struct Ask {
    pub command: String,
    pub cwd: String,
    pub tool_use_id: Option<String>,
}

/// The fields of a Bash call moonlet routes. The hook answers `allow`, so a
/// call with any other field, such as one that asks to leave Claude Code's
/// sandbox, goes through Claude Code's own checks. A background call is
/// routed too (X90): it is how a run outlasts the foreground's 10 minutes.
const KNOWN_FIELDS: [&str; 4] = ["command", "timeout", "description", "run_in_background"];

/// The Bash call in a Claude Code `PreToolUse` payload that may be routed.
pub fn asks(payload: &Value) -> Option<Ask> {
    if payload["hook_event_name"] != "PreToolUse" || payload["tool_name"] != "Bash" {
        return None;
    }
    // Plan mode runs nothing that changes files: `allow` must not get round it.
    if payload["permission_mode"] == "plan" {
        return None;
    }
    let input = &payload["tool_input"];
    let known = input
        .as_object()?
        .keys()
        .all(|k| KNOWN_FIELDS.contains(&k.as_str()));
    if !known {
        return None;
    }
    Some(Ask {
        command: input["command"].as_str()?.to_string(),
        cwd: payload["cwd"].as_str()?.to_string(),
        tool_use_id: payload["tool_use_id"].as_str().map(String::from),
    })
}

/// The hook's answer that runs the call through `moonlet exec`. Claude Code
/// replaces the whole input with `updatedInput`, so every other field
/// stays as the agent wrote it, and it still applies the user's deny and
/// ask rules to the new command. For a routed `line`, what the agent's
/// shell runs around the command goes around `moonlet exec`, as the daemon
/// gave it; without one, the command alone follows `moonlet exec --` as
/// the agent wrote it.
pub fn rewrite(payload: &Value, moonlet: &str, line: Option<&RoutedLine>) -> Value {
    let mut input = payload["tool_input"].clone();
    let command = input["command"].as_str().unwrap_or_default();
    // The tool call's id, so the job is found from the chat's row (X62).
    let tool_use = payload["tool_use_id"]
        .as_str()
        .filter(|id| {
            !id.is_empty()
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
        .map(|id| format!("--tool-use {id} "))
        .unwrap_or_default();
    let exec = format!("{} exec {tool_use}", quote(moonlet));
    input["command"] = json!(match line {
        Some(l) => format!("{}{exec}{}-- {}{}", l.before, l.args, l.command, l.after),
        None => format!("{exec}-- {command}"),
    });
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": "moonlet: an approved heavy command; it runs on whichever machine is free",
            "updatedInput": input,
        }
    })
}

/// The hook's answer for a line that stays here: `note` reaches the agent
/// next to the call's result. With no decision, the call goes through
/// Claude Code's own checks as without moonlet; a Claude Code that does
/// not read the field still runs the call.
pub fn stays(note: &str) -> Value {
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": note,
        }
    })
}

/// `s` in single quotes for a POSIX shell.
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn captured() -> Value {
        serde_json::from_str(include_str!("fixtures/pre_tool_use_bash.json")).unwrap()
    }

    /// Claude Code 2.1.309's `PreToolUse` payload for a Bash call.
    #[test]
    fn the_hook_rewrites_a_captured_bash_call_to_moonlet_exec() {
        let payload = captured();
        assert_eq!(
            asks(&payload),
            Some(Ask {
                command: "pnpm test".into(),
                cwd: "/Users/alex/.moonlet/worktrees/shop/fix-cart".into(),
                tool_use_id: Some("toolu_012ftuDv3XBoqpcogRjeHhqb".into()),
            })
        );
        assert_eq!(
            rewrite(&payload, "/Applications/moonlet.app/Contents/MacOS/moonlet", None),
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "permissionDecisionReason": "moonlet: an approved heavy command; it runs on whichever machine is free",
                    "updatedInput": {
                        "command": "'/Applications/moonlet.app/Contents/MacOS/moonlet' exec --tool-use toolu_012ftuDv3XBoqpcogRjeHhqb -- pnpm test",
                        "timeout": 600000,
                        "description": "Run the tests",
                    },
                },
            })
        );
        // A quote in the binary's path cannot end its quoting.
        let out = rewrite(&payload, "/Users/al'ex/moonlet", None);
        assert_eq!(
            out["hookSpecificOutput"]["updatedInput"]["command"],
            json!(
                "'/Users/al'\\''ex/moonlet' exec --tool-use toolu_012ftuDv3XBoqpcogRjeHhqb -- pnpm test"
            )
        );
    }

    /// A routed line: `cd`, the variables, `timeout`, redirections and
    /// filters stay in the agent's shell, around `moonlet exec`.
    #[test]
    fn the_hook_puts_a_routed_lines_parts_around_moonlet_exec() {
        let mut payload = captured();
        payload["tool_input"]["command"] = json!("cd web && CI=1 pnpm test 2>&1 | tail -n 50");
        let line = RoutedLine {
            before: "cd ./web && ".into(),
            args: "--env CI=1 ".into(),
            command: "pnpm test".into(),
            after: " 2>&1 | tail -n 50".into(),
        };
        assert_eq!(
            rewrite(&payload, "/Applications/moonlet.app/Contents/MacOS/moonlet", Some(&line)),
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "permissionDecisionReason": "moonlet: an approved heavy command; it runs on whichever machine is free",
                    "updatedInput": {
                        "command": "cd ./web && '/Applications/moonlet.app/Contents/MacOS/moonlet' exec --tool-use toolu_012ftuDv3XBoqpcogRjeHhqb --env CI=1 -- pnpm test 2>&1 | tail -n 50",
                        "timeout": 600000,
                        "description": "Run the tests",
                    },
                },
            })
        );
    }

    /// A line that stays here: the agent reads why, next to the result,
    /// and the call goes on as without moonlet.
    #[test]
    fn the_hook_tells_the_agent_why_a_line_stays_here() {
        assert_eq!(
            stays("moonlet: this line runs here, not on a worker: it runs a second command."),
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "additionalContext": "moonlet: this line runs here, not on a worker: it runs a second command.",
                },
            })
        );
    }

    /// Claude Code 2.1.319's `PreToolUse` payload for a Bash call with
    /// `run_in_background` (X90).
    #[test]
    fn a_background_bash_call_is_routed_and_stays_in_the_background() {
        let payload: Value =
            serde_json::from_str(include_str!("fixtures/pre_tool_use_bash_background.json"))
                .unwrap();
        assert_eq!(
            asks(&payload),
            Some(Ask {
                command: "pnpm check".into(),
                cwd: "/Users/alex/.moonlet/worktrees/shop/fix-cart".into(),
                tool_use_id: Some("toolu_01NoQAPN1jqBjTHrojvSFhhY".into()),
            })
        );
        assert_eq!(
            rewrite(&payload, "/Applications/moonlet.app/Contents/MacOS/moonlet", None),
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "permissionDecisionReason": "moonlet: an approved heavy command; it runs on whichever machine is free",
                    "updatedInput": {
                        "command": "'/Applications/moonlet.app/Contents/MacOS/moonlet' exec --tool-use toolu_01NoQAPN1jqBjTHrojvSFhhY -- pnpm check",
                        "description": "Run the checks",
                        "run_in_background": true,
                    },
                },
            })
        );
        // Nor are other tools or other events.
        let mut read = captured();
        read["tool_name"] = json!("Read");
        assert_eq!(asks(&read), None);
        let mut post = captured();
        post["hook_event_name"] = json!("PostToolUse");
        assert_eq!(asks(&post), None);
        // Plan mode runs nothing that changes files; an answer of
        // `allow` must not get round it.
        let mut planning = payload.clone();
        planning["permission_mode"] = json!("plan");
        assert_eq!(asks(&planning), None);
        // A field moonlet does not know, such as one that asks to leave
        // Claude Code's sandbox, keeps the call where it is.
        let mut unsandboxed = payload.clone();
        unsandboxed["tool_input"]["dangerouslyDisableSandbox"] = json!(true);
        assert_eq!(asks(&unsandboxed), None);
    }
}
