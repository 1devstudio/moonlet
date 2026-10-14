//! Linear's GraphQL API (X44): queries and their answers as moonlet's tasks.

use serde_json::Value;

use crate::task::{TrackerRef, TrackerTask};
use crate::{ApiError, TrackerKind};

pub const API: &str = "https://api.linear.app/graphql";
pub const AUTHORIZE: &str = "https://linear.app/oauth/authorize";
pub const TOKEN: &str = "https://api.linear.app/oauth/token";

pub const VIEWER: &str = "query { viewer { id name email } }";
/// Who signed in, and the organisation that names the connection.
pub const ACCOUNT: &str = "query { viewer { id name email } organization { urlKey name } }";
pub const TEAMS: &str = "query { teams { nodes { id key name } } }";
pub const STATES: &str = "query States($team: String!) { workflowStates(filter: { team: { key: { eq: $team } } }) { nodes { id name type position } } }";

/// The issues of `teams`: assigned to the viewer, or all open ones.
pub fn issues_query(mine: bool) -> String {
    let who = if mine {
        ", assignee: { isMe: { eq: true } }"
    } else {
        ""
    };
    format!(
        "query Issues($teams: [String!], $after: String) {{ issues(first: 100, after: $after, \
         filter: {{ team: {{ key: {{ in: $teams }} }}{who} }}) {{ nodes {{ id identifier title description url \
         branchName priority updatedAt state {{ id name type }} assignee {{ id name }} labels {{ nodes {{ name }} }} \
         cycle {{ number }} team {{ key }} }} pageInfo {{ hasNextPage endCursor }} }} }}"
    )
}

/// The answer's `data`, or the error it carries.
fn data(raw: &[u8]) -> Result<Value, ApiError> {
    let v: Value = serde_json::from_slice(raw)
        .map_err(|e| ApiError::new(format!("Linear answered with something else: {e}")))?;
    if let Some(e) = v["errors"].as_array().and_then(|e| e.first()) {
        let ext = &e["extensions"];
        return Err(ApiError {
            auth: ext["type"]
                .as_str()
                .is_some_and(|t| t.contains("authentication")),
            message: ext["userPresentableMessage"]
                .as_str()
                .or(e["message"].as_str())
                .unwrap_or("Linear refused the request")
                .into(),
        });
    }
    Ok(v["data"].clone())
}

fn nodes(v: &Value) -> impl Iterator<Item = &Value> {
    v["nodes"].as_array().into_iter().flatten()
}

/// Who the token belongs to.
pub fn parse_viewer(raw: &[u8]) -> Result<String, ApiError> {
    Ok(data(raw)?["viewer"]["name"]
        .as_str()
        .unwrap_or_default()
        .into())
}

pub const ISSUE_UPDATE: &str = "mutation Move($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }";
pub const COMMENT: &str =
    "mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }";

/// Whether mutation `field` (`issueUpdate`, `commentCreate`) succeeded.
pub fn parse_success(raw: &[u8], field: &str) -> Result<(), ApiError> {
    if data(raw)?[field]["success"].as_bool() == Some(true) {
        Ok(())
    } else {
        Err(ApiError::new("Linear did not save the change"))
    }
}

/// The state a move to `column` uses: the first state in that column.
pub fn state_for(states: &[State], column: crate::states::Column) -> Option<&State> {
    states
        .iter()
        .find(|s| crate::states::default_column(TrackerKind::Linear, &s.kind, &s.name) == column)
}

/// `(organisation urlKey, viewer name)`.
pub fn parse_account(raw: &[u8]) -> Result<(String, String), ApiError> {
    let d = data(raw)?;
    Ok((
        d["organization"]["urlKey"]
            .as_str()
            .unwrap_or_default()
            .into(),
        d["viewer"]["name"].as_str().unwrap_or_default().into(),
    ))
}

/// `(key, name)` of every team the account can see.
pub fn parse_teams(raw: &[u8]) -> Result<Vec<(String, String)>, ApiError> {
    let d = data(raw)?;
    Ok(nodes(&d["teams"])
        .map(|t| {
            (
                t["key"].as_str().unwrap_or_default().into(),
                t["name"].as_str().unwrap_or_default().into(),
            )
        })
        .collect())
}

/// A workflow state of a team.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct State {
    pub id: String,
    pub name: String,
    /// `backlog`, `unstarted`, `started`, `completed`, `canceled` or `triage`.
    pub kind: String,
}

pub fn parse_states(raw: &[u8]) -> Result<Vec<State>, ApiError> {
    let d = data(raw)?;
    Ok(nodes(&d["workflowStates"])
        .map(|s| State {
            id: s["id"].as_str().unwrap_or_default().into(),
            name: s["name"].as_str().unwrap_or_default().into(),
            kind: s["type"].as_str().unwrap_or_default().into(),
        })
        .collect())
}

