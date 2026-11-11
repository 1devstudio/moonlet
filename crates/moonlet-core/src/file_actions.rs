//! File actions of the Files tab (X98): create, rename, duplicate and delete
//! an entry inside a session's folder. Every path is checked against the
//! root, and each step goes through directory handles opened from it
//! (`cap-std`), so no action can reach outside the root.

use std::ffi::OsString;
use std::path::{Component, PathBuf};

use anyhow::{Context, Result, bail};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};

use crate::terminal::expand_home;

/// An entry inside the root: the handle of the folder it is in, its name
/// there, and its full path.
struct Entry {
    dir: Dir,
    name: OsString,
    path: PathBuf,
}

/// Finds `path` inside `root`, which it must be strictly inside, with no
/// `..` and no symlink among the folders on the way. The entry itself may be
/// missing, or be a symlink: actions act on the link, never its target.
fn entry(root: &str, path: &str) -> Result<Entry> {
    let root = expand_home(root);
    let path = expand_home(path);
    let outside = || anyhow::anyhow!("{} is outside {}", path.display(), root.display());
    let rel = path.strip_prefix(&root).map_err(|_| outside())?;
    if rel.as_os_str().is_empty() || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(outside());
    }
    let mut dir = Dir::open_ambient_dir(&root, ambient_authority())
        .with_context(|| format!("cannot open {}", root.display()))?;
    let mut parts: Vec<_> = rel.components().map(|c| c.as_os_str().to_owned()).collect();
    let name = parts.pop().context("no name")?;
    let mut at = root.clone();
    for part in parts {
        at.push(&part);
        let meta = dir
            .symlink_metadata(&part)
            .with_context(|| format!("no such folder: {}", at.display()))?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            bail!("{} is not a folder", at.display());
        }
        dir = dir.open_dir(&part)?;
    }
    Ok(Entry { dir, name, path })
}

impl Entry {
    fn exists(&self) -> bool {
        self.dir.symlink_metadata(&self.name).is_ok()
    }

