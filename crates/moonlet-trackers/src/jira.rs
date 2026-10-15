//! Jira Cloud's REST API v3 (X44): requests and their answers as moonlet's tasks.

use serde_json::{json, Value};

use crate::states::Column;
use crate::task::{TrackerRef, TrackerTask};
use crate::{ApiError, TrackerKind};

/// The fields a search asks for.
const FIELDS: [&str; 9] = [
    "summary",
    "status",
    "priority",
    "assignee",
    "labels",
    "updated",
    "description",
    "project",
    "issuetype",
];

fn parse(raw: &[u8]) -> Result<Value, ApiError> {
    serde_json::from_slice(raw)
        .map_err(|e| ApiError::new(format!("Jira answered with something else: {e}")))
}

/// The body of `POST /rest/api/3/search/jql` for `projects`: the user's
/// issues (or all), open or updated in the last 14 days, newest first.
pub fn search_body(projects: &[String], mine: bool, next_page_token: Option<&str>) -> Value {
    let keys = projects
        .iter()
        .map(|p| format!("\"{}\"", p.replace('"', "")))
        .collect::<Vec<_>>()
        .join(", ");
    let who = if mine {
        " AND assignee = currentUser()"
    } else {
        ""
    };
    let mut body = json!({
        "jql": format!("project in ({keys}){who} AND (statusCategory != Done OR updated >= -14d) ORDER BY updated DESC"),
        "fields": FIELDS,
        "maxResults": 100,
    });
    if let Some(t) = next_page_token {
        body["nextPageToken"] = json!(t);
    }
    body
}

/// The token of the next page of a search, if there is one.
pub fn next_page(raw: &[u8]) -> Option<String> {
    let v = parse(raw).ok()?;
    if v["isLast"].as_bool() == Some(true) {
        return None;
    }
    v["nextPageToken"].as_str().map(String::from)
}

/// One issue by its key (X46: a key pasted into the link dialog). `key` must
/// already be checked as a plain id.
pub fn issue_path(key: &str) -> String {
    format!("/rest/api/3/issue/{key}?fields={}", FIELDS.join(","))
}

/// The issue of [`issue_path`] as a task of `connection` on `site`.
pub fn parse_issue(raw: &[u8], connection: &str, site: &str) -> Result<TrackerTask, ApiError> {
    let issue: Value = parse(raw)?;
    let wrapped = serde_json::json!({ "issues": [issue] }).to_string();
    parse_search(wrapped.as_bytes(), connection, site)?
        .pop()
        .ok_or_else(|| ApiError::new("Jira sent no issue"))
}

/// The issues of a search as tasks of `connection` on `site`.
pub fn parse_search(
    raw: &[u8],
    connection: &str,
    site: &str,
) -> Result<Vec<TrackerTask>, ApiError> {
    let v = parse(raw)?;
    Ok(v["issues"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|i| {
            let f = &i["fields"];
            let key = i["key"].as_str().unwrap_or_default();
            let status = &f["status"];
            let name = status["name"].as_str().unwrap_or_default();
            TrackerTask {
                connection: connection.into(),
                key: key.into(),
                title: f["summary"].as_str().unwrap_or_default().into(),
                url: format!("https://{site}/browse/{key}"),
                column: crate::states::default_column(
                    TrackerKind::Jira,
                    status["statusCategory"]["key"].as_str().unwrap_or_default(),
                    name,
                ),
                priority: crate::priority::named_bars(
                    f["priority"]["name"].as_str().unwrap_or_default(),
                ),
                assignees: f["assignee"]["displayName"]
                    .as_str()
                    .map(String::from)
                    .into_iter()
                    .collect(),
                labels: f["labels"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|l| l.as_str().map(String::from))
                    .collect(),
                description: crate::adf::to_markdown(&f["description"]),
                updated_ms: f["updated"]
                    .as_str()
                    .and_then(crate::time::timestamp_ms)
                    .unwrap_or(0),
                cycle: None,
                issue_type: f["issuetype"]["name"].as_str().map(String::from),
                tracker: TrackerRef {
                    id: i["id"].as_str().unwrap_or_default().into(),
                    state: name.into(),
                    source: key.split('-').next().unwrap_or_default().into(),
                },
            }
        })
        .collect())
}

/// `(accountId, displayName)` of the token's user.
pub fn parse_myself(raw: &[u8]) -> Result<(String, String), ApiError> {
    let v = parse(raw)?;
    Ok((
        v["accountId"].as_str().unwrap_or_default().into(),
        v["displayName"].as_str().unwrap_or_default().into(),
    ))
}

/// `(key, name)` of the projects on a page of `GET /rest/api/3/project/search`.
pub fn parse_projects(raw: &[u8]) -> Result<Vec<(String, String)>, ApiError> {
    let v = parse(raw)?;
    Ok(v["values"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            (
                p["key"].as_str().unwrap_or_default().into(),
                p["name"].as_str().unwrap_or_default().into(),
            )
        })
        .collect())
}

