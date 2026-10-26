//! Where a design's files are (X65), whichever kind it is: one address the
//! store reads and writes every design through. A workspace design is
//! `~/.moonlet/design/<workspace>/designs/<slug>/`, its comments and history
//! in that same folder; a session design is in its session's worktree (see
//! `session.rs`). Every path is resolved inside [`DesignAt::root`] as a
//! handle, so no read or write reaches outside it, or through a link.

use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use moonlet_proto::types::DesignKind;

use super::store::Store;

/// Whose a design is: a workspace's, with its own agent and the live design
/// system, or a session's, in its worktree, written by the session's agent
/// from its own copies of the system.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Place {
    Workspace(String),
    Session(String),
}

/// One design's folders, found once: what every design RPC works on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesignAt {
    /// The folder every path is resolved inside, as a handle: the
    /// workspace's designs folder, or the session's worktree.
    pub root: PathBuf,
    /// The design's own folder in `root`: `design.toml`, `pages/` and
    /// `assets/`.
    pub dir: PathBuf,
    /// Its comments and history in `root`: `comments.json` and `history/`.
    pub side: PathBuf,
    pub slug: String,
    pub place: Place,
}

impl DesignAt {
    /// A workspace design: `<slug>/` in the workspace's designs folder
    /// `designs`, its comments and history in it too.
    pub(super) fn of_workspace(designs: PathBuf, workspace: &str, slug: &str) -> Self {
        DesignAt {
            root: designs,
            dir: PathBuf::from(slug),
            side: PathBuf::from(slug),
            slug: slug.to_string(),
            place: Place::Workspace(workspace.to_string()),
        }
    }

    /// A session design: `<folder>/<slug>/` in the session's worktree, its
    /// comments and history in `<side>/<slug>/`.
    pub(super) fn of_session(
        worktree: &Path,
        folder: &str,
        side: &str,
        session: &str,
        slug: &str,
    ) -> Self {
        DesignAt {
            root: worktree.to_path_buf(),
            dir: Path::new(folder).join(slug),
            side: Path::new(side).join(slug),
            slug: slug.to_string(),
            place: Place::Session(session.to_string()),
        }
    }

    /// Where it lives, as `design.list` names it.
    pub fn kind(&self) -> DesignKind {
        match self.place {
            Place::Workspace(_) => DesignKind::Workspace,
            Place::Session(_) => DesignKind::Session,
        }
    }

    /// The design's key in the daemon's maps and locks, unique among every
    /// design and design system: `w/<workspace>/<slug>` or
    /// `s/<session>/<slug>`.
    pub fn key(&self) -> String {
        match &self.place {
            Place::Workspace(w) => format!("w/{w}/{}", self.slug),
            Place::Session(s) => format!("s/{s}/{}", self.slug),
        }
    }

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
        // `<slug>@<n>` names a snapshot's folder (X65), never a design.
        check_slug(slug)?;
        let designs = self.designs_dir(workspace, false)?;
        let dir = designs.join(slug);
        super::store::not_a_link(&dir)?;
        // Its own file: a link, which would take reads elsewhere, is not one.
        if !std::fs::symlink_metadata(dir.join(super::designs::DESIGN_FILE))
            .is_ok_and(|m| m.is_file())
        {
            bail!("no design \"{slug}\"");
        }
        Ok(DesignAt::of_workspace(designs, workspace, slug))
    }
}

/// A design's slug: one folder name, never a snapshot's (`<slug>@<n>`).
pub(super) fn check_slug(slug: &str) -> Result<()> {
    if !super::store::is_name(slug) || slug.contains('@') {
        bail!("bad design \"{slug}\"");
    }
    Ok(())
}
