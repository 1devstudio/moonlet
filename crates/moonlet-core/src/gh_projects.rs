//! GitHub Projects (X50): the Projects a board can be built from, and a
//! Project's items that are issues, through `gh api graphql`. Reading needs
//! gh's `read:project` scope; moonlet never runs `gh auth` itself.

use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use moonlet_proto::types::{GhOption, GhProject, GhProjectBoard, GhProjectItem};
use serde_json::{json, Value};

use crate::git::{parse_gh_tasks, run_raw};

/// What a Project needs to be a board: its id, owner, number, title and the
/// Status field's options.
const PROJECT_FIELDS: &str =
    "id number title closed owner { ... on User { login } ... on Organization { login } } \
     field(name: \"Status\") { ... on ProjectV2SingleSelectField { id name options { id name } } }";

/// A Project's first number field, `(id, name)`, from its `fields` (the
/// other kinds of field come as `{}`). [`ITEMS_QUERY`] reads the first 50
/// fields, and each item's first 50 values.
fn number_field(project: &Value) -> Option<(&str, &str)> {
    project["fields"]["nodes"]
        .as_array()?
        .iter()
        .find(|f| f["dataType"] == "NUMBER")
        .and_then(|f| Some((f["id"].as_str()?, f["name"].as_str()?)))
}

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
        // A Project without a Status field has no columns to show.
        if field["id"].is_null() {
            continue;
        }
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
     field(name: \"Status\") { ... on ProjectV2SingleSelectField { id options { id name } } } \
     fields(first: 50) { nodes { ... on ProjectV2Field { id name dataType } } } items(first: 100, after: $after) { \
     nodes { id type isArchived fieldValueByName(name: \"Status\") { ... on ProjectV2ItemFieldSingleSelectValue { name optionId } } \
     fieldValues(first: 50) { nodes { ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { id } } } } } \
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
    let estimate_field = number_field(project);
    // The item's value in the first number field; the others are left out.
    let estimate = |i: &Value| {
        let (id, _) = estimate_field?;
        i["fieldValues"]["nodes"]
            .as_array()?
            .iter()
            .find(|v| v["field"]["id"] == id)?["number"]
            .as_f64()
    };
    let items_out = issues
        .iter()
        .zip(tasks)
        .map(|(i, task)| GhProjectItem {
            item: i["id"].as_str().unwrap_or_default().into(),
            status: i["fieldValueByName"]["name"].as_str().map(String::from),
            option: i["fieldValueByName"]["optionId"].as_str().map(String::from),
            estimate: estimate(i),
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
        number_field: estimate_field.map(|(_, name)| name.into()),
        items: items_out,
    };
    Ok((
        board,
        data["viewer"]["login"].as_str().unwrap_or_default().into(),
        next,
    ))
}

/// Sets an item's Status (X50 moves): needs gh's `project` scope.
pub const MOVE_MUTATION: &str = "mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) { \
     updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) \
     { projectV2Item { id } } }";

/// Clears an item's Status, to No Status (X50 moves).
pub const CLEAR_MUTATION: &str = "mutation($project: ID!, $item: ID!, $field: ID!) { \
     clearProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field }) { projectV2Item { id } } }";

/// Whether a [`MOVE_MUTATION`] or [`CLEAR_MUTATION`] answer moved the item; a
/// missing scope is named with its command.
pub fn parse_move(raw: &[u8]) -> Result<()> {
    let data = graphql_data(raw)?;
    let moved = [
        "updateProjectV2ItemFieldValue",
        "clearProjectV2ItemFieldValue",
    ]
    .iter()
    .any(|m| !data[*m]["projectV2Item"]["id"].is_null());
    if !moved {
        bail!("GitHub did not move the item");
    }
    Ok(())
}

/// Adds an issue (its node id) to a Project (X52): needs gh's `project` scope.
pub const ADD_MUTATION: &str = "mutation($project: ID!, $content: ID!) { \
     addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }";

/// The new item's id from an [`ADD_MUTATION`] answer; a missing scope is
/// named with its command.
pub fn parse_added(raw: &[u8]) -> Result<String> {
    let data = graphql_data(raw)?;
    match data["addProjectV2ItemById"]["item"]["id"].as_str() {
        Some(id) => Ok(id.into()),
        None => bail!("GitHub did not add the issue to the Project"),
    }
}

/// The token scopes of gh's active github.com account, from `gh auth status`:
/// the account marked active, or with older gh, which marks none, the first.
/// `None` when no account is signed in.
pub fn parse_scopes(status: &str) -> Option<Vec<String>> {
    let mut accounts: Vec<(bool, Vec<String>)> = Vec::new();
    for line in status.lines().map(str::trim) {
        let line = line.trim_start_matches(['✓', '-', ' ']);
        if line.starts_with("Logged in to") {
            accounts.push((false, Vec::new()));
        } else if line == "Active account: true" {
            if let Some(a) = accounts.last_mut() {
                a.0 = true;
            }
        } else if let Some(list) = line.strip_prefix("Token scopes:") {
            if let Some(a) = accounts.last_mut() {
                a.1 = list
                    .split(',')
                    .map(|s| s.trim().trim_matches('\'').to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            }
        }
    }
    let active = accounts.iter().find(|a| a.0).or(accounts.first())?;
    Some(active.1.clone())
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
    if scope == "project" {
        // A move or an add: there is no Check again, the next one tries again.
        return "Changing a Project's items needs gh's project scope. Run gh auth refresh -s project.".into();
    }
    format!(
        "GitHub Projects need gh's {scope} scope. Run gh auth refresh -s {scope}, then Check again."
    )
}

/// A GraphQL answer's data, or its first error; a missing scope is named
/// with the command that adds it. An answer with some data keeps it: an
/// owner whose Projects gh may not read leaves the others.
fn graphql_data(raw: &[u8]) -> Result<Value> {
    let v: Value = serde_json::from_slice(raw)?;
    let some_data = v["data"]
        .as_object()
        .is_some_and(|o| o.values().any(|x| !x.is_null()));
    if let Some(e) = v["errors"]
        .as_array()
        .and_then(|e| e.first())
        .filter(|_| !some_data)
    {
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

/// A GraphQL variable: a string, or a number, which gh must send as one.
pub enum Var {
    Str(String),
    Int(u64),
}

/// `gh api graphql`'s arguments for `query` and its variables: `-F` types a
/// number, `-f` keeps a string a string (a login of digits stays a string).
pub fn graphql_args(query: &str, vars: &[(&str, Var)]) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "api".into(),
        "graphql".into(),
        "-f".into(),
        format!("query={query}"),
    ];
    for (k, v) in vars {
        let (flag, value) = match v {
            Var::Str(s) => ("-f", s.clone()),
            Var::Int(n) => ("-F", n.to_string()),
        };
        args.extend([flag.into(), format!("{k}={value}")]);
    }
    args
}

/// Runs a GraphQL query through gh; its answer even when gh exits with an
/// error, since GraphQL errors come in the answer.
async fn graphql(query: &str, vars: &[(&str, Var)]) -> Result<Vec<u8>> {
    run_graphql(graphql_args(query, vars)).await
}

async fn run_graphql(args: Vec<String>) -> Result<Vec<u8>> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_raw("gh", Path::new("/"), &refs, None, Duration::from_secs(60)).await?;
    if out.status != 0 && !out.stdout.starts_with(b"{") {
        bail!("gh api graphql: {}", out.stderr);
    }
    Ok(out.stdout)
}

/// The open Projects of the signed-in user and of `owners`, each once.
pub async fn gh_projects(owners: &[String]) -> Result<Vec<GhProject>> {
    let owners = owners_to_ask(owners);
    let names: Vec<String> = (0..owners.len()).map(|i| format!("o{i}")).collect();
    let vars: Vec<(&str, Var)> = names
        .iter()
        .zip(&owners)
        .map(|(k, o)| (k.as_str(), Var::Str(o.to_string())))
        .collect();
    parse_projects(&graphql(&projects_query(owners.len()), &vars).await?)
}

/// The owners worth asking about: GitHub logins (letters, digits and single
/// hyphens, not at either end), each once whatever its case.
pub fn owners_to_ask(owners: &[String]) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for o in owners {
        let login = !o.is_empty()
            && o.len() <= 39
            && !o.starts_with('-')
            && !o.ends_with('-')
            && o.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if login && !out.iter().any(|x| x.eq_ignore_ascii_case(o)) {
            out.push(o);
        }
    }
    out
}

