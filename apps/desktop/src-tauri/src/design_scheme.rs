//! The `moonlet-design://` scheme (X65, ADR 0013): design systems' and
//! designs' files, served to the sandboxed frames that render them, under a
//! CSP with no network. `moonlet-design://<workspace>/<path>` names a file of
//! that workspace's design folder; this Mac's daemon resolves it
//! (`design.file`), never outside the folder.
//!
//! A card framed in the app's window is asked on its own host,
//! `moonlet-design://<card key>.<workspace>/<path>` (`cardUrl` in
//! `src/lib/designView.ts` builds it), so WebKit's site isolation gives it a
//! web process of its own (X64). The key only names the process: the file is
//! the path's, whichever key asks for it.

/// What a `moonlet-design://` URL names: the host it was asked on (the
/// workspace, or a card's key and the workspace), the workspace, and the path
/// (decoded, relative to the workspace's design folder).
#[derive(Debug, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub workspace: String,
    pub path: String,
}

/// The policy every file asked on `host` is served with: a page may load
/// only that host's design files, inline styles and scripts, and
/// `data:`/`blob:` URLs; it cannot fetch, post or frame anything. A card on
/// its own host reaches no other card's host, nor another workspace.
pub fn csp(host: &str) -> String {
    format!(
        "default-src moonlet-design://{host} data: blob: 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'"
    )
}

/// What `url` names, or `None` for anything else: another scheme, no
/// workspace, no path, a path with an empty, `.` or `..` part, or a host
/// that is neither `<workspace>` nor `<card key>.<workspace>`.
pub fn target(url: &str) -> Option<Target> {
    let rest = url.strip_prefix("moonlet-design://")?;
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let (host, path) = rest.split_once('/')?;
    if host.is_empty() || path.is_empty() {
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
    // A card's key is a DNS label: lowercase letters and digits, 1 to 63.
    let workspace = match host.split('.').collect::<Vec<_>>()[..] {
        [workspace] => workspace,
        [key, workspace]
            if (1..=63).contains(&key.len())
                && key
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) =>
        {
            workspace
        }
        _ => return None,
    };
    // A workspace is an id, never another folder of the design root.
    let workspace = decode(workspace)?;
    if workspace.is_empty()
        || !workspace
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(Target {
        host: host.to_string(),
        workspace,
        path: parts.join("/"),
    })
}

/// The render check's measuring script (X64), put in a card the render
/// page asks for.
const MEASURE: &str = include_str!("design_measure.js");

/// The comment bridge (X65): put in a design's page the canvas asks for, so
/// the page, cross-origin to the app, outlines and reports its elements.
const BRIDGE: &str = include_str!("design_bridge.js");

/// Whether the app's render page asks for `url` (`?moonlet-render=<job>`),
/// so the card is served with the measuring script (X64).
pub fn measuring(url: &str) -> bool {
    asks(url, "moonlet-render")
}

/// Whether the design screen's canvas asks for `url` with the bridge
/// (`?moonlet-bridge=1`, X65).
pub fn bridging(url: &str) -> bool {
    asks(url, "moonlet-bridge")
}

/// Whether `url`'s query has the parameter `name`.
fn asks(url: &str, name: &str) -> bool {
    let query = url
        .split('#')
        .next()
        .and_then(|u| u.split_once('?'))
        .map_or("", |(_, q)| q);
    query
        .split('&')
        .any(|pair| pair.split('=').next() == Some(name))
}