/// `(name, category key)` of a project's statuses, each once, in the order
/// of `GET /rest/api/3/project/{key}/statuses` (statuses per issue type).
pub fn parse_project_statuses(raw: &[u8]) -> Result<Vec<(String, String)>, ApiError> {
    let v = parse(raw)?;
    let mut out: Vec<(String, String)> = Vec::new();
    for t in v.as_array().into_iter().flatten() {
        for s in t["statuses"].as_array().into_iter().flatten() {
            let name = s["name"].as_str().unwrap_or_default().to_string();
            if !out.iter().any(|(n, _)| *n == name) {
                out.push((
                    name,
                    s["statusCategory"]["key"]
                        .as_str()
                        .unwrap_or_default()
                        .into(),
                ));
            }
        }
    }
    Ok(out)
}

/// A workflow transition available on an issue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transition {
    pub id: String,
    pub name: String,
    /// The status it leads to, and that status's category key.
    pub to: String,
    pub to_category: String,
}

pub fn parse_transitions(raw: &[u8]) -> Result<Vec<Transition>, ApiError> {
    let v = parse(raw)?;
    Ok(v["transitions"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| Transition {
            id: t["id"].as_str().unwrap_or_default().into(),
            name: t["name"].as_str().unwrap_or_default().into(),
            to: t["to"]["name"].as_str().unwrap_or_default().into(),
            to_category: t["to"]["statusCategory"]["key"]
                .as_str()
                .unwrap_or_default()
                .into(),
        })
        .collect())
}

/// The first transition whose status lands in `column`.
pub fn transition_to<'a>(
    transitions: &'a [Transition],
    column: Column,
    mapping: &crate::states::Mapping,
) -> Option<&'a Transition> {
    crate::states::pick(transitions, column, mapping, |t| {
        let natural = crate::states::default_column(TrackerKind::Jira, &t.to_category, &t.to);
        (natural, t.to.as_str())
    })
}

pub fn transition_body(id: &str) -> Value {
    json!({ "transition": { "id": id } })
}

pub fn assignee_body(account_id: &str) -> Value {
    json!({ "accountId": account_id })
}

/// A comment of one paragraph, in Atlassian Document Format.
pub fn comment_body(text: &str) -> Value {
    json!({ "body": { "type": "doc", "version": 1, "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": text }] }] } })
}

