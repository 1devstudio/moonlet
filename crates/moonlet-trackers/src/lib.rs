//! Task-tracker logic for the desktop app's Rust side (X44–X46): pasted keys
//! and URLs, state columns, priorities and branch names. Pure functions only;
//! network and Keychain code live in the app. Linking sessions to tasks by
//! key happens in the app's board code (`apps/desktop/src/lib`), where the
//! sessions and PRs are.

pub mod adf;
pub mod board;
pub mod branch;
pub mod clickup;
pub mod comment;
pub mod config;
pub mod jira;
pub mod jira_board;
pub mod jira_create;
pub mod linear;
pub mod oauth;
pub mod priority;
pub mod refs;
pub mod states;
pub mod task;
pub mod time;

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

/// A tracker refused or failed a request. `auth` means the token or sign-in
/// no longer works: the connection needs attention and polling stops (X44).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub auth: bool,
    pub message: String,
}

impl ApiError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            auth: false,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
