//! A new Jira issue from a board column's + (X52): the form's lists from
//! Jira's create metadata, the request with its description in Atlassian
//! document format, and the transition that puts it in the column.

use serde_json::{Value, json};

use crate::ApiError;
use crate::board::{Named, NewIssue};
use crate::jira::{Transition, parse};

/// What a project's create screen says for an issue type (X52).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CreateScreen {
    /// The ids of the fields it has.
    pub fields: Vec<String>,
    /// The names of the fields it requires that the form lacks and Jira has no default for.
    pub missing: Vec<String>,
}

/// Where a new issue stands against its column once Jira created it.
#[derive(Debug, PartialEq)]
pub enum ColumnMove<'a> {
    /// Jira created it in one of the column's statuses.
    Already,
    /// This transition leads there.
    Via(&'a Transition),
    /// None does, from where Jira put it.
    Unreachable,
}

/// A project's standard issue types (X52), Task first: sub-tasks and types
/// above (epics) or below the standard level are left out.
pub fn parse_issue_types(raw: &[u8]) -> Result<Vec<Named>, ApiError> {
    let v = parse(raw)?;
    let mut types: Vec<Named> = v["issueTypes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["subtask"] != true && t["hierarchyLevel"].as_i64().unwrap_or(0) == 0)
        .map(|t| Named {
            id: t["id"].as_str().unwrap_or_default().into(),
            name: t["name"].as_str().unwrap_or_default().into(),
        })
        .collect();
    // Task first, found by its English name on a site in another language.
    let task = |t: &Value| t["untranslatedName"].as_str().or(t["name"].as_str()) == Some("Task");
    let tasks: Vec<String> = v["issueTypes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| task(t))
        .filter_map(|t| t["id"].as_str().map(String::from))
        .collect();
    types.sort_by_key(|t| !tasks.contains(&t.id));
    Ok(types)
}

/// The fields the form fills.
const FORM_FIELDS: [&str; 6] = [
    "summary",
    "issuetype",
    "project",
    "description",
    "assignee",
    "labels",
];

/// A project's create screen for an issue type (X52): its fields, and the
/// required ones the form doesn't fill that have no default.
pub fn parse_create_screen(raw: &[u8]) -> Result<CreateScreen, ApiError> {
    let v = parse(raw)?;
    let fields: Vec<&Value> = v["fields"].as_array().into_iter().flatten().collect();
    Ok(CreateScreen {
        fields: fields
            .iter()
            .filter_map(|f| f["fieldId"].as_str().map(String::from))
            .collect(),
        missing: fields
            .iter()
            .filter(|f| f["required"] == true && f["hasDefaultValue"] != true)
            .filter(|f| !FORM_FIELDS.contains(&f["fieldId"].as_str().unwrap_or_default()))
            .filter_map(|f| f["name"].as_str().map(String::from))
            .collect(),
    })
}

/// The people a project's issue can be assigned to (X52), by account id.
pub fn parse_assignable(raw: &[u8]) -> Result<Vec<Named>, ApiError> {
    Ok(parse(raw)?
        .as_array()
        .into_iter()
        .flatten()
        .map(|u| Named {
            id: u["accountId"].as_str().unwrap_or_default().into(),
            name: u["displayName"].as_str().unwrap_or_default().into(),
        })
        .collect())
}

/// `POST /rest/api/3/issue`'s body for `issue` in `project` (X52): its type,
/// summary and description, and the assignee (the user is `me`, an account
/// id) and labels where the create screen has them.
pub fn create_body(issue: &NewIssue, project: &str, me: &str, screen: &CreateScreen) -> Value {
    let on = |field: &str| screen.fields.iter().any(|f| f == field);
    let mut fields = json!({
        "project": { "key": project },
        "issuetype": { "id": issue.issue_type.clone().unwrap_or_default() },
        "summary": issue.title,
    });
    if !issue.description.is_empty() {
        fields["description"] = crate::adf::from_markdown(&issue.description);
    }
    let assignee = match issue.assignee.as_str() {
        "none" => None,
        "me" => Some(me),
        id => Some(id),
    };
    if let (Some(id), true) = (assignee, on("assignee")) {
        fields["assignee"] = json!({ "accountId": id });
    }
    if !issue.labels.is_empty() && on("labels") {
        fields["labels"] = issue.labels.clone().into();
    }
    json!({ "fields": fields })
}

/// The created issue's key.
pub fn parse_created(raw: &[u8]) -> Result<String, ApiError> {
    parse(raw)?["key"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| ApiError::new("Jira did not create the issue"))
}

/// How a new issue Jira created in `current` gets into a column of
/// `statuses` (X52): already there, by the first transition to one of them in
/// the column's order, or not from here.
pub fn into_column<'a>(
    statuses: &[String],
    current: &str,
    transitions: &'a [Transition],
) -> ColumnMove<'a> {
    if statuses.iter().any(|s| s == current) {
        return ColumnMove::Already;
    }
    statuses
        .iter()
        .find_map(|s| transitions.iter().find(|t| &t.to_id == s))
        .map_or(ColumnMove::Unreachable, ColumnMove::Via)
}