/// What a failed request means; a 401 asks to reconnect (X44).
pub fn parse_error(status: u16, raw: &[u8], site: &str) -> ApiError {
    if status == 401 {
        return ApiError {
            auth: true,
            message: format!(
                "Jira no longer accepts the API token for {site}. It may have expired or been revoked. Create a new token and paste it here."
            ),
        };
    }
    let v = parse(raw).unwrap_or_default();
    let msg = v["errorMessages"]
        .as_array()
        .and_then(|m| m.first())
        .and_then(Value::as_str)
        .unwrap_or("request failed");
    ApiError::new(format!("Jira: {msg}"))
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
    fn one_issue_by_its_key() {
        let list: serde_json::Value = serde_json::from_slice(&fixture("jira-search.json")).unwrap();
        let one = list["issues"][0].to_string();
        let site = "acme.atlassian.net";
        let t = parse_issue(one.as_bytes(), "jira:acme.atlassian.net", site).unwrap();
        assert_eq!(
            (t.key.as_str(), t.title.as_str(), t.tracker.state.as_str()),
            ("EX-1", "Main order flow broken", "In Progress")
        );
        assert_eq!(
            issue_path("OPS-12"),
            "/rest/api/3/issue/OPS-12?fields=summary,status,priority,assignee,labels,updated,description,project,issuetype"
        );
    }

    #[test]
    fn an_issue_carries_its_type() {
        // The documented `issuetype` field of an issue's fields.
        let raw = serde_json::json!({ "issues": [{ "id": "1", "key": "OPS-12", "fields": {
            "summary": "Rotate keys", "status": { "name": "To Do", "statusCategory": { "key": "new" } },
            "issuetype": { "name": "Bug" }, "labels": [], "updated": "2026-10-14T09:00:00.000+0000"
        } }] });
        let t = parse_search(
            raw.to_string().as_bytes(),
            "jira:acme.atlassian.net",
            "acme.atlassian.net",
        )
        .unwrap();
        assert_eq!(t[0].issue_type.as_deref(), Some("Bug"));
    }

    #[test]
    fn search_results_as_tasks() {
        let tasks = parse_search(
            &fixture("jira-search.json"),
            "jira:acme.atlassian.net",
            "acme.atlassian.net",
        )
        .unwrap();
        assert_eq!(tasks.len(), 3);
        assert_eq!(
            tasks[0],
            TrackerTask {
                connection: "jira:acme.atlassian.net".into(),
                key: "EX-1".into(),
                title: "Main order flow broken".into(),
                url: "https://acme.atlassian.net/browse/EX-1".into(),
                column: Column::InProgress,
                priority: 3,
                assignees: vec!["Mia Krystof".into()],
                labels: vec!["backend".into(), "checkout".into()],
                description: "Orders fail at the payment step.\n\n- Happens on Safari only\n- Started after the 3.2 release".into(),
                updated_ms: 1_791_969_164_512,
                cycle: None,
                issue_type: None,
                tracker: TrackerRef { id: "10002".into(), state: "In Progress".into(), source: "EX".into() },
            }
        );
        assert_eq!(
            (tasks[1].column, tasks[1].priority, tasks[1].assignees.len()),
            (Column::Todo, 2, 0)
        );
        assert_eq!(
            (tasks[2].column, tasks[2].description.as_str()),
            (Column::Done, "")
        );
    }

    #[test]
    fn the_next_page_token() {
        assert_eq!(
            next_page(&fixture("jira-search-page1.json"))
                .as_deref()
                .map(str::is_empty),
            Some(false)
        );
        assert_eq!(next_page(&fixture("jira-search.json")), None);
    }

    #[test]
    fn myself_and_projects() {
        assert_eq!(
            parse_myself(&fixture("jira-myself.json")).unwrap(),
            (
                "5b10a2844c20165700ede21g".to_string(),
                "Mia Krystof".to_string()
            )
        );
        assert_eq!(
            parse_projects(&fixture("jira-projects.json")).unwrap()[..2],
            [
                ("EX".to_string(), "Example".to_string()),
                ("ABC".to_string(), "Alphabetical".to_string())
            ]
        );
    }

    #[test]
    fn the_transition_that_reaches_a_column() {
        let t = parse_transitions(&fixture("jira-transitions.json")).unwrap();
        assert_eq!(
            transition_to(&t, Column::InProgress, &Default::default()).map(|t| t.id.as_str()),
            Some("21")
        );
        assert_eq!(
            transition_to(&t, Column::Done, &Default::default()).map(|t| t.id.as_str()),
            Some("31")
        );
        // This workflow has no review state.
        assert_eq!(
            transition_to(&t, Column::InReview, &Default::default()),
            None
        );
    }

    #[test]
    fn a_projects_statuses() {
        // `GET /rest/api/3/project/{key}/statuses`: statuses per issue type.
        // Built from the documented schema (no example was captured).
        let raw = br#"[
            {"id": "10001", "name": "Task", "statuses": [
                {"id": "10000", "name": "To Do", "statusCategory": {"key": "new"}},
                {"id": "3", "name": "In Progress", "statusCategory": {"key": "indeterminate"}}
            ]},
            {"id": "10002", "name": "Bug", "statuses": [
                {"id": "3", "name": "In Progress", "statusCategory": {"key": "indeterminate"}},
                {"id": "10010", "name": "Code Review", "statusCategory": {"key": "indeterminate"}},
                {"id": "10001", "name": "Done", "statusCategory": {"key": "done"}}
            ]}
        ]"#;
        assert_eq!(
            parse_project_statuses(raw).unwrap(),
            [
                ("To Do".to_string(), "new".to_string()),
                ("In Progress".to_string(), "indeterminate".to_string()),
                ("Code Review".to_string(), "indeterminate".to_string()),
                ("Done".to_string(), "done".to_string())
            ]
        );
    }

    #[test]
    fn a_rejected_token_needs_reconnecting() {
        let e = parse_error(401, &fixture("jira-error-401.json"), "acme.atlassian.net");
        assert!(e.auth);
        // What Jira actually sends: plain text with a JSON content type.
        assert!(parse_error(401, &fixture("jira-error-401.txt"), "acme.atlassian.net").auth);
        assert_eq!(
            e.message,
            "Jira no longer accepts the API token for acme.atlassian.net. It may have expired or been revoked. Create a new token and paste it here."
        );
        let other = parse_error(
            500,
            br#"{"errorMessages":["Internal server error"],"errors":{}}"#,
            "acme.atlassian.net",
        );
        assert_eq!(
            (other.auth, other.message.as_str()),
            (false, "Jira: Internal server error")
        );
    }

    #[test]
    fn the_search_and_write_bodies() {
        assert_eq!(
            search_body(&["OPS".into(), "PLAT".into()], true, None),
            serde_json::json!({
                "jql": "project in (\"OPS\", \"PLAT\") AND assignee = currentUser() AND (statusCategory != Done OR updated >= -14d) ORDER BY updated DESC",
                "fields": ["summary", "status", "priority", "assignee", "labels", "updated", "description", "project", "issuetype"],
                "maxResults": 100
            })
        );
        assert_eq!(
            transition_body("21"),
            serde_json::from_slice::<serde_json::Value>(&fixture("jira-transition-request.json"))
                .unwrap()
        );
        assert_eq!(
            comment_body("Opened a pull request: https://github.com/acme/app/pull/57"),
            serde_json::from_slice::<serde_json::Value>(&fixture("jira-comment-request.json"))
                .unwrap()
        );
    }
}
