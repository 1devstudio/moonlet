//! The version of a `node` binary for the input editor's chips (T8), found
//! without running it: the shell's PATH may point into an untrusted
//! checkout, so its `node` must never execute on its own.

use std::path::Path;

/// `v<major>.<minor>.<patch>` of the `node` at `path`: from the
/// `include/node/node_version.h` that Node installs beside `bin/`, else from
/// a version directory in the resolved path (Homebrew's `Cellar/node/22.1.0`).
/// Only reads files.
pub fn version_of(path: &Path) -> Option<String> {
    let real = std::fs::canonicalize(path).ok()?;
    let prefix = real.parent()?.parent()?;
    if let Ok(header) = std::fs::read_to_string(prefix.join("include").join("node").join("node_version.h")) {
        let part = |name: &str| {
            header.lines().find_map(|l| {
                let rest = l.trim().strip_prefix("#define ")?.strip_prefix(name)?;
                rest.trim().parse::<u32>().ok()
            })
        };
        if let (Some(major), Some(minor), Some(patch)) = (part("NODE_MAJOR_VERSION"), part("NODE_MINOR_VERSION"), part("NODE_PATCH_VERSION")) {
            return Some(format!("v{major}.{minor}.{patch}"));
        }
    }
    real.components().rev().find_map(|c| {
        let name = c.as_os_str().to_str()?;
        let digits = name.strip_prefix('v').unwrap_or(name);
        let parts: Vec<&str> = digits.split('.').collect();
        (parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))).then(|| format!("v{digits}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A `node` that leaves a mark if anything runs it.
    fn fake_node(bin: &Path, ran: &Path) {
        std::fs::create_dir_all(bin).unwrap();
        let node = bin.join("node");
        std::fs::write(&node, format!("#!/bin/sh\ntouch {}\necho v6.6.6\n", ran.display())).unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn reads_the_header_installed_next_to_the_binary() {
        let d = tempfile::tempdir().unwrap();
        let ran = d.path().join("ran");
        fake_node(&d.path().join("bin"), &ran);
        let include = d.path().join("include").join("node");
        std::fs::create_dir_all(&include).unwrap();
        // As in a real install (nvm's v24.19.0).
        std::fs::write(
            include.join("node_version.h"),
            "#ifndef SRC_NODE_VERSION_H_\n#define NODE_MAJOR_VERSION 24\n#define NODE_MINOR_VERSION 19\n#define NODE_PATCH_VERSION 0\n",
        )
        .unwrap();
        assert_eq!(version_of(&d.path().join("bin").join("node")), Some("v24.19.0".into()));
        assert!(!ran.exists(), "node was run");
    }

    #[test]
    fn falls_back_to_a_version_in_the_resolved_path() {
        let d = tempfile::tempdir().unwrap();
        let ran = d.path().join("ran");
        let real = d.path().join("Cellar").join("node").join("22.1.0").join("bin");
        fake_node(&real, &ran);
        std::fs::create_dir_all(d.path().join("bin")).unwrap();
        std::os::unix::fs::symlink(real.join("node"), d.path().join("bin").join("node")).unwrap();
        assert_eq!(version_of(&d.path().join("bin").join("node")), Some("v22.1.0".into()));
        assert!(!ran.exists(), "node was run");
    }

    #[test]
    fn knows_nothing_without_a_header_or_versioned_path() {
        let d = tempfile::tempdir().unwrap();
        let ran = d.path().join("ran");
        fake_node(&d.path().join("node_modules").join(".bin"), &ran);
        assert_eq!(version_of(&d.path().join("node_modules").join(".bin").join("node")), None);
        assert_eq!(version_of(&d.path().join("missing")), None);
        assert!(!ran.exists(), "node was run");
    }
}
