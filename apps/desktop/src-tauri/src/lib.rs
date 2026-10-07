//! moonlet desktop app: a thin Tauri shell around `moonletd`. It owns no
//! sessions; it connects to daemons, relays RPCs and events, and streams
//! PTY output to the webview over a binary channel.

mod hosts;
mod remote;

use std::sync::Arc;

use hosts::{HostInfo, HostManager};
use moonlet_proto::{RpcError, TerminalId};
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State};

type Hosts<'a> = State<'a, Arc<HostManager>>;

fn err(e: impl std::fmt::Display) -> RpcError {
    RpcError::new("failed", format!("{e:#}"))
}

#[tauri::command]
fn host_list(hosts: Hosts) -> Vec<HostInfo> {
    hosts.list()
}

#[tauri::command]
fn host_add(hosts: Hosts, id: String) -> Result<HostInfo, RpcError> {
    let id = id.trim().to_string();
    if id.is_empty() || id.starts_with('-') || id.contains(char::is_whitespace) {
        return Err(RpcError::new(
            "invalid_params",
            "not a valid SSH host alias",
        ));
    }
    Ok(hosts.add(&id, true))
}

#[tauri::command]
fn host_remove(hosts: Hosts, id: String) {
    hosts.remove(&id);
}

#[tauri::command]
fn host_reconnect(hosts: Hosts, id: String) -> Result<(), RpcError> {
    hosts.reconnect(&id)
}

/// Registers the binary channel that receives this host's PTY output.
#[tauri::command]
fn host_subscribe(
    hosts: Hosts,
    host: String,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), RpcError> {
    hosts.get(&host)?.set_output(channel);
    Ok(())
}

#[tauri::command]
async fn rpc(
    hosts: Hosts<'_>,
    host: String,
    method: String,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let h = hosts.get(&host)?;
    h.request(&method, params.unwrap_or(Value::Null)).await
}

#[tauri::command]
fn send_input(
    hosts: Hosts,
    host: String,
    session: TerminalId,
    data: String,
) -> Result<(), RpcError> {
    hosts.get(&host)?.input(session, data.into_bytes())
}

#[tauri::command]
fn ssh_hosts() -> Vec<String> {
    remote::ssh_config_hosts()
}

#[tauri::command]
async fn remote_install(
    app: tauri::AppHandle,
    hosts: Hosts<'_>,
    host: String,
) -> Result<remote::InstallResult, RpcError> {
    let resources = app.path().resource_dir().ok();
    let result = remote::install(&host, resources).await.map_err(err)?;
    hosts.reconnect(&host)?;
    Ok(result)
}

#[derive(serde::Serialize)]
struct OpenTarget {
    id: &'static str,
    label: &'static str,
}

const APPS: &[(&str, &str, &str)] = &[
    ("cursor", "Cursor", "Cursor"),
    ("vscode", "VS Code", "Visual Studio Code"),
    ("zed", "Zed", "Zed"),
    ("xcode", "Xcode", "Xcode"),
    ("iterm", "iTerm", "iTerm"),
    ("ghostty", "Ghostty", "Ghostty"),
    ("terminal", "Terminal", "Terminal"),
];

fn app_installed(bundle: &str) -> bool {
    [
        "/Applications",
        "/System/Applications/Utilities",
        "/Applications/Utilities",
    ]
    .iter()
    .map(std::path::PathBuf::from)
    .chain(dirs::home_dir().map(|h| h.join("Applications")))
    .any(|d| d.join(format!("{bundle}.app")).exists())
}

#[tauri::command]
fn open_targets() -> Vec<OpenTarget> {
    let mut v = vec![OpenTarget {
        id: "finder",
        label: "Finder",
    }];
    v.extend(
        APPS.iter()
            .filter(|(_, _, b)| app_installed(b))
            .map(|(id, label, _)| OpenTarget { id, label }),
    );
    v
}

/// Percent-encodes everything but unreserved characters (and `/` in paths).
fn url_escape(s: &str, keep_slash: bool) -> Result<String, RpcError> {
    if s.is_empty() {
        return Err(RpcError::new("invalid_params", "empty URL component"));
    }
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) || (keep_slash && b == b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    Ok(out)
}

fn url_path(path: &str) -> Result<String, RpcError> {
    if !path.starts_with('/') {
        return Err(RpcError::new("invalid_params", "remote path must be absolute"));
    }
    url_escape(path, true)
}

