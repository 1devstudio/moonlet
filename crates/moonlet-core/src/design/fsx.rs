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
        f.write_all(bytes)?;
    }
    // A rename replaces the entry at `name`, a link included, never its target.
    dir.rename(&tmp, &dir, name).inspect_err(|_| {
        let _ = dir.remove_file(&tmp);
    })?;
    Ok(())
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

/// Renames `from` over `to`, both inside `root`.
pub(crate) fn rename_inside(root: &Path, from: &Path, to: &Path) -> Result<()> {
    let (from, to) = (from.strip_prefix(root)?, to.strip_prefix(root)?);
    let root_dir = open_root(root)?;
    Ok(root_dir.rename(from, &root_dir, to)?)
}
