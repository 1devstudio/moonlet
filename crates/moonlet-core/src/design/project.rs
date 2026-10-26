//! Project designs (X65): session designs merged into a project's base
//! branch, found under its design folder (`docs/design/*/design.toml` by
//! default) from git's objects, never checked out. They are read only; a
//! new workspace design can start from one (`design.copy`).

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result, bail};
use moonlet_proto::types::{DesignInfo, DesignKind, DesignPage};

use super::designs::{DESIGN_FILE, DesignConfig};
use super::store::Store;
use crate::git;

/// A project design asked for that the base branch does not have.
#[derive(Debug, thiserror::Error)]
#[error("no design at {path} on {base}")]
pub struct NoProjectDesign {
    pub path: String,
    pub base: String,
}

/// One design in a listing of the base branch's tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeDesign {
    pub slug: String,
    /// Its folder in the repository, `<design dir>/<slug>`.
    pub path: String,
    /// Each file of it by its path in the design's folder
    /// (`pages/index.html`), with its blob's id. Files only: a link or a
    /// submodule is left out.
    pub files: BTreeMap<String, String>,
}

/// The designs in `git ls-tree -r -z --full-tree <base> -- <dir>`'s
/// output: the folders right under `dir` that hold a `design.toml`.
pub fn tree_designs(ls_tree: &str, dir: &str) -> Vec<TreeDesign> {
    let prefix = format!("{}/", dir.trim_end_matches('/'));
    // Each folder right under `dir`, with its files.
    let mut folders: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for entry in ls_tree.split('\0') {
        // `<mode> <type> <id>\t<path>`
        let Some((meta, path)) = entry.split_once('\t') else {
            continue;
        };
        let mut meta = meta.split(' ');
        let (Some(mode), Some("blob"), Some(id)) = (meta.next(), meta.next(), meta.next()) else {
            continue;
        };
        // A file, plain or executable: never a link's target path.
        if mode != "100644" && mode != "100755" {
            continue;
        }
        let Some((slug, rel)) = path.strip_prefix(&prefix).and_then(|r| r.split_once('/')) else {
            continue;
        };
        let plain = |p: &str| !p.is_empty() && p != "." && p != "..";
        if !plain(slug) || slug.contains('@') || !rel.split('/').all(plain) {
            continue;
        }
        folders
            .entry(slug.to_string())
            .or_default()
            .insert(rel.to_string(), id.to_string());
    }
    folders
        .into_iter()
        .filter(|(_, files)| files.contains_key(super::designs::DESIGN_FILE))
        .map(|(slug, files)| TreeDesign {
            path: format!("{prefix}{slug}"),
            slug,
            files,
        })
        .collect()
}

/// A base branch name git takes as a revision, never as an option.
fn check_base(base: &str) -> Result<()> {
    if base.is_empty() || base.starts_with('-') || base.contains("..") {
        bail!("bad base branch {base:?}");
    }
    Ok(())
}

/// `git ls-tree` of `path` on the branch `base` of the repository at `repo`.
async fn ls_tree(repo: &Path, base: &str, path: &str) -> Result<String> {
    check_base(base)?;
    let out = git::git(
        repo,
        &["ls-tree", "-r", "-z", "--full-tree", base, "--", path],
    )
    .await?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// A blob's bytes.
async fn blob(repo: &Path, id: &str) -> Result<Vec<u8>> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("bad blob id {id:?}");
    }
    git::git(repo, &["cat-file", "blob", id]).await
}

