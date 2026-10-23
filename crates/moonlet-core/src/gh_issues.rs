//! A new GitHub issue from a board column's + (X52), through `gh api` on the
//! workspace's host: the form's lists, and the issue, which answers with its
//! node id so a GitHub Project can add it.

use anyhow::{Result, bail};
use moonlet_proto::types::{GhComment, GhComments, GhCreateChoices, GhCreated};
use serde_json::{Value, json};

use std::path::Path;
use std::time::Duration;

use crate::git::{check_repo, gh_whoami, parse_gh_tasks, run_raw, utc_ms};

/// `gh api`'s arguments to create an issue in `repo` (`owner/name`):
/// assigned to `assignee`, a login, when given; labels as GitHub names them.
pub fn issue_create_args(
    repo: &str,
    title: &str,
    body: &str,
    assignee: Option<&str>,
    labels: &[String],
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "api".into(),
        format!("repos/{repo}/issues"),
        "-X".into(),
        "POST".into(),
        "-f".into(),
        format!("title={title}"),
    ];
    if !body.is_empty() {
        args.extend(["-f".into(), format!("body={body}")]);
    }
    if let Some(login) = assignee {
        args.extend(["-f".into(), format!("assignees[]={login}")]);
    }
    for label in labels {
        args.extend(["-f".into(), format!("labels[]={label}")]);
    }
    args
}

/// The issues API's answer: the issue as a board task, and its node id.
pub fn parse_created_issue(raw: &[u8]) -> Result<GhCreated> {
    let v: Value = serde_json::from_slice(raw)?;
    let Some(node) = v["node_id"].as_str() else {
        bail!(
            "GitHub did not create the issue: {}",
            v["message"].as_str().unwrap_or("no answer")
        );
    };
    // In `gh issue list`'s shape, which the board's tasks are read from.
    let listed = json!([{
        "number": v["number"], "title": v["title"], "body": v["body"], "url": v["html_url"],
        "state": v["state"], "stateReason": v["state_reason"], "updatedAt": v["updated_at"],
        "assignees": v["assignees"], "labels": v["labels"], "closedByPullRequestsReferences": [],
    }]);
    let task = parse_gh_tasks(listed.to_string().as_bytes())?
        .pop()
        .ok_or_else(|| anyhow::anyhow!("GitHub sent no issue"))?;
    Ok(GhCreated {
        task,
        node: node.into(),
    })
}

/// The form's lists for a repository: its assignable people and labels, and
/// whether gh's user can set them (GitHub drops both silently otherwise).
pub fn parse_create_options(
    me: &str,
    assignees: &[u8],
    labels: &[u8],
    repo: &[u8],
) -> Result<GhCreateChoices> {
    let names = |raw: &[u8], field: &str| -> Result<Vec<String>> {
        let list: Vec<Value> = serde_json::from_slice(raw)?;
        Ok(list
            .iter()
            .filter_map(|x| x[field].as_str().map(String::from))
            .collect())
    };
    let p = &serde_json::from_slice::<Value>(repo)?["permissions"];
    let can_set = ["triage", "push", "maintain", "admin"]
        .iter()
        .any(|k| p[*k] == true);
    Ok(GhCreateChoices {
        me: me.into(),
        people: names(assignees, "login")?,
        labels: names(labels, "name")?,
        can_set,
    })
}

/// What a refused `gh api` call says: GitHub's message and its errors'
/// reasons, else gh's own line.
pub fn refusal(stdout: &[u8], stderr: &str) -> String {
    let v: Value = serde_json::from_slice(stdout).unwrap_or_default();
    let Some(message) = v["message"].as_str() else {
        return stderr.trim().to_string();
    };
    let reasons: Vec<&str> = v["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| e["message"].as_str())
        .collect();
    if reasons.is_empty() {
        format!("GitHub: {message}")
    } else {
        format!("GitHub: {message}: {}", reasons.join("; "))
    }
}

/// `gh api` on the host, its answer or GitHub's refusal.
async fn api(args: &[String]) -> Result<Vec<u8>> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_raw("gh", Path::new("/"), &refs, None, Duration::from_secs(60)).await?;
    if out.status != 0 {
        bail!("{}", refusal(&out.stdout, &out.stderr));
    }
    Ok(out.stdout)
}

