//! Updating this host to the release a Mac asks for (X69): download it from
//! GitHub, check its signature against moonlet's updater key, put the new
//! binaries where this daemon runs from, then hand every session to the new
//! `moonletd` (S3).
//!
//! Two layouts can update themselves: `~/.moonlet/bin` (`install.sh`, X58),
//! which takes `moonlet-<os>-<arch>.tar.gz`, and a Mac app bundle, which takes
//! the archive the app's own updater uses (X35).

use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use moonlet_proto::RpcError;
use serde_json::Value;

use crate::daemon::Daemon;
use moonlet_proto::types::DaemonUpdated;

/// Where releases are published, one folder per tag.
const RELEASES: &str = "https://github.com/1devstudio/moonlet/releases/download";

/// How long the handoff waits after a reply only queued (`Handoff::start_after`),
/// so it reaches the client before the old daemon exits.
pub const REPLY_GRACE: Duration = Duration::from_millis(300);

/// How long a download and its check may take in all; a Mac waits a minute
/// longer for the answer (`moonlet_link::tailnet::update`).
const DOWNLOAD_LIMIT: Duration = Duration::from_secs(300);

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
    moonlet_core::bundle::app_of(exe).map(Layout::Bundle)
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

/// The archive a daemon in `~/.moonlet/bin` takes, for this machine; its
/// signature is `<archive>.sig`. A bundle's comes from `latest.json`.
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

/// Checks `archive` against `<archive>.sig` with the release key.
pub fn verify_file(archive: &Path) -> anyhow::Result<()> {
    let mut sig = archive.as_os_str().to_owned();
    sig.push(".sig");
    let sig = PathBuf::from(sig);
    let signature = std::fs::read_to_string(&sig).map_err(|e| anyhow::anyhow!("{}: {e}", sig.display()))?;
    let data = std::fs::read(archive).map_err(|e| anyhow::anyhow!("{}: {e}", archive.display()))?;
    let (_, key) = source()?;
    verify(&key, &data, &signature)?;
    Ok(())
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
    let (url, signature) = match layout {
        Layout::Bin(_) => {
            let url = release_url(&releases, version, &bin_asset());
            let sig = fetch(&client, &format!("{url}.sig")).await?;
            (url, String::from_utf8_lossy(&sig).to_string())
        }
        Layout::Bundle(_) => {
            let latest = fetch(&client, &release_url(&releases, version, "latest.json")).await?;
            let latest: Value = serde_json::from_slice(&latest)
                .map_err(|e| err("download_failed", format!("latest.json: {e}")))?;
            let entry = &latest["platforms"][updater_platform()];
            let (Some(url), Some(sig)) = (entry["url"].as_str(), entry["signature"].as_str()) else {
                return Err(err("download_failed", format!("release {version} has no {}", updater_platform())));
            };
            // The signature says moonlet made the archive, not which release
            // it is: take it only from the release asked for.
            if !in_release(url, &releases, version) {
                return Err(err("download_failed", format!("latest.json points outside release {version}: {url}")));
            }
            (url.to_string(), sig.to_string())
        }
    };
    let data = fetch(&client, &url).await?;
    verify(&key, &data, &signature)?;
    Ok(data)
}

/// File `name` of release `version`.
fn release_url(releases: &str, version: &str, name: &str) -> String {
    format!("{releases}/v{version}/{name}")
}

/// Whether `url` is a file of release `version` itself.
fn in_release(url: &str, releases: &str, version: &str) -> bool {
    url.strip_prefix(&release_url(releases, version, ""))
        .is_some_and(|name| !name.is_empty() && !name.contains('/') && !name.contains(".."))
}

fn install_failed(e: impl std::fmt::Display) -> RpcError {
    err("install_failed", e.to_string())
}

