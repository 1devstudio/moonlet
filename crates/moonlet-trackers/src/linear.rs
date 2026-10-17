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
    // Open issues, and the done and canceled ones of the last 14 days.
    let recent = r#"or: [{ state: { type: { nin: ["completed", "canceled"] } } }, { updatedAt: { gt: "-P14D" } }]"#;
    format!(
        "query Issues($teams: [String!], $after: String) {{ issues(first: 100, after: $after, \
         filter: {{ team: {{ key: {{ in: $teams }} }}{who}, {recent} }}) {{ nodes {{ {ISSUE_FIELDS} }} \
         pageInfo {{ hasNextPage endCursor }} }} }}"
    )
}

/// What a task needs of a Linear issue.
const ISSUE_FIELDS: &str = "id identifier title description url branchName priority updatedAt \
     state { id name type } assignee { id name } labels { nodes { name } } cycle { number } team { key }";

/// One issue by its key, such as `MOON-142` (X46: a key pasted into the link dialog).
pub fn issue_query() -> String {
    format!("query Issue($id: String!) {{ issue(id: $id) {{ {ISSUE_FIELDS} }} }}")
}

/// The issue of [`issue_query`], or `None` when Linear knows no such key.
pub fn parse_issue(raw: &[u8], connection: &str) -> Result<Option<TrackerTask>, ApiError> {
    let v: Value = serde_json::from_slice(raw)
        .map_err(|e| ApiError::new(format!("Linear answered with something else: {e}")))?;
    // An unknown key comes back as `issue: null` with "Entity not found";
    // any other error stays an error.
    let not_found = v["errors"][0]["message"]
        .as_str()
        .is_some_and(|m| m.starts_with("Entity not found"));
    if v["data"]["issue"].is_null() && not_found {
        return Ok(None);
    }
    let issue = &data(raw)?["issue"];
    Ok((!issue.is_null()).then(|| issue_task(issue, connection)))
}

/// What a rejected API key says (X44).
pub const REJECTED: &str =
    "Linear no longer accepts this token. Create a new one and paste it here.";

