//! Jira boards (X50): the boards a connection can show, a board's columns
//! from its configuration, its query, and its issues with sprint and story
//! points. The app makes the requests; this reads and writes their bodies.

use serde::Serialize;
use serde_json::{Value, json};

pub use crate::board::{BoardIssue, Parent, Sprint};
use crate::config::{BoardColumn, Category, Finished, Show};
use crate::jira::parse;
use crate::states::default_column;
use crate::{ApiError, TrackerKind};

/// One of `GET /rest/agile/1.0/board`'s boards (X50 Add a board, step 1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JiraBoard {
    pub id: u64,
    pub name: String,
    /// `scrum`, `kanban` or `simple` (team-managed).
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
#[serde(rename_all = "camelCase")]
pub struct BoardSetup {
    /// The saved filter that picks the board's issues.
    pub filter_id: String,
    /// That filter's JQL, once read (`GET /rest/api/3/filter/{id}`), for
    /// Add a board's step 2.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter_jql: Option<String>,
    /// A Kanban board's sub-filter, added with AND.
    pub sub_query: Option<String>,
    /// The board's estimation field: its story points.
    pub points_field: Option<String>,
    /// Scrum and team-managed boards can have sprints; Kanban boards can't.
    pub sprints: bool,
    /// `scrum`, `kanban` or `simple` (team-managed), which the board switcher names.
    pub kind: String,
    /// The names of the columns' statuses, by id, for Add a board's step 3.
    pub status_names: std::collections::BTreeMap<String, String>,
    /// Jira's columns in order, with a suggested category and Show / Fold /
    /// Hide: a column with no status, or the backlog, is hidden; Done is folded.
    pub columns: Vec<BoardColumn>,
}

pub fn parse_board_config(raw: &[u8], statuses: &[JiraStatus]) -> Result<BoardSetup, ApiError> {
    let v = parse(raw)?;
    let columns: Vec<BoardColumn> = v["columnConfig"]["columns"]
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
            let category = suggest(
                name,
                ids.iter()
                    .filter_map(|id| statuses.iter().find(|s| s.id == *id))
                    .map(|s| s.category.as_str()),
            );
            let show = if ids.is_empty() || name.eq_ignore_ascii_case("backlog") {
                Show::Hide
            } else if category == Category::Done {
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
        filter_jql: None,
        sub_query: v["subQuery"]["query"]
            .as_str()
            .filter(|q| !q.trim().is_empty())
            .map(String::from),
        points_field: (v["estimation"]["type"] == "field")
            .then(|| {
                v["estimation"]["field"]["fieldId"]
                    .as_str()
                    .map(String::from)
            })
            .flatten(),
        sprints: v["type"] != "kanban",
        kind: v["type"].as_str().unwrap_or_default().into(),
        status_names: columns
            .iter()
            .flat_map(|c| &c.statuses)
            .filter_map(|id| {
                statuses
                    .iter()
                    .find(|s| &s.id == id)
                    .map(|s| (id.clone(), s.name.clone()))
            })
            .collect(),
        columns,
    })
}

/// A column's suggested category: the one most of its statuses have (by
/// their Jira category, or the column's name when that names a review),
/// a tie going to the later one; To do for a column with no status.
fn suggest<'a>(name: &str, categories: impl Iterator<Item = &'a str>) -> Category {
    let order = [
        Category::Todo,
        Category::InProgress,
        Category::InReview,
        Category::Done,
    ];
    let mut counts = [0usize; 4];
    for key in categories {
        let c =
            Category::of(default_column(TrackerKind::Jira, key, name)).unwrap_or(Category::Todo);
        counts[order.iter().position(|o| *o == c).unwrap_or(0)] += 1;
    }
    let best = counts.iter().max().copied().unwrap_or(0);
    order
        .iter()
        .zip(counts)
        .rev()
        .find(|(_, n)| *n == best && best > 0)
        .map_or(Category::Todo, |(c, _)| *c)
}

