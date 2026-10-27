//! Updating this host to the release a Mac asks for (X69): download it from
//! GitHub, check its signature against moonlet's updater key, put the new
//! binaries where this daemon runs from, then hand every session to the new
//! `moonletd` (S3).
//!
//! Two layouts can update themselves: `~/.moonlet/bin` (`install.sh`, X58),
//! which takes `moonlet-<os>-<arch>.tar.gz`, and a Mac app bundle, which takes
//! the archive the app's own updater uses (X35).

use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use moonlet_proto::RpcError;
use serde_json::Value;

use crate::daemon::Daemon;

/// Where releases are published, one folder per tag.
const RELEASES: &str = "https://github.com/1devstudio/moonlet/releases/download";

/// The app's `tauri.conf.json`, whose updater key signs every release.
const TAURI_CONF: &str = include_str!("../../../apps/desktop/src-tauri/tauri.conf.json");

/// Where this daemon runs from, so where the new release goes.
#[derive(Debug, Clone, PartialEq)]
pub enum Layout {
    /// `<moonlet home>/bin`, holding `moonletd` and `moonlet`.
    Bin(PathBuf),
    /// A Mac app bundle (`…/moonlet.app`).
    Bundle(PathBuf),
}

/// The layout of a daemon at `exe` with the moonlet home `home`; `None` for
/// anything else (a dev build, a test binary).
pub fn layout(exe: &Path, home: &Path) -> Option<Layout> {
    let dir = exe.parent()?;
    if home.canonicalize().ok().is_some_and(|h| dir == h.join("bin")) {
        return Some(Layout::Bin(dir.to_path_buf()));
    }
    let contents = dir.parent()?;
    let app = contents.parent()?;
    let bundle = dir.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && app.extension().is_some_and(|e| e == "app");
    bundle.then(|| Layout::Bundle(app.to_path_buf()))
}

