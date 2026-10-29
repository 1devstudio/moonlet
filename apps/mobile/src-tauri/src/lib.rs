//! The moonlet phone app's core (X40, ADR 0008). It offers the webview the
//! same commands and events as the desktop app (`rpc`, `send_input`,
//! `host_subscribe`, `daemon-event`, `host-status`), so the desktop's
//! `lib/daemon.ts` works unchanged, plus pairing with a Mac (X39).

pub mod macs;

use std::sync::Arc;

use macs::{HostEntry, Phone, Sink};
use moonlet_proto::{RpcError, TerminalId};
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

type Phones<'a> = State<'a, Arc<Phone>>;

fn err(e: impl std::fmt::Display) -> RpcError {
    RpcError::new("failed", format!("{e:#}"))
}

struct Webview(AppHandle);

#[derive(Serialize, Clone)]
struct DaemonEvent<'a> {
    host: &'a str,
    name: String,
    data: Value,
}

impl Sink for Webview {
    fn status(&self, entry: &HostEntry) {
        let _ = self.0.emit("host-status", entry);
    }

    fn event(&self, host: &str, name: String, data: Value) {
        let _ = self
            .0
            .emit("daemon-event", DaemonEvent { host, name, data });
    }
}

#[tauri::command]
fn host_list(phone: Phones) -> Vec<HostEntry> {
    phone.list()
}

#[tauri::command]
fn host_reconnect(phone: Phones, id: String) -> Result<(), RpcError> {
    phone.get(&id)?.reconnect();
    Ok(())
}

/// Registers the binary channel that receives this host's PTY output.
#[tauri::command]
fn host_subscribe(
    phone: Phones,
    host: String,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), RpcError> {
    phone.get(&host)?.set_output(move |buf| {
        let _ = channel.send(InvokeResponseBody::Raw(buf));
    });
    Ok(())
}

#[tauri::command]
async fn rpc(
    phone: Phones<'_>,
    host: String,
    method: String,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    let h = phone.get(&host)?;
    h.request(&method, params.unwrap_or(Value::Null)).await
}

#[tauri::command]
fn send_input(
    phone: Phones,
    host: String,
    session: TerminalId,
    data: String,
) -> Result<(), RpcError> {
    phone.get(&host)?.input(session, data.into_bytes())
}

/// Pairs with a Mac using the code from its `moonlet://pair` link (X39).
#[tauri::command]
async fn pair(
    phone: Phones<'_>,
    name: String,
    addrs: Vec<String>,
    code: String,
    device: String,
) -> Result<HostEntry, RpcError> {
    let mac = macs::pair(&name, addrs, &code, &device)
        .await
        .map_err(|e| RpcError::new("pair_failed", format!("{e:#}")))?;
    phone.add(mac).map_err(err)
}

#[tauri::command]
fn mac_forget(phone: Phones, id: String) {
    phone.forget(&id);
}

/// Webview warnings and errors in the app log.
#[tauri::command]
fn log_js(level: String, message: String) {
    if level == "error" {
        tracing::error!(target: "webview", "{message}");
    } else {
        tracing::warn!(target: "webview", "{message}");
    }
}

/// The branch of a session started from a task (X76), as the desktop's
/// `task_branch_name` makes it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
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
    let vars = branch::BranchVars {
        key: &key,
        title: &title,
        number,
        user: user.as_deref().unwrap_or(""),
        issue_type: issue_type.as_deref().unwrap_or(""),
    };
    branch::task_branch(kind, template.as_deref(), &vars, max_len)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("MOONLET_LOG")
                .unwrap_or_else(|_| "info".into()),
        )
        .try_init();
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_barcode_scanner::init())
        .plugin(tauri_plugin_biometric::init())
        .plugin(tauri_plugin_haptics::init());
    builder
        .setup(|app| {
            let file = app.path().app_data_dir().map_err(err)?.join("macs.json");
            let tokens = Arc::new(macs::Keychain {
                service: app.config().identifier.clone(),
            });
            let phone = Phone::start(
                file,
                tokens,
                Webview(app.handle().clone()),
                tauri::async_runtime::handle().inner().clone(),
            );
            app.manage(phone);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host_list,
            host_reconnect,
            host_subscribe,
            rpc,
            send_input,
            pair,
            mac_forget,
            log_js,
            task_branch_name
        ])
        .run(tauri::generate_context!())
        .expect("error while running moonlet");
}
