//! Design systems and workspace designs on every member (X71): each item's
//! folder as a git tree, so the owner can send what changed and every other
//! member can keep a read-only copy. The trees live in a repository of
//! moonlet's own, `~/.moonlet/design/.store`, and every member that holds
//! the same folder gets the same tree id.
//!
//! Which tree each folder holds is the daemon's to keep (X71).
//!
//! A snapshot's tree has the item's files under `files/` and, for a design
//! system, the part of its record that means the same on every member as
//! `record.toml`. Hidden files and folders (`.cache/`, `.claude/`) and
//! links are left out.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use moonlet_proto::types::ProjectIdentity;

use super::store::Store;

/// What kind of item a key names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Kind {
    System,
    Design,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::System => "system",
            Kind::Design => "design",
        }
    }

    /// The folder of the workspace's design folder its items are in.
    pub fn folder(self) -> &'static str {
        match self {
            Kind::System => "systems",
            Kind::Design => "designs",
        }
    }
}

/// One design system or workspace design of a workspace.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Item {
    pub workspace: String,
    pub kind: Kind,
    pub slug: String,
}

impl Item {
    pub fn system(workspace: &str, slug: &str) -> Item {
        Item {
            workspace: workspace.into(),
            kind: Kind::System,
            slug: slug.into(),
        }
    }

    pub fn design(workspace: &str, slug: &str) -> Item {
        Item {
            workspace: workspace.into(),
            kind: Kind::Design,
            slug: slug.into(),
        }
    }
}

/// The trees of one moonlet home's items.
#[derive(Clone)]
pub struct Replicas {
    store: Store,
    repo: PathBuf,
}

impl Replicas {
    pub fn new(home: &Path) -> Replicas {
        Replicas {
            store: Store::new(home),
            repo: home.join("design").join(".store"),
        }
    }

