//! ClickUp's API v2 (X44): requests and their answers as moonlet's tasks.

use serde_json::{json, Value};

use crate::board::BoardIssue;
use crate::config::Finished;
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

/// The lists inside the folders of `GET /space/{id}/folder`, each with its
/// folder's name, which Add a board groups them by (X50).
pub fn parse_folder_lists(raw: &[u8]) -> Result<Vec<(String, String, String)>, ApiError> {
    Ok(parse(raw)?["folders"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|f| {
            let folder = f["name"].as_str().unwrap_or_default().to_string();
            pairs(&f["lists"])
                .into_iter()
                .map(move |(id, name)| (id, name, folder.clone()))
        })
        .collect())
}

/// Since when a board's closed tasks are read (ms): its finished days back
/// from `now`; ClickUp has no sprint to follow, so that takes the default.
pub fn closed_since(now: u64, finished: &Finished) -> u64 {
    let days = match finished {
        Finished::Days(n) => u64::from(*n),
        Finished::Sprint => 14,
    };
    now.saturating_sub(days * 86_400_000)
}

/// A page of a list's tasks on a board (X50), each with its due date's time.
pub fn parse_board_tasks(raw: &[u8], connection: &str) -> Result<Vec<BoardIssue>, ApiError> {
    let due: Vec<Option<u64>> = parse(raw)?["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| str_of(&t["due_date"]).parse().ok())
        .collect();
    Ok(parse_tasks(raw, connection)?
        .into_iter()
        .zip(due)
        .map(|(task, due_ms)| BoardIssue {
            due_ms,
            ..BoardIssue::from_task(task)
        })
        .collect())
}

/// How Add a board heads a list (X50): its space, and folder.
pub fn list_group(space: &str, folder: Option<&str>) -> String {
    match folder {
        Some(f) => format!("{space} › {f}"),
        None => space.into(),
    }
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

/// One list's tasks from its two passes (see [`tasks_path`]): the open pass
/// minus those in Done (any age, since ClickUp's `include_closed` only covers
/// "closed"-type statuses), by the user's state `mapping` where it has one,
/// then the recent pass's tasks not already in.
pub fn merge_passes(
    open: Vec<BoardIssue>,
    recent: Vec<BoardIssue>,
    mapping: &crate::states::Mapping,
) -> Vec<BoardIssue> {
    let done = |i: &BoardIssue| {
        mapping
            .get(&i.task.tracker.state)
            .copied()
            .unwrap_or(i.task.column)
            == Column::Done
    };
    let mut out: Vec<BoardIssue> = open.into_iter().filter(|i| !done(i)).collect();
    let mut seen: std::collections::HashSet<String> =
        out.iter().map(|i| i.task.key.clone()).collect();
    out.extend(
        recent
            .into_iter()
            .filter(|i| seen.insert(i.task.key.clone())),
    );
    out
}

/// Whether another page of tasks follows.
pub fn more_pages(raw: &[u8]) -> bool {
    parse(raw)
        .map(|v| v["last_page"].as_bool() == Some(false))
        .unwrap_or(false)
}

/// One task by its key (X46: a key pasted into the link dialog): `CU-<id>`
/// by its id, a custom id within ClickUp workspace `team`.
pub fn task_path(key: &str, team: &str) -> String {
    match key.strip_prefix("CU-") {
        Some(id) => format!("/task/{id}"),
        None => format!("/task/{key}?custom_task_ids=true&team_id={team}"),
    }
}

/// The task of [`task_path`] as a task of `connection`.
pub fn parse_task(raw: &[u8], connection: &str) -> Result<TrackerTask, ApiError> {
    let task = parse(raw)?;
    let wrapped = json!({ "tasks": [task] }).to_string();
    parse_tasks(wrapped.as_bytes(), connection)?
        .pop()
        .ok_or_else(|| ApiError::new("ClickUp sent no task"))
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
                cycle: None,
                issue_type: None,
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
pub fn status_for<'a>(
    statuses: &'a [Status],
    column: Column,
    mapping: &crate::states::Mapping,
) -> Option<&'a Status> {
    crate::states::pick(statuses, column, mapping, |s| {
        let natural = crate::states::default_column(TrackerKind::Clickup, &s.kind, &s.name);
        (natural, s.name.as_str())
    })
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

    fn issues(tasks: Vec<TrackerTask>) -> Vec<BoardIssue> {
        tasks.into_iter().map(BoardIssue::from_task).collect()
    }
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
    fn one_task_by_its_key() {
        let list: serde_json::Value =
            serde_json::from_slice(&fixture("clickup-tasks.json")).unwrap();
        let one = list["tasks"][0].to_string();
        let t = parse_task(one.as_bytes(), "clickup:9012345").unwrap();
        assert_eq!(
            (t.key.as_str(), t.title.as_str(), t.tracker.state.as_str()),
            ("CU-9hx", "Fix login bug", "in progress")
        );
        assert_eq!(task_path("CU-86abc123", "9012345"), "/task/86abc123");
        assert_eq!(
            task_path("MOON-12", "9012345"),
            "/task/MOON-12?custom_task_ids=true&team_id=9012345"
        );
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
                cycle: None,
                issue_type: None,
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
            status_for(&statuses, Column::Done, &Default::default()).map(|s| s.name.as_str()),
            Some("complete")
        );
        assert_eq!(
            status_for(&statuses, Column::InReview, &Default::default()),
            None
        );
    }

    #[test]
    fn the_two_passes_make_open_tasks_and_recent_closed_ones() {
        let all = parse_tasks(&fixture("clickup-tasks.json"), "clickup:9012345").unwrap();
        let with = |key: &str, column: Column| TrackerTask {
            key: key.into(),
            column,
            ..all[0].clone()
        };
        // Pass one: open tasks of any age; a "done"-type status there is old.
        let open = vec![
            with("CU-a", Column::InProgress),
            with("CU-old", Column::Done),
        ];
        // Pass two: tasks updated lately, closed or not.
        let recent = vec![
            with("CU-a", Column::InProgress),
            with("CU-new", Column::Done),
        ];
        let keys: Vec<String> = merge_passes(issues(open), issues(recent), &Default::default())
            .into_iter()
            .map(|i| i.task.key)
            .collect();
        assert_eq!(keys, ["CU-a", "CU-new"]);
    }

    #[test]
    fn the_open_pass_follows_the_users_state_mapping() {
        let all = parse_tasks(&fixture("clickup-tasks.json"), "clickup:9012345").unwrap();
        let with = |key: &str, column: Column, state: &str| {
            let mut t = TrackerTask {
                key: key.into(),
                column,
                ..all[0].clone()
            };
            t.tracker.state = state.into();
            t
        };
        // "shipped" is a done-type status the user maps to In Review: its old
        // tasks stay; "parked" is mapped to Done: its old tasks go.
        let mapping = crate::states::Mapping::from([
            ("shipped".to_string(), Column::InReview),
            ("parked".to_string(), Column::Done),
        ]);
        let open = vec![
            with("CU-s", Column::Done, "shipped"),
            with("CU-p", Column::InProgress, "parked"),
            // A status not shown is no Done: kept.
            with("CU-h", Column::Hidden, "on hold"),
        ];
        let keys: Vec<String> = merge_passes(issues(open), vec![], &mapping)
            .into_iter()
            .map(|i| i.task.key)
            .collect();
        assert_eq!(keys, ["CU-s", "CU-h"]);
    }

    #[test]
    fn the_lists_inside_a_spaces_folders_are_sources_named_with_their_folder() {
        // The documented folders answer has no lists in its example folders.
        assert_eq!(parse_folder_lists(&fixture("clickup-folders.json")).unwrap(), []);
        let raw = br#"{"folders":[{"id":"457","name":"Roadmap","lists":[{"id":"901","name":"Q4"},{"id":"902","name":"Bugs"}]}]}"#;
        assert_eq!(
            parse_folder_lists(raw).unwrap(),
            [
                ("901".to_string(), "Q4".to_string(), "Roadmap".to_string()),
                ("902".to_string(), "Bugs".to_string(), "Roadmap".to_string())
            ]
        );
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

    #[test]
    fn a_boards_tasks_carry_their_due_dates_time() {
        let tasks = parse_board_tasks(&fixture("clickup-tasks.json"), "clickup:9012345").unwrap();
        assert_eq!(
            tasks
                .iter()
                .map(|i| (i.task.tracker.id.as_str(), i.due_ms))
                .collect::<Vec<_>>(),
            [
                ("9hx", Some(1_508_369_194_377)),
                ("9hz", None),
                ("86d2m1awy", None)
            ]
        );
    }

    #[test]
    fn a_list_is_headed_by_its_space_and_folder() {
        assert_eq!(
            list_group("Engineering", Some("Roadmap")),
            "Engineering › Roadmap"
        );
        assert_eq!(list_group("Engineering", None), "Engineering");
    }

    #[test]
    fn closed_tasks_are_read_back_to_the_boards_finished_days() {
        let now = 1_792_972_800_000;
        assert_eq!(closed_since(now, &Finished::Days(7)), 1_792_368_000_000);
        // ClickUp has no sprint to follow: the default 14 days.
        assert_eq!(closed_since(now, &Finished::Sprint), 1_791_763_200_000);
    }
}
