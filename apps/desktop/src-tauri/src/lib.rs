//! jaunt desktop app: a thin Tauri shell around `jauntd`. It owns no
//! sessions; it connects to daemons, relays RPCs and events, and streams
//! PTY output to the webview over a binary channel.

mod hosts;
mod remote;

use std::sync::Arc;

use hosts::{HostInfo, HostManager};
use jaunt_proto::{RpcError, SessionId};
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
    session: SessionId,
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

/// Opens a workspace in another app. Remote paths open through the editor's
/// SSH remote support where it has one.
#[tauri::command]
fn open_in(target: String, path: String, host: Option<String>) -> Result<(), RpcError> {
    let remote = host.filter(|h| h != hosts::LOCAL);
    let mut cmd = std::process::Command::new("open");
    match (target.as_str(), remote) {
        ("finder", None) => cmd.arg(&path),
        ("reveal", None) => cmd.args(["-R", &path]),
        ("vscode", Some(h)) => cmd.arg(format!("vscode://vscode-remote/ssh-remote+{h}{path}")),
        ("cursor", Some(h)) => cmd.arg(format!("cursor://vscode-remote/ssh-remote+{h}{path}")),
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

/// Runs the bundled `jauntd service install|uninstall|status` (S1b).
#[tauri::command]
async fn daemon_service(action: String) -> Result<Value, RpcError> {
    if !["install", "uninstall", "status"].contains(&action.as_str()) {
        return Err(RpcError::new("invalid_params", "unknown action"));
    }
    let jauntd = hosts::sibling_binary("jauntd").map_err(err)?;
    let out = tokio::process::Command::new(&jauntd)
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
    let status = tokio::process::Command::new(&jauntd)
        .args(["service", "status"])
        .output()
        .await
        .map_err(err)?;
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

#[tauri::command]
fn app_info() -> Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": jaunt_proto::PROTOCOL_VERSION,
        "home": dirs::home_dir().map(|h| h.display().to_string()),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("JAUNT_LOG")
                .unwrap_or_else(|_| "info".into()),
        )
        .try_init();
    tauri::Builder::default()
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
            app_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running jaunt");
}
