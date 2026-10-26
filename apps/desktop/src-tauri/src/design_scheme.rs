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
//! the path's, whichever key asks for it, except on a snapshot's host
//! (`snapshotPageUrl`, X65), whose key, `<page key>s<folder key>`, names the
//! snapshot: there only that snapshot's files and design systems' are
//! served ([`serves`]), so a link in a snapshot's page never shows the
//! current page in its preview.
//!
//! A session design's files (X65) are in its session's worktree, asked on
//! `moonlet-design://<page key>.s-<session>/<path>`, `path` relative to the
//! worktree's design folder (`<slug>/pages/index.html`), and served through
//! `design.file {session, path}`, never outside the folder it names. A
//! workspace id never starts with `s-` (it is hex), so the two never meet.

/// What a `moonlet-design://` URL names: the host it was asked on (the
/// workspace, or a card's key and the workspace), the design folder it is
/// in, and the path (decoded, relative to that folder).
#[derive(Debug, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    /// The card's or the page's key, the host's first label, if it has one.
    pub key: Option<String>,
    pub place: Place,
    pub path: String,
}

/// Whose design folder a URL names: a workspace's, under the design root,
/// or a session's worktree's (X65).
#[derive(Debug, PartialEq, Eq)]
pub enum Place {
    Workspace(String),
    Session(String),
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
/// that is neither `<workspace>` nor `<card key>.<workspace>`, nor a
/// session's `<page key>.s-<session>` (X65), which always has its key.
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
    // A card's or a page's key is a DNS label: lowercase letters and
    // digits, 1 to 63.
    let (key, place) = match host.split('.').collect::<Vec<_>>()[..] {
        [place] => (None, place),
        [key, place]
            if (1..=63).contains(&key.len())
                && key
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) =>
        {
            (Some(key.to_string()), place)
        }
        _ => return None,
    };
    // A workspace or a session is an id, never another folder.
    let id = |id: &str| {
        let id = decode(id)?;
        let ok = !id.is_empty()
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        ok.then_some(id)
    };
    let place = match place.strip_prefix("s-") {
        Some(_) if key.is_none() => return None,
        Some(session) => Place::Session(id(session)?),
        None => Place::Workspace(id(place)?),
    };
    Some(Target {
        host: host.to_string(),
        key,
        place,
        path: parts.join("/"),
    })
}

/// Whether a file of `path` is served on `host` (X65): any is, but on a
/// snapshot's host, whose key is its page's key, an `s`, and its folder's,
/// `designs/<slug>@<n>` (a session design's `<slug>@<n>`), as the 64-bit
/// FNV-1a hash in hex: there only that folder's files, and for a workspace
/// design its design systems' (the page's styles; a session design's are in
/// the snapshot's `system/`), are served. No other key has an `s`, being
/// hex; one with an `s` naming no folder serves nothing.
pub fn serves(t: &Target) -> bool {
    let (Some(key), path) = (&t.key, t.path.as_str()) else {
        return true;
    };
    let Some((page, folder)) = key.split_once('s') else {
        return true;
    };
    let hex = |k: &str| k.len() == 16 && k.bytes().all(|b| b.is_ascii_hexdigit());
    if !hex(page) || !hex(folder) {
        return false;
    }
    if let Place::Session(_) = t.place {
        let named = path.split('/').next().unwrap_or_default();
        return named.contains('@') && fnv1a64(named) == folder;
    }
    if path.starts_with("systems/") {
        return true;
    }
    let mut parts = path.splitn(3, '/');
    match (parts.next(), parts.next()) {
        (Some("designs"), Some(named)) => {
            named.contains('@') && fnv1a64(&format!("designs/{named}")) == folder
        }
        _ => false,
    }
}

/// The 64-bit FNV-1a hash of `text`'s UTF-8 bytes, as 16 lowercase hex
/// digits, as `designUrl` in `src/lib/designView.ts` makes a host's key.
fn fnv1a64(text: &str) -> String {
    let hash = text.bytes().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
    });
    format!("{hash:016x}")
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
    let Some(t) = target(url) else {
        return reply(400, "not a design file");
    };
    // A snapshot's frame, led away by a link in its page, shows no other.
    if !serves(&t) {
        return reply(403, "a snapshot's preview shows only its own files");
    }
    let Target { host, place, path, .. } = t;
    let hosts = app.state::<Arc<crate::hosts::HostManager>>();
    let Ok(local) = hosts.get("local") else {
        return reply(404, "the daemon is not running");
    };
    let params = match &place {
        Place::Workspace(workspace) => serde_json::json!({ "workspace": workspace, "path": path }),
        Place::Session(session) => serde_json::json!({ "session": session, "path": path }),
    };
    let file = match local
        .request(moonlet_proto::methods::DESIGN_FILE, params)
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
    // after the daemon resolved it leads nowhere outside the workspace's
    // folder, or the folder a session design's file must be inside, which
    // the daemon gives as `root`.
    let real = std::path::PathBuf::from(real);
    let read = match place {
        Place::Workspace(ws) => {
            let design = moonlet_core::paths::home().join("design");
            tokio::task::spawn_blocking(move || read_inside(&design, &ws, &real)).await
        }
        Place::Session(_) => {
            let Some(root) = file["root"].as_str().map(std::path::PathBuf::from) else {
                return reply(404, "no such design file");
            };
            tokio::task::spawn_blocking(move || read_within(&root, &real)).await
        }
    };
    let Ok(Ok(body)) = read else {
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
    read_opened(&std::fs::canonicalize(design)?.join(workspace), path)
}