/// Opens a workspace in another app. Remote paths open through the editor's
/// SSH remote support where it has one.
#[tauri::command]
fn open_in(target: String, path: String, host: Option<String>) -> Result<(), RpcError> {
    let remote = host.filter(|h| h != hosts::LOCAL);
    let mut cmd = std::process::Command::new("open");
    match (target.as_str(), remote) {
        ("finder", None) => cmd.arg(&path),
        ("reveal", None) => cmd.args(["-R", &path]),
        (app @ ("vscode" | "cursor"), Some(h)) => {
            cmd.arg(format!("{app}://vscode-remote/ssh-remote+{}{}", url_escape(&h, false)?, url_path(&path)?))
        }
        (_, Some(_)) => {
            return Err(RpcError::new(
                "unsupported",
                "this app cannot open remote folders",
            ));
        }
        (t, None) => {
            let bundle = APPS
                .iter()
                .find(|(id, _, _)| *id == t)
                .map(|(_, _, b)| *b)
                .ok_or_else(|| RpcError::new("invalid_params", "unknown app"))?;
            cmd.args(["-a", bundle, &path])
        }
    };
    let status = cmd.status().map_err(err)?;
    if !status.success() {
        return Err(RpcError::new(
            "failed",
            format!("open exited with {status}"),
        ));
    }
    Ok(())
}

/// Runs the bundled `moonletd service install|uninstall|status` (S1b).
#[tauri::command]
async fn daemon_service(action: String) -> Result<Value, RpcError> {
    if !["install", "uninstall", "status"].contains(&action.as_str()) {
        return Err(RpcError::new("invalid_params", "unknown action"));
    }
    let moonletd = hosts::sibling_binary("moonletd").map_err(err)?;
    let out = tokio::process::Command::new(&moonletd)
        .args(["service", &action])
        .output()
        .await
        .map_err(err)?;
    if !out.status.success() {
        return Err(RpcError::new(
            "failed",
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    let status = tokio::process::Command::new(&moonletd)
        .args(["service", "status"])
        .output()
        .await
        .map_err(err)?;
    if !status.status.success() {
        return Err(RpcError::new(
            "failed",
            String::from_utf8_lossy(&status.stderr).trim().to_string(),
        ));
    }
    serde_json::from_slice(&status.stdout).map_err(err)
}

/// Webview warnings and errors, mirrored into the app log for diagnostics.
#[tauri::command]
fn log_js(level: String, message: String) {
    let message: String = message.chars().take(2000).collect();
    match level.as_str() {
        "error" => tracing::error!(target: "webview", "{message}"),
        _ => tracing::warn!(target: "webview", "{message}"),
    }
}

/// macOS system sounds the app may play. Must match `SYSTEM_SOUNDS` in
/// src/lib/sounds.ts.
const SOUNDS: &[&str] = &[
    "Basso",
    "Blow",
    "Bottle",
    "Frog",
    "Funk",
    "Glass",
    "Hero",
    "Morse",
    "Ping",
    "Pop",
    "Purr",
    "Sosumi",
    "Submarine",
    "Tink",
];

/// The file for an allowlisted sound name. The name comes from the webview,
/// so anything else is rejected rather than joined into a path.
fn sound_path(name: &str) -> Result<String, RpcError> {
    if !SOUNDS.contains(&name) {
        return Err(RpcError::new("invalid_params", "unknown sound"));
    }
    Ok(format!("/System/Library/Sounds/{name}.aiff"))
}

/// Plays an alert sound when an agent finishes or needs the user (X10).
#[tauri::command]
async fn play_sound(name: String) -> Result<(), RpcError> {
    let path = sound_path(&name)?;
    if cfg!(target_os = "macos") {
        // Waiting reaps the child so finished players don't linger as zombies.
        let status = tokio::process::Command::new("afplay")
            .arg(path)
            .status()
            .await
            .map_err(err)?;
        if !status.success() {
            return Err(RpcError::new(
                "failed",
                format!("afplay exited with {status}"),
            ));
        }
    }
    Ok(())
}

#[tauri::command]
fn app_info() -> Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": moonlet_proto::PROTOCOL_VERSION,
        "home": dirs::home_dir().map(|h| h.display().to_string()),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("MOONLET_LOG")
                .unwrap_or_else(|_| "info".into()),
        )
        .try_init();
    // Before anything creates ~/.moonlet (X27).
    moonlet_core::paths::migrate_legacy_home();
    let builder = tauri::Builder::default();
    // Only `pnpm e2e:build` turns this on (X12).
    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio_webdriver::init())
        .plugin(tauri_plugin_wdio::init());
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let hosts = HostManager::new(app.handle().clone());
            app.manage(hosts);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host_list,
            host_add,
            host_remove,
            host_reconnect,
            host_subscribe,
            rpc,
            send_input,
            ssh_hosts,
            remote_install,
            open_targets,
            open_in,
            daemon_service,
            log_js,
            play_sound,
            app_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running moonlet");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sound_path_accepts_only_allowlisted_names() {
        assert_eq!(
            sound_path("Glass").unwrap(),
            "/System/Library/Sounds/Glass.aiff"
        );
        assert!(sound_path("../../tmp/x").is_err());
        assert!(sound_path("glass").is_err());
        assert!(sound_path("").is_err());
    }

    #[test]
    fn every_allowlisted_sound_exists() {
        if cfg!(target_os = "macos") {
            for name in SOUNDS {
                assert!(
                    std::path::Path::new(&sound_path(name).unwrap()).exists(),
                    "{name}"
                );
            }
        }
    }
}