    /// The item's folder; it must be there, and not a link.
    pub fn dir(&self, item: &Item) -> Result<PathBuf> {
        if !super::store::is_name(&item.slug) {
            bail!("bad {} \"{}\"", item.kind.as_str(), item.slug);
        }
        let dir = self
            .store
            .kind_dir(&item.workspace, item.kind.folder(), false)?
            .join(&item.slug);
        if !std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
            bail!("no {} \"{}\"", item.kind.as_str(), item.slug);
        }
        Ok(dir)
    }

    /// The files a snapshot of the item holds, by their path in its tree.
    fn contents(&self, item: &Item) -> Result<BTreeMap<String, Vec<u8>>> {
        let dir = self.dir(item)?;
        let root = self.store.root()?.to_path_buf();
        let rel = dir.strip_prefix(&root)?.to_path_buf();
        let mut out = BTreeMap::new();
        for (path, mut bytes) in super::fsx::read_tree(&root, &rel)? {
            if item.kind == Kind::Design && path == super::designs::DESIGN_FILE {
                bytes = without_session(bytes)?;
            }
            out.insert(format!("files/{path}"), bytes);
        }
        if item.kind == Kind::System {
            let record = self.store.record(&item.workspace, &item.slug)?;
            out.insert(
                RECORD.into(),
                toml::to_string(&Portable::of(&record))?.into_bytes(),
            );
        }
        Ok(out)
    }

    /// Writes the item's folder as a tree and gives its id.
    pub async fn snapshot(&self, item: &Item) -> Result<String> {
        let contents = {
            let (me, item) = (self.clone(), item.clone());
            tokio::task::spawn_blocking(move || me.contents(&item)).await??
        };
        self.init().await?;
        let oids: BTreeMap<&String, String> =
            contents.iter().map(|(p, b)| (p, blob_id(b))).collect();
        let wanted: Vec<String> = oids
            .values()
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let have: BTreeSet<String> = crate::sync::present(&self.repo, &wanted)
            .await?
            .into_iter()
            .collect();
        let mut files = crate::sync::Files::new();
        for (path, bytes) in &contents {
            let oid = &oids[path];
            if !have.contains(oid) {
                let written = crate::sync::hash_bytes(&self.repo, bytes).await?;
                if &written != oid {
                    bail!("git stored {path} as {written}, not {oid}");
                }
            }
            files.insert(
                path.clone(),
                crate::sync::Entry {
                    mode: "100644".into(),
                    oid: oid.clone(),
                },
            );
        }
        crate::sync::write_files(&self.repo, &files).await
    }

    /// The files of tree `tree`, by their path in it.
    pub async fn files(&self, tree: &str) -> Result<BTreeMap<String, Vec<u8>>> {
        if !crate::sync::is_object_id(tree) {
            bail!("not an object id: {tree:?}");
        }
        let entries = crate::sync::read_files(&self.repo, tree).await?;
        let mut input = String::new();
        for e in entries.values() {
            input.push_str(&e.oid);
            input.push('\n');
        }
        let out = crate::sync::git_env(
            &self.repo,
            &[],
            &["cat-file", "--batch"],
            Some(input.as_bytes()),
        )
        .await?;
        let mut blobs = parse_batch(&out)?.into_iter();
        let mut files = BTreeMap::new();
        for (path, e) in entries {
            let (oid, bytes) = blobs.next().context("git gave fewer objects than asked")?;
            if oid != e.oid {
                bail!("git gave {oid} for {path}, not {}", e.oid);
            }
            files.insert(path, bytes);
        }
        Ok(files)
    }

    /// A pack of the objects of `tree` that a member holding the trees
    /// `have` lacks.
    pub async fn pack(&self, tree: &str, have: &[String]) -> Result<Vec<u8>> {
        let have = crate::sync::present(&self.repo, have).await?;
        let have: Vec<&str> = have.iter().map(String::as_str).collect();
        crate::sync::pack_objects(&self.repo, &[tree], &have).await
    }

    /// Stores a pack from another member, once `tree` in it is one a copy
    /// may be made from.
    pub async fn accept(&self, pack: &[u8], tree: &str) -> Result<()> {
        if pack.len() as u64 > MAX_BYTES {
            bail!(
                "a pack of {} bytes is more than a design may hold",
                pack.len()
            );
        }
        self.init().await?;
        // Checked in a repository of its own first, which reads the store's
        // objects for the pack's deltas: a refused tree leaves nothing here.
        let quarantine = self
            .repo
            .join("quarantine")
            .join(uuid::Uuid::new_v4().to_string());
        let checked = async {
            std::fs::create_dir_all(&quarantine)?;
            let q = quarantine.to_string_lossy().into_owned();
            crate::sync::git_env(
                &self.repo,
                &[],
                &["init", "-q", "--bare", "--object-format=sha1", &q],
                None,
            )
            .await?;
            std::fs::write(
                quarantine.join("objects/info/alternates"),
                format!("{}\n", self.repo.join("objects").display()),
            )?;
            crate::sync::unpack(&quarantine, pack).await?;
            check_in(&quarantine, tree).await
        }
        .await;
        // Only what the checked tree reaches goes to the store, never
        // other objects the pack carried along.
        let reached = match checked {
            Ok(()) => crate::sync::pack_objects(&quarantine, &[tree], &[]).await,
            Err(e) => Err(e),
        };
        let _ = std::fs::remove_dir_all(&quarantine);
        crate::sync::unpack(&self.repo, &reached?).await?;
        Ok(())
    }

    /// Refuses a tree a copy may not be made from: anything but files under
    /// `files/` and `record.toml`, a link or submodule, a hidden file or
    /// folder (`.claude/` would give an agent settings), a path that leaves
    /// its folder, a missing object, or more than [`MAX_BYTES`] in all.
    pub async fn check(&self, tree: &str) -> Result<()> {
        check_in(&self.repo, tree).await
    }

    /// Replaces the item's folder with tree `tree`, in one step. A design
    /// system's sources are the projects `locate` finds by identity.
    pub async fn apply(&self, item: &Item, tree: &str, locate: &Locate<'_>) -> Result<()> {
        if !super::store::is_name(&item.slug) || item.slug.starts_with('.') {
            bail!("bad {} \"{}\"", item.kind.as_str(), item.slug);
        }
        self.check(tree).await?;
        let mut files = self.files(tree).await?;
        let record = match files.remove(RECORD) {
            Some(bytes) if item.kind == Kind::System => {
                let p: Portable = toml::from_str(&String::from_utf8_lossy(&bytes))
                    .context("cannot read record.toml")?;
                for sub in p.sources.iter().filter_map(|s| s.subdir.as_deref()) {
                    let plain = Path::new(sub)
                        .components()
                        .all(|c| matches!(c, std::path::Component::Normal(_)));
                    if sub.is_empty() || !plain {
                        bail!("{sub} is not a folder inside its project");
                    }
                }
                Some(p.locate(locate))
            }
            _ => None,
        };
        let files: BTreeMap<String, Vec<u8>> = files
            .into_iter()
            .filter_map(|(path, bytes)| Some((path.strip_prefix("files/")?.to_string(), bytes)))
            .collect();
        let (me, item2) = (self.clone(), item.clone());
        tokio::task::spawn_blocking(move || me.put(&item2, &files, record.as_ref())).await?
    }

    /// Puts `files` in place of the item's folder: written beside it first,
    /// then swapped in, so a reader sees the old folder or the new one.
    fn put(
        &self,
        item: &Item,
        files: &BTreeMap<String, Vec<u8>>,
        record: Option<&super::store::Record>,
    ) -> Result<()> {
        let root = self.store.root()?.to_path_buf();
        let target = self
            .store
            .kind_dir(&item.workspace, item.kind.folder(), true)?
            .join(&item.slug);
        super::store::not_a_link(&target)?;
        let incoming = self.repo.join("incoming");
        std::fs::create_dir_all(&incoming)?;
        let name = uuid::Uuid::new_v4().to_string();
        let staged = incoming.join(&name);
        let base = incoming.strip_prefix(&root)?;
        super::fsx::write_tree(&root, base, Path::new(&name), files, true)?;
        if std::fs::symlink_metadata(&target).is_err() {
            super::fsx::rename_inside(&root, &staged, &target)?;
        } else if super::fsx::swap_inside(
            &root,
            staged.strip_prefix(&root)?,
            target.strip_prefix(&root)?,
        )? {
            super::fsx::remove_dir_inside(&root, &staged)?;
        } else {
            let old = incoming.join(format!("{name}-old"));
            super::fsx::rename_inside(&root, &target, &old)?;
            super::fsx::rename_inside(&root, &staged, &target)?;
            super::fsx::remove_dir_inside(&root, &old)?;
        }
        if let Some(record) = record {
            self.store
                .write_record(&item.workspace, &item.slug, record)?;
        }
        Ok(())
    }

    /// Makes the repository when it is not there yet.
    async fn init(&self) -> Result<()> {
        if self.repo.join("HEAD").exists() {
            return Ok(());
        }
        let parent = self.store.root()?.to_path_buf();
        let repo = self.repo.to_string_lossy().into_owned();
        crate::sync::git_env(
            &parent,
            &[],
            &["init", "-q", "--bare", "--object-format=sha1", &repo],
            None,
        )
        .await
        .context("cannot make the design store's repository")?;
        Ok(())
    }
}