/// The project `project`'s designs on its base branch `base`, in its
/// design folder `dir`, read from git's objects (X65). One whose
/// `design.toml` cannot be read lists with its error.
pub async fn project_designs(
    repo: &Path,
    base: &str,
    dir: &str,
    project: &str,
) -> Result<Vec<DesignInfo>> {
    let mut out = Vec::new();
    for design in tree_designs(&ls_tree(repo, base, dir).await?, dir) {
        let id = &design.files[DESIGN_FILE];
        let config = blob(repo, id).await.and_then(|bytes| {
            toml::from_str::<DesignConfig>(&String::from_utf8_lossy(&bytes))
                .with_context(|| format!("cannot read {DESIGN_FILE}"))
        });
        let pages = super::history::page_names(design.files.keys());
        let (name, system, brief, viewport, labels, error) = match config {
            Ok(c) => (c.name, c.system, c.brief, c.viewport, c.pages, None),
            Err(e) => (
                design.slug.clone(),
                String::new(),
                String::new(),
                String::new(),
                BTreeMap::new(),
                Some(format!("{e:#}")),
            ),
        };
        out.push(DesignInfo {
            slug: design.slug,
            name,
            kind: DesignKind::Project,
            system,
            path: design.path,
            brief,
            viewport,
            pages: pages
                .into_iter()
                .map(|name| DesignPage {
                    label: labels
                        .get(&name)
                        .map(|p| p.label.clone())
                        .filter(|l| !l.is_empty()),
                    name,
                })
                .collect(),
            updated_at: 0,
            open_comments: 0,
            agent: None,
            agent_state: None,
            needs_you: None,
            error,
            session: None,
            project: Some(project.to_string()),
            built_in: None,
            system_updated: false,
        });
    }
    out.sort_by_key(|d| (d.name.to_lowercase(), d.slug.clone()));
    Ok(out)
}

/// A project design as read from git: its `design.toml`, and its pages'
/// and assets' files by their paths in its folder.
pub struct ProjectDesign {
    pub config: DesignConfig,
    pub files: BTreeMap<String, Vec<u8>>,
}

/// Reads the project design at `path` (`docs/design/settings-page`) on the
/// branch `base` of the repository at `repo`, from git's objects.
pub async fn read_project_design(repo: &Path, base: &str, path: &str) -> Result<ProjectDesign> {
    let path = path.trim_end_matches('/');
    let (dir, slug) = path.rsplit_once('/').unwrap_or(("", path));
    let listing = ls_tree(repo, base, path).await?;
    let found = tree_designs(&listing, dir)
        .into_iter()
        .find(|d| d.slug == slug)
        .ok_or_else(|| NoProjectDesign {
            path: path.to_string(),
            base: base.to_string(),
        })?;
    let config: DesignConfig = toml::from_str(&String::from_utf8_lossy(
        &blob(repo, &found.files[DESIGN_FILE]).await?,
    ))
    .with_context(|| format!("cannot read {DESIGN_FILE}"))?;
    let mut files = BTreeMap::new();
    for (rel, id) in &found.files {
        if super::pages::page_of(rel).is_some() || rel.starts_with("assets/") {
            files.insert(rel.clone(), blob(repo, id).await?);
        }
    }
    Ok(ProjectDesign { config, files })
}