/// What an install put in place: kept once the new daemon has taken over,
/// undone when the handoff fails.
#[derive(Debug)]
pub enum Installed {
    /// New binaries in `dir`; the ones they replaced kept as `<name>.prev`.
    Bin { dir: PathBuf },
    /// A swapped bundle; the old one moved aside to `old`.
    Bundle { app: PathBuf, old: PathBuf },
}

const BINARIES: [&str; 2] = ["moonletd", "moonlet"];

impl Installed {
    /// The `moonletd` to hand over to.
    pub fn binary(&self) -> PathBuf {
        match self {
            Installed::Bin { dir } => dir.join("moonletd"),
            Installed::Bundle { app, .. } => app.join("Contents/MacOS/moonletd"),
        }
    }

    /// Drops what the install replaced.
    pub fn keep(self) {
        match self {
            Installed::Bin { dir } => {
                for name in BINARIES {
                    let _ = std::fs::remove_file(prev(&dir, name));
                }
            }
            Installed::Bundle { old, .. } => {
                let _ = std::fs::remove_dir_all(old);
            }
        }
    }

    /// Puts back what the install replaced.
    pub fn undo(self) {
        match self {
            Installed::Bin { dir } => {
                for name in BINARIES {
                    if let Err(e) = std::fs::rename(prev(&dir, name), dir.join(name)) {
                        tracing::error!(name, "cannot put the old binary back: {e}");
                    }
                }
            }
            Installed::Bundle { app, old } => restore_bundle(&app, &old),
        }
    }
}

/// Where `install_bin` keeps the binary `name` it replaces.
fn prev(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.prev"))
}

/// Puts `moonletd` and `moonlet` from `archive` into `dir`, each written
/// beside its place first and then renamed over it, as `install.sh` does.
/// The replaced ones stay as `<name>.prev` until [`Installed::keep`].
pub fn install_bin(dir: &Path, archive: &[u8], version: &str) -> Result<Installed, RpcError> {
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
    for name in BINARIES {
        if !found.contains_key(name) {
            return Err(install_failed(format!("the release has no {name}")));
        }
    }
    for (name, data) in &found {
        let new = dir.join(format!("{name}.new"));
        let _ = std::fs::remove_file(&new);
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .open(&new)
            .and_then(|mut f| f.write_all(data))
            .map_err(install_failed)?;
    }
    // The signature says moonlet made it, not which release it is.
    let says = std::process::Command::new(dir.join("moonletd.new"))
        .arg("--version")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    if says != format!("moonletd {version}") {
        for name in found.keys() {
            let _ = std::fs::remove_file(dir.join(format!("{name}.new")));
        }
        let held = says.strip_prefix("moonletd ").unwrap_or("of an unknown version");
        return Err(install_failed(format!("the release holds moonletd {held}, not {version}")));
    }
    for name in BINARIES {
        let _ = std::fs::remove_file(prev(dir, name));
        if dir.join(name).exists() {
            std::fs::hard_link(dir.join(name), prev(dir, name)).map_err(install_failed)?;
        }
    }
    let installed = Installed::Bin { dir: dir.to_path_buf() };
    for name in BINARIES {
        if let Err(e) = std::fs::rename(dir.join(format!("{name}.new")), dir.join(name)) {
            // Never one new binary beside an old one.
            for name in BINARIES {
                let _ = std::fs::remove_file(dir.join(format!("{name}.new")));
            }
            installed.undo();
            return Err(install_failed(e));
        }
    }
    Ok(installed)
}

/// Where a swap moves the old bundle: `<app>.old-<pid>`.
fn aside(app: &Path) -> PathBuf {
    let name = app.file_name().unwrap_or_default().to_string_lossy();
    app.with_file_name(format!("{name}.old-{}", std::process::id()))
}

/// Whether file `name` beside `app` is a bundle [`aside`] moved there.
fn is_aside(app: &Path, name: &str) -> bool {
    let prefix = format!("{}.old-", app.file_name().unwrap_or_default().to_string_lossy());
    name.strip_prefix(&prefix).is_some_and(|pid| !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()))
}