/// A Project read so far with its next page added: the user's own items
/// only when `mine`, by the signed-in `login`, whatever its case.
pub fn add_page(
    board: Option<GhProjectBoard>,
    mut page: GhProjectBoard,
    login: &str,
    mine: bool,
) -> GhProjectBoard {
    page.items.retain(|i| {
        !mine
            || i.task
                .assignees
                .iter()
                .any(|a| a.eq_ignore_ascii_case(login))
    });
    match board {
        Some(mut b) => {
            b.items.extend(page.items);
            b
        }
        None => page,
    }
}

/// A Project's items that are issues, at most 5 pages of 100; the user's own when `mine`.
pub async fn gh_project_items(owner: &str, number: u64, mine: bool) -> Result<GhProjectBoard> {
    if owners_to_ask(&[owner.to_string()]).is_empty() {
        bail!("{owner} is not a GitHub user or organisation");
    }
    let mut board: Option<GhProjectBoard> = None;
    let mut after: Option<String> = None;
    for _ in 0..5 {
        let mut vars = vec![
            ("owner", Var::Str(owner.into())),
            ("number", Var::Int(number)),
        ];
        if let Some(a) = &after {
            vars.push(("after", Var::Str(a.clone())));
        }
        let (page, login, next) = parse_project_items(&graphql(ITEMS_QUERY, &vars).await?)?;
        board = Some(add_page(board, page, &login, mine));
        after = next;
        if after.is_none() {
            break;
        }
    }
    board.ok_or_else(|| anyhow::anyhow!("GitHub sent no Project"))
}

