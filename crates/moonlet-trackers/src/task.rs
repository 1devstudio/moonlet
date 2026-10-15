//! A tracker issue in the shape the app's board reads (`Task` in
//! `apps/desktop/src/lib/tasks.ts`), whichever tracker it came from.

use serde::Serialize;

use crate::states::Column;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerTask {
    /// The connection id (`jira:acme.atlassian.net`).
    pub connection: String,
    /// `MOON-142`, `OPS-12`, a ClickUp custom id or `CU-<id>`.
    pub key: String,
    pub title: String,
    pub url: String,
    pub column: Column,
    /// 0–3 bars.
    pub priority: u8,
    pub assignees: Vec<String>,
    pub labels: Vec<String>,
    /// Markdown.
    pub description: String,
    pub updated_ms: u64,
    /// Linear's cycle number, when the issue is in one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cycle: Option<u64>,
    /// Jira's issue type ("Bug", "Story"), for `{type}` in branch names.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_type: Option<String>,
    /// What moves and comments need: the tracker's own ids and state.
    pub tracker: TrackerRef,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerRef {
    /// The issue's id in the tracker (Linear's UUID, Jira's id, ClickUp's task id).
    pub id: String,
    /// The state's name as the tracker shows it ("In Review").
    pub state: String,
    /// The team, project or list the issue is in.
    pub source: String,
}

/// A link the tracker gave for an issue, kept only when it is `https:`, since
/// the app puts it in an `href`.
pub fn web_url(v: &serde_json::Value) -> Option<String> {
    v.as_str()
        .filter(|u| u.starts_with("https://"))
        .map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_links_are_kept() {
        assert_eq!(
            web_url(&serde_json::json!("https://linear.app/acme/issue/MOON-1")).as_deref(),
            Some("https://linear.app/acme/issue/MOON-1")
        );
        assert_eq!(web_url(&serde_json::json!("javascript:alert(1)")), None);
        assert_eq!(web_url(&serde_json::Value::Null), None);
    }

    #[test]
    fn it_serialises_as_the_apps_task() {
        let t = TrackerTask {
            connection: "linear:acme".into(),
            key: "MOON-142".into(),
            title: "Remote hosts sidebar".into(),
            url: "https://linear.app/acme/issue/MOON-142".into(),
            column: Column::InProgress,
            priority: 3,
            assignees: vec!["Sam Rivera".into()],
            labels: vec!["sidebar".into()],
            description: "Add a Hosts section.".into(),
            updated_ms: 1_789_528_295_000,
            cycle: None,
            issue_type: None,
            tracker: TrackerRef {
                id: "a1b2".into(),
                state: "In Progress".into(),
                source: "MOON".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(&t).unwrap(),
            serde_json::json!({
                "connection": "linear:acme", "key": "MOON-142", "title": "Remote hosts sidebar",
                "url": "https://linear.app/acme/issue/MOON-142", "column": "in_progress", "priority": 3,
                "assignees": ["Sam Rivera"], "labels": ["sidebar"], "description": "Add a Hosts section.",
                "updatedMs": 1_789_528_295_000u64,
                "tracker": {"id": "a1b2", "state": "In Progress", "source": "MOON"}
            })
        );
    }
}