impl Store {
    /// A new workspace design named `name` made from a project design
    /// (`design.copy`): its pages, linking the workspace's live design system
    /// again, its labels, viewport, brief and assets. Its design system must
    /// be one the workspace has. Returns its slug.
    pub fn create_from_project(
        &self,
        workspace: &str,
        name: &str,
        from: &ProjectDesign,
        now: u64,
    ) -> Result<String> {
        let system = &from.config.system;
        let slug = self.create_design(workspace, name, system, &from.config.brief, now)?;
        let made = (|| -> Result<()> {
            let at = self.workspace_design(workspace, &slug)?;
            let link = super::designs::styles_link(&at, system);
            let mut assets = BTreeMap::new();
            for (rel, bytes) in &from.files {
                if let Some(page) = super::pages::page_of(rel) {
                    let text = String::from_utf8_lossy(bytes)
                        .replace(super::designs::SESSION_STYLES, &link);
                    let path = at.root.join(at.in_dir(super::pages::page_path(page)?));
                    super::fsx::write_inside(&at.root, &path, text.as_bytes())?;
                } else if let Some(asset) = rel.strip_prefix("assets/") {
                    assets.insert(asset.to_string(), bytes.clone());
                }
            }
            super::fsx::write_tree(&at.root, &at.dir, Path::new("assets"), &assets, false)?;
            super::fsx::update_inside(&at.root, &at.in_dir(DESIGN_FILE), |text| {
                let mut config: DesignConfig = toml::from_str(text)?;
                config.viewport = from.config.viewport.clone();
                config.pages = from.config.pages.clone();
                Ok(toml::to_string(&config)?)
            })
        })();
        if let Err(e) = made {
            if let Ok(at) = self.workspace_design(workspace, &slug) {
                let _ = self.remove_design(&at);
            }
            return Err(e);
        }
        Ok(slug)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `git ls-tree -r -z --full-tree main -- docs/design` of a repository
    /// with two designs, a folder without a `design.toml`, a README, a link
    /// and a page named with a space, captured on 2026-10-25.
    const LS_TREE: &str = "100644 blob f935dfc1e50f82e1d0a6ca1e7a261af032335846\tdocs/design/README.md\0100644 blob a51da316693ac7ee4b0879faba8ea9edd0b3adaa\tdocs/design/drafts/pages/index.html\0100644 blob 4b7175df615c0fc1535e2b022e17c69376aa8131\tdocs/design/onboarding/design.toml\0100644 blob 32cb1c69555245bcae43471939caab61eb9aacd9\tdocs/design/onboarding/pages/index.html\0100644 blob 3e8fcacea683d976f2537bcb307318a6257ef556\tdocs/design/settings-page/assets/logo.svg\0120000 blob b3e266f1221a8e4777caadffe7c4f64c92c3a93b\tdocs/design/settings-page/assets/src-link\0100644 blob a5d9e4cc14d3a08f9ce6409d23e9ecee944a35cf\tdocs/design/settings-page/design.toml\0100644 blob 3dd1ada4b9e82ae0d38e09589760cb87be49f497\tdocs/design/settings-page/pages/git b.html\0100644 blob 76a24b32dcc91ca8879bb93ffe25f3ccdcf182bc\tdocs/design/settings-page/pages/git-a.html\0100644 blob 544775d45df05847a794e4c36082fd26df88aa43\tdocs/design/settings-page/pages/index.html\0100644 blob 01aa1d8d429d554bd7af600b7a13672ffc4df152\tdocs/design/settings-page/system/styles.css\0100644 blob 3db7d72c69a0c05114ccb9ba2a0730f8db9f471b\tdocs/design/settings-page/system/tokens/colors.css\0";

    #[test]
    fn project_designs_are_the_folders_with_a_design_toml_in_a_captured_git_ls_tree_of_the_base_branch()
     {
        let files = |list: &[(&str, &str)]| {
            list.iter()
                .map(|(p, id)| (p.to_string(), id.to_string()))
                .collect::<BTreeMap<_, _>>()
        };
        assert_eq!(
            tree_designs(LS_TREE, "docs/design"),
            vec![
                TreeDesign {
                    slug: "onboarding".into(),
                    path: "docs/design/onboarding".into(),
                    files: files(&[
                        ("design.toml", "4b7175df615c0fc1535e2b022e17c69376aa8131"),
                        (
                            "pages/index.html",
                            "32cb1c69555245bcae43471939caab61eb9aacd9"
                        ),
                    ]),
                },
                TreeDesign {
                    slug: "settings-page".into(),
                    path: "docs/design/settings-page".into(),
                    files: files(&[
                        (
                            "assets/logo.svg",
                            "3e8fcacea683d976f2537bcb307318a6257ef556"
                        ),
                        ("design.toml", "a5d9e4cc14d3a08f9ce6409d23e9ecee944a35cf"),
                        (
                            "pages/git b.html",
                            "3dd1ada4b9e82ae0d38e09589760cb87be49f497"
                        ),
                        (
                            "pages/git-a.html",
                            "76a24b32dcc91ca8879bb93ffe25f3ccdcf182bc"
                        ),
                        (
                            "pages/index.html",
                            "544775d45df05847a794e4c36082fd26df88aa43"
                        ),
                        (
                            "system/styles.css",
                            "01aa1d8d429d554bd7af600b7a13672ffc4df152"
                        ),
                        (
                            "system/tokens/colors.css",
                            "3db7d72c69a0c05114ccb9ba2a0730f8db9f471b"
                        ),
                    ]),
                },
            ]
        );
        // Another folder lists nothing of these, and an empty tree nothing.
        assert_eq!(tree_designs(LS_TREE, "design"), vec![]);
        assert_eq!(tree_designs("", "docs/design"), vec![]);
    }
}
