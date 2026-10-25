//! Routing in moonlet's `PreToolUse` hook (X62): a Bash call that the daemon
//! says may run on another machine is rewritten to go through
//! `moonlet exec`.

use serde_json::{Value, json};

/// What the hook asks the daemon about one Bash call.
#[derive(Debug, Clone, PartialEq)]
pub struct Ask {
    pub command: String,
    pub cwd: String,
    pub tool_use_id: Option<String>,
}

/// The fields of a Bash call moonlet routes. The hook answers `allow`, so a
/// call with any other field, such as `run_in_background` or one that asks
/// to leave Claude Code's sandbox, goes through Claude Code's own checks.
const KNOWN_FIELDS: [&str; 3] = ["command", "timeout", "description"];

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
/// ask rules to the new command.
pub fn rewrite(payload: &Value, moonlet: &str) -> Value {
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
    input["command"] = json!(format!("{} exec {tool_use}-- {command}", quote(moonlet)));
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": "moonlet: an approved heavy command; it runs on whichever machine is free",
            "updatedInput": input,
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
            rewrite(&payload, "/Applications/moonlet.app/Contents/MacOS/moonlet"),
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
        let out = rewrite(&payload, "/Users/al'ex/moonlet");
        assert_eq!(
            out["hookSpecificOutput"]["updatedInput"]["command"],
            json!(
                "'/Users/al'\\''ex/moonlet' exec --tool-use toolu_012ftuDv3XBoqpcogRjeHhqb -- pnpm test"
            )
        );
    }

    #[test]
    fn a_background_bash_call_is_not_routed() {
        let mut payload = captured();
        payload["tool_input"]["run_in_background"] = json!(true);
        assert_eq!(asks(&payload), None);
        // Nor are other tools or other events.
        let mut read = captured();
        read["tool_name"] = json!("Read");
        assert_eq!(asks(&read), None);
        let mut post = captured();
        post["hook_event_name"] = json!("PostToolUse");
        assert_eq!(asks(&post), None);
        // A field moonlet does not know, such as one that asks to leave
        // Claude Code's sandbox, keeps the call where it is.
        // Plan mode runs nothing that changes files; an answer of
        // `allow` must not get round it.
        let mut planning = captured();
        planning["permission_mode"] = json!("plan");
        assert_eq!(asks(&planning), None);
        let mut unsandboxed = captured();
        unsandboxed["tool_input"]["dangerouslyDisableSandbox"] = json!(true);
        assert_eq!(asks(&unsandboxed), None);
    }
}
