//! GitHub Projects (X50): the Projects a board can be built from, and a
//! Project's items that are issues, through `gh api graphql`. Reading needs
//! gh's `read:project` scope; moonlet never runs `gh auth` itself.

use std::path::Path;
use std::time::Duration;

use anyhow::{Result, bail};
use moonlet_proto::types::{GhOption, GhProject, GhProjectBoard, GhProjectItem};
use serde_json::{Value, json};

use crate::git::{parse_gh_tasks, run_raw};

/// What a Project needs to be a board: its id, owner, number, title and the
/// Status field's options.
const PROJECT_FIELDS: &str = "id number title closed owner { ... on User { login } ... on Organization { login } } \
     field(name: \"Status\") { ... on ProjectV2SingleSelectField { id name options { id name } } }";

/// The user's own Projects, and those of each owner in `owners`.
pub fn projects_query(owners: usize) -> String {
    let mut q = format!(
        "query({}) {{ viewer {{ projectsV2(first: 50) {{ nodes {{ {PROJECT_FIELDS} }} }} }}",
        (0..owners)
            .map(|i| format!("$o{i}: String!"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    for i in 0..owners {
        q.push_str(&format!(" o{i}: repositoryOwner(login: $o{i}) {{ ... on ProjectV2Owner {{ projectsV2(first: 50) {{ nodes {{ {PROJECT_FIELDS} }} }} }} }}"));
    }
    q.push_str(" }");
    q.replace("query() {", "query {")
}

/// The open Projects in a [`projects_query`] answer, each once.
pub fn parse_projects(raw: &[u8]) -> Result<Vec<GhProject>> {
    let data = graphql_data(raw)?;
    let lists = data
        .as_object()
        .into_iter()
        .flat_map(|o| o.values())
        .map(|owner| &owner["projectsV2"]["nodes"]);
    let mut out: Vec<GhProject> = Vec::new();
    for p in lists.flat_map(|l| l.as_array().into_iter().flatten()) {
        if p["closed"].as_bool() == Some(true)
            || out
                .iter()
                .any(|x| x.id == p["id"].as_str().unwrap_or_default())
        {
            continue;
        }
        let field = &p["field"];
        out.push(GhProject {
            id: p["id"].as_str().unwrap_or_default().into(),
            owner: p["owner"]["login"].as_str().unwrap_or_default().into(),
            number: p["number"].as_u64().unwrap_or(0),
            title: p["title"].as_str().unwrap_or_default().into(),
            status_field: field["id"].as_str().map(String::from),
            options: options(&field["options"]),
        });
    }
    Ok(out)
}

/// A page of a Project's items, by its owner and number, with the user's login.
pub const ITEMS_QUERY: &str = "query($owner: String!, $number: Int!, $after: String) { viewer { login } \
     repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) { id \
     field(name: \"Status\") { ... on ProjectV2SingleSelectField { id options { id name } } } items(first: 100, after: $after) { \
     nodes { id type isArchived fieldValueByName(name: \"Status\") { ... on ProjectV2ItemFieldSingleSelectValue { name optionId } } \
     content { ... on Issue { number title body url state stateReason updatedAt repository { nameWithOwner } \
     assignees(first: 10) { nodes { login } } labels(first: 20) { nodes { name } } \
     closedByPullRequestsReferences(first: 5) { nodes { number repository { name owner { login } } } } } } } \
     pageInfo { hasNextPage endCursor } } } } } }";

/// A page of [`ITEMS_QUERY`]: the Project with its Status options and its
/// items that are issues and not archived, the signed-in login, and the next
/// page's cursor.
pub fn parse_project_items(raw: &[u8]) -> Result<(GhProjectBoard, String, Option<String>)> {
    let data = graphql_data(raw)?;
    let project = &data["repositoryOwner"]["projectV2"];
    if !project.is_object() {
        bail!("GitHub has no such Project, or gh can't see it");
    }
    let items = &project["items"];
    let issues: Vec<&Value> = items["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| i["type"] == "ISSUE" && i["isArchived"] != true)
        .collect();
    // The issues in `gh issue list`'s shape: lists of nodes flattened.
    let flat = |v: &Value| v["nodes"].clone();
    let listed: Vec<Value> = issues
        .iter()
        .map(|i| {
            let c = &i["content"];
            json!({
                "number": c["number"], "title": c["title"], "body": c["body"], "url": c["url"], "state": c["state"],
                "stateReason": c["stateReason"], "updatedAt": c["updatedAt"], "assignees": flat(&c["assignees"]),
                "labels": flat(&c["labels"]), "closedByPullRequestsReferences": flat(&c["closedByPullRequestsReferences"]),
            })
        })
        .collect();
    let tasks = parse_gh_tasks(&serde_json::to_vec(&listed)?)?;
    let items_out = issues
        .iter()
        .zip(tasks)
        .map(|(i, task)| GhProjectItem {
            item: i["id"].as_str().unwrap_or_default().into(),
            status: i["fieldValueByName"]["name"].as_str().map(String::from),
            task,
        })
        .collect();
    let next = (items["pageInfo"]["hasNextPage"] == true)
        .then(|| items["pageInfo"]["endCursor"].as_str().map(String::from))
        .flatten();
    let board = GhProjectBoard {
        id: project["id"].as_str().unwrap_or_default().into(),
        status_field: project["field"]["id"].as_str().map(String::from),
        options: options(&project["field"]["options"]),
        items: items_out,
    };
    Ok((
        board,
        data["viewer"]["login"].as_str().unwrap_or_default().into(),
        next,
    ))
}

/// A Status field's options.
fn options(v: &Value) -> Vec<GhOption> {
    v.as_array()
        .into_iter()
        .flatten()
        .map(|o| GhOption {
            id: o["id"].as_str().unwrap_or_default().into(),
            name: o["name"].as_str().unwrap_or_default().into(),
        })
        .collect()
}

/// What gh sends back about a missing scope, as the user can act on it (X50).
pub fn scope_hint(scope: &str) -> String {
    format!(
        "GitHub Projects need gh's {scope} scope. Run gh auth refresh -s {scope}, then Check again."
    )
}

/// A GraphQL answer's data, or its first error; a missing scope is named with the command that adds it.
fn graphql_data(raw: &[u8]) -> Result<Value> {
    let v: Value = serde_json::from_slice(raw)?;
    if let Some(e) = v["errors"].as_array().and_then(|e| e.first()) {
        let message = e["message"]
            .as_str()
            .unwrap_or("GitHub refused the request");
        if e["type"] == "INSUFFICIENT_SCOPES" {
            let scope = if message.contains("['project']") {
                "project"
            } else {
                "read:project"
            };
            bail!("{}", scope_hint(scope));
        }
        bail!("GitHub: {message}");
    }
    Ok(v["data"].clone())
}

/// Runs a GraphQL query through gh; its answer even when gh exits with an
/// error, since GraphQL errors come in the answer.
async fn graphql(query: &str, vars: &[(&str, String)]) -> Result<Vec<u8>> {
    let mut args: Vec<String> = vec![
        "api".into(),
        "graphql".into(),
        "-f".into(),
        format!("query={query}"),
    ];
    for (k, v) in vars {
        // -F types numbers; -f keeps strings as strings.
        let flag = if v.parse::<u64>().is_ok() && *k == "number" {
            "-F"
        } else {
            "-f"
        };
        args.extend([flag.into(), format!("{k}={v}")]);
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_raw("gh", Path::new("/"), &refs, None, Duration::from_secs(60)).await?;
    if out.status != 0 && !out.stdout.starts_with(b"{") {
        bail!("gh api graphql: {}", out.stderr);
    }
    Ok(out.stdout)
}

/// The open Projects of the signed-in user and of `owners`, each once.
pub async fn gh_projects(owners: &[String]) -> Result<Vec<GhProject>> {
    let owners: Vec<&String> = owners.iter().filter(|o| is_login(o)).collect();
    let vars: Vec<(String, String)> = owners
        .iter()
        .enumerate()
        .map(|(i, o)| (format!("o{i}"), (*o).clone()))
        .collect();
    let refs: Vec<(&str, String)> = vars.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
    parse_projects(&graphql(&projects_query(owners.len()), &refs).await?)
}

/// A Project's items that are issues, at most 5 pages of 100; the user's own when `mine`.
pub async fn gh_project_items(owner: &str, number: u64, mine: bool) -> Result<GhProjectBoard> {
    if !is_login(owner) {
        bail!("{owner} is not a GitHub user or organisation");
    }
    let mut board: Option<GhProjectBoard> = None;
    let mut after: Option<String> = None;
    for _ in 0..5 {
        let mut vars = vec![("owner", owner.to_string()), ("number", number.to_string())];
        if let Some(a) = &after {
            vars.push(("after", a.clone()));
        }
        let (mut page, login, next) = parse_project_items(&graphql(ITEMS_QUERY, &vars).await?)?;
        page.items.retain(|i| {
            !mine
                || i.task
                    .assignees
                    .iter()
                    .any(|a| a.eq_ignore_ascii_case(&login))
        });
        match &mut board {
            Some(b) => b.items.extend(page.items),
            None => board = Some(page),
        }
        after = next;
        if after.is_none() {
            break;
        }
    }
    board.ok_or_else(|| anyhow::anyhow!("GitHub sent no Project"))
}

/// A GitHub login: letters, digits and single hyphens, not at either end.
fn is_login(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 39
        && !s.starts_with('-')
        && !s.ends_with('-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
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
    fn the_users_open_projects_with_their_status_options() {
        let projects = parse_projects(&fixture("gh-projects.json")).unwrap();
        // "Mobile app" is closed.
        assert_eq!(
            projects
                .iter()
                .map(|p| (p.owner.as_str(), p.number, p.title.as_str()))
                .collect::<Vec<_>>(),
            [("sam-rivera", 2, "Website"), ("sam-rivera", 1, "Pricing")]
        );
        assert_eq!(projects[0].status_field.as_deref(), Some("PVTSSF_e2e0007"));
        assert_eq!(
            projects[0]
                .options
                .iter()
                .map(|o| o.name.as_str())
                .collect::<Vec<_>>(),
            ["Todo", "In Progress", "Done"]
        );
        // An owner's Projects come in the same answer, under their own key, and a Project seen twice counts once.
        let both =
            format!(
                r#"{{"data":{{"viewer":{},"o0":{}}}}}"#,
                serde_json::to_string(
                    &serde_json::from_slice::<Value>(&fixture("gh-projects.json")).unwrap()["data"]
                        ["viewer"]
                )
                .unwrap(),
                serde_json::to_string(
                    &serde_json::from_slice::<Value>(&fixture("gh-projects.json")).unwrap()["data"]
                        ["viewer"]
                )
                .unwrap(),
            );
        assert_eq!(parse_projects(both.as_bytes()).unwrap().len(), 2);
        assert!(projects_query(2).starts_with("query($o0: String!, $o1: String!) { viewer"));
        assert!(projects_query(0).starts_with("query { viewer"));
    }

    #[test]
    fn a_projects_issues_with_their_status_and_no_drafts_or_pull_requests() {
        let (board, login, next) = parse_project_items(&fixture("gh-project-items.json")).unwrap();
        assert_eq!((login.as_str(), next), ("sam-rivera", None));
        assert_eq!(
            (board.id.as_str(), board.status_field.as_deref()),
            ("PVT_e2e0006", Some("PVTSSF_e2e0007"))
        );
        assert_eq!(
            board
                .options
                .iter()
                .map(|o| o.name.as_str())
                .collect::<Vec<_>>(),
            ["Todo", "In Progress", "Done"]
        );
        let items = board.items;
        // 13 issues; the 7 drafts and the pull request are left out.
        assert_eq!(items.len(), 13);
        let first = &items[0];
        assert_eq!(
            (
                first.task.repo.as_str(),
                first.task.number,
                first.status.as_deref()
            ),
            ("acme/web", 10, Some("Todo"))
        );
        assert_eq!(
            (first.task.assignees.clone(), first.task.labels.clone()),
            (vec!["sam-rivera".to_string()], vec!["bug".to_string()])
        );
        // An issue with no Status yet has none.
        assert_eq!(items.iter().filter(|i| i.status.is_none()).count(), 1);
        assert_eq!(
            items
                .iter()
                .filter(|i| i.status.as_deref() == Some("Done"))
                .count(),
            7
        );
    }

    #[test]
    fn a_missing_scope_names_the_command_that_adds_it() {
        assert_eq!(
            parse_projects(&fixture("gh-error-read-project-scope.json"))
                .unwrap_err()
                .to_string(),
            "GitHub Projects need gh's read:project scope. Run gh auth refresh -s read:project, then Check again."
        );
        assert_eq!(
            graphql_data(&fixture("gh-error-project-scope.json"))
                .unwrap_err()
                .to_string(),
            "GitHub Projects need gh's project scope. Run gh auth refresh -s project, then Check again."
        );
    }

    #[test]
    fn only_a_github_login_is_asked_about() {
        assert!(is_login("acme") && is_login("sam-rivera"));
        assert!(!is_login("-x") && !is_login("a b") && !is_login("x\"y") && !is_login(""));
    }
}
