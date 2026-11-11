//! Download a design's page as one HTML file (X99): the daemon of the host
//! the design is on inlines it (`design.standalone`), and the app writes it
//! where the user picks in a save dialog. The webview never writes a file.

use serde_json::Value;
use tauri_plugin_dialog::DialogExt;

use moonlet_proto::RpcError;

use crate::Hosts;

/// Saves the page `file` names (a `design.file` reference) on `host` as
/// `name`, where the user picks; with `MOONLET_DOWNLOAD_DIR` set (e2e), in
/// that folder without asking. The saved path, none when the user cancelled,
/// and the addresses the page loads that could not be read.
#[tauri::command]
pub async fn design_download(app: tauri::AppHandle, hosts: Hosts<'_>, host: String, file: Value, name: String) -> Result<Value, RpcError> {
    let page = hosts.get(&host)?.request(moonlet_proto::methods::DESIGN_STANDALONE, file).await?;
    let html = page["html"].as_str().unwrap_or_default().to_string();
    let to = match std::env::var_os("MOONLET_DOWNLOAD_DIR") {
        Some(dir) => Some(std::path::PathBuf::from(dir).join(&name)),
        None => {
            let (tx, rx) = tokio::sync::oneshot::channel();
            app.dialog()
                .file()
                .set_file_name(&name)
                .add_filter("HTML", &["html"])
                .save_file(move |picked| {
                    let _ = tx.send(picked.and_then(|p| p.into_path().ok()));
                });
            rx.await.unwrap_or(None)
        }
    };
    let Some(to) = to else {
        return Ok(serde_json::json!({"path": null, "missing": page["missing"]}));
    };
    tokio::fs::write(&to, html).await.map_err(|e| RpcError::new("failed", format!("could not save {}: {e}", to.display())))?;
    Ok(serde_json::json!({"path": to, "missing": page["missing"]}))
}