/// The most comments the Task detail lists (X66).
const MAX_COMMENTS: usize = 100;

/// `gh issue view <n> --json comments` as the Task detail lists them (X66):
/// oldest first, the newest 100, without those hidden on GitHub.
pub fn parse_issue_comments(raw: &[u8]) -> Result<GhComments> {
    let v: Value = serde_json::from_slice(raw)?;
    let mut comments: Vec<GhComment> = v["comments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["isMinimized"].as_bool() != Some(true))
        .map(|c| {
            let login = c["author"]["login"].as_str().unwrap_or_default();
            GhComment {
                id: c["id"].as_str().unwrap_or_default().into(),
                author: if login.is_empty() { String::new() } else { format!("@{login}") },
                body: c["body"].as_str().unwrap_or_default().into(),
                created_ms: c["createdAt"].as_str().and_then(utc_ms).unwrap_or(0),
            }
        })
        .collect();
    comments.sort_by_key(|c| c.created_ms);
    let extra = comments.len().saturating_sub(MAX_COMMENTS);
    comments.drain(..extra);
    Ok(GhComments { comments, more: extra > 0 })
}

/// gh's arguments to comment on issue `number`, the body read from stdin.
pub fn issue_comment_args(number: u64) -> Vec<String> {
    vec!["issue".into(), "comment".into(), number.to_string(), "--body-file".into(), "-".into()]
}

/// The comments of issue `number` of the repository at `repo` (X66).
pub async fn gh_issue_comments(repo: &Path, number: u64) -> Result<GhComments> {
    let n = number.to_string();
    let out = run_raw("gh", repo, &["issue", "view", &n, "--json", "comments"], None, Duration::from_secs(60)).await?;
    if out.status != 0 {
        bail!("{}", out.stderr.trim());
    }
    parse_issue_comments(&out.stdout)
}

/// Posts the user's comment on issue `number` of the repository at `repo` (X66).
pub async fn gh_issue_comment(repo: &Path, number: u64, body: &str) -> Result<()> {
    if body.trim().is_empty() {
        bail!("The comment is empty");
    }
    let args = issue_comment_args(number);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_raw("gh", repo, &refs, Some(body.as_bytes()), Duration::from_secs(60)).await?;
    if out.status != 0 {
        bail!("{}", out.stderr.trim());
    }
    Ok(())
}

/// The new-issue form's lists for `repo` (X52). Who the user is is needed;
/// people, labels or access GitHub won't give leave the user's own choice.
pub async fn gh_create_options(repo: &str) -> Result<GhCreateChoices> {
    let repo = check_repo(repo)?;
    let me = gh_whoami().await?;
    let get = |path: String| async move {
        api(&["api".into(), path])
            .await
            .unwrap_or_else(|_| b"[]".to_vec())
    };
    let assignees = get(format!("repos/{repo}/assignees?per_page=100")).await;
    let labels = get(format!("repos/{repo}/labels?per_page=100")).await;
    let access = api(&["api".into(), format!("repos/{repo}")])
        .await
        .unwrap_or_else(|_| b"{}".to_vec());
    parse_create_options(&me, &assignees, &labels, &access)
}

/// Creates an issue in `repo` (X52): assigned to the user (`me`), no one
/// (`none`) or a login, with its labels.
pub async fn gh_issue_create(
    repo: &str,
    title: &str,
    body: &str,
    assignee: &str,
    labels: &[String],
) -> Result<GhCreated> {
    let repo = check_repo(repo)?;
    let login = match assignee {
        "none" => None,
        "me" => Some(gh_whoami().await?),
        login => Some(login.to_string()),
    };
    parse_created_issue(
        &api(&issue_create_args(
            repo,
            title,
            body,
            login.as_deref(),
            labels,
        ))
        .await?,
    )
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
    fn an_issues_comments_by_login_oldest_first_without_hidden_ones() {
        use moonlet_proto::types::{GhComment, GhComments};
        assert_eq!(
            parse_issue_comments(&fixture("gh-issue-comments.json")).unwrap(),
            GhComments {
                comments: vec![
                    GhComment {
                        id: "IC_e2e0001".into(),
                        author: "@sam-rivera".into(),
                        body: "Looks good. Can we **also** cover `ClickUp`?\n\n- [ ] one\n- [x] two\n".into(),
                        created_ms: 1_792_767_974_000,
                    },
                    GhComment {
                        id: "IC_e2e0003".into(),
                        author: "@lee-moreno".into(),
                        body: "Done in #13.".into(),
                        created_ms: 1_792_771_200_000,
                    },
                ],
                more: false,
            }
        );
    }

    #[test]
    fn a_comment_goes_to_gh_on_stdin() {
        assert_eq!(issue_comment_args(12), ["issue", "comment", "12", "--body-file", "-"]);
    }

    #[test]
    fn an_issue_is_created_through_the_issues_api_with_its_assignee_and_labels() {
        assert_eq!(
            issue_create_args(
                "acme/web",
                "Retry failed webhook deliveries",
                "Back off **exponentially**.",
                Some("sam-rivera"),
                &["bug".to_string()]
            ),
            [
                "api",
                "repos/acme/web/issues",
                "-X",
                "POST",
                "-f",
                "title=Retry failed webhook deliveries",
                "-f",
                "body=Back off **exponentially**.",
                "-f",
                "assignees[]=sam-rivera",
                "-f",
                "labels[]=bug",
            ]
        );
        // No body, assignee or labels: none sent.
        assert_eq!(
            issue_create_args("acme/web", "Hosts", "", None, &[]),
            [
                "api",
                "repos/acme/web/issues",
                "-X",
                "POST",
                "-f",
                "title=Hosts"
            ]
        );
    }

    #[test]
    fn the_created_issue_as_a_task_with_its_node_id() {
        let created = parse_created_issue(&fixture("gh-issue-create.json")).unwrap();
        assert_eq!(
            (
                created.task.repo.as_str(),
                created.task.number,
                created.task.title.as_str(),
                created.task.closed
            ),
            ("acme/web", 1, "Retry failed webhook deliveries", false)
        );
        assert_eq!(
            (created.task.assignees.clone(), created.task.labels.clone()),
            (vec!["sam-rivera".to_string()], vec!["bug".to_string()])
        );
        assert_eq!(created.task.url, "https://github.com/acme/web/issues/1");
        assert_eq!(created.node, "I_e2e0001");
    }

    #[test]
    fn a_refusal_says_githubs_reasons() {
        // As captured: gh's stdout is GitHub's answer, its stderr gh's own line.
        assert_eq!(
            refusal(
                &fixture("gh-error-issue-create.json"),
                "gh: Validation Failed (HTTP 422)"
            ),
            "GitHub: Validation Failed: title can't be blank"
        );
        assert_eq!(
            refusal(b"", "error connecting to api.github.com\n"),
            "error connecting to api.github.com"
        );
    }

    #[test]
    fn a_repositorys_people_and_labels_and_whether_they_can_be_set() {
        let o = parse_create_options(
            "sam-rivera",
            &fixture("gh-assignees.json"),
            &fixture("gh-labels.json"),
            &fixture("gh-repo-permissions.json"),
        )
        .unwrap();
        assert_eq!(
            (o.me.as_str(), o.people.clone(), o.labels.clone(), o.can_set),
            (
                "sam-rivera",
                vec!["sam-rivera".to_string()],
                vec![
                    "bug".to_string(),
                    "documentation".to_string(),
                    "enhancement".to_string()
                ],
                true
            )
        );
        // Read access only: GitHub would drop them.
        let read = br#"{"permissions":{"admin":false,"maintain":false,"pull":true,"push":false,"triage":false}}"#;
        assert!(
            !parse_create_options("sam-rivera", b"[]", b"[]", read)
                .unwrap()
                .can_set
        );
    }
}
