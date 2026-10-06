//! Decisions behind `jaunt project` and `jaunt session` (X22), kept apart
//! from the socket so they can be tested on plain data.

use anyhow::{Result, bail};
use jaunt_proto::types::{ChatState, Project};

/// The project `query` names: an id, then a path, then a name (any case).
pub fn find_project<'a>(projects: &'a [Project], query: &str, home: &str) -> Result<&'a Project> {
    if let Some(p) = projects.iter().find(|p| p.id == query) {
        return Ok(p);
    }
    let path = match query.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{home}{rest}"),
        _ => query.to_string(),
    };
    let path = path.trim_end_matches('/');
    if let Some(p) = projects.iter().find(|p| p.path.trim_end_matches('/') == path) {
        return Ok(p);
    }
    let named: Vec<&Project> = projects.iter().filter(|p| p.name.eq_ignore_ascii_case(query)).collect();
    match named.as_slice() {
        [p] => Ok(p),
        [] => {
            let known: Vec<&str> = projects.iter().map(|p| p.name.as_str()).collect();
            bail!("no project \"{query}\"; known projects: {}", known.join(", "))
        }
        several => {
            let paths: Vec<&str> = several.iter().map(|p| p.path.as_str()).collect();
            bail!("\"{query}\" matches several projects: {}; pass a path instead", paths.join(", "))
        }
    }
}

/// What `jaunt session read` prints: the agent's last reply, then one line
/// per approval it waits for.
pub fn reply(state: &ChatState) -> String {
    let mut out = String::new();
    if let Some(last) = state.items.iter().rev().find(|i| i.kind == "assistant") {
        out.push_str(last.text.trim_end());
        out.push('\n');
    }
    for ask in &state.pending {
        out.push_str(&format!("[waiting for approval] {}: {}\n", ask.tool, ask.summary));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(id: &str, name: &str, path: &str) -> Project {
        Project { id: id.into(), name: name.into(), path: path.into(), base_branch: "main".into() }
    }

    fn projects() -> Vec<Project> {
        vec![
            project("a1b2c3", "api", "/Users/me/code/api"),
            project("d4e5f6", "web", "/Users/me/code/web"),
            project("g7h8i9", "docs", "/Users/me/code/docs"),
            project("j0k1l2", "docs", "/Users/me/client/docs"),
        ]
    }

    #[test]
    fn finds_a_project_by_id_path_or_name() {
        let p = projects();
        let id = |q: &str| find_project(&p, q, "/Users/me").map(|p| p.id.as_str()).map_err(|e| e.to_string());
        assert_eq!(id("d4e5f6"), Ok("d4e5f6"));
        assert_eq!(id("web"), Ok("d4e5f6"));
        assert_eq!(id("Web"), Ok("d4e5f6"));
        assert_eq!(id("/Users/me/code/api"), Ok("a1b2c3"));
        assert_eq!(id("/Users/me/code/api/"), Ok("a1b2c3"));
        assert_eq!(id("~/client/docs"), Ok("j0k1l2"));
    }

    #[test]
    fn an_unknown_or_ambiguous_project_lists_the_known_ones() {
        let p = projects();
        let err = |q: &str| find_project(&p, q, "/Users/me").unwrap_err().to_string();
        assert_eq!(err("mobile"), r#"no project "mobile"; known projects: api, web, docs, docs"#);
        assert_eq!(
            err("docs"),
            r#""docs" matches several projects: /Users/me/code/docs, /Users/me/client/docs; pass a path instead"#
        );
    }

    #[test]
    fn read_prints_the_last_reply_and_pending_approvals() {
        let state: ChatState = serde_json::from_value(serde_json::json!({
            "status": "blocked",
            "items": [
                {"id": "u1", "kind": "user", "text": "Add the button", "ts": 1},
                {"id": "a1", "kind": "assistant", "text": "Looking at the page.", "ts": 2},
                {"id": "t1", "kind": "tool", "text": "", "ts": 3},
                {"id": "a2", "kind": "assistant", "text": "I need to run the tests.\nOne moment.", "ts": 4},
                {"id": "t2", "kind": "tool", "text": "", "ts": 5}
            ],
            "pending": [
                {"id": "p1", "tool": "Bash", "summary": "pnpm test"}
            ]
        }))
        .unwrap();
        assert_eq!(
            reply(&state),
            "I need to run the tests.\nOne moment.\n[waiting for approval] Bash: pnpm test\n"
        );
        assert_eq!(reply(&ChatState::default()), "");
    }
}
