//! Task-tracker logic shared by the desktop app (X44–X46): issue keys in
//! branch names, pasted keys and URLs, state columns, priorities and branch
//! names. Pure functions only; network and Keychain code live in the app.

pub mod branch;
pub mod keys;
pub mod priority;
pub mod refs;
pub mod states;

use serde::{Deserialize, Serialize};

/// The trackers moonlet connects to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackerKind {
    Linear,
    Jira,
    Clickup,
    Github,
}
