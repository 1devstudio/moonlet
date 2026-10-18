//! What every tracker's board sync gives the app (X50): a board's issue with
//! its card fields, an issue's parent, and the sprint or cycle a board follows.

use serde::{Deserialize, Serialize};

use crate::task::TrackerTask;

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
    /// A due date given as a time (ClickUp's), whose day the app takes
    /// where the user is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_ms: Option<u64>,
}

impl BoardIssue {
    /// A Linear or ClickUp task on a board: its columns list states by name.
    pub fn from_task(task: TrackerTask) -> Self {
        Self {
            task,
            status_id: String::new(),
            components: vec![],
            points: None,
            parent: None,
            due: None,
            due_ms: None,
        }
    }
}

/// An issue's epic or parent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Parent {
    pub key: String,
    pub title: String,
}

/// The sprint a Scrum board follows, or the cycle a Linear team board follows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sprint {
    pub id: u64,
    pub name: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// A new issue from a board column's + (X52), as the form sends it.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewIssue {
    pub title: String,
    /// Markdown.
    #[serde(default)]
    pub description: String,
    /// `me`, `none` (Unassigned), or a person's id in the tracker.
    pub assignee: String,
    /// Label names.
    #[serde(default)]
    pub labels: Vec<String>,
    /// The column's first status: a Jira status id, else a state's name.
    pub status: String,
    /// Jira: the issue type's id.
    #[serde(default)]
    pub issue_type: Option<String>,
    /// Where it goes when the board's issues come from several places.
    #[serde(default)]
    pub place: Option<String>,
}

/// A person or label the form offers (X52), by id and name.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Named {
    pub id: String,
    pub name: String,
}