/// This member's project with a given identity: its id and folder.
pub type Locate<'a> = dyn Fn(&ProjectIdentity) -> Option<(String, String)> + Send + Sync + 'a;

/// The most a design's files may hold in all: 256 MiB.
pub const MAX_BYTES: u64 = 256 * 1024 * 1024;

/// [`Replicas::check`]'s rules, in repository `repo`.
async fn check_in(repo: &Path, tree: &str) -> Result<()> {
    if !crate::sync::is_object_id(tree) {
        bail!("not an object id: {tree:?}");
    }
    let entries = crate::sync::read_files(repo, tree).await?;
    if let Some(path) = crate::sync::unsafe_path(&entries) {
        bail!("a path outside its folder: {path}");
    }
    for (path, e) in &entries {
        if e.mode != "100644" && e.mode != "100755" {
            bail!("{path} is not a file");
        }
        if path != RECORD && !path.starts_with("files/") {
            bail!("{path} is not a design file");
        }
        if path
            .split('/')
            .any(|part| part.starts_with('.') || part.is_empty())
        {
            bail!("{path} is hidden");
        }
        // Read by an agent working in the folder after Move here.
        let name = path.rsplit('/').next().unwrap_or_default().to_lowercase();
        if name.ends_with(".md") && (name.starts_with("claude") || name.starts_with("agents")) {
            bail!("{path} would instruct an agent");
        }
    }
    let input: String = entries.values().map(|e| format!("{}\n", e.oid)).collect();
    let out = crate::sync::git_env(
        repo,
        &[],
        &[
            "cat-file",
            "--batch-check=%(objectname) %(objecttype) %(objectsize)",
        ],
        Some(input.as_bytes()),
    )
    .await?;
    let mut total: u64 = 0;
    for line in String::from_utf8_lossy(&out).lines() {
        let mut parts = line.split(' ');
        match (parts.next(), parts.next(), parts.next()) {
            (Some(_), Some("blob"), Some(size)) => total += size.parse::<u64>()?,
            _ => bail!("a file of the tree is missing: {line}"),
        }
    }
    if total > MAX_BYTES {
        bail!("{total} bytes is more than a design may hold ({MAX_BYTES})");
    }
    Ok(())
}

