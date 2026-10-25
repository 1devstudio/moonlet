//! A workspace design's comments (X65): pins on elements of its pages, kept
//! in the design's `comments.json`, each with its number, page, `data-mid`,
//! the element's tag and text, the comment, when it was sent and whether it
//! is open or resolved.

use std::path::Path;

use anyhow::{Context, Result};

use moonlet_proto::types::{CommentState, DesignComment};

use super::fsx;
use super::store::Store;

/// The file a design keeps its comments in.
pub const COMMENTS_FILE: &str = "comments.json";

/// How much of an element's text a pin keeps, in characters.
pub const TEXT_MAX: usize = 60;

/// A comment that names no element of a page, or no pin.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct BadComment(pub String);

/// A comment to keep: a new pin (no `n`), or pin `n`'s comment changed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommentPut {
    pub n: Option<u32>,
    pub page: String,
    pub mid: String,
    pub tag: String,
    pub text: String,
    pub comment: String,
    /// Sent to the chat now.
    pub sent: bool,
}

impl Store {
    /// A design's comments, by number; none before it has a `comments.json`.
    pub fn comments(&self, workspace: &str, slug: &str) -> Result<Vec<DesignComment>> {
        let dir = self.design_dir(workspace, slug)?;
        let file = dir.join(COMMENTS_FILE);
        if std::fs::symlink_metadata(&file).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
        {
            return Ok(Vec::new());
        }
        parse(&fsx::read_inside(&dir, &file)?)
    }

    /// Keeps a comment and returns its pin: a new pin gets the number after
    /// the highest so far; pin `n` gets its new comment. Sent, it records
    /// the time. Written through the designs folder as a handle, read again
    /// when the agent changed the file meanwhile, so its change is kept.
    pub fn put_comment(
        &self,
        workspace: &str,
        slug: &str,
        put: CommentPut,
        now: u64,
    ) -> Result<DesignComment> {
        let comment = put.comment.trim().to_string();
        if comment.is_empty() {
            return Err(BadComment("a comment needs text".into()).into());
        }
        let new = match put.n {
            Some(_) => None,
            None => Some(new_pin(&put, comment.clone())?),
        };
        self.update_comments(workspace, slug, |pins| {
            let pin = match (&new, put.n) {
                (Some(pin), _) => {
                    let mut pin = pin.clone();
                    pin.n = pins.iter().map(|p| p.n).max().unwrap_or(0) + 1;
                    pins.push(pin);
                    pins.last_mut().expect("just pushed")
                }
                (None, n) => {
                    let n = n.unwrap_or_default();
                    let pin = pins
                        .iter_mut()
                        .find(|p| p.n == n)
                        .ok_or_else(|| BadComment(format!("no comment {n}")))?;
                    pin.comment = comment.clone();
                    pin
                }
            };
            if put.sent {
                pin.sent_at = Some(now);
            }
            Ok(pin.clone())
        })
    }

    /// Marks pin `n` resolved.
    pub fn resolve_comment(&self, workspace: &str, slug: &str, n: u32) -> Result<DesignComment> {
        self.update_comments(workspace, slug, |pins| {
            let pin = pins
                .iter_mut()
                .find(|p| p.n == n)
                .ok_or_else(|| BadComment(format!("no comment {n}")))?;
            pin.state = CommentState::Resolved;
            Ok(pin.clone())
        })
    }

    /// Reads, changes and writes a design's `comments.json`, made when missing.
    fn update_comments(
        &self,
        workspace: &str,
        slug: &str,
        mut change: impl FnMut(&mut Vec<DesignComment>) -> Result<DesignComment>,
    ) -> Result<DesignComment> {
        // An existing design, its folder no link.
        let dir = self.design_dir(workspace, slug)?;
        let designs = self.designs_dir(workspace, false)?;
        let rel = Path::new(slug).join(COMMENTS_FILE);
        if std::fs::symlink_metadata(dir.join(COMMENTS_FILE))
            .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
        {
            fsx::write_inside(&designs, &designs.join(&rel), b"[]\n")?;
        }
        let mut out = None;
        fsx::update_inside(&designs, &rel, |text| {
            let mut pins = parse(text)?;
            out = Some(change(&mut pins)?);
            Ok(format!("{}\n", serde_json::to_string_pretty(&pins)?))
        })?;
        out.context("comments.json was not written")
    }
}