/// `X.Y.Z` as numbers; `None` for anything else.
pub fn version(s: &str) -> Option<(u64, u64, u64)> {
    let mut parts = s.split('.').map(|p| {
        (!p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
            .then(|| p.parse::<u64>().ok())
            .flatten()
    });
    let v = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(v)
}

/// The archive and its signature's names in release `layout`, for this
/// machine. A bundle's come from the release's `latest.json`.
fn bin_asset() -> String {
    format!("moonlet-{}-{}.tar.gz", std::env::consts::OS, std::env::consts::ARCH)
}

/// `latest.json`'s key for this Mac.
fn updater_platform() -> String {
    format!("darwin-{}", std::env::consts::ARCH)
}

fn err(code: &str, message: impl Into<String>) -> RpcError {
    RpcError::new(code, message)
}

/// The release folder and key: GitHub and the app's key, except in debug
/// builds, where tests point both elsewhere.
fn source() -> Result<(String, minisign_verify::PublicKey), RpcError> {
    let test = |k: &str| {
        if cfg!(debug_assertions) {
            std::env::var(k).ok().filter(|v| !v.is_empty())
        } else {
            None
        }
    };
    let releases = test("MOONLET_RELEASES").unwrap_or_else(|| RELEASES.into());
    let key = match test("MOONLET_RELEASE_KEY") {
        Some(k) => k,
        None => {
            let conf: Value = serde_json::from_str(TAURI_CONF).map_err(|e| err("internal", e.to_string()))?;
            conf["plugins"]["updater"]["pubkey"].as_str().unwrap_or_default().to_string()
        }
    };
    Ok((releases.trim_end_matches('/').to_string(), public_key(&key)?))
}

/// A key as Tauri writes it: base64 of minisign's public key file.
fn public_key(b64: &str) -> Result<minisign_verify::PublicKey, RpcError> {
    let text = decode(b64).ok_or_else(|| err("internal", "the release key cannot be read"))?;
    minisign_verify::PublicKey::decode(&text).map_err(|e| err("internal", format!("the release key cannot be read: {e}")))
}

fn decode(b64: &str) -> Option<String> {
    let raw = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
    String::from_utf8(raw).ok()
}

/// Checks `data` against `signature` (base64 of a minisign signature, as
/// Tauri's signer writes it).
pub fn verify(key: &minisign_verify::PublicKey, data: &[u8], signature: &str) -> Result<(), RpcError> {
    let bad = || err("bad_signature", "the release's signature does not match moonlet's key");
    let text = decode(signature).ok_or_else(bad)?;
    let sig = minisign_verify::Signature::decode(&text).map_err(|_| bad())?;
    key.verify(data, &sig, false).map_err(|_| bad())
}

async fn fetch(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, RpcError> {
    let failed = |e: String| err("download_failed", format!("{url}: {e}"));
    let resp = client.get(url).send().await.map_err(|e| failed(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(failed(resp.status().to_string()));
    }
    Ok(resp.bytes().await.map_err(|e| failed(e.to_string()))?.to_vec())
}

/// Downloads release `version`'s archive for `layout` and checks it.
async fn download(layout: &Layout, version: &str) -> Result<Vec<u8>, RpcError> {
    let (releases, key) = source()?;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| err("download_failed", e.to_string()))?;
    let base = format!("{releases}/v{version}");
    let (url, signature) = match layout {
        Layout::Bin(_) => {
            let url = format!("{base}/{}", bin_asset());
            let sig = fetch(&client, &format!("{url}.sig")).await?;
            (url, String::from_utf8_lossy(&sig).to_string())
        }
        Layout::Bundle(_) => {
            let latest = fetch(&client, &format!("{base}/latest.json")).await?;
            let latest: Value = serde_json::from_slice(&latest)
                .map_err(|e| err("download_failed", format!("latest.json: {e}")))?;
            let entry = &latest["platforms"][updater_platform()];
            let (Some(url), Some(sig)) = (entry["url"].as_str(), entry["signature"].as_str()) else {
                return Err(err("download_failed", format!("release {version} has no {}", updater_platform())));
            };
            (url.to_string(), sig.to_string())
        }
    };
    let data = fetch(&client, &url).await?;
    verify(&key, &data, &signature)?;
    Ok(data)
}

fn install_failed(e: impl std::fmt::Display) -> RpcError {
    err("install_failed", e.to_string())
}

/// Puts `moonletd` and `moonlet` from `archive` into `dir`, each written
/// beside its place first and then renamed over it, as `install.sh` does.
pub fn install_bin(dir: &Path, archive: &[u8]) -> Result<PathBuf, RpcError> {
    let mut found = std::collections::HashMap::new();
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
    for entry in tar.entries().map_err(install_failed)? {
        let mut entry = entry.map_err(install_failed)?;
        let path = entry.path().map_err(install_failed)?.to_path_buf();
        let name = path.to_string_lossy().trim_start_matches("./").to_string();
        if name == "moonletd" || name == "moonlet" {
            let mut data = Vec::new();
            entry.read_to_end(&mut data).map_err(install_failed)?;
            found.insert(name, data);
        }
    }
    for name in ["moonletd", "moonlet"] {
        if !found.contains_key(name) {
            return Err(install_failed(format!("the release has no {name}")));
        }
    }
    for (name, data) in &found {
        let new = dir.join(format!("{name}.new"));
        std::fs::write(&new, data).map_err(install_failed)?;
        std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o700)).map_err(install_failed)?;
    }
    for name in found.keys() {
        std::fs::rename(dir.join(format!("{name}.new")), dir.join(name)).map_err(install_failed)?;
    }
    Ok(dir.join("moonletd"))
}

/// The bundle a swap moved aside: `<app>.old-<pid>`.
fn aside(app: &Path) -> PathBuf {
    let name = app.file_name().unwrap_or_default().to_string_lossy();
    app.with_file_name(format!("{name}.old-{}", std::process::id()))
}

