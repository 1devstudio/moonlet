//! A workspace design's comments (X65): pins on elements of its pages, kept
//! in the design's `comments.json`, each with its number, page, `data-mid`,
//! the element's tag and text, the comment, when it was sent and whether it
//! is open or resolved.

use anyhow::{Context, Result};

use moonlet_proto::types::{CommentChange, CommentState, DesignComment};

use super::fsx;
use super::place::DesignAt;
use super::store::Store;

/// The file a design keeps its comments in.
pub const COMMENTS_FILE: &str = "comments.json";

/// How much of an element's text a pin keeps, in characters.
pub const TEXT_MAX: usize = 60;

/// A comment that names no element of a page, or no pin.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct BadComment(pub String);

impl Store {
    /// A design's comments, by number; none before it has a `comments.json`.
    pub fn comments(&self, at: &DesignAt) -> Result<Vec<DesignComment>> {
        let file = at.root.join(at.in_side(COMMENTS_FILE));
        if std::fs::symlink_metadata(&file).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
        {
            return Ok(Vec::new());
        }
        parse(&fsx::read_inside(&at.root, &file)?)
    }

    /// Changes a design's comments and returns the pins changed: a new pin
    /// gets the number after the highest so far; an edited pin its new
    /// comment, and, when it changed, is not sent any more; sent pins record
    /// the time, each only while its comment is still the one sent, so one
    /// edited meanwhile stays not sent (and is returned as it is). Written through the designs folder as a handle, read again
    /// when the agent changed the file meanwhile, so its change is kept.
    pub fn put_comment(
        &self,
        at: &DesignAt,
        change: &CommentChange,
        now: u64,
    ) -> Result<Vec<DesignComment>> {
        match change {
            CommentChange::New {
                page,
                mid,
                tag,
                text,
                comment,
            } => {
                let pin = new_pin(page, mid, tag, text, comment_text(comment)?)?;
                self.update_comments(at, |pins| {
                    let mut pin = pin.clone();
                    pin.n = pins.iter().map(|p| p.n).max().unwrap_or(0) + 1;
                    pins.push(pin.clone());
                    Ok(vec![pin])
                })
            }
            CommentChange::Edit { n, comment } => {
                let comment = comment_text(comment)?;
                self.update_comments(at, |pins| {
                    let pin = find(pins, *n)?;
                    if pin.comment != comment {
                        pin.comment = comment.clone();
                        pin.sent_at = None;
                    }
                    Ok(vec![pin.clone()])
                })
            }
            CommentChange::Sent { pins: sent } => self.update_comments(at, |pins| {
                // Every pin is there before any is marked.
                for s in sent {
                    find(pins, s.n)?;
                }
                let mut out = Vec::new();
                for s in sent {
                    let pin = find(pins, s.n)?;
                    if pin.comment == s.comment {
                        pin.sent_at = Some(now);
                    }
                    out.push(pin.clone());
                }
                Ok(out)
            }),
        }
    }

    /// Marks pin `n` resolved.
    pub fn resolve_comment(&self, at: &DesignAt, n: u32) -> Result<DesignComment> {
        self.update_comments(at, |pins| {
            let pin = find(pins, n)?;
            pin.state = CommentState::Resolved;
            Ok(pin.clone())
        })
    }

    /// Reads, changes and writes a design's `comments.json` in one update: a
    /// missing file is an empty list, made by the write. The daemon runs one
    /// change of a design's comments at a time.
    fn update_comments<T>(
        &self,
        at: &DesignAt,
        mut change: impl FnMut(&mut Vec<DesignComment>) -> Result<T>,
    ) -> Result<T> {
        let rel = at.in_side(COMMENTS_FILE);
        let mut out = None;
        fsx::update_or_create_inside(&at.root, &rel, |text| {
            let mut pins = parse(text)?;
            out = Some(change(&mut pins)?);
            Ok(format!("{}\n", serde_json::to_string_pretty(&pins)?))
        })?;
        out.context("comments.json was not written")
    }
}

/// Pin `n`, or why there is none.
fn find(pins: &mut [DesignComment], n: u32) -> Result<&mut DesignComment> {
    Ok(pins
        .iter_mut()
        .find(|p| p.n == n)
        .ok_or_else(|| BadComment(format!("no comment {n}")))?)
}

