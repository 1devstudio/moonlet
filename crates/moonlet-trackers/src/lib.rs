//! Task-tracker logic for the desktop app's Rust side (X44–X46): pasted keys
//! and URLs, state columns, priorities and branch names. Pure functions only;
//! network and Keychain code live in the app. Linking sessions to tasks by
//! key happens in the app's board code (`apps/desktop/src/lib`), where the
//! sessions and PRs are.

pub mod branch;
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
