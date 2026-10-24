//! The `moonlet-design://` scheme (X65, ADR 0013): design systems' and
//! designs' files, served to the sandboxed frames that render them, under a
//! CSP with no network. `moonlet-design://<workspace>/<path>` names a file of
//! that workspace's design folder; this Mac's daemon resolves it
//! (`design.file`), never outside the folder.

/// Every file is served with it: a page may load only design files, inline
/// styles and scripts, and `data:`/`blob:` URLs; it cannot fetch, post or
/// frame anything.
pub const CSP: &str = "default-src moonlet-design: data: blob: 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'";

/// The workspace and the path (decoded, relative to its design folder) a URL
/// names, or `None` for anything else: another scheme, no workspace, no
/// path, or a path with an empty, `.` or `..` part.
pub fn target(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("moonlet-design://")?;
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let (workspace, path) = rest.split_once('/')?;
    if workspace.is_empty() || path.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        let part = decode(part)?;
        if part.is_empty() || part == "." || part == ".." || part.contains(['/', '\\', '\0']) {
            return None;
        }
        parts.push(part);
    }
    Some((decode(workspace)?, parts.join("/")))
}

/// The headers of a served file.
pub fn headers(content_type: &str) -> [(&'static str, String); 4] {
    [
        ("Content-Type", content_type.to_string()),
        ("Content-Security-Policy", CSP.to_string()),
        ("X-Content-Type-Options", "nosniff".to_string()),
        // The canvas reloads on every change.
        ("Cache-Control", "no-store".to_string()),
    ]
}

/// Answers a request for `url`: the file this Mac's daemon resolves it to,
/// with [`headers`]; 400 for a URL that names no file, 404 for one the daemon
/// refuses or that cannot be read.
pub async fn serve(app: &tauri::AppHandle, url: &str) -> tauri::http::Response<Vec<u8>> {
    use std::sync::Arc;
    use tauri::Manager;
    let reply = |status: u16, body: &str| {
        tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(body.as_bytes().to_vec())
            .unwrap_or_default()
    };
    let Some((workspace, path)) = target(url) else {
        return reply(400, "not a design file");
    };
    let hosts = app.state::<Arc<crate::hosts::HostManager>>();
    let Ok(local) = hosts.get("local") else {
        return reply(404, "the daemon is not running");
    };
    let file = match local
        .request(
            moonlet_proto::methods::DESIGN_FILE,
            serde_json::json!({ "workspace": workspace, "path": path }),
        )
        .await
    {
        Ok(f) => f,
        Err(e) => return reply(404, &e.message),
    };
    let (Some(real), Some(content_type)) = (file["path"].as_str(), file["content_type"].as_str())
    else {
        return reply(404, "no such design file");
    };
    // Checked against the file actually opened, so a link put in its place
    // after the daemon resolved it leads nowhere outside the design folder.
    let root = moonlet_core::paths::home().join("design");
    let real = std::path::PathBuf::from(real);
    let Ok(Ok(body)) = tokio::task::spawn_blocking(move || read_inside(&root, &real)).await else {
        return reply(404, "no such design file");
    };
    let mut res = tauri::http::Response::builder().status(200);
    for (name, value) in headers(content_type) {
        res = res.header(name, value);
    }
    res.body(body).unwrap_or_default()
}

/// The bytes of `path`, opened first and then checked: the file opened must
/// be inside `root` (links resolved), or nothing is read.
pub fn read_inside(root: &std::path::Path, path: &std::path::Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let root = std::fs::canonicalize(root)?;
    let mut file = std::fs::File::open(path)?;
    if !opened_path(&file)?.starts_with(&root) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "outside the design folder",
        ));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Where an open file is, as the system resolved it when opening it.
#[cfg(target_os = "macos")]
fn opened_path(file: &std::fs::File) -> std::io::Result<std::path::PathBuf> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    let mut buf = vec![0u8; libc::PATH_MAX as usize];
    // SAFETY: `buf` holds PATH_MAX bytes, as F_GETPATH requires.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buf.as_mut_ptr()) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    let len = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Ok(std::path::PathBuf::from(std::ffi::OsStr::from_bytes(
        &buf[..len],
    )))
}

#[cfg(not(target_os = "macos"))]
fn opened_path(file: &std::fs::File) -> std::io::Result<std::path::PathBuf> {
    use std::os::fd::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

/// `%XX` escapes decoded, as UTF-8; `None` when they are not valid.
fn decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_url_names_a_workspace_and_a_file_of_its_design_folder() {
        let t = |w: &str, p: &str| Some((w.to_string(), p.to_string()));
        assert_eq!(
            target(
                "moonlet-design://w-1devstudio/systems/storefront/components/buttons/button/button.html"
            ),
            t(
                "w-1devstudio",
                "systems/storefront/components/buttons/button/button.html"
            )
        );
        assert_eq!(
            target("moonlet-design://w1/systems/s/img/hero%20shot.png"),
            t("w1", "systems/s/img/hero shot.png")
        );
        assert_eq!(
            target("moonlet-design://w1/systems/s/styles.css?v=2#top"),
            t("w1", "systems/s/styles.css")
        );
    }

    #[test]
    fn a_url_that_leaves_the_folder_or_names_nothing_is_refused() {
        for bad in [
            "https://w1/systems/s/styles.css",
            "moonlet-design://w1/",
            "moonlet-design://w1",
            "moonlet-design:///systems/s/styles.css",
            "moonlet-design://w1/systems/../../secret.txt",
            "moonlet-design://w1/systems/%2e%2e/secret.txt",
            "moonlet-design://w1/systems/a%2f..%2fb",
            "moonlet-design://w1/systems//s",
            "moonlet-design://w1/systems/%zz",
        ] {
            assert_eq!(target(bad), None, "{bad}");
        }
    }

    #[test]
    fn only_a_file_that_is_inside_the_design_folder_when_opened_is_read() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("card.html"), "<p>card</p>").unwrap();
        std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            root.path().join("link.html"),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("dir")).unwrap();
        assert_eq!(
            read_inside(root.path(), &root.path().join("card.html")).unwrap(),
            b"<p>card</p>"
        );
        assert!(read_inside(root.path(), &root.path().join("link.html")).is_err());
        assert!(read_inside(root.path(), &root.path().join("dir/secret.txt")).is_err());
    }

    #[test]
    fn every_file_is_served_with_the_no_network_policy() {
        let h = headers("text/html; charset=utf-8");
        assert_eq!(
            h[0],
            ("Content-Type", "text/html; charset=utf-8".to_string())
        );
        assert_eq!(
            h[1],
            (
                "Content-Security-Policy",
                "default-src moonlet-design: data: blob: 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'".to_string()
            )
        );
    }
}
