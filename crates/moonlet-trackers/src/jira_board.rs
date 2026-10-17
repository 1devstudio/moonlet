//! Jira boards (X50): the boards a connection can show, a board's columns
//! from its configuration, its query, and its issues with sprint and story
//! points. The app makes the requests; this reads and writes their bodies.

use serde::Serialize;
use serde_json::{Value, json};

use crate::config::{BoardColumn, Finished, Show};
use crate::states::{Column, default_column};
use crate::task::TrackerTask;
use crate::{ApiError, TrackerKind};

fn parse(raw: &[u8]) -> Result<Value, ApiError> {
    serde_json::from_slice(raw)
        .map_err(|e| ApiError::new(format!("Jira answered with something else: {e}")))
}

/// One of `GET /rest/agile/1.0/board`'s boards (X50 Add a board, step 1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JiraBoard {
    pub id: u64,
    pub name: String,
    /// `scrum`, `kanban` or `simple`.
    pub kind: String,
    /// The project key, when the board belongs to one.
    pub project: Option<String>,
}

/// A page of boards, and whether it is the last.
pub fn parse_boards(raw: &[u8]) -> Result<(Vec<JiraBoard>, bool), ApiError> {
    let v = parse(raw)?;
    let boards = v["values"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|b| JiraBoard {
            id: b["id"].as_u64().unwrap_or_default(),
            name: b["name"].as_str().unwrap_or_default().into(),
            kind: b["type"].as_str().unwrap_or_default().into(),
            project: b["location"]["projectKey"].as_str().map(String::from),
        })
        .collect();
    Ok((boards, v["isLast"].as_bool().unwrap_or(true)))
}

/// One of the site's statuses (`GET /rest/api/3/status`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraStatus {
    pub id: String,
    pub name: String,
    /// The status category key: `new`, `indeterminate` or `done`.
    pub category: String,
}

pub fn parse_statuses(raw: &[u8]) -> Result<Vec<JiraStatus>, ApiError> {
    let v = parse(raw)?;
    Ok(v.as_array()
        .into_iter()
        .flatten()
        .map(|s| JiraStatus {
            id: s["id"].as_str().unwrap_or_default().into(),
            name: s["name"].as_str().unwrap_or_default().into(),
            category: s["statusCategory"]["key"]
                .as_str()
                .unwrap_or_default()
                .into(),
        })
        .collect())
}

/// What a board's configuration says (`GET /rest/agile/1.0/board/{id}/configuration`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BoardSetup {
    /// The saved filter that picks the board's issues.
    pub filter_id: String,
    /// A Kanban board's sub-filter, added with AND.
    pub sub_query: Option<String>,
    /// The story points field, when the board estimates with one.
    pub estimation: Option<String>,
    /// Scrum boards have sprints.
    pub sprints: bool,
    /// Jira's columns in order, with a suggested category and Show / Fold /
    /// Hide: a column with no status, or the backlog, is hidden; Done is folded.
    pub columns: Vec<BoardColumn>,
}

pub fn parse_board_config(raw: &[u8], statuses: &[JiraStatus]) -> Result<BoardSetup, ApiError> {
    let v = parse(raw)?;
    let columns = v["columnConfig"]["columns"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let name = c["name"].as_str().unwrap_or_default();
            let ids: Vec<String> = c["statuses"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|s| s["id"].as_str().map(String::from))
                .collect();
            // The first status's category, or the column's name when that
            // names a review ("Code Review", "QA Testing").
            let category_key = ids
                .first()
                .and_then(|id| statuses.iter().find(|s| s.id == *id))
                .map_or("new", |s| s.category.as_str());
            let category = match default_column(TrackerKind::Jira, category_key, name) {
                Column::Hidden => Column::Todo,
                c => c,
            };
            let show = if ids.is_empty() || name.eq_ignore_ascii_case("backlog") {
                Show::Hide
            } else if category == Column::Done {
                Show::Fold
            } else {
                Show::Show
            };
            BoardColumn {
                name: name.into(),
                statuses: ids,
                category,
                show,
                wip: c["max"].as_u64().map(|m| m as u32),
            }
        })
        .collect();
    Ok(BoardSetup {
        filter_id: v["filter"]["id"].as_str().unwrap_or_default().into(),
        sub_query: v["subQuery"]["query"]
            .as_str()
            .filter(|q| !q.trim().is_empty())
            .map(String::from),
        estimation: (v["estimation"]["type"] == "field")
            .then(|| {
                v["estimation"]["field"]["fieldId"]
                    .as_str()
                    .map(String::from)
            })
            .flatten(),
        sprints: v["type"] == "scrum",
        columns,
    })
}