/// The answer's `data`, or the error it carries.
fn data(raw: &[u8]) -> Result<Value, ApiError> {
    let v: Value = serde_json::from_slice(raw)
        .map_err(|e| ApiError::new(format!("Linear answered with something else: {e}")))?;
    if let Some(e) = v["errors"].as_array().and_then(|e| e.first()) {
        let ext = &e["extensions"];
        let auth = ext["type"]
            .as_str()
            .is_some_and(|t| t.contains("authentication"));
        // A rejected token reads the same however Linear sends it (X44); the
        // app words it for an OAuth sign-in.
        let message = if auth {
            REJECTED
        } else {
            ext["userPresentableMessage"]
                .as_str()
                .or(e["message"].as_str())
                .unwrap_or("Linear refused the request")
        };
        return Err(ApiError {
            auth,
            message: message.into(),
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

/// The viewer's id, to assign issues to them.
pub fn parse_viewer_id(raw: &[u8]) -> Result<String, ApiError> {
    data(raw)?["viewer"]["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(String::from)
        .ok_or_else(|| ApiError::new("Linear did not say who you are"))
}

/// The cursor of the next page of an `issues` answer, if there is one.
pub fn next_page(raw: &[u8]) -> Option<String> {
    let info = &data(raw).ok()?["issues"]["pageInfo"];
    if info["hasNextPage"].as_bool() != Some(true) {
        return None;
    }
    info["endCursor"].as_str().map(String::from)
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

/// The state a move to `column` uses, by the user's state mapping (X44).
/// A board column's state (X50), given by its id or name.
pub fn state_named<'a>(states: &'a [State], status: &str) -> Option<&'a State> {
    states.iter().find(|s| s.id == status || s.name == status)
}

pub fn state_for<'a>(
    states: &'a [State],
    column: crate::states::Column,
    mapping: &crate::states::Mapping,
) -> Option<&'a State> {
    crate::states::pick(states, column, mapping, |s| {
        let natural = crate::states::default_column(TrackerKind::Linear, &s.kind, &s.name);
        (natural, s.name.as_str())
    })
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

/// A team's states in board order (`position`), which the API does not
/// promise to keep.
pub fn parse_states(raw: &[u8]) -> Result<Vec<State>, ApiError> {
    let d = data(raw)?;
    let mut states: Vec<(f64, State)> = nodes(&d["workflowStates"])
        .map(|s| {
            let state = State {
                id: s["id"].as_str().unwrap_or_default().into(),
                name: s["name"].as_str().unwrap_or_default().into(),
                kind: s["type"].as_str().unwrap_or_default().into(),
            };
            (s["position"].as_f64().unwrap_or(f64::MAX), state)
        })
        .collect();
    states.sort_by(|a, b| a.0.total_cmp(&b.0));
    Ok(states.into_iter().map(|(_, s)| s).collect())
}

/// The issues of an `issues` query as tasks of `connection`.
pub fn parse_issues(raw: &[u8], connection: &str) -> Result<Vec<TrackerTask>, ApiError> {
    let d = data(raw)?;
    Ok(nodes(&d["issues"])
        .map(|i| issue_task(i, connection))
        .collect())
}

fn issue_task(i: &Value, connection: &str) -> TrackerTask {
    let state = &i["state"];
    let state_name = state["name"].as_str().unwrap_or_default();
    TrackerTask {
        connection: connection.into(),
        key: i["identifier"].as_str().unwrap_or_default().into(),
        title: i["title"].as_str().unwrap_or_default().into(),
        url: crate::task::web_url(&i["url"]).unwrap_or_default(),
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
        cycle: i["cycle"]["number"].as_u64(),
        issue_type: None,
        tracker: TrackerRef {
            id: i["id"].as_str().unwrap_or_default().into(),
            state: state_name.into(),
            source: i["team"]["key"].as_str().unwrap_or_default().into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::states::Column;
    use crate::states::Mapping;
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
        let list: serde_json::Value =
            serde_json::from_slice(&fixture("linear-issues.json")).unwrap();
        let node = &list["data"]["issues"]["nodes"][0];
        let one = serde_json::json!({ "data": { "issue": node } }).to_string();
        let t = parse_issue(one.as_bytes(), "linear:acme").unwrap().unwrap();
        assert_eq!(
            (t.key.as_str(), t.title.as_str(), t.tracker.state.as_str()),
            ("ENG-123", "Retry failed webhook deliveries", "In Progress")
        );
        // Linear answers a key it does not know with `issue: null` and an error.
        let missing =
            br#"{"data":{"issue":null},"errors":[{"message":"Entity not found: Issue"}]}"#;
        assert_eq!(parse_issue(missing, "linear:acme").unwrap(), None);
        assert!(issue_query()
            .starts_with("query Issue($id: String!) { issue(id: $id) { id identifier title"));
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
                cycle: Some(42),
                issue_type: None,
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
        assert_eq!(
            [tasks[0].cycle, tasks[1].cycle, tasks[2].cycle],
            [Some(42), None, Some(41)]
        );
        // `priority` is a Float in Linear's schema.
        let float = br#"{"data":{"issues":{"nodes":[{"identifier":"ENG-1","priority":2.0,"state":{"type":"started","name":"In Progress"},"team":{"key":"ENG"}}]}}}"#;
        assert_eq!(parse_issues(float, "linear:acme").unwrap()[0].priority, 3);
    }

    #[test]
    fn a_board_columns_state_by_its_id_or_name() {
        let states = parse_states(&fixture("linear-states.json")).unwrap();
        assert_eq!(
            state_named(&states, "In Review").map(|s| s.id.as_str()),
            Some("a1000000-0000-4000-8000-000000000004")
        );
        assert_eq!(
            state_named(&states, "a1000000-0000-4000-8000-000000000003").map(|s| s.name.as_str()),
            Some("Done")
        );
        assert_eq!(state_named(&states, "Shipped"), None);
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
            state_for(&states, crate::states::Column::InReview, &Mapping::new())
                .map(|s| s.name.as_str()),
            Some("In Review")
        );
        assert_eq!(
            state_for(&states, crate::states::Column::Done, &Mapping::new())
                .map(|s| s.name.as_str()),
            Some("Done")
        );
    }

    #[test]
    fn a_move_picks_the_first_state_of_the_column_by_position() {
        // The API does not promise any order.
        let raw = br#"{"data":{"workflowStates":{"nodes":[
            {"id":"s2","name":"Doing","type":"started","position":3},
            {"id":"s1","name":"In Progress","type":"started","position":2.5}
        ]}}}"#;
        let states = parse_states(raw).unwrap();
        assert_eq!(
            state_for(&states, crate::states::Column::InProgress, &Mapping::new())
                .map(|s| s.name.as_str()),
            Some("In Progress")
        );
    }

    #[test]
    fn a_move_follows_the_users_state_mapping() {
        let states = parse_states(&fixture("linear-states.json")).unwrap();
        let name = |m: &Mapping, c| state_for(&states, c, m).map(|s| s.name.clone());
        // Backlog mapped onto Todo: a move to Todo still lands on Todo.
        let backlog = Mapping::from([("Backlog".to_string(), Column::Todo)]);
        assert_eq!(name(&backlog, Column::Todo).as_deref(), Some("Todo"));
        // In Progress mapped onto In Review: a move to In Progress has nowhere to go…
        let moved = Mapping::from([("In Progress".to_string(), Column::InReview)]);
        assert_eq!(name(&moved, Column::InProgress), None);
        // …unless another state is mapped onto it.
        let both = Mapping::from([
            ("In Progress".to_string(), Column::InReview),
            ("Backlog".to_string(), Column::InProgress),
        ]);
        assert_eq!(name(&both, Column::InProgress).as_deref(), Some("Backlog"));
    }

    #[test]
    fn the_viewer_id_or_an_error() {
        assert_eq!(
            parse_viewer_id(&fixture("linear-viewer.json")).unwrap(),
            "8f1c2d3e-4b5a-4c6d-9e7f-0a1b2c3d4e5f"
        );
        assert!(parse_viewer_id(br#"{"data":{"viewer":null}}"#).is_err());
    }

    #[test]
    fn assigned_to_me_is_linears_own_is_me() {
        assert!(issues_query(true).contains("assignee: { isMe: { eq: true } }"));
        assert!(!issues_query(false).contains("isMe"));
        // Pages of 100.
        assert!(issues_query(true).contains("issues(first: 100, after: $after"));
    }

    #[test]
    fn issues_are_read_page_by_page() {
        assert_eq!(next_page(&fixture("linear-issues.json")), None);
        let more =
            br#"{"data":{"issues":{"nodes":[],"pageInfo":{"hasNextPage":true,"endCursor":"c2"}}}}"#;
        assert_eq!(next_page(more).as_deref(), Some("c2"));
        // Open issues, and the done and canceled ones of the last 14 days.
        assert!(issues_query(true).contains(
            r#"or: [{ state: { type: { nin: ["completed", "canceled"] } } }, { updatedAt: { gt: "-P14D" } }]"#
        ));
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
            "Linear no longer accepts this token. Create a new one and paste it here."
        );
    }

    #[test]
    fn an_unknown_key_is_no_issue_but_other_errors_stay_errors() {
        let missing = br#"{"data":{"issue":null},"errors":[{"message":"Entity not found: Issue","extensions":{"type":"invalid input"}}]}"#;
        assert_eq!(parse_issue(missing, "linear:acme").unwrap(), None);
        assert!(parse_issue(&fixture("linear-error-ratelimited.json"), "linear:acme").is_err());
        assert!(
            parse_issue(&fixture("linear-error-auth.json"), "linear:acme")
                .unwrap_err()
                .auth
        );
    }
}