/// Sets a Project item's Status to `option`, or with none clears it (X50 moves).
pub async fn gh_project_move(
    project: &str,
    item: &str,
    field: &str,
    option: Option<&str>,
) -> Result<()> {
    parse_move(&run_graphql(move_args(project, item, field, option)).await?)
}

/// `gh api graphql`'s arguments for a move: [`MOVE_MUTATION`] to set the
/// item's Status to `option`, [`CLEAR_MUTATION`] with none (No Status).
pub fn move_args(project: &str, item: &str, field: &str, option: Option<&str>) -> Vec<String> {
    let mut vars = vec![
        ("project", Var::Str(project.into())),
        ("item", Var::Str(item.into())),
        ("field", Var::Str(field.into())),
    ];
    let query = match option {
        Some(o) => {
            vars.push(("option", Var::Str(o.into())));
            MOVE_MUTATION
        }
        None => CLEAR_MUTATION,
    };
    graphql_args(query, &vars)
}

/// Adds the issue `content` (a node id) to `project`, answering with its item (X52).
pub async fn gh_project_add(project: &str, content: &str) -> Result<String> {
    let vars = [
        ("project", Var::Str(project.into())),
        ("content", Var::Str(content.into())),
    ];
    parse_added(&graphql(ADD_MUTATION, &vars).await?)
}

