//! What every tracker's board sync gives the app (X50): a board's issue with
//! its card fields, an issue's parent, and the sprint or cycle a board follows.

use serde::Serialize;

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
