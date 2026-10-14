//! ClickUp's API v2 (X44): requests and their answers as moonlet's tasks.

use serde_json::{json, Value};

use crate::states::Column;
use crate::task::{TrackerRef, TrackerTask};
use crate::{ApiError, TrackerKind};

pub const API: &str = "https://api.clickup.com/api/v2";

fn parse(raw: &[u8]) -> Result<Value, ApiError> {
    serde_json::from_slice(raw)
        .map_err(|e| ApiError::new(format!("ClickUp answered with something else: {e}")))
}

fn str_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn pairs(v: &Value) -> Vec<(String, String)> {
    v.as_array()
        .into_iter()
        .flatten()
        .map(|x| {
            (
                str_of(&x["id"]),
                x["name"].as_str().unwrap_or_default().into(),
            )
        })
        .collect()
}

pub fn parse_user(raw: &[u8]) -> Result<String, ApiError> {
    Ok(parse(raw)?["user"]["username"]
        .as_str()
        .unwrap_or_default()
        .into())
}

pub fn parse_user_id(raw: &[u8]) -> Result<String, ApiError> {
    Ok(str_of(&parse(raw)?["user"]["id"]))
}

/// `(id, name)` of the workspaces (ClickUp's "teams").
pub fn parse_teams(raw: &[u8]) -> Result<Vec<(String, String)>, ApiError> {
    Ok(pairs(&parse(raw)?["teams"]))
}

pub fn parse_spaces(raw: &[u8]) -> Result<Vec<(String, String)>, ApiError> {
    Ok(pairs(&parse(raw)?["spaces"]))
}

/// `(id, name)` of the lists of `GET /space/{id}/list` or of a folder.
pub fn parse_lists(raw: &[u8]) -> Result<Vec<(String, String)>, ApiError> {
    Ok(pairs(&parse(raw)?["lists"]))
}

/// The lists inside the folders of `GET /space/{id}/folder`.
pub fn parse_folder_lists(raw: &[u8]) -> Result<Vec<(String, String)>, ApiError> {
    Ok(parse(raw)?["folders"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|f| pairs(&f["lists"]))
        .collect())
}

/// A page of a list's tasks for the user (or all): the open ones, or with
/// `closed_since` (ms) the open and closed ones updated since then. ClickUp's
/// date filter covers every task, so open ones come in their own pass.
pub fn tasks_path(
    list: &str,
    assignee: Option<&str>,
    page: u32,
    closed_since: Option<u64>,
) -> String {
    let mut p =
        format!("/list/{list}/task?include_markdown_description=true&order_by=updated&page={page}");
    if let Some(since) = closed_since {
        p.push_str(&format!("&include_closed=true&date_updated_gt={since}"));
    }
    if let Some(a) = assignee {
        p.push_str(&format!("&assignees%5B%5D={a}"));
    }
    p
}

/// Whether another page of tasks follows.
pub fn more_pages(raw: &[u8]) -> bool {
    parse(raw)
        .map(|v| v["last_page"].as_bool() == Some(false))
        .unwrap_or(false)
}

pub fn parse_tasks(raw: &[u8], connection: &str) -> Result<Vec<TrackerTask>, ApiError> {
    let v = parse(raw)?;
    Ok(v["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| {
            let id = str_of(&t["id"]);
            let status = &t["status"];
            let name = status["status"].as_str().unwrap_or_default();
            let desc = t["markdown_description"]
                .as_str()
                .filter(|d| !d.is_empty())
                .or(t["description"].as_str())
                .unwrap_or_default();
            TrackerTask {
                connection: connection.into(),
                key: t["custom_id"]
                    .as_str()
                    .filter(|c| !c.is_empty())
                    .map(String::from)
                    .unwrap_or_else(|| format!("CU-{id}")),
                title: t["name"].as_str().unwrap_or_default().into(),
                url: crate::task::web_url(&t["url"])
                    .unwrap_or_else(|| format!("https://app.clickup.com/t/{id}")),
                column: crate::states::default_column(
                    TrackerKind::Clickup,
                    status["type"].as_str().unwrap_or_default(),
                    name,
                ),
                priority: crate::priority::named_bars(
                    t["priority"]["priority"].as_str().unwrap_or_default(),
                ),
                // The docs give these as objects and, elsewhere, as strings.
                assignees: names(&t["assignees"], "username"),
                labels: names(&t["tags"], "name"),
                description: desc.into(),
                updated_ms: str_of(&t["date_updated"]).parse().unwrap_or(0),
                tracker: TrackerRef {
                    id,
                    state: name.into(),
                    source: str_of(&t["list"]["id"]),
                },
            }
        })
        .collect())
}

fn names(v: &Value, field: &str) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| {
            x.as_str()
                .map(String::from)
                .or_else(|| x[field].as_str().map(String::from))
        })
        .collect()
}

/// A status of a list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub name: String,
    /// `open`, `custom`, `closed` or `done`.
    pub kind: String,
}

/// The statuses of `GET /list/{id}`.
pub fn parse_statuses(raw: &[u8]) -> Result<Vec<Status>, ApiError> {
    Ok(parse(raw)?["statuses"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| Status {
            name: s["status"].as_str().unwrap_or_default().into(),
            kind: s["type"].as_str().unwrap_or_default().into(),
        })
        .collect())
}