/// Where a design system's portable record goes in its tree.
const RECORD: &str = "record.toml";

/// A source of a design system as every member reads it: which project,
/// never where it is on one Mac.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortableSource {
    #[serde(default)]
    pub identity: ProjectIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subdir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

/// The part of a design system's record that means the same on every
/// member: never a folder, a project id, an agent or a sync in flight.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Portable {
    #[serde(default)]
    pub sources: Vec<PortableSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synced_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub last_sync: Vec<super::store::SyncChange>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub kept: BTreeSet<String>,
}

impl Portable {
    pub fn of(record: &super::store::Record) -> Portable {
        Portable {
            sources: record
                .sources
                .iter()
                .map(|s| PortableSource {
                    identity: s.identity.clone(),
                    subdir: s.subdir.clone(),
                    commit: s.commit.clone(),
                })
                .collect(),
            synced_at: record.synced_at,
            last_sync: record.last_sync.clone(),
            kept: record.kept.clone(),
        }
    }
}

impl Portable {
    /// The record a copy keeps: each source as this member's project with
    /// its identity, or with no folder when it has none.
    pub fn locate(&self, locate: &Locate<'_>) -> super::store::Record {
        super::store::Record {
            sources: self
                .sources
                .iter()
                .map(|s| {
                    let (project, path) = locate(&s.identity).unwrap_or_default();
                    super::store::Source {
                        project,
                        path,
                        identity: s.identity.clone(),
                        subdir: s.subdir.clone(),
                        commit: s.commit.clone(),
                    }
                })
                .collect(),
            synced_at: self.synced_at,
            last_sync: self.last_sync.clone(),
            kept: self.kept.clone(),
            ..Default::default()
        }
    }
}

/// `design.toml` without the session it was built in, which names a
/// session of one member only.
fn without_session(bytes: Vec<u8>) -> Result<Vec<u8>> {
    let mut config: super::designs::DesignConfig =
        toml::from_str(&String::from_utf8_lossy(&bytes)).context("cannot read design.toml")?;
    if config.session.take().is_none() {
        return Ok(bytes);
    }
    Ok(toml::to_string(&config)?.into_bytes())
}

/// The objects of `git cat-file --batch` output: for each, a line
/// `<oid> <type> <size>`, its bytes and a newline.
fn parse_batch(mut out: &[u8]) -> Result<Vec<(String, Vec<u8>)>> {
    let mut objects = Vec::new();
    while !out.is_empty() {
        let end = out
            .iter()
            .position(|b| *b == b'\n')
            .context("a cut-off cat-file header")?;
        let header = std::str::from_utf8(&out[..end])?;
        let mut parts = header.split(' ');
        let (Some(oid), Some(kind), Some(size)) = (parts.next(), parts.next(), parts.next()) else {
            bail!("unexpected cat-file header {header:?}");
        };
        if kind != "blob" {
            bail!("{oid} is a {kind}, not a file");
        }
        let size: usize = size.parse()?;
        let body = out
            .get(end + 1..end + 1 + size)
            .context("a cut-off object")?;
        objects.push((oid.to_string(), body.to_vec()));
        out = out.get(end + 2 + size..).unwrap_or_default();
    }
    Ok(objects)
}