/// `html` with `script` first in its `<head>`: after the `<head>` tag, else
/// after `<html>`, else after the doctype (never before it, which would put
/// the page in quirks mode), else at the start.
pub fn with_script(html: &[u8], script: &[u8]) -> Vec<u8> {
    // Found in the bytes, so a card in another encoding is served as it is:
    // lowercased ASCII keeps every byte where it was.
    let lower = html.to_ascii_lowercase();
    let find = |from: usize, needle: &[u8]| {
        lower
            .get(from..)?
            .windows(needle.len())
            .position(|w| w == needle)
            .map(|i| from + i)
    };
    // Just after the `>` of the first `<tag` (followed by `>`, a space or `/`).
    let after = |tag: &[u8]| {
        let mut from = 0;
        while let Some(start) = find(from, tag) {
            let next = lower.get(start + tag.len()).copied();
            if matches!(next, Some(b'>' | b'/' | b' ' | b'\t' | b'\n' | b'\r')) {
                return find(start, b">").map(|j| j + 1);
            }
            from = start + tag.len();
        }
        None
    };
    let at = after(b"<head")
        .or_else(|| after(b"<html"))
        .or_else(|| after(b"<!doctype"))
        .unwrap_or(0);
    [&html[..at], script, &html[at..]].concat()
}

