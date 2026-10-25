//! A workspace design's pages as the visual editor reads and saves them
//! (X65): `pages/<page>.html`, each read with its version, a hash of its
//! text, and written whole as the app sends it, only over the version the
//! editor read, so an edit by hand never overwrites the agent's change.

use std::path::Path;

use anyhow::Result;

use moonlet_proto::methods::DesignPageText;

use super::fsx;
use super::store::Store;

/// A save over a page that changed on disk since the editor read it.
#[derive(Debug, thiserror::Error)]
#[error("{0} changed since it was read")]
pub struct Stale(pub String);

/// A page name that names no page of a design.
#[derive(Debug, thiserror::Error)]
#[error("bad page \"{0}\"")]
pub struct BadPage(pub String);

/// A page's name, `index` for `pages/index.html`: not empty, no folder and
/// no hidden file.
pub fn is_page_name(page: &str) -> bool {
    !page.is_empty() && !page.starts_with('.') && !page.contains(['/', '\\', '\0'])
}

/// A page's version: the SHA-256 of its text, in hex.
fn version_of(text: &str) -> String {
    crate::hash::sha256_hex(text.as_bytes())
}

/// `<slug>/pages/<page>.html`, inside the designs folder.
fn page_rel(slug: &str, page: &str) -> Result<std::path::PathBuf> {
    if !is_page_name(page) {
        return Err(BadPage(page.to_string()).into());
    }
    Ok(Path::new(slug).join("pages").join(format!("{page}.html")))
}

impl Store {
    /// A design's page, `pages/<page>.html`, with its version.
    pub fn page(&self, workspace: &str, slug: &str, page: &str) -> Result<DesignPageText> {
        let rel = page_rel(slug, page)?;
        let designs = self.designs_of(workspace, slug)?;
        let html = fsx::read_inside(&designs, &designs.join(rel))?;
        Ok(DesignPageText {
            version: version_of(&html),
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
    pub fn write_page(
        &self,
        workspace: &str,
        slug: &str,
        page: &str,
        html: &str,
        base: &str,
    ) -> Result<String> {
        let rel = page_rel(slug, page)?;
        let designs = self.designs_of(workspace, slug)?;
        // Read again just before it is replaced: changed meanwhile, it is
        // read again, and is no longer at `base`.
        fsx::update_inside(&designs, &rel, |text| {
            if version_of(text) != base {
                return Err(Stale(format!("pages/{page}.html")).into());
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
        let read = store.page("w1", "settings-page", "index").unwrap();
        assert_eq!(read.html, INDEX);
        // `shasum -a 256` of INDEX.
        assert_eq!(
            read.version,
            "481faada599299fe4a62df14441b3ede9a8a2d0a53b1c90e93902910d05ec0e4"
        );
        let edited = "<!doctype html>\r\n<body data-mid=\"m1\">\r\n<h1 data-mid=m2>Settings</h1>\r\n<p data-mid=m3>Saved &amp; kept</p></body>";
        let version = store
            .write_page("w1", "settings-page", "index", edited, &read.version)
            .unwrap();
        let file = home
            .path()
            .join("design/w1/designs/settings-page/pages/index.html");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), edited);
        assert_eq!(
            store.page("w1", "settings-page", "index").unwrap(),
            DesignPageText {
                html: edited.into(),
                version: version.clone()
            }
        );
        // A second edit goes over the version the first one gave.
        store
            .write_page("w1", "settings-page", "index", INDEX, &version)
            .unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), INDEX);
    }

    #[test]
    fn a_save_over_a_page_changed_since_it_was_read_is_refused_as_stale_and_leaves_the_change() {
        let (home, store) = store_with_page();
        let file = home
            .path()
            .join("design/w1/designs/settings-page/pages/index.html");
        let read = store.page("w1", "settings-page", "index").unwrap();
        let agents = "<!doctype html>\n<body data-mid=\"m1\"><h1 data-mid=\"m2\">Settings, by the agent</h1></body>\n";
        std::fs::write(&file, agents).unwrap();
        let err = store
            .write_page("w1", "settings-page", "index", "<p>mine</p>", &read.version)
            .unwrap_err();
        assert!(err.is::<Stale>(), "{err:#}");
        assert_eq!(
            err.to_string(),
            "pages/index.html changed since it was read"
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), agents);
        // The agent writing it while it is saved: refused too.
        let read = store.page("w1", "settings-page", "index").unwrap();
        let theirs = file.clone();
        fsx::BEFORE_REPLACE.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                std::fs::write(&theirs, "<p>the agent's</p>").unwrap()
            }))
        });
        let err = store
            .write_page("w1", "settings-page", "index", "<p>mine</p>", &read.version)
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
        let read = store.page("w1", "settings-page", "index").unwrap();
        // A pages folder swapped for a link to a folder outside.
        let pages = designs.join("settings-page/pages");
        std::fs::rename(&pages, designs.join("settings-page/.pages")).unwrap();
        std::os::unix::fs::symlink(outside.path(), &pages).unwrap();
        assert!(store.page("w1", "settings-page", "index").is_err());
        let version = super::version_of("outside");
        assert!(
            store
                .write_page("w1", "settings-page", "index", "mine", &version)
                .is_err()
        );
        assert!(
            store
                .write_page("w1", "settings-page", "index", "mine", &read.version)
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(outside.path().join("index.html")).unwrap(),
            "outside"
        );
        for bad in ["../index", "", ".hidden", "a/b"] {
            let err = store
                .write_page("w1", "settings-page", bad, "mine", &read.version)
                .unwrap_err();
            assert!(err.is::<BadPage>(), "{bad}: {err:#}");
        }
    }
}
