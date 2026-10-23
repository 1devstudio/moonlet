//! Writing inside a design system's folder, where its agent may have left
//! symlinks (X64): a write never goes through one to a file outside.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result, bail};

static NEXT: AtomicU64 = AtomicU64::new(0);

/// Writes `path`, which must be inside `root`, replacing what is there. A
/// symlink at `path` is replaced, never followed; a folder on the way that
/// leads outside `root` is refused.
pub(crate) fn write_inside(root: &Path, path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("a file needs a folder")?;
    // Folder by folder from `root`, creating what is missing: a folder that
    // is a symlink is refused before anything is made through it.
    let rel = parent
        .strip_prefix(root)
        .with_context(|| format!("{} is outside {}", path.display(), root.display()))?;
    let mut at = root.to_path_buf();
    for c in rel.components() {
        let std::path::Component::Normal(name) = c else {
            bail!("{} is not a plain path", path.display())
        };
        at.push(name);
        match std::fs::symlink_metadata(&at) {
            Ok(m) if m.file_type().is_symlink() => bail!(
                "{} is a link; moonlet does not write through it",
                at.display()
            ),
            Ok(m) if m.is_dir() => {}
            Ok(_) => bail!("{} is not a folder", at.display()),
            Err(_) => std::fs::create_dir(&at)
                .with_context(|| format!("cannot create {}", at.display()))?,
        }
    }
    let real_parent = std::fs::canonicalize(parent)?;
    let name = path
        .file_name()
        .context("a file needs a name")?
        .to_string_lossy();
    let tmp = real_parent.join(format!(
        ".{name}.moonlet-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    {
        use std::io::Write;
        // `create_new` refuses an existing file or link at the temporary name.
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        f.write_all(bytes)?;
    }
    // A rename replaces the entry at `path`, a symlink included, never its target.
    std::fs::rename(&tmp, real_parent.join(path.file_name().unwrap_or_default())).inspect_err(
        |_| {
            let _ = std::fs::remove_file(&tmp);
        },
    )?;
    Ok(())
}

/// Removes the folder `dir` inside `root`: a symlink only as a link.
pub(crate) fn remove_dir_inside(root: &Path, dir: &Path) -> Result<()> {
    let Ok(meta) = std::fs::symlink_metadata(dir) else {
        return Ok(());
    };
    if meta.file_type().is_symlink() {
        return Ok(std::fs::remove_file(dir)?);
    }
    if !std::fs::canonicalize(dir)?.starts_with(std::fs::canonicalize(root)?) {
        bail!("{} leads outside {}", dir.display(), root.display());
    }
    Ok(std::fs::remove_dir_all(dir)?)
}