/// The first status of a list in `column`.
pub fn status_for(statuses: &[Status], column: Column) -> Option<&Status> {
    statuses
        .iter()
        .find(|s| crate::states::default_column(TrackerKind::Clickup, &s.kind, &s.name) == column)
}

pub fn comment_body(text: &str) -> Value {
    json!({ "comment_text": text, "notify_all": false })
}

/// What a failed request means; a rejected token asks for a new one (X44).
pub fn parse_error(status: u16, raw: &[u8]) -> ApiError {
    let v = parse(raw).unwrap_or_default();
    let code = v["ECODE"].as_str().unwrap_or_default();
    if status == 401 || code.starts_with("OAUTH_") {
        return ApiError {
            auth: true,
            message: if code.is_empty() {
                "ClickUp no longer accepts this token. Create a new one and paste it here.".into()
            } else {
                format!(
                    "ClickUp no longer accepts this token ({code}). Create a new one and paste it here."
                )
            },
        };
    }
    ApiError::new(format!(
        "ClickUp: {}",
        v["err"].as_str().unwrap_or("request failed")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::states::Column;
    use crate::task::{TrackerRef, TrackerTask};

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/tests/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    #[test]
    fn tasks_keyed_by_custom_id_or_cu_id() {
        let tasks = parse_tasks(&fixture("clickup-tasks.json"), "clickup:1234").unwrap();
        assert_eq!(tasks.len(), 3);
        assert_eq!(
            tasks[0],
            TrackerTask {
                connection: "clickup:1234".into(),
                key: "CU-9hx".into(),
                title: "Fix login bug".into(),
                url: "https://app.clickup.com/t/9hx".into(),
                column: Column::InProgress,
                priority: 2,
                assignees: vec!["Alex Johnson".into()],
                labels: vec!["bug".into()],
                description: "Users are unable to log in when **SSO** is enabled.".into(),
                updated_ms: 1_567_780_450_202,
                tracker: TrackerRef {
                    id: "9hx".into(),
                    state: "in progress".into(),
                    source: "15505202".into()
                },
            }
        );
        assert_eq!(
            (tasks[1].key.as_str(), tasks[1].column, tasks[1].priority),
            ("ENG-42", Column::Todo, 0)
        );
        assert_eq!((tasks[2].column, tasks[2].priority), (Column::Done, 3));
        assert!(!more_pages(&fixture("clickup-tasks.json")));
    }

    #[test]
    fn user_workspaces_spaces_lists_and_statuses() {
        assert_eq!(
            parse_user(&fixture("clickup-user.json")).unwrap(),
            "John Doe"
        );
        assert_eq!(parse_user_id(&fixture("clickup-user.json")).unwrap(), "123");
        assert_eq!(
            parse_teams(&fixture("clickup-teams.json")).unwrap(),
            [("1234".to_string(), "My ClickUp Workspace".to_string())]
        );
        assert_eq!(
            parse_spaces(&fixture("clickup-spaces.json")).unwrap()[0],
            ("790".to_string(), "Updated Space Name".to_string())
        );
        assert_eq!(
            parse_lists(&fixture("clickup-lists.json")).unwrap()[1],
            ("125".to_string(), "Sprint Backlog".to_string())
        );
        let statuses = parse_statuses(&fixture("clickup-list.json")).unwrap();
        assert_eq!(
            status_for(&statuses, Column::Done).map(|s| s.name.as_str()),
            Some("complete")
        );
        assert_eq!(status_for(&statuses, Column::InReview), None);
    }

    #[test]
    fn requests() {
        // Open tasks of any age…
        assert_eq!(
            tasks_path("15505202", Some("123"), 0, None),
            "/list/15505202/task?include_markdown_description=true&order_by=updated&page=0\
             &assignees%5B%5D=123"
        );
        // …and, in a second pass, closed ones updated since a time.
        assert_eq!(
            tasks_path("15505202", None, 1, Some(1_790_000_000_000)),
            "/list/15505202/task?include_markdown_description=true&order_by=updated&page=1\
             &include_closed=true&date_updated_gt=1790000000000"
        );
        assert_eq!(
            comment_body("Opened a pull request: https://github.com/acme/app/pull/57"),
            serde_json::from_slice::<serde_json::Value>(&fixture("clickup-comment-request.json"))
                .unwrap()
        );
    }

    #[test]
    fn a_rejected_token_needs_a_new_one() {
        let e = parse_error(401, &fixture("clickup-error-401.json"));
        assert!(e.auth);
        assert_eq!(
            e.message,
            "ClickUp no longer accepts this token (OAUTH_025). Create a new one and paste it here."
        );
        // Without a code the message has no empty brackets.
        assert_eq!(
            parse_error(401, b"").message,
            "ClickUp no longer accepts this token. Create a new one and paste it here."
        );
        let other = parse_error(429, br#"{"err":"Rate limit reached","ECODE":"APP_002"}"#);
        assert_eq!(
            (other.auth, other.message.as_str()),
            (false, "ClickUp: Rate limit reached")
        );
    }
}
