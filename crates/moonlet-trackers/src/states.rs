//! moonlet's four columns and the default mapping of tracker states onto them
//! (X44 "States").

use serde::{Deserialize, Serialize};

use crate::TrackerKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Column {
    Todo,
    InProgress,
    InReview,
    Done,
    /// "Not shown": backlog, triage, canceled and the like.
    Hidden,
}

/// The column a tracker state lands in until the user maps it differently.
/// For GitHub this maps a project board's Status options; issues of a plain
/// repository source have no such state and are placed by the app from their
/// sessions and PRs (X44 "States").
/// `state_type` is Linear's state type, Jira's status category key or
/// ClickUp's status type; `name` is the state's display name.
pub fn default_column(kind: TrackerKind, state_type: &str, name: &str) -> Column {
    let started = || {
        if looks_like_review(name) {
            Column::InReview
        } else {
            Column::InProgress
        }
    };
    match (kind, state_type) {
        (TrackerKind::Linear, "unstarted") => Column::Todo,
        (TrackerKind::Linear, "started") => started(),
        (TrackerKind::Linear, "completed") => Column::Done,
        (TrackerKind::Jira, "new") => Column::Todo,
        (TrackerKind::Jira, "indeterminate") => started(),
        (TrackerKind::Jira, "done") => Column::Done,
        (TrackerKind::Clickup, "open") => Column::Todo,
        (TrackerKind::Clickup, "custom") => started(),
        (TrackerKind::Clickup, "closed" | "done") => Column::Done,
        (TrackerKind::Github, _) => match name.to_ascii_lowercase().as_str() {
            "todo" | "to do" => Column::Todo,
            "in progress" => Column::InProgress,
            "done" => Column::Done,
            _ if looks_like_review(name) => Column::InReview,
            _ => Column::Hidden,
        },
        _ => Column::Hidden,
    }
}

/// "In Review", "Code review", "QA", "Ready for QA"; not "Preview".
/// A connection's state mapping: state name → the column the user put it in,
/// where that differs from [`default_column`] (`trackers.toml` `states`).
pub type Mapping = std::collections::BTreeMap<String, Column>;

/// The state a move to `column` lands on (X46): the first whose own column it
/// is and that the user left there, else the first the user mapped onto it.
/// `natural` gives a state's default column and its name.
pub fn pick<'a, T>(
    states: &'a [T],
    column: Column,
    mapping: &Mapping,
    natural: impl Fn(&T) -> (Column, &str),
) -> Option<&'a T> {
    let left_alone = states.iter().find(|s| {
        let (own, name) = natural(s);
        own == column && !mapping.contains_key(name)
    });
    left_alone.or_else(|| {
        states
            .iter()
            .find(|s| mapping.get(natural(s).1) == Some(&column))
    })
}

fn looks_like_review(name: &str) -> bool {
    name.split(|c: char| !c.is_ascii_alphanumeric())
        .any(|w| w.eq_ignore_ascii_case("review") || w.eq_ignore_ascii_case("qa"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TrackerKind::*;

    #[test]
    fn linear_state_types() {
        assert_eq!(default_column(Linear, "unstarted", "Todo"), Column::Todo);
        assert_eq!(
            default_column(Linear, "started", "In Progress"),
            Column::InProgress
        );
        assert_eq!(
            default_column(Linear, "started", "In Review"),
            Column::InReview
        );
        assert_eq!(default_column(Linear, "started", "QA"), Column::InReview);
        // "review" must be a word: a "Preview" state is still in progress.
        assert_eq!(
            default_column(Linear, "started", "Preview"),
            Column::InProgress
        );
        assert_eq!(default_column(Linear, "completed", "Done"), Column::Done);
        assert_eq!(default_column(Linear, "backlog", "Backlog"), Column::Hidden);
        assert_eq!(
            default_column(Linear, "canceled", "Duplicate"),
            Column::Hidden
        );
        assert_eq!(default_column(Linear, "triage", "Triage"), Column::Hidden);
    }

    #[test]
    fn jira_status_categories() {
        assert_eq!(default_column(Jira, "new", "To Do"), Column::Todo);
        assert_eq!(
            default_column(Jira, "indeterminate", "In Progress"),
            Column::InProgress
        );
        assert_eq!(
            default_column(Jira, "indeterminate", "Code Review"),
            Column::InReview
        );
        assert_eq!(default_column(Jira, "done", "Closed"), Column::Done);
    }

    #[test]
    fn clickup_status_types() {
        assert_eq!(default_column(Clickup, "open", "to do"), Column::Todo);
        assert_eq!(
            default_column(Clickup, "custom", "in progress"),
            Column::InProgress
        );
        assert_eq!(
            default_column(Clickup, "custom", "ready for qa"),
            Column::InReview
        );
        assert_eq!(default_column(Clickup, "done", "complete"), Column::Done);
        assert_eq!(default_column(Clickup, "closed", "closed"), Column::Done);
    }

    #[test]
    fn github_project_status_options_by_name() {
        assert_eq!(default_column(Github, "", "Todo"), Column::Todo);
        assert_eq!(
            default_column(Github, "", "In Progress"),
            Column::InProgress
        );
        assert_eq!(default_column(Github, "", "In review"), Column::InReview);
        assert_eq!(default_column(Github, "", "Done"), Column::Done);
        assert_eq!(default_column(Github, "", "Backlog"), Column::Hidden);
    }
}