    /// Whether both names are one entry, as `a.md` and `A.md` are on a
    /// Mac's case-insensitive volume.
    fn same_as(&self, other: &Entry) -> bool {
        use cap_std::fs::MetadataExt;
        match (
            self.dir.symlink_metadata(&self.name),
            other.dir.symlink_metadata(&other.name),
        ) {
            (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
            _ => false,
        }
    }

    fn label(&self) -> String {
        self.name.to_string_lossy().into_owned()
    }
}

/// Creates an empty file, or a folder when `dir`, at `path` inside `root`.
/// An existing entry is never replaced.
pub fn create(root: &str, path: &str, dir: bool) -> Result<()> {
    let e = entry(root, path)?;
    let made = if dir {
        e.dir.create_dir(&e.name)
    } else {
        e.dir
            .open_with(&e.name, OpenOptions::new().write(true).create_new(true))
            .map(drop)
    };
    made.map_err(|err| match err.kind() {
        std::io::ErrorKind::AlreadyExists => anyhow::anyhow!("{} already exists", e.label()),
        _ => anyhow::Error::new(err).context(format!("cannot create {}", e.path.display())),
    })
}

/// Renames or moves the entry at `from` to `to`, both inside `root`. An
/// existing entry at `to` is never replaced.
pub fn rename(root: &str, from: &str, to: &str) -> Result<()> {
    if expand_home(to).starts_with(expand_home(from)) {
        bail!("cannot move {from} into itself");
    }
    let (a, b) = (entry(root, from)?, entry(root, to)?);
    if !a.exists() {
        bail!("no such file: {}", a.path.display());
    }
    if b.exists() && !a.same_as(&b) {
        bail!("{} already exists", b.label());
    }
    a.dir
        .rename(&a.name, &b.dir, &b.name)
        .with_context(|| format!("cannot move {} to {}", a.path.display(), b.path.display()))
}

/// Copies the entry at `path` next to it as `name copy.ext` (then `name
/// copy 2.ext` and up), a folder with its contents; the copy's path.
pub fn duplicate(root: &str, path: &str) -> Result<String> {
    let e = entry(root, path)?;
    let meta = e
        .dir
        .symlink_metadata(&e.name)
        .with_context(|| format!("no such file: {}", e.path.display()))?;
    let is_dir = meta.is_dir();
    let name = (1..1000)
        .map(|n| copy_name(&e.name, n, is_dir))
        .find(|n| e.dir.symlink_metadata(n).is_err())
        .context("too many copies")?;
    copy_entry(&e.dir, &e.name, &e.dir, &name)
        .with_context(|| format!("cannot copy {}", e.path.display()))?;
    Ok(e.path.with_file_name(&name).display().to_string())
}

/// The `n`th copy's name: `util copy.ts`, `util copy 2.ts`; a folder's and
/// a dotfile's name get the suffix at the end: `src copy`, `.env copy`.
fn copy_name(name: &std::ffi::OsStr, n: u32, is_dir: bool) -> OsString {
    with_suffix(
        name,
        &if n == 1 {
            " copy".to_string()
        } else {
            format!(" copy {n}")
        },
        is_dir,
    )
}

/// `name` with `suffix` before its last extension; at the end of a
/// folder's or a dotfile's name.
fn with_suffix(name: &std::ffi::OsStr, suffix: &str, is_dir: bool) -> OsString {
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    let bytes = name.as_bytes();
    let dot = (!is_dir)
        .then(|| bytes.iter().rposition(|&b| b == b'.'))
        .flatten()
        .filter(|&i| i > 0);
    let (stem, ext) = bytes.split_at(dot.unwrap_or(bytes.len()));
    OsString::from_vec([stem, suffix.as_bytes(), ext].concat())
}

/// Copies `from` in `src` to `to` in `dst`: a folder with its contents, a
/// symlink as a link to the same place, a file with its permissions.
fn copy_entry(src: &Dir, from: &std::ffi::OsStr, dst: &Dir, to: &std::ffi::OsStr) -> Result<()> {
    let kind = src.symlink_metadata(from)?.file_type();
    if kind.is_symlink() {
        dst.symlink_contents(src.read_link_contents(from)?, to)?;
    } else if kind.is_dir() {
        dst.create_dir(to)?;
        let (inner_src, inner_dst) = (src.open_dir(from)?, dst.open_dir(to)?);
        for child in inner_src.entries()? {
            let name = child?.file_name();
            copy_entry(&inner_src, &name, &inner_dst, &name)?;
        }
    } else if kind.is_file() {
        src.copy(from, dst, to)?;
    } else {
        bail!("{} is not a file or a folder", from.to_string_lossy());
    }
    Ok(())
}

/// Where a deleted entry goes.
pub enum Trash {
    /// The user's Trash on this Mac.
    System,
    /// A folder of its own, for tests (`MOONLET_TRASH_DIR`).
    Folder(PathBuf),
    /// Nowhere: deleted for good, as on a host with no Trash.
    None,
}

impl Trash {
    /// This host's: a test's folder, the Trash on a Mac, none elsewhere.
    pub fn here() -> Trash {
        match std::env::var_os("MOONLET_TRASH_DIR") {
            Some(dir) if !dir.is_empty() => Trash::Folder(dir.into()),
            _ if cfg!(target_os = "macos") => Trash::System,
            _ => Trash::None,
        }
    }
}

/// Deletes the entry at `path` inside `root`, moving it to `trash` when
/// there is one; whether it went to a Trash. A symlink is removed, never
/// its target.
pub fn delete(root: &str, path: &str, trash: &Trash) -> Result<bool> {
    let e = entry(root, path)?;
    let meta = e
        .dir
        .symlink_metadata(&e.name)
        .with_context(|| format!("no such file: {}", e.path.display()))?;
    let failed = || format!("cannot delete {}", e.path.display());
    match trash {
        Trash::System => {
            move_to_trash(&e.path).with_context(failed)?;
            Ok(true)
        }
        Trash::Folder(bin) => {
            let bin = Dir::open_ambient_dir(bin, ambient_authority()).with_context(failed)?;
            let name = (1..1000)
                .map(|n| {
                    if n == 1 {
                        e.name.clone()
                    } else {
                        with_suffix(&e.name, &format!(" {n}"), meta.is_dir())
                    }
                })
                .find(|n| bin.symlink_metadata(n).is_err())
                .context("the trash is full")?;
            e.dir.rename(&e.name, &bin, &name).with_context(failed)?;
            Ok(true)
        }
        Trash::None => {
            if meta.is_dir() {
                e.dir.remove_dir_all(&e.name)
            } else {
                e.dir.remove_file(&e.name)
            }
            .with_context(failed)?;
            Ok(false)
        }
    }
}

/// Moves `path` to the user's Trash, where Finder can put it back.
#[cfg(target_os = "macos")]
fn move_to_trash(path: &std::path::Path) -> Result<()> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|e| anyhow::anyhow!("{}", e.localizedDescription()))
}