/// A comment's text, trimmed; an empty one is refused.
fn comment_text(comment: &str) -> Result<String> {
    let comment = comment.trim();
    if comment.is_empty() {
        return Err(BadComment("a comment needs text".into()).into());
    }
    Ok(comment.to_string())
}

/// A new pin, its element checked: the page a page's name, the `data-mid`
/// `m` and digits, the tag a tag's name; the text squashed to one line and
/// cut to [`TEXT_MAX`] characters.
fn new_pin(page: &str, mid: &str, tag: &str, text: &str, comment: String) -> Result<DesignComment> {
    if !super::pages::is_page_name(page) {
        return Err(BadComment(format!("bad page \"{page}\"")).into());
    }
    if !is_mid(mid) {
        return Err(BadComment(format!("bad data-mid \"{mid}\"")).into());
    }
    let lower = tag.to_ascii_lowercase();
    let tag_ok = lower.len() <= 32
        && lower.starts_with(|c: char| c.is_ascii_lowercase())
        && lower
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !tag_ok {
        return Err(BadComment(format!("bad tag \"{tag}\"")).into());
    }
    let text: String = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(TEXT_MAX)
        .collect();
    Ok(DesignComment {
        n: 0,
        page: page.to_string(),
        mid: mid.to_string(),
        tag: lower,
        text,
        comment,
        sent_at: None,
        state: CommentState::Open,
    })
}

/// `m` and digits: a page's element id.
pub fn is_mid(mid: &str) -> bool {
    mid.len() > 1 && mid.starts_with('m') && mid[1..].bytes().all(|b| b.is_ascii_digit())
}

/// `comments.json`'s pins by number; an empty file has none.
pub(super) fn parse(text: &str) -> Result<Vec<DesignComment>> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut pins: Vec<DesignComment> =
        serde_json::from_str(text).with_context(|| format!("cannot read {COMMENTS_FILE}"))?;
    pins.sort_by_key(|p| p.n);
    Ok(pins)
}

#[cfg(test)]
mod tests {
    use super::*;
    use moonlet_proto::types::CommentState;

    /// A workspace with a design, `settings-page`, on `moonlet-desktop`.
    fn store_with_design() -> (tempfile::TempDir, Store) {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        store
            .create_system(
                "w1",
                "moonlet desktop",
                vec![],
                super::super::store::Cover::Core,
                1,
            )
            .unwrap();
        store
            .create_design("w1", "Settings page", "moonlet-desktop", "", 1)
            .unwrap();
        (home, store)
    }

    fn new(page: &str, mid: &str, tag: &str, text: &str, comment: &str) -> CommentChange {
        CommentChange::New {
            page: page.into(),
            mid: mid.into(),
            tag: tag.into(),
            text: text.into(),
            comment: comment.into(),
        }
    }

    fn nav() -> CommentChange {
        new(
            "index",
            "m12",
            "nav",
            "General Appearance Terminal Agents",
            "Collapse into a menu on phone",
        )
    }

    fn edit(n: u32, comment: &str) -> CommentChange {
        CommentChange::Edit {
            n,
            comment: comment.into(),
        }
    }

    /// The one pin a change made or changed.
    fn put(store: &Store, change: CommentChange, now: u64) -> DesignComment {
        let mut pins = store
            .put_comment(
                &store.workspace_design("w1", "settings-page").unwrap(),
                &change,
                now,
            )
            .unwrap();
        assert_eq!(pins.len(), 1);
        pins.remove(0)
    }