/// Unpacks the app archive next to `app` and swaps the two bundles. Returns
/// where the old bundle went, to [`restore_bundle`] or remove.
pub fn install_bundle(app: &Path, archive: &[u8]) -> Result<PathBuf, RpcError> {
    let parent = app.parent().ok_or_else(|| install_failed("the app has no folder"))?;
    let name = app.file_name().unwrap_or_default().to_string_lossy().to_string();
    let unpacked = parent.join(format!(".{name}.update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&unpacked);
    let result = (|| {
        std::fs::create_dir(&unpacked).map_err(install_failed)?;
        tar::Archive::new(flate2::read::GzDecoder::new(archive))
            .unpack(&unpacked)
            .map_err(install_failed)?;
        let new = std::fs::read_dir(&unpacked)
            .map_err(install_failed)?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|e| e == "app") && p.is_dir())
            .ok_or_else(|| install_failed("the release has no app"))?;
        if !new.join("Contents/MacOS/moonletd").is_file() {
            return Err(install_failed("the release's app has no moonletd"));
        }
        let old = aside(app);
        let _ = std::fs::remove_dir_all(&old);
        std::fs::rename(app, &old).map_err(install_failed)?;
        if let Err(e) = std::fs::rename(&new, app) {
            let _ = std::fs::rename(&old, app);
            return Err(install_failed(e));
        }
        Ok(old)
    })();
    let _ = std::fs::remove_dir_all(&unpacked);
    result
}

