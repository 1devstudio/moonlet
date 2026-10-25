//! Where a design's files are (X65), whichever kind it is: one address the
//! store reads and writes every design through. A workspace design is
//! `~/.moonlet/design/<workspace>/designs/<slug>/`, its comments and history
//! in that same folder. Every path is resolved inside [`DesignAt::root`] as a
//! handle, so no read or write reaches outside it, or through a link.

use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use moonlet_proto::types::DesignKind;

use super::store::Store;

/// One design's folders, found once: what every design RPC works on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesignAt {
    /// The folder every path is resolved inside, as a handle: the
    /// workspace's designs folder.
    pub root: PathBuf,
    /// The design's own folder in `root`: `design.toml`, `pages/` and
    /// `assets/`.
    pub dir: PathBuf,
    /// Its comments and history in `root`: `comments.json` and `history/`.
    pub side: PathBuf,
    pub slug: String,
    pub kind: DesignKind,
    /// The workspace whose live design system a workspace design reads.
    pub workspace: Option<String>,
    /// The session whose worktree holds a session design.
    pub session: Option<String>,
    /// The design's key in the daemon's maps and locks, unique among every
    /// design and design system.
    pub key: String,
}

impl DesignAt {
    /// The design's own folder.
    pub fn folder(&self) -> PathBuf {
        self.root.join(&self.dir)
    }

    /// `rel` (`pages/index.html`) in the design's own folder, in `root`.
    pub fn in_dir(&self, rel: impl AsRef<Path>) -> PathBuf {
        self.dir.join(rel)
    }

    /// `rel` (`comments.json`) in its comments and history folder, in `root`.
    pub fn in_side(&self, rel: impl AsRef<Path>) -> PathBuf {
        self.side.join(rel)
    }
}

impl Store {
    /// A workspace design (X65), which must exist: `designs/<slug>/` with
    /// its own `design.toml`, never through a link.
    pub fn workspace_design(&self, workspace: &str, slug: &str) -> Result<DesignAt> {
        self.design_dir(workspace, slug)?;
        Ok(DesignAt {
            root: self.designs_dir(workspace, false)?,
            dir: PathBuf::from(slug),
            side: PathBuf::from(slug),
            slug: slug.to_string(),
            kind: DesignKind::Workspace,
            workspace: Some(workspace.to_string()),
            session: None,
            key: format!("w/{workspace}/{slug}"),
        })
    }
}

/// A design's slug: one folder name, never a snapshot's (`<slug>@<n>`).
pub(super) fn check_slug(slug: &str) -> Result<()> {
    if !super::store::is_name(slug) || slug.contains('@') {
        bail!("bad design \"{slug}\"");
    }
    Ok(())
}
