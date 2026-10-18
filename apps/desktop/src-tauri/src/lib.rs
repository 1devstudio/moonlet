//! moonlet desktop app: a thin Tauri shell around `moonletd`. It owns no
//! sessions; it connects to daemons, relays RPCs and events, and streams
//! PTY output to the webview over a binary channel.

mod attach;
mod hosts;
mod remote;
mod secrets;
mod trackers;
mod webview_data;

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
    let h = hosts.get(&host)?;
    hosts::send_output(&h, channel);
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

/// The bytes of an image the user picked to attach (X29).
#[tauri::command]
async fn read_image(path: String) -> Result<tauri::ipc::Response, RpcError> {
    let bytes = tauri::async_runtime::spawn_blocking(move || attach::read_image(&path))
        .await
        .map_err(err)?
        .map_err(err)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Forwards a sign-in callback port to a remote host while an MCP server
/// signs in, and removes the forward after (X29).
#[tauri::command]
async fn ssh_forward(host: String, bind: String, port: u16, open: bool) -> Result<(), RpcError> {
    if host == hosts::LOCAL {
        return Ok(());
    }
    remote::forward(&host, &bind, port, open).await.map_err(err)
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

/// The `latest` release in npm's dist-tags for Claude Code (X36).
fn latest_from_dist_tags(body: &str) -> Option<String> {
    let tags: Value = serde_json::from_str(body).ok()?;
    Some(tags.get("latest")?.as_str()?.to_string())
}

/// The newest Claude Code release (X36). Asked here, not in the webview,
/// so the CSP stays closed to the network.
#[tauri::command]
async fn claude_latest_version() -> Result<String, RpcError> {
    // reqwest comes with the updater plugin, which installs the same provider.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .user_agent(concat!("moonlet/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(err)?;
    let body = client
        .get("https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(err)?
        .text()
        .await
        .map_err(err)?;
    latest_from_dist_tags(&body).ok_or_else(|| err("npm did not name a latest Claude Code"))
}

/// The branch of a session started from a task (X44, X46): the template
/// (the tracker's default when absent) filled in and cut to `max_len`.
#[tauri::command]
fn task_branch_name(
    kind: moonlet_trackers::TrackerKind,
    template: Option<String>,
    key: String,
    title: String,
    number: Option<u64>,
    max_len: Option<usize>,
    user: Option<String>,
    issue_type: Option<String>,
) -> String {
    use moonlet_trackers::branch;
    let template = template
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| branch::default_template(kind).into());
    let vars = branch::BranchVars {
        key: &key,
        title: &title,
        number,
        user: user.as_deref().unwrap_or(""),
        issue_type: issue_type.as_deref().unwrap_or(""),
    };
    branch::branch_name(&template, &vars, max_len.unwrap_or(branch::DEFAULT_MAX_LEN))
}

fn trackers_path() -> std::path::PathBuf {
    moonlet_core::paths::home().join("trackers.toml")
}

/// `trackers.toml`, or the defaults when there is none (X44).
fn read_trackers(path: &std::path::Path) -> Result<moonlet_trackers::config::TrackersConfig, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => moonlet_trackers::config::parse(&text).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Writes `trackers.toml` whole, through a temp file so a crash never leaves half of it.
fn write_trackers(path: &std::path::Path, config: &moonlet_trackers::config::TrackersConfig) -> Result<(), String> {
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, moonlet_trackers::config::to_toml(config)).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// The app's tracker settings (X44).
#[tauri::command]
fn trackers_config() -> Result<moonlet_trackers::config::TrackersConfig, RpcError> {
    read_trackers(&trackers_path()).map_err(err)
}

#[tauri::command]
fn trackers_save(config: moonlet_trackers::config::TrackersConfig) -> Result<(), RpcError> {
    let _ = moonlet_core::paths::ensure_private_dir(&moonlet_core::paths::home());
    write_trackers(&trackers_path(), &config).map_err(err)
}

/// A key or issue URL pasted into the link dialog (X46), or null.
#[tauri::command]
fn task_parse_pasted(input: String) -> Value {
    moonlet_trackers::refs::parse_pasted(&input)
        .and_then(|p| serde_json::to_value(p).ok())
        .unwrap_or(Value::Null)
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
    let context = tauri::generate_context!();
    // Before the window opens and creates its own, empty storage (X27).
    webview_data::carry_over(&context.config().identifier);
    let builder = tauri::Builder::default();
    // Only `pnpm e2e:build` turns this on (X12).
    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio_webdriver::init())
        .plugin(tauri_plugin_wdio::init());
    // Only release builds update themselves (X35): a dev or e2e build has no
    // bundle to replace and must not pick up a published release.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .plugin(tauri_plugin_process::init())
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
            read_image,
            ssh_forward,
            remote_install,
            open_targets,
            open_in,
            daemon_service,
            log_js,
            play_sound,
            claude_latest_version,
            task_branch_name,
            task_parse_pasted,
            trackers_config,
            trackers_save,
            trackers::tracker_connect,
            trackers::tracker_disconnect,
            trackers::tracker_sources,
            trackers::tracker_task,
            trackers::tracker_update,
            trackers::tracker_states,
            trackers::tracker_boards,
            trackers::tracker_board_setup,
            trackers::github_project_columns,
            trackers::tracker_board_tasks,
            trackers::tracker_oauth_available,
            trackers::tracker_oauth_linear,
            app_info
        ])
        .run(context)
        .expect("error while running moonlet");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracker_settings_are_read_and_saved_in_trackers_toml() {
        use moonlet_trackers::config::{Rule, TrackersConfig};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("trackers.toml");
        // No file yet: the defaults.
        assert_eq!(read_trackers(&path).unwrap(), TrackersConfig::default());
        let mut c = TrackersConfig::default();
        c.github.rules.session_starts = Rule::Off;
        write_trackers(&path, &c).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("session_starts = \"off\""));
        assert_eq!(read_trackers(&path).unwrap(), c);
        // A file the user broke says where.
        std::fs::write(&path, "[sync]\ninterval = \"often\"\n").unwrap();
        assert!(read_trackers(&path).unwrap_err().contains("interval"));
    }

    #[test]
    fn a_pasted_issue_url_reaches_the_app_as_kind_key_and_site() {
        assert_eq!(
            task_parse_pasted("https://acme.atlassian.net/browse/OPS-12".into()),
            serde_json::json!({"kind": "jira", "key": "OPS-12", "site": "acme.atlassian.net"})
        );
        assert_eq!(task_parse_pasted("#42".into()), serde_json::json!({"kind": "github", "key": "#42", "site": null}));
        assert_eq!(task_parse_pasted("changelog themes".into()), Value::Null);
    }

    #[test]
    fn a_task_branch_follows_the_trackers_default_template() {
        use moonlet_trackers::TrackerKind;
        let name = |kind, template: Option<&str>, key: &str, title: &str, number, max| {
            task_branch_name(kind, template.map(String::from), key.into(), title.into(), number, max, None, None)
        };
        assert_eq!(
            name(TrackerKind::Github, None, "acme/storefront#15", "Gift cards at checkout", Some(15), None),
            "15-gift-cards-at-checkout"
        );
        assert_eq!(
            name(TrackerKind::Linear, None, "MOON-151", "Drag sessions between sections", None, None),
            "moon-151-drag-sessions-between-sections"
        );
        assert_eq!(name(TrackerKind::Linear, Some("{key}"), "MOON-151", "x", None, Some(5)), "moon");
    }

    #[test]
    fn a_task_branch_fills_user_and_type() {
        use moonlet_trackers::TrackerKind;
        assert_eq!(
            task_branch_name(
                TrackerKind::Jira,
                Some("{user}/{type}/{key}-{title}".into()),
                "OPS-12".into(),
                "Rotate keys".into(),
                None,
                None,
                Some("sam".into()),
                Some("Bug".into()),
            ),
            "sam/bug/ops-12-rotate-keys"
        );
    }

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
    fn reads_the_latest_claude_code_from_npm_dist_tags() {
        // Captured from registry.npmjs.org on 2026-10-12.
        let body = r#"{"stable":"2.1.287","next":"2.1.296","latest":"2.1.296"}"#;
        assert_eq!(latest_from_dist_tags(body).as_deref(), Some("2.1.296"));
        assert_eq!(latest_from_dist_tags(r#"{"error":"Not found"}"#), None);
        assert_eq!(latest_from_dist_tags("<html>"), None);
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