/// The headers of a file served on `host`.
pub fn headers(content_type: &str, host: &str) -> [(&'static str, String); 4] {
    [
        ("Content-Type", content_type.to_string()),
        ("Content-Security-Policy", csp(host)),
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
    let Some(Target {
        host,
        workspace,
        path,
    }) = target(url)
    else {
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
    // after the daemon resolved it leads nowhere outside the workspace's folder.
    let design = moonlet_core::paths::home().join("design");
    let (real, ws) = (std::path::PathBuf::from(real), workspace.clone());
    let Ok(Ok(body)) = tokio::task::spawn_blocking(move || read_inside(&design, &ws, &real)).await
    else {
        return reply(404, "no such design file");
    };
    // The render page's card measures itself, in its own sandboxed frame.
    let body = if measuring(url) && content_type.starts_with("text/html") {
        with_script(&body, format!("<script>{MEASURE}</script>").as_bytes())
    } else if bridging(url) && content_type.starts_with("text/html") {
        // The canvas's page outlines and reports its elements (X65).
        with_script(&body, format!("<script>{BRIDGE}</script>").as_bytes())
    } else {
        body
    };
    let mut res = tauri::http::Response::builder().status(200);
    for (name, value) in headers(content_type, &host) {
        res = res.header(name, value);
    }
    res.body(body).unwrap_or_default()
}

/// The bytes of `path`, opened first and then checked: the file opened must
/// be inside `workspace`'s folder of the design root `design`, measured from
/// the design root's real path, so neither a link in the folder nor a
/// workspace folder that is itself a link leads anywhere else.
pub fn read_inside(
    design: &std::path::Path,
    workspace: &str,
    path: &std::path::Path,
) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let root = std::fs::canonicalize(design)?.join(workspace);
    let mut file = std::fs::File::open(path)?;
    if !opened_path(&file)?.starts_with(&root) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "outside the workspace's design folder",
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
        let t = |w: &str, p: &str| {
            Some(Target {
                host: w.to_string(),
                workspace: w.to_string(),
                path: p.to_string(),
            })
        };
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
    fn a_cards_own_host_names_its_key_and_its_workspace() {
        assert_eq!(
            target(
                "moonlet-design://5a1c3e0f9b2d4c67.w-1devstudio/systems/storefront/components/buttons/button/button.html?v=3"
            ),
            Some(Target {
                host: "5a1c3e0f9b2d4c67.w-1devstudio".to_string(),
                workspace: "w-1devstudio".to_string(),
                path: "systems/storefront/components/buttons/button/button.html".to_string(),
            })
        );
        // The card's stylesheet, asked on the card's host.
        assert_eq!(
            target("moonlet-design://5a1c3e0f9b2d4c67.w1/systems/s/styles.css"),
            Some(Target {
                host: "5a1c3e0f9b2d4c67.w1".to_string(),
                workspace: "w1".to_string(),
                path: "systems/s/styles.css".to_string(),
            })
        );
    }

    #[test]
    fn a_card_host_with_a_bad_key_or_workspace_or_extra_labels_is_refused() {
        for bad in [
            // Empty labels.
            "moonlet-design://.w1/systems/s/styles.css",
            "moonlet-design://5a1c.//systems/s/styles.css",
            "moonlet-design://5a1c./systems/s/styles.css",
            "moonlet-design://5a1c..w1/systems/s/styles.css",
            // Extra labels.
            "moonlet-design://a.5a1c.w1/systems/s/styles.css",
            // A key is lowercase letters and digits, at most 63 of them.
            "moonlet-design://5A1C.w1/systems/s/styles.css",
            "moonlet-design://5a_1c.w1/systems/s/styles.css",
            "moonlet-design://5a-1c.w1/systems/s/styles.css",
            "moonlet-design://5a%31c.w1/systems/s/styles.css",
            "moonlet-design://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.w1/systems/s/styles.css",
            // The workspace is still an id.
            "moonlet-design://5a1c.w1%2fx/systems/s/styles.css",
            "moonlet-design://5a1c.%2e%2e/w2/systems/s/styles.css",
            "moonlet-design://5a1c.w%201/systems/s/styles.css",
        ] {
            assert_eq!(target(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_card_on_its_own_host_may_load_only_that_hosts_files() {
        let h = headers("text/html; charset=utf-8", "5a1c3e0f9b2d4c67.w-1devstudio");
        let get = |name: &str| h.iter().find(|(n, _)| *n == name).map(|(_, v)| v.as_str());
        assert_eq!(
            get("Content-Security-Policy"),
            Some(
                "default-src moonlet-design://5a1c3e0f9b2d4c67.w-1devstudio data: blob: 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'"
            )
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
            // A workspace is an id: no other folder of the design root.
            "moonlet-design://%2e%2e/w2/systems/s/styles.css",
            "moonlet-design://w1%2fx/systems/s/styles.css",
        ] {
            assert_eq!(target(bad), None, "{bad}");
        }
    }

    #[test]
    fn only_a_file_that_is_inside_the_workspaces_folder_when_opened_is_read() {
        let design = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let w1 = design.path().join("w1");
        std::fs::create_dir(&w1).unwrap();
        std::fs::write(w1.join("card.html"), "<p>card</p>").unwrap();
        std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), w1.join("link.html"))
            .unwrap();
        std::os::unix::fs::symlink(outside.path(), w1.join("dir")).unwrap();
        // A workspace folder that is a link, swapped in after the daemon checked.
        std::os::unix::fs::symlink(outside.path(), design.path().join("w2")).unwrap();
        // Another workspace's file is not this one's either.
        std::fs::create_dir(design.path().join("w3")).unwrap();
        std::fs::write(design.path().join("w3/card.html"), "<p>w3</p>").unwrap();
        assert_eq!(
            read_inside(design.path(), "w1", &w1.join("card.html")).unwrap(),
            b"<p>card</p>"
        );
        assert!(read_inside(design.path(), "w1", &w1.join("link.html")).is_err());
        assert!(read_inside(design.path(), "w1", &w1.join("dir/secret.txt")).is_err());
        assert!(read_inside(design.path(), "w2", &design.path().join("w2/secret.txt")).is_err());
        assert!(read_inside(design.path(), "w1", &design.path().join("w3/card.html")).is_err());
    }

    #[test]
    fn every_file_is_served_with_the_no_network_policy_of_its_workspace() {
        let h = headers("text/html; charset=utf-8", "w-1devstudio");
        let get = |name: &str| h.iter().find(|(n, _)| *n == name).map(|(_, v)| v.as_str());
        assert_eq!(get("Content-Type"), Some("text/html; charset=utf-8"));
        assert_eq!(
            get("Content-Security-Policy"),
            Some(
                "default-src moonlet-design://w-1devstudio data: blob: 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'"
            )
        );
    }

    #[test]
    fn the_measuring_script_is_served_only_when_the_render_page_asks() {
        assert!(measuring(
            "moonlet-design://w1/systems/s/components/buttons/button/button.html?moonlet-render=3"
        ));
        assert!(measuring(
            "moonlet-design://w1/systems/s/components/buttons/button/button.html?moonlet-render=3&variant=buttons%2Fbutton%2Fghost"
        ));
        for plain in [
            "moonlet-design://w1/systems/s/components/buttons/button/button.html",
            "moonlet-design://w1/systems/s/components/buttons/button/button.html?v=2",
            "moonlet-design://w1/systems/s/components/buttons/button/button.html#moonlet-render=3",
            "moonlet-design://w1/systems/s/x.html?not-moonlet-render=3",
        ] {
            assert!(!measuring(plain), "{plain}");
        }
    }

    #[test]
    fn the_bridge_is_served_only_when_the_canvas_asks() {
        assert!(bridging(
            "moonlet-design://0f3c2a1b4d5e6f70.w1/designs/settings-page/pages/index.html?moonlet-bridge=1"
        ));
        assert!(bridging(
            "moonlet-design://0f3c2a1b4d5e6f70.w1/designs/settings-page/pages/index.html?v=3&moonlet-bridge=1"
        ));
        for plain in [
            "moonlet-design://0f3c2a1b4d5e6f70.w1/designs/settings-page/pages/index.html",
            "moonlet-design://0f3c2a1b4d5e6f70.w1/designs/settings-page/pages/index.html?v=3",
            "moonlet-design://0f3c2a1b4d5e6f70.w1/designs/settings-page/pages/index.html#moonlet-bridge=1",
            "moonlet-design://0f3c2a1b4d5e6f70.w1/designs/settings-page/pages/index.html?not-moonlet-bridge=1",
            "moonlet-design://0f3c2a1b4d5e6f70.w1/systems/s/components/buttons/button/button.html?moonlet-render=3",
        ] {
            assert!(!bridging(plain), "{plain}");
        }
    }

    #[test]
    fn the_measuring_script_goes_first_in_the_head_and_never_before_the_doctype() {
        let s = "<script>measure()</script>";
        let with_script = |html: &str, script: &str| {
            String::from_utf8(with_script(html.as_bytes(), script.as_bytes())).unwrap()
        };
        assert_eq!(
            with_script(
                "<!-- @dsCard group=\"Buttons\" -->\n<!doctype html>\n<html><HEAD lang=\"en\"><link rel=\"stylesheet\" href=\"../../../styles.css\"></head><body></body></html>\n",
                s
            ),
            "<!-- @dsCard group=\"Buttons\" -->\n<!doctype html>\n<html><HEAD lang=\"en\"><script>measure()</script><link rel=\"stylesheet\" href=\"../../../styles.css\"></head><body></body></html>\n"
        );
        // A <header> is not the head.
        assert_eq!(
            with_script(
                "<!DOCTYPE html><html lang=\"en\"><body><header>Top</header></body></html>",
                s
            ),
            "<!DOCTYPE html><html lang=\"en\"><script>measure()</script><body><header>Top</header></body></html>"
        );
        assert_eq!(
            with_script(
                "<!-- @dsCard group=\"Buttons\" -->\n<!doctype html>\n<p>Run</p>",
                s
            ),
            "<!-- @dsCard group=\"Buttons\" -->\n<!doctype html><script>measure()</script>\n<p>Run</p>"
        );
        assert_eq!(
            with_script("<p>Run</p>", s),
            "<script>measure()</script><p>Run</p>"
        );
    }

    #[test]
    fn a_card_that_is_not_utf_8_keeps_its_bytes_around_the_script() {
        // Latin-1 "Café": 0xE9 is not UTF-8.
        let card =
            b"<!doctype html><html><head><title>Caf\xe9</title></head><body>Caf\xe9</body></html>";
        assert_eq!(
            with_script(card, b"<script>measure()</script>"),
            b"<!doctype html><html><head><script>measure()</script><title>Caf\xe9</title></head><body>Caf\xe9</body></html>".to_vec()
        );
    }
}
