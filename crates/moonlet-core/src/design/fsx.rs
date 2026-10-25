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
