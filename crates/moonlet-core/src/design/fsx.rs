//! Writing inside a design system's folder, where its agent may have left
//! symlinks (X64). Every step goes through directory handles opened from the
//! system's root (`cap-std`), so a path is never resolved twice: no write or
//! removal can land outside the root, even if a folder is swapped for a link
//! while it runs.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};

static NEXT: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
thread_local! {
    /// A test's other writer, run once between reading a file and replacing
    /// it, so a change made in between can be tested deterministically.
    pub(crate) static BEFORE_REPLACE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

/// Runs the test's other writer, if one is set; nothing outside tests.
pub(crate) fn before_replace() {
    #[cfg(test)]
    if let Some(other) = BEFORE_REPLACE.with(|h| h.borrow_mut().take()) {
        other();
    }
}

/// The folder `root` as a handle all paths are resolved inside.
fn open_root(root: &Path) -> Result<Dir> {
    Dir::open_ambient_dir(root, ambient_authority())
        .with_context(|| format!("cannot open {}", root.display()))
}

/// Writes `path`, which must be inside `root`, replacing what is there. A
/// symlink at `path` is replaced, never followed.
pub(crate) fn write_inside(root: &Path, path: &Path, bytes: &[u8]) -> Result<()> {
    let rel = path
        .strip_prefix(root)
        .with_context(|| format!("{} is outside {}", path.display(), root.display()))?;
    let name = rel.file_name().context("a file needs a name")?;
    let root_dir = open_root(root)?;
    let dir = match rel.parent().filter(|p| !p.as_os_str().is_empty()) {
        Some(parent) => {
            root_dir.create_dir_all(parent).with_context(|| {
                format!("cannot create {} in {}", parent.display(), root.display())
            })?;
            root_dir.open_dir(parent).with_context(|| {
                format!("cannot open {} in {}", parent.display(), root.display())
            })?
        }
        None => root_dir,
    };
    replace_in(&dir, name, bytes)
}

/// Replaces the file `name` in the folder `dir` with `bytes`, through a
/// temporary file renamed over it within that folder.
fn replace_in(dir: &Dir, name: &std::ffi::OsStr, bytes: &[u8]) -> Result<()> {
    let tmp = stage(dir, name, bytes)?;
    commit(dir, &tmp, name)
}

/// `bytes` written to a new temporary file beside `name` in `dir`, for
/// [`commit`] to put in its place; its name.
fn stage(dir: &Dir, name: &std::ffi::OsStr, bytes: &[u8]) -> Result<String> {
    let tmp = format!(
        ".{}.moonlet-{}-{}",
        name.to_string_lossy(),
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    {
        use std::io::Write;
        // `create_new` refuses an existing file or link at the temporary name.
        let mut f = dir.open_with(&tmp, OpenOptions::new().write(true).create_new(true))?;
        f.write_all(bytes).inspect_err(|_| {
            let _ = dir.remove_file(&tmp);
        })?;
    }
    Ok(tmp)
}

/// The file [`stage`] wrote put at `name`. A rename replaces the entry at
/// `name`, a link included, never its target.
fn commit(dir: &Dir, tmp: &str, name: &std::ffi::OsStr) -> Result<()> {
    dir.rename(tmp, dir, name).inspect_err(|_| {
        let _ = dir.remove_file(tmp);
    })?;
    Ok(())
}

/// How many times an update reads the file again after another writer
/// changed it before giving up.
const UPDATE_TRIES: usize = 8;

/// Rewrites the file `rel` inside `root` with `edit` of its text, which must
/// leave the rest of the file as it is. Its folder is found from `root`
/// once, as a handle, and must be a folder, not a link: every read and the
/// replace go through that handle, so a folder swapped for a link meanwhile
/// is never followed. When another writer, such as the design's agent,
/// changed the file after it was read, it is read again and edited from
/// there, so that writer's change is kept. The new text is written aside
/// before the last read, so only the rename follows it: a write by another
/// process in that moment is still replaced, as no rename can compare
/// first. Moonlet's own writers of a file take a lock around this.
pub(crate) fn update_inside(
    root: &Path,
    rel: &Path,
    edit: impl FnMut(&str) -> Result<String>,
) -> Result<()> {
    update(root, rel, false, edit)
}

/// As [`update_inside`], but a missing file reads as empty and the replace
/// makes it: one made by another writer after it was found missing is read
/// again, as a changed one is.
pub(crate) fn update_or_create_inside(
    root: &Path,
    rel: &Path,
    edit: impl FnMut(&str) -> Result<String>,
) -> Result<()> {
    update(root, rel, true, edit)
}

fn update(
    root: &Path,
    rel: &Path,
    create: bool,
    mut edit: impl FnMut(&str) -> Result<String>,
) -> Result<()> {
    let name = rel.file_name().context("a file needs a name")?;
    let root_dir = open_root(root)?;
    let dir = match rel.parent().filter(|p| !p.as_os_str().is_empty()) {
        Some(parent) => {
            let meta = root_dir.symlink_metadata(parent).with_context(|| {
                format!("cannot reach {} in {}", parent.display(), root.display())
            })?;
            if !meta.is_dir() {
                anyhow::bail!("{} in {} is not a folder", parent.display(), root.display());
            }
            // Within `root` whatever happens to the path: the handle is the
            // folder itself.
            root_dir.open_dir(parent).with_context(|| {
                format!("cannot open {} in {}", parent.display(), root.display())
            })?
        }
        None => root_dir,
    };
    // The file's text; None when it is missing and may be made.
    let read = |dir: &Dir| match dir.read_to_string(name) {
        Ok(text) => Ok(Some(text)),
        Err(e) if create && e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => {
            Err(e).with_context(|| format!("cannot read {} in {}", rel.display(), root.display()))
        }
    };
    for _ in 0..UPDATE_TRIES {
        let before = read(&dir)?;
        let after = edit(before.as_deref().unwrap_or(""))?;
        // Written aside first, so the last read is right before the rename.
        let tmp = stage(&dir, name, after.as_bytes())?;
        before_replace();
        // Changed, or made, since it was read: start again from the newest text.
        if read(&dir)? != before {
            let _ = dir.remove_file(&tmp);
            continue;
        }
        return commit(&dir, &tmp, name);
    }
    anyhow::bail!("{} kept changing while it was saved", rel.display())
}

/// Reads `path`, which must be inside `root`; a link out of it is refused.
pub(crate) fn read_inside(root: &Path, path: &Path) -> Result<String> {
    let rel = path
        .strip_prefix(root)
        .with_context(|| format!("{} is outside {}", path.display(), root.display()))?;
    open_root(root)?
        .read_to_string(rel)
        .with_context(|| format!("cannot read {} in {}", rel.display(), root.display()))
}

/// Removes the folder `dir` inside `root`: a symlink only as a link.
pub(crate) fn remove_dir_inside(root: &Path, dir: &Path) -> Result<()> {
    let rel = dir
        .strip_prefix(root)
        .with_context(|| format!("{} is outside {}", dir.display(), root.display()))?;
    let root_dir = open_root(root)?;
    let meta = match root_dir.symlink_metadata(rel) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        // Such as a path through a link out of the root: refused.
        Err(e) => {
            return Err(e)
                .with_context(|| format!("cannot reach {} in {}", rel.display(), root.display()));
        }
    };
    if meta.file_type().is_symlink() {
        return Ok(root_dir.remove_file(rel)?);
    }
    Ok(root_dir.remove_dir_all(rel)?)
}

/// Removes the file `path` inside `root`; a missing file is fine.
pub(crate) fn remove_file_inside(root: &Path, path: &Path) -> Result<()> {
    let rel = path
        .strip_prefix(root)
        .with_context(|| format!("{} is outside {}", path.display(), root.display()))?;
    match open_root(root)?.remove_file(rel) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// Renames `from` over `to`, both inside `root`; false when `from` is
/// missing.
pub(crate) fn rename_inside(root: &Path, from: &Path, to: &Path) -> Result<bool> {
    let (from, to) = (from.strip_prefix(root)?, to.strip_prefix(root)?);
    let root_dir = open_root(root)?;
    match root_dir.rename(from, &root_dir, to) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// Whether the entry `name` of `dir` and the handle `opened` are one file:
/// a link swapped in between the look and the open is refused.
fn same(look: &cap_std::fs::Metadata, opened: &cap_std::fs::Metadata) -> bool {
    use cap_std::fs::MetadataExt;
    look.dev() == opened.dev() && look.ino() == opened.ino()
}

/// The folder `name` of `dir`, which must be a folder of its own, never a
/// link: `None` when it is missing, or for reading (not `create`) a link,
/// which is left out; with `create`, made when missing, and a link is
/// refused.
fn open_folder(dir: &Dir, name: &std::ffi::OsStr, create: bool) -> Result<Option<Dir>> {
    if create {
        match dir.create_dir(name) {
            Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e.into()),
            _ => {}
        }
    }
    let look = match dir.symlink_metadata(name) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if look.is_symlink() && !create {
        return Ok(None);
    }
    if !look.is_dir() {
        anyhow::bail!(
            "{} is not a folder (a link is refused)",
            name.to_string_lossy()
        );
    }
    let opened = dir.open_dir(name)?;
    if !same(&look, &opened.dir_metadata()?) {
        anyhow::bail!("{} changed while it was opened", name.to_string_lossy());
    }
    Ok(Some(opened))
}

/// The folder `rel` inside `root`, each of its folders one of its own,
/// never a link; with `create`, made when missing. `None` when it is
/// missing, or a link on the way when not creating.
fn open_path(root: &Path, rel: &Path, create: bool) -> Result<Option<Dir>> {
    open_under(open_root(root)?, rel, create)
}

/// As [`open_path`], from the folder `dir`.
fn open_under(mut dir: Dir, rel: &Path, create: bool) -> Result<Option<Dir>> {
    for part in rel.components() {
        let std::path::Component::Normal(name) = part else {
            anyhow::bail!("{} is not a path inside its folder", rel.display());
        };
        match open_folder(&dir, name, create)? {
            Some(next) => dir = next,
            None => return Ok(None),
        }
    }
    Ok(Some(dir))
}

/// The bytes of file `name` in `dir`, a file of its own, never a link.
fn read_file(dir: &Dir, name: &std::ffi::OsStr) -> Result<Vec<u8>> {
    use std::io::Read;
    let look = dir.symlink_metadata(name)?;
    if !look.is_file() {
        anyhow::bail!(
            "{} is not a file (a link is refused)",
            name.to_string_lossy()
        );
    }
    let mut file = dir.open(name)?;
    if !same(&look, &file.metadata()?) {
        anyhow::bail!("{} changed while it was opened", name.to_string_lossy());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Every file in the folder `rel` inside `root` and its folders, by its
/// path in `rel` (`img/logo.png`): links are left out, never followed, and
/// so are hidden files, such as moonlet's own temporary ones. A missing
/// folder, or one that is a link, has none.
pub(crate) fn read_tree(
    root: &Path,
    rel: &Path,
) -> Result<std::collections::BTreeMap<String, Vec<u8>>> {
    let mut out = std::collections::BTreeMap::new();
    if let Some(dir) = open_path(root, rel, false)? {
        walk(&dir, "", &mut |at, name, path, kind| {
            if kind.is_file() {
                out.insert(path.to_string(), read_file(at, name)?);
            }
            Ok(())
        })?;
    }
    Ok(out)
}

/// Calls `visit` with each entry of the folder `dir` and its folders that
/// is not a folder: the folder it is in, its name, its path in `dir`
/// (`img/logo.png`) and its type. Hidden entries are left out, and a link
/// is an entry, never followed.
fn walk(
    dir: &Dir,
    prefix: &str,
    visit: &mut dyn FnMut(&Dir, &std::ffi::OsStr, &str, cap_std::fs::FileType) -> Result<()>,
) -> Result<()> {
    for entry in dir.entries()? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(text) = name.to_str().filter(|n| !n.starts_with('.')) else {
            continue;
        };
        let kind = entry.file_type()?;
        let path = format!("{prefix}{text}");
        if kind.is_dir() {
            if let Some(sub) = open_folder(dir, &name, false)? {
                walk(&sub, &format!("{path}/"), visit)?;
            }
        } else {
            visit(dir, &name, &path, kind)?;
        }
    }
    Ok(())
}

/// The folder of `path` (`img/logo.png`) in `dir`, made when missing, and
/// the file's name: never through a link.
fn parent_of<'p>(dir: &Dir, path: &'p str) -> Result<(Dir, &'p std::ffi::OsStr)> {
    let path = Path::new(path);
    let name = path.file_name().context("a file needs a name")?;
    let mut at = dir.try_clone()?;
    if let Some(parent) = path.parent() {
        for part in parent.components() {
            let std::path::Component::Normal(folder) = part else {
                anyhow::bail!("{} is not a path inside its folder", path.display());
            };
            at = open_folder(&at, folder, true)?.context("a folder went away")?;
        }
    }
    Ok((at, name))
}

/// Writes `files` (by their paths in `rel`) into the folder `rel` of the
/// folder `base` inside `root`: `rel` is made when missing, `base` never
/// (a folder removed meanwhile stays removed). Each file replaces what is
/// there: a link in its place is replaced, never followed. With `exact`,
/// every other file and link in it that is not hidden is removed, so the
/// folder holds `files` and nothing else.
pub(crate) fn write_tree(
    root: &Path,
    base: &Path,
    rel: &Path,
    files: &std::collections::BTreeMap<String, Vec<u8>>,
    exact: bool,
) -> Result<()> {
    let base_dir = open_path(root, base, false)?
        .with_context(|| format!("no {} in {}", base.display(), root.display()))?;
    let dir = open_under(base_dir, rel, true)?.context("a folder went away")?;
    for (path, bytes) in files {
        let (at, name) = parent_of(&dir, path)?;
        replace_in(&at, name, bytes)?;
    }
    if exact {
        walk(&dir, "", &mut |at, name, path, _| {
            if !files.contains_key(path) {
                // A link goes as a link: its target is never touched.
                at.remove_file(name)?;
            }
            Ok(())
        })?;
    }
    Ok(())
}

/// Reads the file `rel` inside `root`: neither it nor any folder on its way
/// may be a link.
pub(crate) fn read_file_inside(root: &Path, rel: &Path) -> Result<Vec<u8>> {
    let name = rel.file_name().context("a file needs a name")?;
    let folder = rel.parent().unwrap_or(Path::new(""));
    let dir = open_path(root, folder, false)?
        .with_context(|| format!("no {} in {}", folder.display(), root.display()))?;
    read_file(&dir, name)
}

/// Makes the folder `rel` inside `root` and those on its way, each one of
/// its own: a link on the way is refused, never followed.
pub(crate) fn make_dirs_inside(root: &Path, rel: &Path) -> Result<()> {
    open_path(root, rel, true)?.context("a folder went away")?;
    Ok(())
}

/// Makes the folder `name` in the folder `rel` inside `root` (made when
/// missing, never through a link); an error of kind `AlreadyExists` when it
/// is there.
pub(crate) fn create_dir_in(root: &Path, rel: &Path, name: &str) -> std::io::Result<()> {
    let dir = open_path(root, rel, true)
        .map_err(std::io::Error::other)?
        .ok_or_else(|| std::io::Error::other("a folder went away"))?;
    dir.create_dir(name)
}

/// Makes a folder in the folder `rel` inside `root` (made when missing,
/// never through a link) named after `name`, or `<name> 2` (` 3`, …) when
/// that one is taken, and returns the name and the folder's slug.
pub(crate) fn create_numbered_inside(
    root: &Path,
    rel: &Path,
    name: &str,
    fallback: &str,
) -> Result<(String, String)> {
    let dir = open_path(root, rel, true)?.context("a folder went away")?;
    let mut n = 1;
    loop {
        let name_n = if n == 1 {
            name.to_string()
        } else {
            format!("{name} {n}")
        };
        let slug = super::store::slug_or(&name_n, fallback);
        match dir.create_dir(&slug) {
            Ok(()) => return Ok((name_n, slug)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
            Err(e) => {
                return Err(e)
                    .with_context(|| format!("cannot create {slug} in {}", rel.display()));
            }
        }
    }
}

/// Whether the folder `rel` inside `root` is there, each folder on its way
/// one of its own, never a link.
pub(crate) fn is_dir_inside(root: &Path, rel: &Path) -> Result<bool> {
    Ok(open_path(root, rel, false)?.is_some())
}