/// The id git gives `bytes` as a blob (SHA-1).
fn blob_id(bytes: &[u8]) -> String {
    use sha1::{Digest, Sha1};
    let mut h = Sha1::new();
    h.update(format!("blob {}\0", bytes.len()).as_bytes());
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// "Acme web" with a token file, as the sync agent leaves it, and the
    /// hidden folders moonlet and Claude Code keep in it.
    fn acme(home: &Path) -> PathBuf {
        let dir = home.join("design/w-acme/systems/acme-web");
        write(&dir, "config.toml", "name = \"Acme web\"\ncreated_at = 1\n");
        write(&dir, "styles.css", "@import \"tokens/colors.css\";\n");
        write(&dir, "tokens/colors.css", ":root { --brand: #0a66ff; }\n");
        write(&dir, ".cache/progress.toml", "step = \"cards\"\n");
        write(
            &dir,
            ".claude/settings.json",
            "{\"permissions\":{\"allow\":[\"Bash\"]}}\n",
        );
        dir
    }

    // The ids were worked out with git itself: `git hash-object -w` for
    // each file, then `git mktree` for each folder.
    #[tokio::test]
    async fn a_design_systems_snapshot_is_its_files_and_its_record_without_hidden_folders() {
        let home = tempfile::tempdir().unwrap();
        acme(home.path());
        let replicas = Replicas::new(home.path());
        assert_eq!(
            replicas
                .snapshot(&Item::system("w-acme", "acme-web"))
                .await
                .unwrap(),
            "06441c7ba8234cb1db38b4de7e2351bbced1745d"
        );
    }

    fn source() -> crate::design::store::Source {
        crate::design::store::Source {
            project: "p-acme".into(),
            path: "/Users/alex/Workspace/acme-web".into(),
            identity: ProjectIdentity {
                origin: Some("github.com/acme/acme-web".into()),
                root: Some("4f2a91c".into()),
            },
            subdir: Some("apps/web".into()),
            commit: Some("b7e01d2".into()),
        }
    }

    #[tokio::test]
    async fn a_snapshots_record_names_its_sources_by_identity_never_by_folder() {
        let home = tempfile::tempdir().unwrap();
        let store = Store::new(home.path());
        store
            .create_system(
                "w-acme",
                "Acme web",
                vec![source()],
                crate::design::store::Cover::Core,
                1,
            )
            .unwrap();
        let replicas = Replicas::new(home.path());
        let tree = replicas
            .snapshot(&Item::system("w-acme", "acme-web"))
            .await
            .unwrap();
        let files = replicas.files(&tree).await.unwrap();
        assert_eq!(
            String::from_utf8(files["record.toml"].clone()).unwrap(),
            "[[sources]]\nsubdir = \"apps/web\"\ncommit = \"b7e01d2\"\n\n[sources.identity]\norigin = \"github.com/acme/acme-web\"\nroot = \"4f2a91c\"\n"
        );
    }

    #[tokio::test]
    async fn a_copy_on_another_member_is_the_owners_folder_with_its_own_clones_as_sources() {
        let (mini, book) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        acme(mini.path());
        std::fs::create_dir_all(mini.path().join("design/w-acme/.records")).unwrap();
        std::fs::write(
            mini.path().join("design/w-acme/.records/acme-web.toml"),
            toml::to_string(&crate::design::store::Record {
                sources: vec![source()],
                synced_at: Some(7),
                ..Default::default()
            })
            .unwrap(),
        )
        .unwrap();
        let item = Item::system("w-acme", "acme-web");
        let owner = Replicas::new(mini.path());
        let tree = owner.snapshot(&item).await.unwrap();

        // The MacBook had an older copy, with a card since removed.
        let old = book.path().join("design/w-acme/systems/acme-web");
        write(&old, "config.toml", "name = \"Acme web\"\ncreated_at = 1\n");
        write(&old, "components/old/Old.html", "<div>old</div>\n");
        let copy = Replicas::new(book.path());
        copy.accept(&owner.pack(&tree, &[]).await.unwrap(), &tree)
            .await
            .unwrap();
        copy.apply(&item, &tree, &|id: &ProjectIdentity| {
            (id.origin.as_deref() == Some("github.com/acme/acme-web")).then(|| {
                (
                    "p-book-acme".to_string(),
                    "/Users/sam/code/acme-web".to_string(),
                )
            })
        })
        .await
        .unwrap();

        let read = |root: &Path| {
            let mut out: Vec<String> = walk(root);
            out.sort();
            out
        };
        assert_eq!(
            read(&old),
            ["config.toml", "styles.css", "tokens/colors.css"]
        );
        assert_eq!(
            std::fs::read_to_string(old.join("tokens/colors.css")).unwrap(),
            ":root { --brand: #0a66ff; }\n"
        );
        let record = Store::new(book.path())
            .record("w-acme", "acme-web")
            .unwrap();
        assert_eq!(
            record.sources,
            vec![crate::design::store::Source {
                project: "p-book-acme".into(),
                path: "/Users/sam/code/acme-web".into(),
                ..source()
            }]
        );
        assert_eq!(record.synced_at, Some(7));
        // The copy is the same tree as the owner's folder.
        assert_eq!(copy.snapshot(&item).await.unwrap(), tree);
    }

    /// A tree made by hand in `replicas`' repository from `entries`
    /// (`<mode> <path>`, each holding `text`), as a hostile member could.
    async fn tree_of(replicas: &Replicas, entries: &[(&str, &str)]) -> String {
        replicas.init().await.unwrap();
        let blob = crate::sync::hash_bytes(&replicas.repo, b"text\n")
            .await
            .unwrap();
        let files: crate::sync::Files = entries
            .iter()
            .map(|(mode, path)| {
                (
                    path.to_string(),
                    crate::sync::Entry {
                        mode: mode.to_string(),
                        oid: blob.clone(),
                    },
                )
            })
            .collect();
        crate::sync::write_files(&replicas.repo, &files)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_tree_with_agent_settings_a_link_or_a_file_outside_files_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let replicas = Replicas::new(home.path());
        let fine = tree_of(
            &replicas,
            &[("100644", "files/config.toml"), ("100644", "record.toml")],
        )
        .await;
        replicas.check(&fine).await.unwrap();
        for (entries, why) in [
            (
                vec![("100644", "files/.claude/settings.json")],
                "files/.claude/settings.json is hidden",
            ),
            (
                vec![("120000", "files/styles.css")],
                "files/styles.css is not a file",
            ),
            (vec![("100644", "run.sh")], "run.sh is not a design file"),
            (
                vec![("100644", "files/CLAUDE.md")],
                "files/CLAUDE.md would instruct an agent",
            ),
            (
                vec![("100644", "files/components/agents.md")],
                "files/components/agents.md would instruct an agent",
            ),
            (
                vec![("100644", "files/AGENTS.override.md")],
                "files/AGENTS.override.md would instruct an agent",
            ),
        ] {
            let tree = tree_of(&replicas, &entries).await;
            let err = replicas.check(&tree).await.unwrap_err();
            assert_eq!(format!("{err:#}"), why);
        }
    }

    #[tokio::test]
    async fn a_designs_snapshot_leaves_out_the_session_it_was_built_in() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("design/w-acme/designs/checkout");
        write(
            &dir,
            "design.toml",
            "name = \"Checkout\"\nsystem = \"acme-web\"\nsession = \"s-7f3a\"\n",
        );
        write(&dir, "pages/index.html", "<main>Pay</main>\n");
        write(&dir, "comments.json", "[]\n");
        let replicas = Replicas::new(home.path());
        let tree = replicas
            .snapshot(&Item::design("w-acme", "checkout"))
            .await
            .unwrap();
        let files = replicas.files(&tree).await.unwrap();
        assert_eq!(
            files.keys().cloned().collect::<Vec<_>>(),
            [
                "files/comments.json",
                "files/design.toml",
                "files/pages/index.html"
            ]
        );
        assert_eq!(
            String::from_utf8(files["files/design.toml"].clone()).unwrap(),
            "name = \"Checkout\"\nsystem = \"acme-web\"\nbrief = \"\"\nviewport = \"1440x900\"\ncreated_at = 0\n"
        );
    }

    #[tokio::test]
    async fn a_pack_whose_tree_is_refused_leaves_nothing_in_the_store() {
        let (mini, book) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let hostile = Replicas::new(mini.path());
        let tree = tree_of(&hostile, &[("100644", "files/.claude/settings.json")]).await;
        let pack = hostile.pack(&tree, &[]).await.unwrap();
        let copy = Replicas::new(book.path());
        assert!(copy.accept(&pack, &tree).await.is_err());
        assert_eq!(
            crate::sync::present(&copy.repo, &[tree]).await.unwrap(),
            Vec::<String>::new()
        );
    }

    #[tokio::test]
    async fn only_the_objects_of_the_accepted_tree_reach_the_store() {
        let (mini, book) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let owner = Replicas::new(mini.path());
        let tree = tree_of(&owner, &[("100644", "files/config.toml")]).await;
        // A second tree the pack carries along, which no copy asked for.
        let stray = tree_of(&owner, &[("100644", "files/other.toml")]).await;
        let pack = crate::sync::pack_objects(&owner.repo, &[&tree, &stray], &[])
            .await
            .unwrap();
        let copy = Replicas::new(book.path());
        copy.accept(&pack, &tree).await.unwrap();
        assert_eq!(
            crate::sync::present(&copy.repo, &[tree.clone()])
                .await
                .unwrap(),
            vec![tree]
        );
        assert_eq!(
            crate::sync::present(&copy.repo, &[stray]).await.unwrap(),
            Vec::<String>::new()
        );
    }

    #[tokio::test]
    async fn a_copy_refuses_a_bad_slug_and_a_source_folder_outside_its_project() {
        let (mini, book) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        acme(mini.path());
        std::fs::create_dir_all(mini.path().join("design/w-acme/.records")).unwrap();
        let escaping = crate::design::store::Source {
            subdir: Some("../../.ssh".into()),
            ..source()
        };
        std::fs::write(
            mini.path().join("design/w-acme/.records/acme-web.toml"),
            toml::to_string(&crate::design::store::Record {
                sources: vec![escaping],
                ..Default::default()
            })
            .unwrap(),
        )
        .unwrap();
        let owner = Replicas::new(mini.path());
        let tree = owner
            .snapshot(&Item::system("w-acme", "acme-web"))
            .await
            .unwrap();
        let copy = Replicas::new(book.path());
        copy.accept(&owner.pack(&tree, &[]).await.unwrap(), &tree)
            .await
            .unwrap();
        let none = |_: &ProjectIdentity| None;
        let err = copy
            .apply(&Item::system("w-acme", "acme-web"), &tree, &none)
            .await
            .unwrap_err();
        assert_eq!(
            format!("{err:#}"),
            "../../.ssh is not a folder inside its project"
        );
        for slug in ["..", ".store", "a/b"] {
            assert!(
                copy.apply(&Item::system("w-acme", slug), &tree, &none)
                    .await
                    .is_err(),
                "{slug}"
            );
        }
        assert!(!book.path().join("design/w-acme/systems/acme-web").exists());
    }

    /// Every file under `root`, hidden ones too, by its path in it.
    fn walk(root: &Path) -> Vec<String> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(root).unwrap().flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.file_type().unwrap().is_dir() {
                out.extend(walk(&e.path()).into_iter().map(|p| format!("{name}/{p}")));
            } else {
                out.push(name);
            }
        }
        out
    }
}