/// Puts the bundle moved aside back, after a failed handoff.
pub fn restore_bundle(app: &Path, old: &Path) {
    let failed = app.with_file_name(format!(
        ".{}.failed-{}",
        app.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    if std::fs::rename(app, &failed).is_ok() && std::fs::rename(old, app).is_ok() {
        let _ = std::fs::remove_dir_all(&failed);
    } else {
        tracing::error!(app = %app.display(), old = %old.display(), "cannot put the old app back");
    }
}

/// Removes bundles earlier updates moved aside and could not remove (the
/// old daemon exits right after its handoff).
pub fn clean_leftovers() {
    let Ok(exe) = std::env::current_exe().and_then(|e| e.canonicalize()) else { return };
    let Some(Layout::Bundle(app)) = layout(&exe, &moonlet_core::paths::home()) else { return };
    let (Some(parent), Some(name)) = (app.parent(), app.file_name()) else { return };
    let prefix = format!("{}.old-", name.to_string_lossy());
    for entry in std::fs::read_dir(parent).into_iter().flatten().filter_map(Result::ok) {
        let n = entry.file_name().to_string_lossy().to_string();
        if n.strip_prefix(&prefix).is_some_and(|pid| !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit())) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// `daemon.update {version}`: installs `version` and starts the handoff;
/// answers `{from, to}` once the new files are in place.
pub async fn update(daemon: &Arc<Daemon>, version: &str) -> Result<Value, RpcError> {
    let from = env!("CARGO_PKG_VERSION");
    let Some(wanted) = self::version(version) else {
        return Err(err("invalid_params", format!("not a version: {version}")));
    };
    if wanted <= self::version(from).unwrap_or_default() {
        return Err(err("not_newer", format!("moonlet {from} is not older than {version}")));
    }
    let exe = std::env::current_exe()
        .and_then(|e| e.canonicalize())
        .map_err(|e| err("unsupported", e.to_string()))?;
    let Some(layout) = layout(&exe, &moonlet_core::paths::home()) else {
        return Err(err("unsupported", format!("moonletd runs from {}, which it cannot update", exe.display())));
    };
    if !daemon.begin_upgrade() {
        return Err(err("busy", "an update or upgrade is already in progress"));
    }
    let installed = async {
        let archive = download(&layout, version).await?;
        match &layout {
            Layout::Bin(dir) => install_bin(dir, &archive).map(|b| (b, None)),
            Layout::Bundle(app) => {
                install_bundle(app, &archive).map(|old| (app.join("Contents/MacOS/moonletd"), Some(old)))
            }
        }
    }
    .await;
    let (binary, old) = match installed {
        Ok(v) => v,
        Err(e) => {
            daemon.end_upgrade();
            return Err(e);
        }
    };
    tracing::info!(from, to = version, binary = %binary.display(), "updating");
    let me = daemon.clone();
    let app = match &layout {
        Layout::Bundle(app) => Some(app.clone()),
        Layout::Bin(_) => None,
    };
    tokio::spawn(async move {
        let result = crate::upgrade::hand_off_claimed(me, Some(binary)).await;
        match (result, app, old) {
            (Ok(()), Some(_), Some(old)) => {
                let _ = std::fs::remove_dir_all(&old);
            }
            (Err(e), app, old) => {
                tracing::error!("update failed, still serving: {e:#}");
                if let (Some(app), Some(old)) = (app, old) {
                    restore_bundle(&app, &old);
                }
            }
            _ => {}
        }
    });
    Ok(serde_json::json!({ "from": from, "to": version }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_three_numbers() {
        assert_eq!(version("0.1.34"), Some((0, 1, 34)));
        assert_eq!(version("10.0.0"), Some((10, 0, 0)));
        for bad in ["", "0.1", "0.1.34.1", "v0.1.34", "0.1.x", "0..1", "0.1.34-beta", "../0.1"] {
            assert_eq!(version(bad), None, "{bad}");
        }
        assert!(version("0.1.34") > version("0.1.9"));
    }

    #[test]
    fn a_daemon_updates_itself_only_from_bin_or_an_app_bundle() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path().canonicalize().unwrap();
        assert_eq!(layout(&home.join("bin/moonletd"), &home), Some(Layout::Bin(home.join("bin"))));
        assert_eq!(
            layout(Path::new("/Applications/moonlet.app/Contents/MacOS/moonletd"), &home),
            Some(Layout::Bundle("/Applications/moonlet.app".into()))
        );
        assert_eq!(layout(Path::new("/src/moonlet/target/debug/moonletd"), &home), None);
        assert_eq!(layout(Path::new("/opt/moonlet/Contents/MacOS/moonletd"), &home), None);
    }

    /// A gzipped tar of `files`, paths as given.
    fn tgz(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
        for (path, data) in files {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o755);
            h.set_cksum();
            tar.append_data(&mut h, path, *data).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn an_app_bundle_is_swapped_and_the_old_one_can_be_put_back() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("moonlet.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/MacOS/moonletd"), "old").unwrap();
        let archive = tgz(&[("moonlet.app/Contents/MacOS/moonletd", b"new")]);

        let old = install_bundle(&app, &archive).unwrap();
        assert_eq!(std::fs::read_to_string(app.join("Contents/MacOS/moonletd")).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(old.join("Contents/MacOS/moonletd")).unwrap(), "old");

        restore_bundle(&app, &old);
        assert_eq!(std::fs::read_to_string(app.join("Contents/MacOS/moonletd")).unwrap(), "old");
        let mut left: Vec<String> =
            std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into()).collect();
        left.sort();
        assert_eq!(left, ["moonlet.app"]);
    }

    #[test]
    fn an_archive_without_an_app_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("moonlet.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/MacOS/moonletd"), "old").unwrap();

        let e = install_bundle(&app, &tgz(&[("README", b"hi")])).unwrap_err();
        assert_eq!((e.code.as_str(), e.message.as_str()), ("install_failed", "the release has no app"));
        assert_eq!(std::fs::read_to_string(app.join("Contents/MacOS/moonletd")).unwrap(), "old");
        let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(left.len(), 1);
    }

    #[test]
    fn the_app_key_is_read_from_tauri_conf() {
        let key = public_key(
            serde_json::from_str::<Value>(TAURI_CONF).unwrap()["plugins"]["updater"]["pubkey"].as_str().unwrap(),
        );
        assert!(key.is_ok());
    }
}