/// gh's token scopes for github.com, from `gh auth status`.
pub async fn gh_scopes() -> Result<Vec<String>> {
    let out = run_raw(
        "gh",
        Path::new("/"),
        &["auth", "status", "--hostname", "github.com"],
        None,
        Duration::from_secs(30),
    )
    .await?;
    // gh before 2.40 prints it to stderr.
    let text = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), out.stderr);
    parse_scopes(&text).context("gh is not signed in to github.com")
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
        let both = format!(
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
    }

    #[test]
    fn a_projects_first_number_field_and_each_issues_value_in_it() {
        // Website has Estimate and then Hours.
        let (board, _, _) = parse_project_items(&fixture("gh-project-items.json")).unwrap();
        assert_eq!(board.number_field.as_deref(), Some("Estimate"));
        // #10 has 3 and Hours 8, #11 half a point, #12 only Hours.
        assert_eq!(
            board.items[..3]
                .iter()
                .map(|i| (i.task.number, i.estimate))
                .collect::<Vec<_>>(),
            [(10, Some(3.0)), (11, Some(0.5)), (12, None)]
        );
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
        // Its Status option's id, which board columns match by.
        assert_eq!(first.option.as_deref(), Some("f75a_e2e0003"));
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
            parse_project_items(&fixture("gh-error-project-scope.json"))
                .unwrap_err()
                .to_string(),
            "Changing a Project's items needs gh's project scope. Run gh auth refresh -s project."
        );
    }

    #[test]
    fn only_github_logins_are_asked_about_each_once() {
        let owners: Vec<String> = ["acme", "sam-rivera", "-x", "a b", "x\"y", "", "ACME"]
            .map(String::from)
            .to_vec();
        assert_eq!(owners_to_ask(&owners), ["acme", "sam-rivera"]);
    }

    #[test]
    fn a_number_goes_to_gh_as_a_number_and_a_login_as_a_string() {
        assert_eq!(
            graphql_args(
                "q",
                &[("owner", Var::Str("1234".into())), ("number", Var::Int(2))]
            ),
            [
                "api",
                "graphql",
                "-f",
                "query=q",
                "-f",
                "owner=1234",
                "-F",
                "number=2"
            ]
        );
    }

    #[test]
    fn pages_add_up_and_mine_keeps_the_users_own() {
        let page = || {
            parse_project_items(&fixture("gh-project-items.json"))
                .unwrap()
                .0
        };
        let all = add_page(
            Some(add_page(None, page(), "sam-rivera", false)),
            page(),
            "sam-rivera",
            false,
        );
        assert_eq!(all.items.len(), 26);
        // Two issues are assigned to sam-rivera; the login's case doesn't matter.
        let mine = add_page(None, page(), "Sam-Rivera", true);
        assert_eq!(
            mine.items.iter().map(|i| i.task.number).collect::<Vec<_>>(),
            [10, 5]
        );
    }

    #[test]
    fn a_project_without_a_status_field_is_not_offered() {
        let raw = br#"{"data":{"viewer":{"projectsV2":{"nodes":[{"id":"PVT_a","number":4,"title":"Notes","closed":false,"owner":{"login":"sam-rivera"},"field":null}]}}}}"#;
        assert_eq!(parse_projects(raw).unwrap(), []);
    }

    #[test]
    fn an_owner_gh_may_not_read_leaves_the_others() {
        let raw = format!(
            r#"{{"data":{{"viewer":{},"o0":null}},"errors":[{{"type":"FORBIDDEN","message":"Resource protected by organization SAML enforcement."}}]}}"#,
            serde_json::to_string(
                &serde_json::from_slice::<Value>(&fixture("gh-projects.json")).unwrap()["data"]
                    ["viewer"]
            )
            .unwrap()
        );
        assert_eq!(parse_projects(raw.as_bytes()).unwrap().len(), 2);
    }

    #[test]
    fn a_move_to_an_option_sets_the_status_and_one_to_no_option_clears_it() {
        let set = move_args("PVT_1", "PVTI_10", "PVTSSF_1", Some("o2"));
        assert_eq!(set[3], format!("query={MOVE_MUTATION}"));
        assert_eq!(
            set[4..],
            [
                "-f",
                "project=PVT_1",
                "-f",
                "item=PVTI_10",
                "-f",
                "field=PVTSSF_1",
                "-f",
                "option=o2"
            ]
        );
        let clear = move_args("PVT_1", "PVTI_10", "PVTSSF_1", None);
        assert_eq!(clear[3], format!("query={CLEAR_MUTATION}"));
        assert_eq!(
            clear[4..],
            [
                "-f",
                "project=PVT_1",
                "-f",
                "item=PVTI_10",
                "-f",
                "field=PVTSSF_1"
            ]
        );
    }

    #[test]
    fn a_new_issue_added_to_the_project_answers_with_its_item() {
        assert_eq!(
            parse_added(&fixture("gh-project-add.json")).unwrap(),
            "PVTI_e2e0050"
        );
        assert_eq!(
            parse_added(&fixture("gh-error-project-scope.json"))
                .unwrap_err()
                .to_string(),
            "Changing a Project's items needs gh's project scope. Run gh auth refresh -s project."
        );
        assert_eq!(
            parse_added(br#"{"data":{"addProjectV2ItemById":null}}"#)
                .unwrap_err()
                .to_string(),
            "GitHub did not add the issue to the Project"
        );
    }

    #[test]
    fn a_move_sets_the_status_or_says_the_scope_it_needs() {
        assert!(parse_move(&fixture("gh-project-move.json")).is_ok());
        // Clearing it, to No Status.
        assert!(parse_move(&fixture("gh-project-clear.json")).is_ok());
        assert!(parse_move(br#"{"data":{"clearProjectV2ItemFieldValue":null}}"#).is_err());
        assert_eq!(
            parse_move(&fixture("gh-error-project-scope.json"))
                .unwrap_err()
                .to_string(),
            "Changing a Project's items needs gh's project scope. Run gh auth refresh -s project."
        );
    }

    #[test]
    fn the_active_accounts_token_scopes() {
        let status = String::from_utf8(fixture("gh-auth-status.txt")).unwrap();
        assert_eq!(
            parse_scopes(&status).unwrap(),
            ["gist", "project", "read:org", "repo", "workflow"]
        );
        // Not captured (one account here): two accounts, the active one's; and
        // older gh, which marks none and prefixes its lines with ✓, the first.
        let two = "github.com\n  ✓ Logged in to github.com account kim (keyring)\n  - Active account: false\n  - Token scopes: 'repo'\n  ✓ Logged in to github.com account sam-rivera (keyring)\n  - Active account: true\n  - Token scopes: 'repo', 'read:project'\n";
        assert_eq!(parse_scopes(two).unwrap(), ["repo", "read:project"]);
        let older = "github.com\n  ✓ Logged in to github.com as sam-rivera (oauth_token)\n  ✓ Token scopes: gist, read:org, repo\n";
        assert_eq!(parse_scopes(older).unwrap(), ["gist", "read:org", "repo"]);
        assert_eq!(
            parse_scopes("You are not logged into any GitHub hosts. To log in, run: gh auth login"),
            None
        );
    }
}