/// The JQL of a saved filter (`GET /rest/api/3/filter/{id}`).
pub fn parse_filter(raw: &[u8]) -> Result<String, ApiError> {
    Ok(parse(raw)?["jql"].as_str().unwrap_or_default().into())
}

/// `jql` split into its condition and its `ORDER BY` clause, if it has one
/// outside quotes.
fn split_order(jql: &str) -> (&str, Option<&str>) {
    let lower = jql.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut quote = None;
    let mut found = None;
    for (i, &b) in bytes.iter().enumerate() {
        match (quote, b) {
            (None, b'"' | b'\'') => quote = Some(b),
            (Some(q), _) if b == q => quote = None,
            (None, b'o')
                if lower[i..].starts_with("order")
                    && (i == 0 || bytes[i - 1].is_ascii_whitespace()) =>
            {
                let rest = lower[i + 5..].trim_start();
                let gap = lower.len() - i - 5 - rest.len();
                if gap > 0 && rest.starts_with("by") && rest[2..].starts_with(char::is_whitespace) {
                    found = Some(i);
                }
            }
            _ => {}
        }
    }
    match found {
        Some(i) => {
            let order = jql[i + 5..].trim_start()[2..].trim();
            (jql[..i].trim(), Some(order))
        }
        None => (jql.trim(), None),
    }
}

/// A board's search (X50): its filter or query, a Kanban board's sub-filter,
/// moonlet's narrowing, the user's own issues when `mine`, and the active
/// sprint's issues or those open or finished in the last days; in the
/// filter's order, else Jira's rank.
pub fn board_jql(
    filter: &str,
    sub_query: Option<&str>,
    narrow: &str,
    mine: bool,
    finished: Finished,
) -> String {
    let (condition, order) = split_order(filter);
    let mut parts = vec![format!("({condition})")];
    if let Some(q) = sub_query {
        parts.push(format!("({q})"));
    }
    if !narrow.trim().is_empty() {
        parts.push(format!("({})", narrow.trim()));
    }
    if mine {
        parts.push("assignee = currentUser()".into());
    }
    parts.push(match finished {
        Finished::Sprint => "sprint in openSprints()".into(),
        Finished::Days(n) => format!("(statusCategory != Done OR updated >= -{n}d)"),
    });
    format!(
        "{} ORDER BY {}",
        parts.join(" AND "),
        order.unwrap_or("Rank ASC")
    )
}

/// The site's sprint field: the one Jira Software made (`gh-sprint`).
pub fn sprint_field(raw: &[u8]) -> Result<Option<String>, ApiError> {
    let v = parse(raw)?;
    Ok(v.as_array()
        .into_iter()
        .flatten()
        .find(|f| f["schema"]["custom"] == "com.pyxis.greenhopper.jira:gh-sprint")
        .and_then(|f| f["id"].as_str().map(String::from)))
}

/// The body of `POST /rest/api/3/search/jql` for a board: X44's fields plus
/// components, parent, due date, and the sprint and points fields.
pub fn board_search_body(
    jql: &str,
    sprint: Option<&str>,
    points: Option<&str>,
    next_page_token: Option<&str>,
) -> Value {
    let mut fields: Vec<&str> = crate::jira::FIELDS.to_vec();
    fields.extend(["components", "parent", "duedate"]);
    fields.extend(sprint);
    fields.extend(points);
    let mut body = json!({ "jql": jql, "fields": fields, "maxResults": 100 });
    if let Some(t) = next_page_token {
        body["nextPageToken"] = json!(t);
    }
    body
}

/// A board's issue: the task, and what a board card and its column need.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardIssue {
    #[serde(flatten)]
    pub task: TrackerTask,
    /// The status's id, which the board's columns list.
    pub status_id: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub components: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<Parent>,
    /// `YYYY-MM-DD`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
}

/// An issue's epic or parent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Parent {
    pub key: String,
    pub title: String,
}

/// The sprint a Scrum board follows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sprint {
    pub id: u64,
    pub name: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// A page of a board's search: its issues, and the active sprint of board