/// The bytes of `path`, opened first and then checked: the file opened must
/// be inside `root`, measured from its real path, as `read_inside` does for
/// a workspace's folder. A session design's file is checked so against the
/// folder `design.file` gives as its `root` (X65).
pub fn read_within(root: &std::path::Path, path: &std::path::Path) -> std::io::Result<Vec<u8>> {
    read_opened(&std::fs::canonicalize(root)?, path)
}

/// The bytes of `path` once opened, when the file opened is inside `root`
/// (a real path).
fn read_opened(root: &std::path::Path, path: &std::path::Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    if !opened_path(&file)?.starts_with(root) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "outside the design's folder",
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

    /// Whether `path` is served on `host`, as `serve` asks for the target
    /// the URL names; a URL that names none is not.
    fn serves_at(host: &str, path: &str) -> bool {
        target(&format!("moonlet-design://{host}/{path}")).is_some_and(|t| serves(&t))
    }

    #[test]
    fn a_url_names_a_workspace_and_a_file_of_its_design_folder() {
        let t = |w: &str, p: &str| {
            Some(Target {
                host: w.to_string(),
                key: None,
                place: Place::Workspace(w.to_string()),
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
                key: Some("5a1c3e0f9b2d4c67".to_string()),
                place: Place::Workspace("w-1devstudio".to_string()),
                path: "systems/storefront/components/buttons/button/button.html".to_string(),
            })
        );
        // The card's stylesheet, asked on the card's host.
        assert_eq!(
            target("moonlet-design://5a1c3e0f9b2d4c67.w1/systems/s/styles.css"),
            Some(Target {
                host: "5a1c3e0f9b2d4c67.w1".to_string(),
                key: Some("5a1c3e0f9b2d4c67".to_string()),
                place: Place::Workspace("w1".to_string()),
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
    fn a_snapshots_host_serves_only_that_snapshots_files_and_design_systems() {
        // As `snapshotPageUrl` asks for snapshot 3's pages of settings-page.
        for host in [
            "bde3977b4fe8bcc8sc159239263e42bb1.w-1devstudio",
            "d33e539a169502d6sc159239263e42bb1.w-1devstudio",
        ] {
            for path in [
                "designs/settings-page@3/pages/index.html",
                "designs/settings-page@3/pages/git-a.html",
                "designs/settings-page@3/assets/logo.svg",
                "systems/moonlet-desktop/styles.css",
            ] {
                assert!(serves_at(host, path), "{host} {path}");
            }
            // The current design's page, which a link in the snapshot's page
            // could lead the frame to, another snapshot, or another design.
            for path in [
                "designs/settings-page/pages/index.html",
                "designs/settings-page/assets/logo.svg",
                "designs/settings-page@2/pages/index.html",
                "designs/settings-page@31/pages/index.html",
                "designs/billing@3/pages/index.html",
                "comments.json",
            ] {
                assert!(!serves_at(host, path), "{host} {path}");
            }
        }
        // A design's own page, a card, and a workspace's host serve as they did.
        for (host, path) in [
            (
                "77b546eb07dc1f7b.w-1devstudio",
                "designs/settings-page/pages/index.html",
            ),
            (
                "77b546eb07dc1f7b.w-1devstudio",
                "designs/settings-page@3/pages/index.html",
            ),
            (
                "de8ad9aca07be977.w-1devstudio",
                "systems/moonlet-desktop/styles.css",
            ),
            ("w-1devstudio", "designs/settings-page/pages/index.html"),
        ] {
            assert!(serves_at(host, path), "{host} {path}");
        }
        // A key with an s that names no snapshot's folder serves nothing.
        for host in [
            "s.w1",
            "sc159239263e42bb1.w1",
            "bde3977b4fe8bcc8s.w1",
            "bde3977b4fe8bcc8sc159239263e42bb1s.w1",
        ] {
            assert!(
                !serves_at(host, "systems/moonlet-desktop/styles.css"),
                "{host}"
            );
        }
    }

    #[test]
    fn a_session_designs_own_host_names_its_key_and_its_session() {
        // As `pageUrl({session}, …)` asks for a session design's page.
        assert_eq!(
            target(
                "moonlet-design://19a1c555a197e847.s-4f2a9c1e7b3d/settings-page/pages/index.html?v=4&moonlet-bridge=1"
            ),
            Some(Target {
                host: "19a1c555a197e847.s-4f2a9c1e7b3d".to_string(),
                key: Some("19a1c555a197e847".to_string()),
                place: Place::Session("4f2a9c1e7b3d".to_string()),
                path: "settings-page/pages/index.html".to_string(),
            })
        );
        // Its pinned styles, asked on the page's host.
        assert_eq!(
            target("moonlet-design://19a1c555a197e847.s-4f2a9c1e7b3d/settings-page/system/styles.css"),
            Some(Target {
                host: "19a1c555a197e847.s-4f2a9c1e7b3d".to_string(),
                key: Some("19a1c555a197e847".to_string()),
                place: Place::Session("4f2a9c1e7b3d".to_string()),
                path: "settings-page/system/styles.css".to_string(),
            })
        );
        // A snapshot's page.
        assert_eq!(
            target(
                "moonlet-design://315894b4a2cd5984saa0232c623a69ded.s-4f2a9c1e7b3d/settings-page%403/pages/index.html"
            ),
            Some(Target {
                host: "315894b4a2cd5984saa0232c623a69ded.s-4f2a9c1e7b3d".to_string(),
                key: Some("315894b4a2cd5984saa0232c623a69ded".to_string()),
                place: Place::Session("4f2a9c1e7b3d".to_string()),
                path: "settings-page@3/pages/index.html".to_string(),
            })
        );
        for bad in [
            // A session's host always has its page's key.
            "moonlet-design://s-4f2a9c1e7b3d/settings-page/pages/index.html",
            // No session, or one that is not an id.
            "moonlet-design://19a1c555a197e847.s-/settings-page/pages/index.html",
            "moonlet-design://19a1c555a197e847.s-4f2a%2fx/settings-page/pages/index.html",
            "moonlet-design://19a1c555a197e847.s-%2e%2e/settings-page/pages/index.html",
            // A session's page leaves its design folder no more than a workspace's.
            "moonlet-design://19a1c555a197e847.s-4f2a9c1e7b3d/settings-page/../../.git/config",
        ] {
            assert_eq!(target(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_session_designs_page_may_load_only_its_hosts_files() {
        let h = headers("text/html; charset=utf-8", "19a1c555a197e847.s-4f2a9c1e7b3d");
        let get = |name: &str| h.iter().find(|(n, _)| *n == name).map(|(_, v)| v.as_str());
        assert_eq!(
            get("Content-Security-Policy"),
            Some(
                "default-src moonlet-design://19a1c555a197e847.s-4f2a9c1e7b3d data: blob: 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'"
            )
        );
    }

    #[test]
    fn a_session_designs_snapshot_host_serves_only_that_snapshots_files() {
        // As `snapshotPageUrl({session}, …)` asks for snapshot 3's pages of settings-page.
        for host in [
            "315894b4a2cd5984saa0232c623a69ded.s-4f2a9c1e7b3d",
            "509b21765e7e6062saa0232c623a69ded.s-4f2a9c1e7b3d",
        ] {
            for path in [
                "settings-page@3/pages/index.html",
                "settings-page@3/pages/git-a.html",
                "settings-page@3/assets/logo.svg",
                "settings-page@3/system/styles.css",
            ] {
                assert!(serves_at(host, path), "{host} {path}");
            }
            for path in [
                "settings-page/pages/index.html",
                "settings-page/system/styles.css",
                "settings-page@2/pages/index.html",
                "billing@3/pages/index.html",
                "systems/moonlet-desktop/styles.css",
            ] {
                assert!(!serves_at(host, path), "{host} {path}");
            }
        }
        // A session design's own page serves as a workspace design's does.
        assert!(serves_at("19a1c555a197e847.s-4f2a9c1e7b3d", "settings-page/pages/index.html"));
    }

    #[test]
    fn only_a_file_inside_the_root_design_file_gives_when_opened_is_read() {
        let worktree = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let design = worktree.path().join("docs/design");
        std::fs::create_dir_all(design.join("settings-page/pages")).unwrap();
        std::fs::write(design.join("settings-page/pages/index.html"), "<p>page</p>").unwrap();
        std::fs::write(worktree.path().join("secret.txt"), "secret").unwrap();
        std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        // A link swapped in after the daemon resolved the file.
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), design.join("settings-page/pages/link.html")).unwrap();
        std::os::unix::fs::symlink(worktree.path().join("secret.txt"), design.join("settings-page/pages/up.html")).unwrap();
        assert_eq!(
            read_within(&design, &design.join("settings-page/pages/index.html")).unwrap(),
            b"<p>page</p>"
        );
        assert!(read_within(&design, &design.join("settings-page/pages/link.html")).is_err());
        assert!(read_within(&design, &design.join("settings-page/pages/up.html")).is_err());
        assert!(read_within(&design, &worktree.path().join("secret.txt")).is_err());
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