/// A new pin of `put`, its element checked: the page a page's name, the
/// `data-mid` `m` and digits, the tag a tag's name; the text squashed to
/// one line and cut to [`TEXT_MAX`] characters.
fn new_pin(put: &CommentPut, comment: String) -> Result<DesignComment> {
    let page_ok =
        !put.page.is_empty() && !put.page.starts_with('.') && !put.page.contains(['/', '\\', '\0']);
    if !page_ok {
        return Err(BadComment(format!("bad page \"{}\"", put.page)).into());
    }
    if !is_mid(&put.mid) {
        return Err(BadComment(format!("bad data-mid \"{}\"", put.mid)).into());
    }
    let tag = put.tag.to_ascii_lowercase();
    let tag_ok = tag.len() <= 32
        && tag.starts_with(|c: char| c.is_ascii_lowercase())
        && tag
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !tag_ok {
        return Err(BadComment(format!("bad tag \"{}\"", put.tag)).into());
    }
    let text: String = put
        .text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(TEXT_MAX)
        .collect();
    Ok(DesignComment {
        n: 0,
        page: put.page.clone(),
        mid: put.mid.clone(),
        tag,
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

    fn nav() -> CommentPut {
        CommentPut {
            page: "index".into(),
            mid: "m12".into(),
            tag: "nav".into(),
            text: "General Appearance Terminal Agents".into(),
            comment: "Collapse into a menu on phone".into(),
            ..CommentPut::default()
        }
    }

    #[test]
    fn a_kept_comment_is_numbered_saved_in_comments_json_and_listed() {
        let (home, store) = store_with_design();
        let first = store
            .put_comment("w1", "settings-page", nav(), 1_761_200_000_000)
            .unwrap();
        let second = store
            .put_comment(
                "w1",
                "settings-page",
                CommentPut {
                    page: "git-a".into(),
                    mid: "m25".into(),
                    tag: "h2".into(),
                    text: "Git".into(),
                    comment: "Make Git the first section".into(),
                    ..CommentPut::default()
                },
                1_761_200_060_000,
            )
            .unwrap();
        assert_eq!((first.n, second.n), (1, 2));
        assert_eq!(
            store.comments("w1", "settings-page").unwrap(),
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
        store.put_comment("w1", "settings-page", nav(), 1).unwrap();
        let kept = store
            .put_comment(
                "w1",
                "settings-page",
                CommentPut {
                    n: Some(1),
                    comment: "Collapse into a menu below 600 px".into(),
                    ..CommentPut::default()
                },
                2,
            )
            .unwrap();
        assert_eq!(
            (kept.comment.as_str(), kept.sent_at, kept.mid.as_str()),
            ("Collapse into a menu below 600 px", None, "m12")
        );
        let sent = store
            .put_comment(
                "w1",
                "settings-page",
                CommentPut {
                    n: Some(1),
                    comment: "Collapse into a menu below 600 px".into(),
                    sent: true,
                    ..CommentPut::default()
                },
                1_761_200_100_000,
            )
            .unwrap();
        assert_eq!(sent.sent_at, Some(1_761_200_100_000));
        let resolved = store.resolve_comment("w1", "settings-page", 1).unwrap();
        assert_eq!(
            (resolved.state, resolved.sent_at),
            (CommentState::Resolved, Some(1_761_200_100_000))
        );
        assert_eq!(store.designs("w1").unwrap()[0].open_comments, 0);
        // A number is never given again, though its pin is resolved.
        assert_eq!(
            store
                .put_comment("w1", "settings-page", nav(), 3)
                .unwrap()
                .n,
            2
        );
        assert_eq!(
            store
                .resolve_comment("w1", "settings-page", 9)
                .unwrap_err()
                .to_string(),
            "no comment 9"
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
            store.comments("w1", "settings-page").unwrap(),
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
        assert_eq!(store.comments("w1", "settings-page").unwrap(), vec![]);
        std::fs::remove_file(&file).unwrap();
        assert_eq!(store.comments("w1", "settings-page").unwrap(), vec![]);
        assert_eq!(
            store
                .put_comment("w1", "settings-page", nav(), 1)
                .unwrap()
                .n,
            1
        );
        assert_eq!(store.comments("w1", "settings-page").unwrap().len(), 1);
    }

    #[test]
    fn an_unreadable_comments_json_is_reported_and_never_written_over() {
        let (home, store) = store_with_design();
        let file = home
            .path()
            .join("design/w1/designs/settings-page/comments.json");
        std::fs::write(&file, "[{\"n\": 1,").unwrap();
        let err = store.comments("w1", "settings-page").unwrap_err();
        assert!(
            format!("{err:#}").starts_with("cannot read comments.json"),
            "{err:#}"
        );
        assert!(store.put_comment("w1", "settings-page", nav(), 1).is_err());
        assert!(store.resolve_comment("w1", "settings-page", 1).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "[{\"n\": 1,");
        assert_eq!(store.designs("w1").unwrap()[0].open_comments, 0);
    }

    #[test]
    fn a_pin_names_a_page_and_an_element_and_keeps_60_characters_of_its_text() {
        let (_home, store) = store_with_design();
        let pin = store
            .put_comment(
                "w1",
                "settings-page",
                CommentPut {
                    tag: "NAV".into(),
                    text: "  General\n  Appearance   Terminal Agents Git Notifications Shortcuts Advanced  ".into(),
                    ..nav()
                },
                1,
            )
            .unwrap();
        assert_eq!(
            (pin.tag.as_str(), pin.text.as_str()),
            (
                "nav",
                "General Appearance Terminal Agents Git Notifications Shortcu"
            )
        );
        for (bad, message) in [
            (
                CommentPut {
                    page: "../index".into(),
                    ..nav()
                },
                "bad page \"../index\"",
            ),
            (
                CommentPut {
                    mid: "m12\"]".into(),
                    ..nav()
                },
                "bad data-mid \"m12\"]\"",
            ),
            (
                CommentPut {
                    tag: "nav onclick".into(),
                    ..nav()
                },
                "bad tag \"nav onclick\"",
            ),
            (
                CommentPut {
                    comment: "  ".into(),
                    ..nav()
                },
                "a comment needs text",
            ),
        ] {
            assert_eq!(
                store
                    .put_comment("w1", "settings-page", bad, 1)
                    .unwrap_err()
                    .to_string(),
                message
            );
        }
        assert_eq!(store.comments("w1", "settings-page").unwrap().len(), 1);
    }
}
