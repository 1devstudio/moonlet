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

/// A Linear team's or ClickUp list's states, `(name, type)` in the tracker's
/// order, as a board's columns (X50): one per state, listed by name, with
/// its default category; Done folded, a state not shown hidden.
pub fn board_columns(
    kind: TrackerKind,
    states: &[(String, String)],
) -> Vec<crate::config::BoardColumn> {
    use crate::config::{BoardColumn, Category, Show};
    states
        .iter()
        .map(|(name, state_type)| {
            let category = Category::of(default_column(kind, state_type, name));
            BoardColumn {
                name: name.clone(),
                statuses: vec![name.clone()],
                category: category.unwrap_or(Category::Todo),
                show: match category {
                    None => Show::Hide,
                    Some(Category::Done) => Show::Fold,
                    Some(_) => Show::Show,
                },
                wip: None,
            }
        })
        .collect()
}

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

/// "In Review", "Code review", "Needs Reviews", "QA", "Ready for QA"; not
/// "Preview": a word that starts with "review", or the word "QA".
fn looks_like_review(name: &str) -> bool {
    name.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| {
        w.get(..6)
            .is_some_and(|start| start.eq_ignore_ascii_case("review"))
            || w.eq_ignore_ascii_case("qa")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TrackerKind::*;
    use crate::config::{Category, Show};

    #[test]
    fn a_clickup_lists_statuses_as_board_columns() {
        let states: Vec<(String, String)> = crate::clickup::parse_statuses(
            &std::fs::read(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/clickup-list.json"
            ))
            .unwrap(),
        )
        .unwrap()
        .into_iter()
        .map(|s| (s.name, s.kind))
        .collect();
        let columns = board_columns(Clickup, &states);
        assert_eq!(
            columns
                .iter()
                .map(|c| (c.name.as_str(), c.statuses.clone(), c.category, c.show))
                .collect::<Vec<_>>(),
            [
                (
                    "to do",
                    vec!["to do".to_string()],
                    Category::Todo,
                    Show::Show
                ),
                (
                    "complete",
                    vec!["complete".to_string()],
                    Category::Done,
                    Show::Fold
                ),
            ]
        );
    }

    #[test]
    fn a_linear_teams_states_as_board_columns() {
        let states: Vec<(String, String)> = crate::linear::parse_states(
            &std::fs::read(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/linear-states.json"
            ))
            .unwrap(),
        )
        .unwrap()
        .into_iter()
        .map(|s| (s.name, s.kind))
        .collect();
        let columns = board_columns(Linear, &states);
        assert_eq!(
            columns
                .iter()
                .map(|c| (c.name.as_str(), c.statuses.clone(), c.category, c.show))
                .collect::<Vec<_>>(),
            [
                (
                    "Backlog",
                    vec!["Backlog".to_string()],
                    Category::Todo,
                    Show::Hide
                ),
                ("Todo", vec!["Todo".to_string()], Category::Todo, Show::Show),
                (
                    "In Progress",
                    vec!["In Progress".to_string()],
                    Category::InProgress,
                    Show::Show
                ),
                (
                    "In Review",
                    vec!["In Review".to_string()],
                    Category::InReview,
                    Show::Show
                ),
                ("Done", vec!["Done".to_string()], Category::Done, Show::Fold),
                (
                    "Canceled",
                    vec!["Canceled".to_string()],
                    Category::Todo,
                    Show::Hide
                ),
                (
                    "Duplicate",
                    vec!["Duplicate".to_string()],
                    Category::Todo,
                    Show::Hide
                ),
            ]
        );
    }

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
        assert_eq!(
            default_column(Linear, "started", "Reviewing"),
            Column::InReview
        );
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
        // A board's real review column (X50): "review" may take an ending.
        assert_eq!(
            default_column(Jira, "indeterminate", "Needs Reviews"),
            Column::InReview
        );
        assert_eq!(
            default_column(Jira, "indeterminate", "Reviewing"),
            Column::InReview
        );
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