#[cfg(not(target_os = "macos"))]
fn move_to_trash(_path: &std::path::Path) -> Result<()> {
    bail!("this host has no Trash")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn s(p: &Path) -> String {
        p.display().to_string()
    }

    #[test]
    fn create_makes_an_empty_file_or_a_folder_and_never_replaces_one() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir(root.join("src")).unwrap();

        create(&s(root), &s(&root.join("src/util.ts")), false).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("src/util.ts")).unwrap(),
            ""
        );
        create(&s(root), &s(&root.join("src/lib")), true).unwrap();
        assert!(root.join("src/lib").is_dir());

        std::fs::write(root.join("src/util.ts"), "keep").unwrap();
        let err = create(&s(root), &s(&root.join("src/util.ts")), false).unwrap_err();
        assert!(err.to_string().contains("util.ts already exists"), "{err}");
        assert_eq!(
            std::fs::read_to_string(root.join("src/util.ts")).unwrap(),
            "keep"
        );
        assert!(create(&s(root), &s(&root.join("src/lib")), true).is_err());
    }

    #[test]
    fn file_actions_stay_inside_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("worktree");
        let home = dir.path().join("home");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join(".zshrc"), "keep").unwrap();
        std::os::unix::fs::symlink(&home, root.join("linked")).unwrap();
        let r = s(&root);

        for (path, why) in [
            (s(&home.join("new.txt")), "outside"),
            (r.clone(), "outside"),
            (format!("{r}/src/../../home/new.txt"), "outside"),
            (s(&root.join("linked/new.txt")), "is not a folder"),
        ] {
            let err = create(&r, &path, false).unwrap_err().to_string();
            assert!(err.contains(why), "{path}: {err}");
        }
        assert!(rename(&r, &s(&home.join(".zshrc")), &s(&root.join("zshrc"))).is_err());
        assert!(rename(&r, &s(&root.join("src")), &s(&root.join("linked/src"))).is_err());
        assert!(!home.join("new.txt").exists());
        assert!(home.join(".zshrc").exists() && root.join("src").is_dir());
    }

    #[test]
    fn rename_moves_and_never_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let r = s(root);
        std::fs::create_dir_all(root.join("src/lib")).unwrap();
        std::fs::write(root.join("src/util.ts"), "util").unwrap();
        std::fs::write(root.join("src/lib/index.ts"), "index").unwrap();

        rename(
            &r,
            &s(&root.join("src/util.ts")),
            &s(&root.join("src/helpers.ts")),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("src/helpers.ts")).unwrap(),
            "util"
        );
        assert!(!root.join("src/util.ts").exists());
        // A move into another folder.
        rename(
            &r,
            &s(&root.join("src/helpers.ts")),
            &s(&root.join("src/lib/helpers.ts")),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("src/lib/helpers.ts")).unwrap(),
            "util"
        );
        // A folder with its contents.
        rename(&r, &s(&root.join("src/lib")), &s(&root.join("lib"))).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("lib/index.ts")).unwrap(),
            "index"
        );

        std::fs::write(root.join("a.md"), "a").unwrap();
        std::fs::write(root.join("b.md"), "b").unwrap();
        let err = rename(&r, &s(&root.join("a.md")), &s(&root.join("b.md"))).unwrap_err();
        assert!(err.to_string().contains("b.md already exists"), "{err}");
        assert_eq!(std::fs::read_to_string(root.join("b.md")).unwrap(), "b");
        assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "a");

        let err = rename(&r, &s(&root.join("lib")), &s(&root.join("lib/inner/lib"))).unwrap_err();
        assert!(err.to_string().contains("into itself"), "{err}");
        assert!(rename(&r, &s(&root.join("missing.md")), &s(&root.join("c.md"))).is_err());

        // Only the case changes: on a Mac's volume both names are one file.
        rename(&r, &s(&root.join("a.md")), &s(&root.join("A.md"))).unwrap();
        let names: Vec<_> = std::fs::read_dir(root)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert!(
            names.iter().any(|n| n == "A.md") && !names.iter().any(|n| n == "a.md"),
            "{names:?}"
        );
    }

    #[test]
    fn duplicate_names_the_copy_like_finder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let r = s(root);
        std::fs::write(root.join("util.ts"), "util").unwrap();
        std::fs::write(root.join(".env"), "A=1").unwrap();

        let first = duplicate(&r, &s(&root.join("util.ts"))).unwrap();
        assert_eq!(first, s(&root.join("util copy.ts")));
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "util");
        assert_eq!(
            duplicate(&r, &s(&root.join("util.ts"))).unwrap(),
            s(&root.join("util copy 2.ts"))
        );
        assert_eq!(
            duplicate(&r, &s(&root.join("util.ts"))).unwrap(),
            s(&root.join("util copy 3.ts"))
        );
        assert_eq!(
            duplicate(&r, &s(&root.join(".env"))).unwrap(),
            s(&root.join(".env copy"))
        );
        assert_eq!(
            std::fs::read_to_string(root.join(".env copy")).unwrap(),
            "A=1"
        );
    }

    #[test]
    fn duplicate_copies_a_folder_with_its_contents() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("worktree");
        let home = dir.path().join("home");
        std::fs::create_dir_all(root.join("v1.2/nested")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(root.join("v1.2/nested/a.txt"), "a").unwrap();
        std::os::unix::fs::symlink(&home, root.join("v1.2/home")).unwrap();
        std::os::unix::fs::symlink("nested/a.txt", root.join("v1.2/a-link")).unwrap();

        let copy = duplicate(&s(&root), &s(&root.join("v1.2"))).unwrap();
        assert_eq!(copy, s(&root.join("v1.2 copy")));
        assert_eq!(
            std::fs::read_to_string(root.join("v1.2 copy/nested/a.txt")).unwrap(),
            "a"
        );
        // Links are copied as links, absolute or relative, and never followed.
        assert_eq!(
            std::fs::read_link(root.join("v1.2 copy/home")).unwrap(),
            home
        );
        assert_eq!(
            std::fs::read_link(root.join("v1.2 copy/a-link")).unwrap(),
            Path::new("nested/a.txt")
        );
        assert_eq!(std::fs::read_dir(&home).unwrap().count(), 0);
    }

    #[test]
    fn delete_removes_a_link_not_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("worktree");
        let home = dir.path().join("home");
        std::fs::create_dir_all(root.join("src/lib")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join(".zshrc"), "keep").unwrap();
        std::fs::write(root.join("src/lib/a.ts"), "a").unwrap();
        std::fs::write(root.join("notes.md"), "n").unwrap();
        std::os::unix::fs::symlink(&home, root.join("home")).unwrap();
        std::os::unix::fs::symlink(home.join(".zshrc"), root.join("zshrc")).unwrap();
        let r = s(&root);

        assert!(!delete(&r, &s(&root.join("home")), &Trash::None).unwrap());
        assert!(!delete(&r, &s(&root.join("zshrc")), &Trash::None).unwrap());
        assert_eq!(
            std::fs::read_to_string(home.join(".zshrc")).unwrap(),
            "keep"
        );
        assert!(
            !root.join("home").exists() && std::fs::symlink_metadata(root.join("zshrc")).is_err()
        );
        delete(&r, &s(&root.join("src")), &Trash::None).unwrap();
        delete(&r, &s(&root.join("notes.md")), &Trash::None).unwrap();
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        assert!(delete(&r, &s(&root.join("notes.md")), &Trash::None).is_err());
    }

    #[test]
    fn delete_moves_to_the_trash_on_a_mac() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("worktree");
        let trash = dir.path().join("Trash");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(&trash).unwrap();
        std::fs::write(root.join("src/a.ts"), "first").unwrap();
        let r = s(&root);
        let bin = Trash::Folder(trash.clone());

        assert!(delete(&r, &s(&root.join("src/a.ts")), &bin).unwrap());
        assert!(!root.join("src/a.ts").exists());
        assert_eq!(
            std::fs::read_to_string(trash.join("a.ts")).unwrap(),
            "first"
        );
        // A second a.ts goes beside the first, as in the Trash.
        std::fs::write(root.join("src/a.ts"), "second").unwrap();
        delete(&r, &s(&root.join("src/a.ts")), &bin).unwrap();
        let mut kept: Vec<_> = std::fs::read_dir(&trash)
            .unwrap()
            .map(|e| std::fs::read_to_string(e.unwrap().path()).unwrap())
            .collect();
        kept.sort();
        assert_eq!(kept, ["first", "second"]);
        assert!(delete(&r, &s(&root.join("src")), &bin).unwrap());
        assert!(trash.join("src").is_dir() && !root.join("src").exists());
    }
}
