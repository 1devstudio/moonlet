//! A workspace design's pages as the visual editor reads and saves them
//! (X65): `pages/<page>.html`, each read with its version, a hash of its
//! text, and written whole as the app sends it, only over the version the
//! editor read, so an edit by hand never overwrites the agent's change.

use anyhow::Result;

use moonlet_proto::methods::DesignPageText;

use super::fsx;
use super::place::DesignAt;
use super::store::Store;

/// A save over a page that changed on disk since the editor read it.
#[derive(Debug, thiserror::Error)]
#[error("{0} changed since it was read")]
pub struct Stale(pub String);

/// A page whose file is not there or cannot be read, said as the canvas's
/// did-not-load bar says it (X65): plainly, with no path, as it goes to the
/// bar and the design's agent. It is the context of the error it comes
/// from, which keeps the cause for the daemon's log.
#[derive(Debug, thiserror::Error)]
pub enum Unreadable {
    #[error("the file is missing")]
    Missing,
    #[error("the file is a link out of the design")]
    LinkOut,
    #[error("the file is not valid UTF-8")]
    NotUtf8,
    #[error("the file cannot be read")]
    Denied,
}

impl Unreadable {
    /// What a failed read of `rel` in `root` is: a link out of the design
    /// when the file, or a folder on its way, is a link that leads out of
    /// `root`; missing when it is not there; not UTF-8 when its bytes are
    /// not text; else it cannot be read (no permission, a folder, …).
    fn of(e: &anyhow::Error, root: &std::path::Path, rel: &std::path::Path) -> Self {
        let io = |kind: std::io::ErrorKind| {
            e.chain().any(|c| {
                c.downcast_ref::<std::io::Error>()
                    .is_some_and(|io| io.kind() == kind)
            })
        };
        if leads_out(root, rel) {
            Self::LinkOut
        } else if io(std::io::ErrorKind::NotFound) {
            Self::Missing
        } else if io(std::io::ErrorKind::InvalidData) {
            Self::NotUtf8
        } else {
            Self::Denied
        }
    }
}

/// Whether `rel` in `root`, or a folder on its way, is a link whose target
/// is outside `root`: only to say why a read failed, never to allow one.
fn leads_out(root: &std::path::Path, rel: &std::path::Path) -> bool {
    let Ok(root) = root.canonicalize() else {
        return false;
    };
    let mut at = root.clone();
    rel.components().any(|part| {
        at.push(part);
        at.symlink_metadata()
            .is_ok_and(|m| m.file_type().is_symlink())
            && !at.canonicalize().is_ok_and(|real| real.starts_with(&root))
    })
}

/// A page name that names no page of a design.
#[derive(Debug, thiserror::Error)]
#[error("bad page \"{0}\"")]
pub struct BadPage(pub String);

/// A page's name, `index` for `pages/index.html`: not empty, no folder, no
/// hidden file, and no `@`, which names a snapshot's folder
/// (`designs/<slug>@<n>/`, X65).
pub fn is_page_name(page: &str) -> bool {
    !page.is_empty() && !page.starts_with('.') && !page.contains(['/', '\\', '\0', '@'])
}

/// A page's path in its design's folder, `pages/<page>.html`: the one build
/// of it, [`page_of`] its one parse. A name that is not a page's is
/// [`BadPage`].
pub fn page_path(page: &str) -> Result<String> {
    if !is_page_name(page) {
        return Err(BadPage(page.to_string()).into());
    }
    Ok(format!("pages/{page}.html"))
}

/// The page a path in a design's folder is (`pages/index.html` is
/// `index`); `None` for any other path.
pub fn page_of(path: &str) -> Option<&str> {
    path.strip_prefix("pages/").and_then(page_of_file)
}

/// The page a file of `pages/` is by its name (`index.html` is `index`).
pub fn page_of_file(name: &str) -> Option<&str> {
    name.strip_suffix(".html").filter(|p| is_page_name(p))
}

/// Pages in the order their tabs show them: `index` first, then by name.
pub fn sort_pages(pages: &mut [String]) {
    pages.sort_by(|a, b| (a != "index", a).cmp(&(b != "index", b)));
}

/// A page's version: the SHA-256 of its text, in hex.
fn version_of(text: &str) -> String {
    crate::hash::sha256_hex(text.as_bytes())
}

/// `pages/<page>.html` of the design, inside its root.
fn page_rel(at: &DesignAt, page: &str) -> Result<std::path::PathBuf> {
    Ok(at.in_dir(page_path(page)?))
}