/// `board` as its issues' sprint field gives it.
pub fn parse_board_search(
    raw: &[u8],
    connection: &str,
    site: &str,
    sprint_field: Option<&str>,
    points_field: Option<&str>,
    board: Option<u64>,
) -> Result<(Vec<BoardIssue>, Option<Sprint>), ApiError> {
    let tasks = crate::jira::parse_search(raw, connection, site)?;
    let v = parse(raw)?;
    let raw_issues: Vec<&Value> = v["issues"].as_array().into_iter().flatten().collect();
    let mut sprint = None;
    let issues = tasks
        .into_iter()
        .zip(raw_issues)
        .map(|(task, i)| {
            let f = &i["fields"];
            if let (None, Some(field)) = (&sprint, sprint_field) {
                sprint = f[field].as_array().into_iter().flatten().find_map(|s| {
                    let here = board.is_none_or(|b| s["boardId"].as_u64() == Some(b));
                    (s["state"] == "active" && here).then(|| Sprint {
                        id: s["id"].as_u64().unwrap_or_default(),
                        name: s["name"].as_str().unwrap_or_default().into(),
                        start_ms: s["startDate"]
                            .as_str()
                            .and_then(crate::time::timestamp_ms)
                            .unwrap_or(0),
                        end_ms: s["endDate"]
                            .as_str()
                            .and_then(crate::time::timestamp_ms)
                            .unwrap_or(0),
                    })
                });
            }
            BoardIssue {
                task,
                status_id: f["status"]["id"].as_str().unwrap_or_default().into(),
                components: f["components"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|c| c["name"].as_str().map(String::from))
                    .collect(),
                points: points_field.and_then(|p| f[p].as_f64()),
                parent: f["parent"]["key"].as_str().map(|key| Parent {
                    key: key.into(),
                    title: f["parent"]["fields"]["summary"]
                        .as_str()
                        .unwrap_or_default()
                        .into(),
                }),
                due: f["duedate"].as_str().map(String::from),
            }
        })
        .collect();
    Ok((issues, sprint))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(format!(
            "{}/tests/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    }

    #[test]
    fn the_boards_a_connection_can_show() {
        let (boards, last) = parse_boards(&fixture("jira-boards.json")).unwrap();
        assert!(last);
        assert_eq!(
            boards,
            [
                JiraBoard {
                    id: 10,
                    name: "OPS board".into(),
                    kind: "scrum".into(),
                    project: Some("OPS".into())
                },
                JiraBoard {
                    id: 224,
                    name: "PLAT tasks".into(),
                    kind: "kanban".into(),
                    project: Some("PLAT".into())
                },
                JiraBoard {
                    id: 78,
                    name: "Design board".into(),
                    kind: "simple".into(),
                    project: Some("DES".into())
                },
                // A board on a filter that spans projects has no project.
                JiraBoard {
                    id: 18,
                    name: "Release train".into(),
                    kind: "scrum".into(),
                    project: None
                },
            ]
        );
    }

    fn col(
        name: &str,
        statuses: &[&str],
        category: Column,
        show: Show,
        wip: Option<u32>,
    ) -> BoardColumn {
        BoardColumn {
            name: name.into(),
            statuses: statuses.iter().map(|s| s.to_string()).collect(),
            category,
            show,
            wip,
        }
    }

    #[test]
    fn a_scrum_boards_columns_with_their_suggested_categories() {
        let statuses = parse_statuses(&fixture("jira-statuses.json")).unwrap();
        let setup =
            parse_board_config(&fixture("jira-board-scrum-configuration.json"), &statuses).unwrap();
        assert_eq!(
            setup,
            BoardSetup {
                filter_id: "10021".into(),
                sub_query: None,
                estimation: Some("customfield_10014".into()),
                sprints: true,
                columns: vec![
                    col("Open", &["1"], Column::Todo, Show::Show, None),
                    col("In Progress", &["3"], Column::InProgress, Show::Show, None),
                    col(
                        "Needs Reviews",
                        &["10018"],
                        Column::InReview,
                        Show::Show,
                        Some(2)
                    ),
                    col(
                        "Acceptance Testing",
                        &["10030"],
                        Column::InProgress,
                        Show::Show,
                        None
                    ),
                    col("QA Testing", &["5"], Column::InReview, Show::Show, None),
                    col("Done", &["10019", "6"], Column::Done, Show::Fold, None),
                ],
            }
        );
    }

    #[test]
    fn a_kanban_boards_backlog_is_hidden_and_its_sub_filter_kept() {
        let statuses = parse_statuses(&fixture("jira-statuses.json")).unwrap();
        let setup = parse_board_config(&fixture("jira-board-kanban-configuration.json"), &statuses)
            .unwrap();
        assert_eq!(
            (
                setup.filter_id.as_str(),
                setup.sub_query.as_deref(),
                setup.estimation,
                setup.sprints
            ),
            (
                "10650",
                Some("fixVersion in unreleasedVersions() OR fixVersion is EMPTY"),
                None,
                false
            )
        );
        assert_eq!(
            setup.columns,
            [
                col("Backlog", &[], Column::Todo, Show::Hide, None),
                col("To Do", &["10000"], Column::Todo, Show::Show, None),
                col("In Progress", &["3"], Column::InProgress, Show::Show, None),
                col("IN REVIEW", &["10129"], Column::InReview, Show::Show, None),
                col(
                    "In Testing",
                    &["10349"],
                    Column::InProgress,
                    Show::Show,
                    None
                ),
                col(
                    "Tested - Pending Deployment",
                    &["10382"],
                    Column::InProgress,
                    Show::Show,
                    None
                ),
                col("Done", &["10097"], Column::Done, Show::Fold, None),
            ]
        );
    }

    #[test]
    fn a_boards_query_is_its_filter_and_moonlets_narrowing_in_the_filters_order() {
        let scrum = parse_filter(&fixture("jira-filter-scrum.json")).unwrap();
        assert_eq!(scrum, "project = 10008 ORDER BY Rank ASC");
        assert_eq!(
            board_jql(&scrum, None, "", true, Finished::Sprint),
            "(project = 10008) AND assignee = currentUser() AND sprint in openSprints() ORDER BY Rank ASC"
        );
        let kanban = parse_filter(&fixture("jira-filter-kanban.json")).unwrap();
        assert_eq!(
            board_jql(
                &kanban,
                Some("fixVersion in unreleasedVersions() OR fixVersion is EMPTY"),
                "component = billing",
                false,
                Finished::Days(14)
            ),
            "(project in (10173) AND issuetype != Epic) AND (fixVersion in unreleasedVersions() OR fixVersion is EMPTY) AND (component = billing) AND (statusCategory != Done OR updated >= -14d) ORDER BY priority DESC, Rank ASC"
        );
        // A JQL board's own query, without an order of its own, gets Jira's rank.
        assert_eq!(
            board_jql(
                "project = OPS and Order = 1",
                None,
                "",
                false,
                Finished::Days(7)
            ),
            "(project = OPS and Order = 1) AND (statusCategory != Done OR updated >= -7d) ORDER BY Rank ASC"
        );
    }

    #[test]
    fn the_sprint_field_is_found_by_its_type_and_points_come_from_the_boards_estimation() {
        assert_eq!(
            sprint_field(&fixture("jira-fields.json"))
                .unwrap()
                .as_deref(),
            Some("customfield_10010")
        );
        // The search asks for the board's own points field, not the site's
        // other "Story point estimate".
        assert_eq!(
            board_search_body(
                "project = 10008 ORDER BY Rank ASC",
                Some("customfield_10010"),
                Some("customfield_10014"),
                None
            )["fields"],
            serde_json::json!([
                "summary",
                "status",
                "priority",
                "assignee",
                "labels",
                "updated",
                "description",
                "project",
                "issuetype",
                "components",
                "parent",
                "duedate",
                "customfield_10010",
                "customfield_10014"
            ])
        );
    }

    #[test]
    fn a_boards_issues_with_their_status_id_points_parent_and_the_active_sprint() {
        let (issues, sprint) = parse_board_search(
            &fixture("jira-board-search.json"),
            "jira:acme.atlassian.net",
            "acme.atlassian.net",
            Some("customfield_10010"),
            Some("customfield_10014"),
            Some(10),
        )
        .unwrap();
        assert_eq!(
            issues
                .iter()
                .map(|i| (
                    i.task.key.as_str(),
                    i.status_id.as_str(),
                    i.points,
                    i.components.clone(),
                    i.parent
                        .as_ref()
                        .map(|p| (p.key.as_str(), p.title.as_str()))
                ))
                .collect::<Vec<_>>(),
            [
                (
                    "OPS-512",
                    "10000",
                    Some(3.0),
                    vec![],
                    Some(("OPS-400", "Audit readiness"))
                ),
                (
                    "OPS-487",
                    "10018",
                    Some(5.0),
                    vec!["billing".to_string()],
                    Some(("OPS-480", "Billing reliability"))
                ),
                (
                    "OPS-490",
                    "10018",
                    Some(5.0),
                    vec![],
                    Some(("OPS-480", "Billing reliability"))
                ),
                ("OPS-521", "10000", Some(0.5), vec![], None),
            ]
        );
        assert_eq!(
            (
                issues[3].task.issue_type.as_deref(),
                issues[3].task.assignees.clone()
            ),
            (Some("Task"), vec!["Anna Kowalska".to_string()])
        );
        // OPS-490 was carried over from Sprint 41; the active one counts.
        assert_eq!(
            sprint,
            Some(Sprint {
                id: 5109,
                name: "OPS Sprint 42".into(),
                start_ms: 1_791_387_419_718,
                end_ms: 1_792_593_000_000
            })
        );
        let json = serde_json::to_value(&issues[1]).unwrap();
        assert_eq!(
            (
                &json["key"],
                &json["statusId"],
                &json["points"],
                &json["components"]
            ),
            (
                &serde_json::json!("OPS-487"),
                &serde_json::json!("10018"),
                &serde_json::json!(5.0),
                &serde_json::json!(["billing"])
            )
        );
    }
}