/// Unpacks the app archive next to `app` and swaps the two bundles; the old
/// one stays aside until [`Installed::keep`] or [`Installed::undo`].
pub fn install_bundle(app: &Path, archive: &[u8], version: &str) -> Result<Installed, RpcError> {
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
        let plist = std::fs::read_to_string(new.join("Contents/Info.plist")).unwrap_or_default();
        let held = moonlet_core::bundle::short_version(&plist).unwrap_or_else(|| "of an unknown version".into());
        if held != version {
            return Err(install_failed(format!("the release holds moonlet {held}, not {version}")));
        }
        let old = aside(app);
        let _ = std::fs::remove_dir_all(&old);
        swap(&new, app).map_err(install_failed)?;
        // `new` now holds the old bundle.
        if let Err(e) = std::fs::rename(&new, &old) {
            // Put the old app back before the staging folder goes.
            if let Err(back) = swap(&new, app) {
                let kept = app.with_file_name(format!(".{name}.kept-{}", std::process::id()));
                let _ = std::fs::rename(&new, &kept);
                tracing::error!(old = %kept.display(), "cannot put the old app back: {back}");
            }
            return Err(install_failed(e));
        }
        Ok(Installed::Bundle { app: app.to_path_buf(), old })
    })();
    let _ = std::fs::remove_dir_all(&unpacked);
    result
}

/// Swaps two folders. On macOS in one step (`renamex_np` with `RENAME_SWAP`),
/// so the app's path never stands empty; elsewhere in two renames.
fn swap(a: &Path, b: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let a = std::ffi::CString::new(a.as_os_str().as_bytes())?;
        let b = std::ffi::CString::new(b.as_os_str().as_bytes())?;
        // SAFETY: two NUL-terminated paths that outlive the call.
        if unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_SWAP) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let tmp = b.with_extension("swap");
        std::fs::rename(b, &tmp)?;
        if let Err(e) = std::fs::rename(a, b) {
            let _ = std::fs::rename(&tmp, b);
            return Err(e);
        }
        std::fs::rename(&tmp, a)
    }
}

/// Puts the bundle moved aside back, after a failed handoff.
fn restore_bundle(app: &Path, old: &Path) {
    match swap(old, app) {
        // `old` now holds the bundle that failed.
        Ok(()) => {
            let _ = std::fs::remove_dir_all(old);
        }
        Err(e) => tracing::error!(app = %app.display(), old = %old.display(), "cannot put the old app back: {e}"),
    }
}

/// Where this daemon runs from, if it can update itself.
fn this_layout() -> Result<Layout, RpcError> {
    let exe = std::env::current_exe()
        .and_then(|e| e.canonicalize())
        .map_err(|e| err("unsupported", e.to_string()))?;
    layout(&exe, &moonlet_core::paths::home())
        .ok_or_else(|| err("unsupported", format!("moonletd runs from {}, which it cannot update", exe.display())))
}