impl Store {
    /// A design's page, `pages/<page>.html`, with its version, and when
    /// `parse` asks for it, where its markup swallows the editor bridge, if
    /// it does: what the canvas asks of a page whose bridge was silent,
    /// never on the editor's reads on every change.
    pub fn page(&self, at: &DesignAt, page: &str, parse: bool) -> Result<DesignPageText> {
        let rel = page_rel(at, page)?;
        let html = fsx::read_inside(&at.root, &at.root.join(&rel)).map_err(|e| {
            let why = Unreadable::of(&e, &at.root, &rel);
            e.context(why)
        })?;
        Ok(DesignPageText {
            version: version_of(&html),
            parse_error: if parse {
                super::parse::first_parse_error(&html)
            } else {
                None
            },
            html,
        })
    }

    /// Replaces a design's page with `html`, as it is, when the file on disk
    /// is still at `base`; returns its new version. A page changed since is
    /// [`Stale`] and left as it is. Written through the designs folder as a
    /// handle, so a design or pages folder swapped for a link is never
    /// followed.
    ///
    /// The file is read again right before the rename that replaces it, the
    /// new text already written aside, but a check and a rename are two
    /// steps: a write by another process between them, such as the
    /// design's agent's own edit, is replaced, not refused. The daemon
    /// takes a lock of the design's pages around this, so moonlet's own
    /// saves never fall between them.
    pub fn write_page(&self, at: &DesignAt, page: &str, html: &str, base: &str) -> Result<String> {
        let rel = page_rel(at, page)?;
        // Read again just before it is replaced: changed meanwhile, it is
        // read again, and is no longer at `base`.
        fsx::update_inside(&at.root, &rel, |text| {
            if version_of(text) != base {
                return Err(Stale(page_path(page)?).into());
            }
            Ok(html.to_string())
        })?;
        Ok(version_of(html))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A workspace with a design, `settings-page`, whose index page is `INDEX`.
    fn store_with_page() -> (tempfile::TempDir, Store) {
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
        let pages = home.path().join("design/w1/designs/settings-page/pages");
        std::fs::create_dir_all(&pages).unwrap();
        std::fs::write(pages.join("index.html"), INDEX).unwrap();
        (home, store)
    }

    const INDEX: &str =
        "<!doctype html>\r\n<body data-mid=\"m1\">\r\n<h1 data-mid=m2>Settings</h1>\r\n</body>\r\n";

    #[test]
    fn a_page_is_read_with_its_version_and_written_exactly_as_sent_over_that_version() {
        let (home, store) = store_with_page();
        let read = store
            .page(
                &store.workspace_design("w1", "settings-page").unwrap(),
                "index",
                false,
            )
            .unwrap();
        assert_eq!(read.html, INDEX);
        // `shasum -a 256` of INDEX.
        assert_eq!(
            read.version,
            "481faada599299fe4a62df14441b3ede9a8a2d0a53b1c90e93902910d05ec0e4"
        );
        let edited = "<!doctype html>\r\n<body data-mid=\"m1\">\r\n<h1 data-mid=m2>Settings</h1>\r\n<p data-mid=m3>Saved &amp; kept</p></body>";
        let version = store
            .write_page(
                &store.workspace_design("w1", "settings-page").unwrap(),
                "index",
                edited,
                &read.version,
            )
            .unwrap();
        let file = home
            .path()
            .join("design/w1/designs/settings-page/pages/index.html");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), edited);
        assert_eq!(
            store
                .page(
                    &store.workspace_design("w1", "settings-page").unwrap(),
                    "index",
                    false
                )
                .unwrap(),
            DesignPageText {
                html: edited.into(),
                version: version.clone(),
                parse_error: None,
            }
        );
        // A second edit goes over the version the first one gave.
        store
            .write_page(
                &store.workspace_design("w1", "settings-page").unwrap(),
                "index",
                INDEX,
                &version,
            )
            .unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), INDEX);
    }

    #[test]
    fn a_save_over_a_page_changed_since_it_was_read_is_refused_as_stale_and_leaves_the_change() {
        let (home, store) = store_with_page();
        let file = home
            .path()
            .join("design/w1/designs/settings-page/pages/index.html");
        let read = store
            .page(
                &store.workspace_design("w1", "settings-page").unwrap(),
                "index",
                false,
            )
            .unwrap();
        let agents = "<!doctype html>\n<body data-mid=\"m1\"><h1 data-mid=\"m2\">Settings, by the agent</h1></body>\n";
        std::fs::write(&file, agents).unwrap();
        let err = store
            .write_page(
                &store.workspace_design("w1", "settings-page").unwrap(),
                "index",
                "<p>mine</p>",
                &read.version,
            )
            .unwrap_err();
        assert!(err.is::<Stale>(), "{err:#}");
        assert_eq!(
            err.to_string(),
            "pages/index.html changed since it was read"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), agents);
        // The agent writing it while it is saved: refused too.
        let read = store
            .page(
                &store.workspace_design("w1", "settings-page").unwrap(),
                "index",
                false,
            )
            .unwrap();
        let theirs = file.clone();
        fsx::BEFORE_REPLACE.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                std::fs::write(&theirs, "<p>the agent's</p>").unwrap()
            }))
        });
        let err = store
            .write_page(
                &store.workspace_design("w1", "settings-page").unwrap(),
                "index",
                "<p>mine</p>",
                &read.version,
            )
            .unwrap_err();
        assert!(err.is::<Stale>(), "{err:#}");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "<p>the agent's</p>"
        );
    }

    #[test]
    fn a_page_is_never_read_or_written_through_a_link_or_by_a_name_that_is_not_a_page() {
        let (home, store) = store_with_page();
        let designs = home.path().join("design/w1/designs");
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("index.html"), "outside").unwrap();
        let read = store
            .page(
                &store.workspace_design("w1", "settings-page").unwrap(),
                "index",
                false,
            )
            .unwrap();
        // A pages folder swapped for a link to a folder outside.
        let pages = designs.join("settings-page/pages");
        std::fs::rename(&pages, designs.join("settings-page/.pages")).unwrap();
        std::os::unix::fs::symlink(outside.path(), &pages).unwrap();
        assert!(
            store
                .page(
                    &store.workspace_design("w1", "settings-page").unwrap(),
                    "index",
                    false
                )
                .is_err()
        );
        let version = super::version_of("outside");
        assert!(
            store
                .write_page(
                    &store.workspace_design("w1", "settings-page").unwrap(),
                    "index",
                    "mine",
                    &version
                )
                .is_err()
        );
        assert!(
            store
                .write_page(
                    &store.workspace_design("w1", "settings-page").unwrap(),
                    "index",
                    "mine",
                    &read.version
                )
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(outside.path().join("index.html")).unwrap(),
            "outside"
        );
        for bad in ["../index", "", ".hidden", "a/b"] {
            let err = store
                .write_page(
                    &store.workspace_design("w1", "settings-page").unwrap(),
                    bad,
                    "mine",
                    &read.version,
                )
                .unwrap_err();
            assert!(err.is::<BadPage>(), "{bad}: {err:#}");
        }
    }

    #[test]
    fn a_page_is_read_with_the_first_place_it_goes_wrong_as_html_only_when_asked() {
        let (home, store) = store_with_page();
        let at = store.workspace_design("w1", "settings-page").unwrap();
        assert_eq!(store.page(&at, "index", true).unwrap().parse_error, None);
        std::fs::write(
            home.path()
                .join("design/w1/designs/settings-page/pages/index.html"),
            "<!doctype html>\n<body data-mid=\"m1\">\n<html lang=\"en>\n<head><title>x</title></head>\n<h1 data-mid=m2>Settings</h1>\n",
        )
        .unwrap();
        assert_eq!(
            store.page(&at, "index", true).unwrap().parse_error,
            Some(moonlet_proto::methods::DesignParseError {
                line: 3,
                message: "an attribute's quote is never closed".into()
            })
        );
        // The editor's reads, on every change, read no further than the text.
        assert_eq!(store.page(&at, "index", false).unwrap().parse_error, None);
    }

    #[test]
    fn a_page_that_is_missing_or_cannot_be_read_says_so_plainly() {
        use std::os::unix::fs::PermissionsExt;
        let (home, store) = store_with_page();
        let at = store.workspace_design("w1", "settings-page").unwrap();
        assert_eq!(
            store.page(&at, "gone", false).unwrap_err().to_string(),
            "the file is missing"
        );
        // Root reads a file whatever its mode: no case to make there.
        if nix::unistd::geteuid().is_root() {
            return;
        }
        let file = home
            .path()
            .join("design/w1/designs/settings-page/pages/index.html");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        let read = store.page(&at, "index", false);
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(read.unwrap_err().to_string(), "the file cannot be read");
    }

    #[test]
    fn a_page_that_is_not_utf_8_or_a_link_out_of_the_design_says_so_and_keeps_its_cause() {
        let (home, store) = store_with_page();
        let at = store.workspace_design("w1", "settings-page").unwrap();
        let pages = home.path().join("design/w1/designs/settings-page/pages");
        std::fs::write(pages.join("latin.html"), b"<p>caf\xe9</p>\n").unwrap();
        let latin = store.page(&at, "latin", false).unwrap_err();
        assert_eq!(latin.to_string(), "the file is not valid UTF-8");
        // The cause stays in the chain, for the daemon's log, never in what is said.
        assert!(
            latin.chain().any(|c| c
                .downcast_ref::<std::io::Error>()
                .is_some_and(|io| io.kind() == std::io::ErrorKind::InvalidData)),
            "{latin:#}"
        );
        std::fs::write(home.path().join("outside.html"), "<p>out</p>\n").unwrap();
        std::os::unix::fs::symlink(home.path().join("outside.html"), pages.join("out.html"))
            .unwrap();
        let out = store.page(&at, "out", false).unwrap_err();
        assert_eq!(out.to_string(), "the file is a link out of the design");
        assert!(out.chain().count() > 1, "{out:#}");
    }
}