    #[test]
    fn a_kept_comment_is_numbered_saved_in_comments_json_and_listed() {
        let (home, store) = store_with_design();
        let first = put(&store, nav(), 1_761_200_000_000);
        let second = put(
            &store,
            new("git-a", "m25", "h2", "Git", "Make Git the first section"),
            1_761_200_060_000,
        );
        assert_eq!((first.n, second.n), (1, 2));
        assert_eq!(
            store
                .comments(&store.workspace_design("w1", "settings-page").unwrap())
                .unwrap(),
            vec![
                DesignComment {
                    n: 1,
                    page: "index".into(),
                    mid: "m12".into(),
                    tag: "nav".into(),
                    text: "General Appearance Terminal Agents".into(),
                    comment: "Collapse into a menu on phone".into(),
                    sent_at: None,
                    state: CommentState::Open,
                },
                DesignComment {
                    n: 2,
                    page: "git-a".into(),
                    mid: "m25".into(),
                    tag: "h2".into(),
                    text: "Git".into(),
                    comment: "Make Git the first section".into(),
                    sent_at: None,
                    state: CommentState::Open,
                },
            ]
        );
        let json = std::fs::read_to_string(
            home.path()
                .join("design/w1/designs/settings-page/comments.json"),
        )
        .unwrap();
        assert!(
            json.contains(r#""comment": "Collapse into a menu on phone""#),
            "{json}"
        );
        assert_eq!(store.designs("w1").unwrap()[0].open_comments, 2);
    }

    #[test]
    fn a_sent_comment_records_when_and_a_resolved_one_no_longer_counts_as_open() {
        let (_home, store) = store_with_design();
        put(&store, nav(), 1);
        put(&store, new("index", "m25", "h2", "Git", "Git first"), 1);
        let kept = put(&store, edit(1, "Collapse into a menu below 600 px"), 2);
        assert_eq!(
            (kept.comment.as_str(), kept.sent_at, kept.mid.as_str()),
            ("Collapse into a menu below 600 px", None, "m12")
        );
        let marked = store
            .put_comment(
                &store.workspace_design("w1", "settings-page").unwrap(),
                &sent(&[(1, "Collapse into a menu below 600 px"), (2, "Git first")]),
                1_761_200_100_000,
            )
            .unwrap();
        assert_eq!(
            marked.iter().map(|p| (p.n, p.sent_at)).collect::<Vec<_>>(),
            vec![(1, Some(1_761_200_100_000)), (2, Some(1_761_200_100_000))]
        );
        let resolved = store
            .resolve_comment(&store.workspace_design("w1", "settings-page").unwrap(), 1)
            .unwrap();
        assert_eq!(
            (resolved.state, resolved.sent_at),
            (CommentState::Resolved, Some(1_761_200_100_000))
        );
        assert_eq!(store.designs("w1").unwrap()[0].open_comments, 1);
        // A number is never given again, though its pin is resolved.
        assert_eq!(put(&store, nav(), 3).n, 3);
        assert_eq!(
            store
                .resolve_comment(&store.workspace_design("w1", "settings-page").unwrap(), 9)
                .unwrap_err()
                .to_string(),
            "no comment 9"
        );
        // A pin that is not there marks none of them sent.
        let none = store.put_comment(
            &store.workspace_design("w1", "settings-page").unwrap(),
            &sent(&[(3, "Collapse into a menu on phone"), (9, "x")]),
            4,
        );
        assert_eq!(none.unwrap_err().to_string(), "no comment 9");
        assert_eq!(
            store
                .comments(&store.workspace_design("w1", "settings-page").unwrap())
                .unwrap()[2]
                .sent_at,
            None
        );
    }

    #[test]
    fn an_edited_comment_is_not_sent_any_more_and_an_unchanged_one_stays_sent() {
        let (_home, store) = store_with_design();
        put(&store, nav(), 1);
        store
            .put_comment(
                &store.workspace_design("w1", "settings-page").unwrap(),
                &sent(&[(1, "Collapse into a menu on phone")]),
                1_761_200_100_000,
            )
            .unwrap();
        let same = put(&store, edit(1, " Collapse into a menu on phone "), 2);
        assert_eq!(same.sent_at, Some(1_761_200_100_000));
        let changed = put(&store, edit(1, "Collapse into a menu below 600 px"), 3);
        assert_eq!(
            (changed.comment.as_str(), changed.sent_at),
            ("Collapse into a menu below 600 px", None)
        );
    }

    /// `sent` as the app sends it: each pin's number and its comment as sent.
    fn sent(pins: &[(u32, &str)]) -> CommentChange {
        let pins: Vec<_> = pins
            .iter()
            .map(|(n, comment)| serde_json::json!({"n": n, "comment": comment}))
            .collect();
        serde_json::from_value(serde_json::json!({"sent": {"pins": pins}})).unwrap()
    }

    #[test]
    fn a_pin_edited_while_it_was_being_sent_stays_not_sent() {
        let (_home, store) = store_with_design();
        put(&store, nav(), 1);
        put(&store, new("index", "m25", "h2", "Git", "Git first"), 1);
        // Pin 1 was edited after the chat got its old comment.
        put(&store, edit(1, "Collapse into a menu below 600 px"), 2);
        let back = store
            .put_comment(
                &store.workspace_design("w1", "settings-page").unwrap(),
                &sent(&[(1, "Collapse into a menu on phone"), (2, "Git first")]),
                1_761_200_100_000,
            )
            .unwrap();
        let shown = |pins: &[DesignComment]| {
            pins.iter()
                .map(|p| (p.n, p.comment.clone(), p.sent_at))
                .collect::<Vec<_>>()
        };
        let want = vec![
            (1, "Collapse into a menu below 600 px".to_string(), None),
            (2, "Git first".to_string(), Some(1_761_200_100_000)),
        ];
        assert_eq!(shown(&back), want);
        assert_eq!(
            shown(
                &store
                    .comments(&store.workspace_design("w1", "settings-page").unwrap())
                    .unwrap()
            ),
            want
        );
    }

    #[test]
    fn a_comments_json_from_before_its_fields_or_empty_or_missing_still_loads() {
        let (home, store) = store_with_design();
        let file = home
            .path()
            .join("design/w1/designs/settings-page/comments.json");
        std::fs::write(&file, "[{\"n\": 1, \"state\": \"open\"}]\n").unwrap();
        assert_eq!(
            store
                .comments(&store.workspace_design("w1", "settings-page").unwrap())
                .unwrap(),
            vec![DesignComment {
                n: 1,
                page: String::new(),
                mid: String::new(),
                tag: String::new(),
                text: String::new(),
                comment: String::new(),
                sent_at: None,
                state: CommentState::Open,
            }]
        );
        std::fs::write(&file, "").unwrap();
        assert_eq!(
            store
                .comments(&store.workspace_design("w1", "settings-page").unwrap())
                .unwrap(),
            vec![]
        );
        std::fs::remove_file(&file).unwrap();
        assert_eq!(
            store
                .comments(&store.workspace_design("w1", "settings-page").unwrap())
                .unwrap(),
            vec![]
        );
        assert_eq!(put(&store, nav(), 1).n, 1);
        assert_eq!(
            store
                .comments(&store.workspace_design("w1", "settings-page").unwrap())
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn an_unreadable_comments_json_is_reported_and_never_written_over() {
        let (home, store) = store_with_design();
        let file = home
            .path()
            .join("design/w1/designs/settings-page/comments.json");
        std::fs::write(&file, "[{\"n\": 1,").unwrap();
        let err = store
            .comments(&store.workspace_design("w1", "settings-page").unwrap())
            .unwrap_err();
        assert!(
            format!("{err:#}").starts_with("cannot read comments.json"),
            "{err:#}"
        );
        assert!(
            store
                .put_comment(
                    &store.workspace_design("w1", "settings-page").unwrap(),
                    &nav(),
                    1
                )
                .is_err()
        );
        assert!(
            store
                .resolve_comment(&store.workspace_design("w1", "settings-page").unwrap(), 1)
                .is_err()
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "[{\"n\": 1,");
        assert_eq!(store.designs("w1").unwrap()[0].open_comments, 0);
    }

    #[test]
    fn a_pin_names_a_page_and_an_element_and_keeps_60_characters_of_its_text() {
        let (_home, store) = store_with_design();
        let pin = put(
            &store,
            new(
                "index",
                "m12",
                "NAV",
                "  General\n  Appearance   Terminal Agents Git Notifications Shortcuts Advanced  ",
                "Collapse",
            ),
            1,
        );
        assert_eq!(
            (pin.tag.as_str(), pin.text.as_str()),
            (
                "nav",
                "General Appearance Terminal Agents Git Notifications Shortcu"
            )
        );
        for (bad, message) in [
            (
                new("../index", "m12", "nav", "", "c"),
                "bad page \"../index\"",
            ),
            (
                new("index", "m12\"]", "nav", "", "c"),
                "bad data-mid \"m12\"]\"",
            ),
            (
                new("index", "m12", "nav onclick", "", "c"),
                "bad tag \"nav onclick\"",
            ),
            (new("index", "m12", "nav", "", "  "), "a comment needs text"),
            (edit(1, ""), "a comment needs text"),
        ] {
            assert_eq!(
                store
                    .put_comment(
                        &store.workspace_design("w1", "settings-page").unwrap(),
                        &bad,
                        1
                    )
                    .unwrap_err()
                    .to_string(),
                message
            );
        }
        assert_eq!(
            store
                .comments(&store.workspace_design("w1", "settings-page").unwrap())
                .unwrap()
                .len(),
            1
        );
    }
}