/// A JQL board's columns (X50 Add a board, step 3): one per status its
/// issues are in, each named after it, in category order and else as first
/// seen; Done folded.
pub fn columns_from_issues(issues: &[BoardIssue]) -> Vec<BoardColumn> {
    let mut columns: Vec<BoardColumn> = Vec::new();
    for i in issues {
        if i.status_id.is_empty() || columns.iter().any(|c| c.statuses.contains(&i.status_id)) {
            continue;
        }
        let category = Category::of(i.task.column).unwrap_or(Category::Todo);
        columns.push(BoardColumn {
            name: i.task.tracker.state.clone(),
            statuses: vec![i.status_id.clone()],
            category,
            show: if category == Category::Done {
                Show::Fold
            } else {
                Show::Show
            },
            wip: None,
        });
    }
    let rank = |c: &Category| {
        [
            Category::Todo,
            Category::InProgress,
            Category::InReview,
            Category::Done,
        ]
        .iter()
        .position(|o| o == c)
    };
    columns.sort_by_key(|c| rank(&c.category));
    columns
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
    let mut escaped = false;
    let mut found = None;
    for (i, &b) in bytes.iter().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        match (quote, b) {
            (Some(_), b'\\') => escaped = true,
            (None, b'"' | b'\'') => quote = Some(b),
            (Some(q), _) if b == q => quote = None,
            (None, b'o')
                if lower[i..].starts_with("order")
                    && (i == 0 || bytes[i - 1].is_ascii_whitespace() || bytes[i - 1] == b')') =>
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
    // An ORDER BY in the sub-filter or the narrowing would end the query
    // early: only the filter's order counts.
    let mut parts: Vec<String> = [
        Some(condition),
        sub_query.map(|q| split_order(q).0),
        Some(split_order(narrow).0),
    ]
    .into_iter()
    .flatten()
    .filter(|c| !c.is_empty())
    .map(|c| format!("({c})"))
    .collect();
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

/// The site's sprint field and a board's story points field, which a
/// board's search asks for and reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchFields {
    pub sprint: Option<String>,
    pub points: Option<String>,
}

/// The body of `POST /rest/api/3/search/jql` for a board: X44's fields plus
/// components, parent, due date, and the sprint and points fields.
pub fn board_search_body(jql: &str, fields: &SearchFields, next_page_token: Option<&str>) -> Value {
    let mut asked: Vec<&str> = crate::jira::FIELDS.to_vec();
    asked.extend(["components", "parent", "duedate"]);
    asked.extend(fields.sprint.as_deref());
    asked.extend(fields.points.as_deref());
    let fields = asked;
    let mut body = json!({ "jql": jql, "fields": fields, "maxResults": 100 });
    if let Some(t) = next_page_token {
        body["nextPageToken"] = json!(t);
    }
    body
}

/// A page of a board's search: its issues, and the active sprint of board
/// `board` as its issues' sprint field gives it.
pub fn parse_board_search(
    raw: &[u8],
    connection: &str,
    site: &str,
    fields: &SearchFields,
    board: Option<u64>,
) -> Result<(Vec<BoardIssue>, Option<Sprint>), ApiError> {
    let (sprint_field, points_field) = (fields.sprint.as_deref(), fields.points.as_deref());
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
                due_ms: None,
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

    fn ops_fields() -> SearchFields {
        SearchFields {
            sprint: Some("customfield_10010".into()),
            points: Some("customfield_10014".into()),
        }
    }

    fn col(
        name: &str,
        statuses: &[&str],
        category: Category,
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
                filter_jql: None,
                sub_query: None,
                points_field: Some("customfield_10014".into()),
                sprints: true,
                kind: "scrum".into(),
                // Step 3 lists each column's statuses by name.
                status_names: [
                    ("1", "Open"),
                    ("10018", "Needs Reviews"),
                    ("10019", "Ready to Deploy"),
                    ("10030", "Acceptance Testing"),
                    ("3", "In Progress"),
                    ("5", "QA Testing"),
                    ("6", "Closed"),
                ]
                .into_iter()
                .map(|(id, name)| (id.to_string(), name.to_string()))
                .collect(),
                columns: vec![
                    col("Open", &["1"], Category::Todo, Show::Show, None),
                    col(
                        "In Progress",
                        &["3"],
                        Category::InProgress,
                        Show::Show,
                        None
                    ),
                    col(
                        "Needs Reviews",
                        &["10018"],
                        Category::InReview,
                        Show::Show,
                        Some(2)
                    ),
                    col(
                        "Acceptance Testing",
                        &["10030"],
                        Category::InProgress,
                        Show::Show,
                        None
                    ),
                    col("QA Testing", &["5"], Category::InReview, Show::Show, None),
                    col("Done", &["10019", "6"], Category::Done, Show::Fold, None),
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
                setup.points_field,
                setup.sprints,
                setup.kind.as_str()
            ),
            (
                "10650",
                Some("fixVersion in unreleasedVersions() OR fixVersion is EMPTY"),
                None,
                false,
                "kanban"
            )
        );
        assert_eq!(
            setup.columns,
            [
                col("Backlog", &[], Category::Todo, Show::Hide, None),
                col("To Do", &["10000"], Category::Todo, Show::Show, None),
                col(
                    "In Progress",
                    &["3"],
                    Category::InProgress,
                    Show::Show,
                    None
                ),
                col(
                    "IN REVIEW",
                    &["10129"],
                    Category::InReview,
                    Show::Show,
                    None
                ),
                col(
                    "In Testing",
                    &["10349"],
                    Category::InProgress,
                    Show::Show,
                    None
                ),
                col(
                    "Tested - Pending Deployment",
                    &["10382"],
                    Category::InProgress,
                    Show::Show,
                    None
                ),
                col("Done", &["10097"], Category::Done, Show::Fold, None),
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
            board_search_body("project = 10008 ORDER BY Rank ASC", &ops_fields(), None)["fields"],
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
            &ops_fields(),
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

    #[test]
    fn a_columns_category_is_the_one_most_of_its_statuses_have() {
        let statuses = parse_statuses(&fixture("jira-statuses.json")).unwrap();
        let config = serde_json::json!({ "type": "kanban", "filter": { "id": "1" }, "columnConfig": { "columns": [
            { "name": "Doing", "statuses": [{ "id": "10000" }, { "id": "3" }, { "id": "10030" }] },
            { "name": "Shipping", "statuses": [{ "id": "10030" }, { "id": "10097" }] }
        ] } });
        let setup = parse_board_config(config.to_string().as_bytes(), &statuses).unwrap();
        // Two in progress against one to do; a tie goes to the later category.
        assert_eq!(
            setup
                .columns
                .iter()
                .map(|c| (c.name.as_str(), c.category))
                .collect::<Vec<_>>(),
            [
                ("Doing", Category::InProgress),
                ("Shipping", Category::Done)
            ]
        );
    }

    #[test]
    fn the_query_survives_filters_that_end_or_hide_an_order_by() {
        // Only an order: no empty condition.
        assert_eq!(
            board_jql("ORDER BY created DESC", None, "", false, Finished::Days(14)),
            "(statusCategory != Done OR updated >= -14d) ORDER BY created DESC"
        );
        // A parenthesis right before ORDER BY, and an ORDER BY in the narrowing.
        assert_eq!(
            board_jql(
                "(project = OPS)ORDER BY Rank ASC",
                None,
                "component = billing order by key",
                true,
                Finished::Sprint
            ),
            "((project = OPS)) AND (component = billing) AND assignee = currentUser() AND sprint in openSprints() ORDER BY Rank ASC"
        );
        // An escaped quote inside a string doesn't end it.
        assert_eq!(
            board_jql(
                r#"summary ~ "it\"s order by x" ORDER BY key"#,
                None,
                "",
                false,
                Finished::Days(14)
            ),
            r#"(summary ~ "it\"s order by x") AND (statusCategory != Done OR updated >= -14d) ORDER BY key"#
        );
    }

    #[test]
    fn a_jql_boards_columns_are_its_issues_statuses_in_category_order() {
        let (issues, _) = parse_board_search(
            &fixture("jira-board-search.json"),
            "jira:acme.atlassian.net",
            "acme.atlassian.net",
            &ops_fields(),
            Some(10),
        )
        .unwrap();
        assert_eq!(
            columns_from_issues(&issues),
            [
                col("To Do", &["10000"], Category::Todo, Show::Show, None),
                col(
                    "Needs Reviews",
                    &["10018"],
                    Category::InReview,
                    Show::Show,
                    None
                ),
            ]
        );
        assert_eq!(issues[3].due.as_deref(), Some("2026-10-24"));
    }
}