/// The issues of an `issues` query as tasks of `connection`.
pub fn parse_issues(raw: &[u8], connection: &str) -> Result<Vec<TrackerTask>, ApiError> {
    let d = data(raw)?;
    Ok(nodes(&d["issues"])
        .map(|i| {
            let state = &i["state"];
            let state_name = state["name"].as_str().unwrap_or_default();
            TrackerTask {
                connection: connection.into(),
                key: i["identifier"].as_str().unwrap_or_default().into(),
                title: i["title"].as_str().unwrap_or_default().into(),
                url: i["url"].as_str().unwrap_or_default().into(),
                column: crate::states::default_column(
                    TrackerKind::Linear,
                    state["type"].as_str().unwrap_or_default(),
                    state_name,
                ),
                priority: crate::priority::linear_bars(i["priority"].as_f64().unwrap_or(0.0) as u8),
                assignees: i["assignee"]["name"]
                    .as_str()
                    .map(String::from)
                    .into_iter()
                    .collect(),
                labels: nodes(&i["labels"])
                    .filter_map(|l| l["name"].as_str().map(String::from))
                    .collect(),
                description: i["description"].as_str().unwrap_or_default().into(),
                updated_ms: i["updatedAt"]
                    .as_str()
                    .and_then(crate::time::timestamp_ms)
                    .unwrap_or(0),
                tracker: TrackerRef {
                    id: i["id"].as_str().unwrap_or_default().into(),
                    state: state_name.into(),
                    source: i["team"]["key"].as_str().unwrap_or_default().into(),
                },
            }
        })
        .collect())
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
    fn issues_as_tasks() {
        let tasks = parse_issues(&fixture("linear-issues.json"), "linear:acme").unwrap();
        assert_eq!(tasks.len(), 3);
        assert_eq!(
            tasks[0],
            TrackerTask {
                connection: "linear:acme".into(),
                key: "ENG-123".into(),
                title: "Retry failed webhook deliveries".into(),
                url: "https://linear.app/acme/issue/ENG-123/retry-failed-webhook-deliveries".into(),
                column: Column::InProgress,
                priority: 3,
                assignees: vec!["Ada Lovelace".into()],
                labels: vec!["Bug".into(), "Backend".into()],
                description: "Webhooks that fail with a 5xx should be retried.\n\n- [ ] Exponential backoff\n- [ ] Give up after 24h".into(),
                updated_ms: 1_791_969_164_512,
                tracker: TrackerRef {
                    id: "1a2b3c4d-0000-4000-8000-000000000123".into(),
                    state: "In Progress".into(),
                    source: "ENG".into(),
                },
            }
        );
        assert_eq!(
            (
                tasks[1].column,
                tasks[1].priority,
                tasks[1].description.as_str()
            ),
            (Column::Todo, 0, "")
        );
        assert_eq!((tasks[2].column, tasks[2].priority), (Column::Done, 1));
        // `priority` is a Float in Linear's schema.
        let float = br#"{"data":{"issues":{"nodes":[{"identifier":"ENG-1","priority":2.0,"state":{"type":"started","name":"In Progress"},"team":{"key":"ENG"}}]}}}"#;
        assert_eq!(parse_issues(float, "linear:acme").unwrap()[0].priority, 3);
    }

    #[test]
    fn the_viewer_teams_and_states() {
        assert_eq!(
            parse_viewer(&fixture("linear-viewer.json")).unwrap(),
            "Ada Lovelace"
        );
        assert_eq!(
            parse_teams(&fixture("linear-teams.json")).unwrap(),
            [
                ("ENG".to_string(), "Engineering".to_string()),
                ("DES".to_string(), "Design".to_string())
            ]
        );
        let states = parse_states(&fixture("linear-states.json")).unwrap();
        assert_eq!(
            states
                .iter()
                .take(4)
                .map(|s| (s.name.as_str(), s.kind.as_str()))
                .collect::<Vec<_>>(),
            [
                ("Backlog", "backlog"),
                ("Todo", "unstarted"),
                ("In Progress", "started"),
                ("In Review", "started")
            ]
        );
    }

    #[test]
    fn moves_and_comments_report_success() {
        assert_eq!(
            parse_success(&fixture("linear-issue-update.json"), "issueUpdate"),
            Ok(())
        );
        assert_eq!(
            parse_success(&fixture("linear-comment.json"), "commentCreate"),
            Ok(())
        );
        assert_eq!(
            parse_success(
                br#"{"data":{"issueUpdate":{"success":false}}}"#,
                "issueUpdate"
            ),
            Err(ApiError::new("Linear did not save the change"))
        );
        // The state a move to a column picks: the first of that column, by position.
        let states = parse_states(&fixture("linear-states.json")).unwrap();
        assert_eq!(
            state_for(&states, crate::states::Column::InReview).map(|s| s.name.as_str()),
            Some("In Review")
        );
        assert_eq!(
            state_for(&states, crate::states::Column::Done).map(|s| s.name.as_str()),
            Some("Done")
        );
    }

    #[test]
    fn the_organisation_names_the_connection() {
        // `organization { urlKey name }` as in Linear's schema.
        let raw = br#"{"data":{"viewer":{"id":"8f1c","name":"Ada Lovelace","email":"ada@example.com"},"organization":{"urlKey":"acme","name":"Acme"}}}"#;
        assert_eq!(
            parse_account(raw).unwrap(),
            ("acme".to_string(), "Ada Lovelace".to_string())
        );
    }

    #[test]
    fn an_unauthenticated_answer_asks_to_sign_in_again() {
        let err = parse_viewer(&fixture("linear-error-auth.json")).unwrap_err();
        assert!(err.auth);
        assert_eq!(
            err.message,
            "You need to authenticate to access this operation."
        );
    }
}