/// Removes what earlier updates replaced and could not remove, as the old
/// daemon exits right after its handoff.
pub fn clean_leftovers() {
    match this_layout() {
        Ok(Layout::Bin(dir)) => Installed::Bin { dir }.keep(),
        Ok(Layout::Bundle(app)) => {
            let Some(parent) = app.parent() else { return };
            for entry in std::fs::read_dir(parent).into_iter().flatten().filter_map(Result::ok) {
                if is_aside(&app, &entry.file_name().to_string_lossy()) {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
        Err(_) => {}
    }
}

/// A handoff to an installed release, started once the reply is on its way:
/// the old daemon exits after it, cutting off any reply not yet written.
#[must_use = "a handoff the caller never starts leaves the update claimed"]
pub struct Handoff {
    daemon: Arc<Daemon>,
    installed: Installed,
}

impl Handoff {
    /// Hands every session to the new `moonletd`; keeps the install when it
    /// takes over, undoes it when it doesn't.
    pub fn start(self) {
        let Handoff { daemon, installed } = self;
        let binary = installed.binary();
        tokio::spawn(async move {
            match crate::upgrade::hand_off_claimed(daemon, Some(binary)).await {
                Ok(()) => installed.keep(),
                Err(e) => {
                    tracing::error!("update failed, still serving: {e:#}");
                    installed.undo();
                }
            }
        });
    }

    /// [`Handoff::start`] after `wait`, for a reply the caller can only queue.
    pub fn start_after(self, wait: Duration) {
        tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            self.start();
        });
    }
}

/// `daemon.update {version}`: installs `version`; answers `{from, to}` once
/// the new files are in place, with the handoff for the caller to start.
pub async fn update(daemon: &Arc<Daemon>, version: &str) -> Result<(DaemonUpdated, Handoff), RpcError> {
    let from = env!("CARGO_PKG_VERSION");
    let Some(wanted) = self::version(version) else {
        return Err(err("invalid_params", format!("not a version: {version}")));
    };
    if wanted <= self::version(from).unwrap_or_default() {
        return Err(err("not_newer", format!("moonlet {from} is not older than {version}")));
    }
    let layout = this_layout()?;
    if !daemon.begin_upgrade() {
        return Err(err("busy", "an update or upgrade is already in progress"));
    }
    let installed = async {
        let archive = tokio::time::timeout(DOWNLOAD_LIMIT, download(&layout, version))
            .await
            .map_err(|_| err("download_failed", "the download took longer than 5 minutes"))??;
        match &layout {
            Layout::Bin(dir) => install_bin(dir, &archive, version),
            Layout::Bundle(app) => install_bundle(app, &archive, version),
        }
    }
    .await;
    let installed = match installed {
        Ok(v) => v,
        Err(e) => {
            daemon.end_upgrade();
            return Err(e);
        }
    };
    tracing::info!(from, to = version, binary = %installed.binary().display(), "updating");
    Ok((DaemonUpdated { from: from.into(), to: version.into() }, Handoff { daemon: daemon.clone(), installed }))
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

    /// `Info.plist` as Tauri writes it, trimmed.
    fn plist(version: &str) -> Vec<u8> {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>moonlet</string>
	<key>CFBundleShortVersionString</key>
	<string>{version}</string>
	<key>CFBundleVersion</key>
	<string>{version}</string>
</dict>
</plist>
"#
        )
        .into_bytes()
    }

    #[test]
    fn an_app_bundle_is_swapped_and_the_old_one_can_be_put_back() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("moonlet.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/MacOS/moonletd"), "old").unwrap();
        let info = plist("0.1.34");
        let archive = tgz(&[("moonlet.app/Contents/MacOS/moonletd", b"new"), ("moonlet.app/Contents/Info.plist", &info)]);

        let Installed::Bundle { old, .. } = install_bundle(&app, &archive, "0.1.34").unwrap() else { panic!("not a bundle") };
        assert_eq!(std::fs::read_to_string(app.join("Contents/MacOS/moonletd")).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(old.join("Contents/MacOS/moonletd")).unwrap(), "old");

        restore_bundle(&app, &old);
        assert_eq!(std::fs::read_to_string(app.join("Contents/MacOS/moonletd")).unwrap(), "old");
        let mut left: Vec<String> =
            std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into()).collect();
        left.sort();
        assert_eq!(left, ["moonlet.app"]);
    }

    /// Moving the old bundle aside fails (here a file is in its way): the
    /// bundles are swapped back, and the old app stays.
    #[test]
    fn a_swap_that_cannot_finish_leaves_the_old_app() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("moonlet.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/MacOS/moonletd"), "old").unwrap();
        std::fs::write(aside(&app), "in the way").unwrap();
        let info = plist("0.1.34");
        let archive = tgz(&[("moonlet.app/Contents/MacOS/moonletd", b"new"), ("moonlet.app/Contents/Info.plist", &info)]);

        let e = install_bundle(&app, &archive, "0.1.34").unwrap_err();
        assert_eq!(e.code, "install_failed");
        assert_eq!(std::fs::read_to_string(app.join("Contents/MacOS/moonletd")).unwrap(), "old");
    }

    #[test]
    fn an_archive_without_an_app_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("moonlet.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/MacOS/moonletd"), "old").unwrap();

        let e = install_bundle(&app, &tgz(&[("README", b"hi")]), "0.1.34").unwrap_err();
        assert_eq!((e.code.as_str(), e.message.as_str()), ("install_failed", "the release has no app"));
        assert_eq!(std::fs::read_to_string(app.join("Contents/MacOS/moonletd")).unwrap(), "old");
        let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(left.len(), 1);
    }

    #[test]
    fn an_app_of_another_version_is_refused_and_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("moonlet.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/MacOS/moonletd"), "old").unwrap();
        let info = plist("0.1.20");
        let archive = tgz(&[("moonlet.app/Contents/MacOS/moonletd", b"new"), ("moonlet.app/Contents/Info.plist", &info)]);

        let e = install_bundle(&app, &archive, "0.1.34").unwrap_err();
        assert_eq!((e.code.as_str(), e.message.as_str()), ("install_failed", "the release holds moonlet 0.1.20, not 0.1.34"));
        assert_eq!(std::fs::read_to_string(app.join("Contents/MacOS/moonletd")).unwrap(), "old");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn a_bundle_archive_comes_only_from_the_release_asked_for() {
        let base = "https://github.com/1devstudio/moonlet/releases/download";
        assert!(in_release(&format!("{base}/v0.1.34/moonlet.app.tar.gz"), base, "0.1.34"));
        assert!(!in_release(&format!("{base}/v0.1.20/moonlet.app.tar.gz"), base, "0.1.34"));
        assert!(!in_release("https://example.com/v0.1.34/moonlet.app.tar.gz", base, "0.1.34"));
        assert!(!in_release(&format!("{base}/v0.1.34/../v0.1.20/moonlet.app.tar.gz"), base, "0.1.34"));
    }

    /// Without the debug seams, releases come from GitHub and only moonlet's
    /// updater key is trusted: an archive signed by any other key is refused.
    #[test]
    fn a_release_build_trusts_only_github_and_moonlets_key() {
        let (releases, key) = source().unwrap();
        assert_eq!(releases, "https://github.com/1devstudio/moonlet/releases/download");
        let minisign::KeyPair { pk, sk } = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let sig = minisign::sign(Some(&pk), &sk, &b"moonlet"[..], None, None).unwrap().into_string();
        let sig = base64::engine::general_purpose::STANDARD.encode(sig);
        let e = verify(&key, b"moonlet", &sig).unwrap_err();
        assert_eq!(e.code, "bad_signature");
    }

    #[test]
    fn an_old_binary_comes_back_when_the_handoff_fails_and_goes_once_it_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        for name in BINARIES {
            std::fs::write(dir.path().join(name), "old").unwrap();
        }
        // `--version` of the new `moonletd` must say what was asked for.
        let new_daemon = b"#!/bin/sh\necho moonletd 0.1.34\n";
        let archive = tgz(&[("moonletd", new_daemon), ("moonlet", b"new")]);

        let installed = install_bin(dir.path(), &archive, "0.1.34").unwrap();
        assert_eq!(std::fs::read(dir.path().join("moonletd")).unwrap(), new_daemon);
        installed.undo();
        assert_eq!(std::fs::read_to_string(dir.path().join("moonletd")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(dir.path().join("moonlet")).unwrap(), "old");

        install_bin(dir.path(), &archive, "0.1.34").unwrap().keep();
        let mut left: Vec<String> =
            std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into()).collect();
        left.sort();
        assert_eq!(left, ["moonlet", "moonletd"]);
        assert_eq!(std::fs::read_to_string(dir.path().join("moonlet")).unwrap(), "new");
    }
}
