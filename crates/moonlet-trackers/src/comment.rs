//! A task's comments as the Task detail and Task tab list them (X66),
//! whichever tracker they came from.

use serde::Serialize;

/// The most comments moonlet reads of one task (X66).
pub const MAX: usize = 100;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskComment {
    pub id: String,
    /// The tracker's display name; empty when it gives none.
    pub author: String,
    pub body: String,
    /// Whether `body` is Markdown; ClickUp's comment text is not.
    pub markdown: bool,
    pub created_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Comments {
    /// Oldest first.
    pub comments: Vec<TaskComment>,
    /// The tracker has more than these.
    pub more: bool,
}

impl Comments {
    /// `comments` oldest first, whatever order the tracker gave them in, and
    /// at most the newest [`MAX`].
    pub fn new(mut comments: Vec<TaskComment>, more: bool) -> Self {
        comments.sort_by_key(|c| c.created_ms);
        let extra = comments.len().saturating_sub(MAX);
        comments.drain(..extra);
        Comments {
            comments,
            more: more || extra > 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ms: u64) -> TaskComment {
        TaskComment {
            id: ms.to_string(),
            author: "Ada Lovelace".into(),
            body: "Hi".into(),
            markdown: true,
            created_ms: ms,
        }
    }

    #[test]
    fn past_a_hundred_the_oldest_are_left_out_and_more_is_said() {
        let c = Comments::new((1..=101).rev().map(at).collect(), false);
        assert_eq!(c.comments.len(), 100);
        assert_eq!(c.comments.first().map(|c| c.id.as_str()), Some("2"));
        assert_eq!(c.comments.last().map(|c| c.id.as_str()), Some("101"));
        assert!(c.more);
        let c = Comments::new(vec![at(5), at(3)], false);
        assert_eq!(
            c.comments.iter().map(|c| c.created_ms).collect::<Vec<_>>(),
            [3, 5]
        );
        assert!(!c.more);
    }
}