/// What the notice says after "Created <key>" when the issue isn't in its
/// column (X52): where Jira put it, and that no transition leads there.
pub fn move_note(placed: &ColumnMove, current: &str, column: &str) -> Option<String> {
    matches!(placed, ColumnMove::Unreachable)
        .then(|| format!(" in {current}; Jira has no way to move it to {column} from there"))
}

/// `GET /rest/api/3/issue/{key}`'s issue as a board shows it.
pub fn parse_board_issue(
    raw: &[u8],
    connection: &str,
    site: &str,
) -> Result<crate::board::BoardIssue, ApiError> {
    let wrapped = json!({ "issues": [parse(raw)?] }).to_string();
    let fields = crate::jira_board::SearchFields {
        sprint: None,
        points: None,
    };
    let (mut issues, _) =
        crate::jira_board::parse_board_search(wrapped.as_bytes(), connection, site, &fields, None)?;
    issues
        .pop()
        .ok_or_else(|| ApiError::new("Jira sent no issue"))
}

/// A created issue Jira couldn't be asked about yet: its key, the title
/// given, and its page; the next sync reads the rest.
pub fn created_issue(
    key: &str,
    title: &str,
    connection: &str,
    site: &str,
) -> crate::board::BoardIssue {
    let project = key.split('-').next().unwrap_or_default();
    crate::board::BoardIssue::from_task(crate::task::TrackerTask {
        connection: connection.into(),
        key: key.into(),
        title: title.into(),
        url: format!("https://{site}/browse/{key}"),
        column: crate::states::Column::Todo,
        priority: 0,
        assignees: vec![],
        labels: vec![],
        description: String::new(),
        updated_ms: 0,
        cycle: None,
        issue_type: None,
        tracker: crate::task::TrackerRef {
            id: key.into(),
            state: String::new(),
            source: project.into(),
        },
    })
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
    fn a_projects_standard_issue_types_task_first() {
        // Bug, Task, Epic (a level up) and Sub-task: epics and sub-tasks are left out.
        assert_eq!(
            parse_issue_types(&fixture("jira-createmeta-issuetypes.json")).unwrap(),
            [
                Named {
                    id: "10001".into(),
                    name: "Task".into()
                },
                Named {
                    id: "1".into(),
                    name: "Bug".into()
                }
            ]
        );
    }

    #[test]
    fn a_create_screens_fields_and_the_required_ones_the_form_lacks() {
        let screen = parse_create_screen(&fixture("jira-createmeta-fields.json")).unwrap();
        assert_eq!(
            screen.fields,
            [
                "summary",
                "issuetype",
                "project",
                "assignee",
                "labels",
                "description",
                "reporter",
                "customfield_10050"
            ]
        );
        // The reporter is required but has a default; Team has none.
        assert_eq!(screen.missing, ["Team"]);
    }

    #[test]
    fn the_people_an_issue_can_be_assigned_to() {
        assert_eq!(
            parse_assignable(&fixture("jira-assignable-users.json")).unwrap(),
            [
                Named {
                    id: "5b10a2844c20165700ede21g".into(),
                    name: "Mia Krystof".into()
                },
                Named {
                    id: "5b10ac8d82e05b22cc7d4ef5".into(),
                    name: "Kim Park".into()
                }
            ]
        );
    }

    #[test]
    fn task_first_by_its_untranslated_name_and_a_required_reporter_without_a_default() {
        let types = br#"{"issueTypes":[{"id":"1","name":"Bug","subtask":false},{"id":"2","name":"T\u00e2che","untranslatedName":"Task","subtask":false}]}"#;
        assert_eq!(
            parse_issue_types(types)
                .unwrap()
                .iter()
                .map(|t| t.name.as_str())
                .collect::<Vec<_>>(),
            ["Tâche", "Bug"]
        );
        let screen = br#"{"fields":[{"fieldId":"summary","name":"Summary","required":true,"hasDefaultValue":false},{"fieldId":"reporter","name":"Reporter","required":true,"hasDefaultValue":false}]}"#;
        assert_eq!(parse_create_screen(screen).unwrap().missing, ["Reporter"]);
    }

    #[test]
    fn what_the_notice_says_when_jira_cant_move_it_into_the_column() {
        let ts = crate::jira::parse_transitions(&fixture("jira-transitions.json")).unwrap();
        assert_eq!(
            move_note(&ColumnMove::Unreachable, "To Do", "QA").as_deref(),
            Some(" in To Do; Jira has no way to move it to QA from there")
        );
        assert_eq!(move_note(&ColumnMove::Already, "To Do", "QA"), None);
        assert_eq!(
            move_note(&ColumnMove::Via(&ts[1]), "To Do", "In Progress"),
            None
        );
    }

    #[test]
    fn the_new_issue_read_back_or_as_much_as_moonlet_knows() {
        // GET /rest/api/3/issue/{key} answers with an issue as the search lists it.
        let search: Value = serde_json::from_slice(&fixture("jira-search.json")).unwrap();
        let one = serde_json::to_vec(&search["issues"][0]).unwrap();
        let issue =
            parse_board_issue(&one, "jira:acme.atlassian.net", "acme.atlassian.net").unwrap();
        assert_eq!(
            (issue.task.key.as_str(), issue.status_id.as_str()),
            ("EX-1", "3")
        );
        let known = created_issue(
            "EX-24",
            "Retry failed webhook deliveries",
            "jira:acme.atlassian.net",
            "acme.atlassian.net",
        );
        assert_eq!(
            (
                known.task.key.as_str(),
                known.task.title.as_str(),
                known.task.url.as_str(),
                known.status_id.as_str()
            ),
            (
                "EX-24",
                "Retry failed webhook deliveries",
                "https://acme.atlassian.net/browse/EX-24",
                ""
            )
        );
    }

    #[test]
    fn a_new_issue_with_its_type_assignee_labels_and_description() {
        let screen = parse_create_screen(&fixture("jira-createmeta-fields.json")).unwrap();
        let issue = NewIssue {
            title: "Retry failed webhook deliveries".into(),
            description: "Back off.".into(),
            assignee: "me".into(),
            labels: vec!["backend".into()],
            status: "3".into(),
            issue_type: Some("10001".into()),
            ..Default::default()
        };
        assert_eq!(
            create_body(&issue, "ED", "5b10a2844c20165700ede21g", &screen),
            json!({ "fields": {
                "project": { "key": "ED" },
                "issuetype": { "id": "10001" },
                "summary": "Retry failed webhook deliveries",
                "description": { "type": "doc", "version": 1, "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Back off." }] }] },
                "assignee": { "accountId": "5b10a2844c20165700ede21g" },
                "labels": ["backend"]
            } })
        );
        // A screen without assignee or labels: they are not sent; nor an empty description, or Unassigned.
        let bare = CreateScreen {
            fields: vec!["summary".into(), "issuetype".into(), "project".into()],
            missing: vec![],
        };
        let plain = NewIssue {
            description: String::new(),
            ..issue.clone()
        };
        assert_eq!(
            create_body(&plain, "ED", "me-id", &bare),
            json!({ "fields": { "project": { "key": "ED" }, "issuetype": { "id": "10001" }, "summary": "Retry failed webhook deliveries" } })
        );
        assert!(
            create_body(
                &NewIssue {
                    assignee: "none".into(),
                    ..issue
                },
                "ED",
                "me-id",
                &screen
            )["fields"]
                .get("assignee")
                .is_none()
        );
    }

    #[test]
    fn the_created_issues_key() {
        assert_eq!(
            parse_created(&fixture("jira-issue-create.json")).unwrap(),
            "ED-24"
        );
    }

    #[test]
    fn into_the_column_by_a_transition_unless_jira_created_it_there() {
        let ts = crate::jira::parse_transitions(&fixture("jira-transitions.json")).unwrap();
        // A column of In Progress (3) and QA (5): Jira put it in To Do (10000).
        let column = ["3".to_string(), "5".to_string()];
        assert_eq!(into_column(&column, "10000", &ts), ColumnMove::Via(&ts[1]));
        assert_eq!(into_column(&column, "3", &ts), ColumnMove::Already);
        assert_eq!(
            into_column(&["5".to_string()], "10000", &ts),
            ColumnMove::Unreachable
        );
    }
}
