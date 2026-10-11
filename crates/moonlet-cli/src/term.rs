//! Output of `moonlet term` (X31), kept apart from the socket.

use moonlet_proto::RpcError;
use moonlet_proto::types::TerminalInfo;

/// The daemon's message alone (`no terminal 7 in this session`), without
/// the error code, so an agent reads plain words.
pub fn rpc_message(e: anyhow::Error) -> anyhow::Error {
    match e.downcast::<RpcError>() {
        Ok(r) => anyhow::anyhow!(r.message),
        Err(e) => e,
    }
}

/// `moonlet term ls`: one row per terminal, no output and no command line.
pub fn ls_table(list: &[TerminalInfo]) -> String {
    let mut out = format!("{:>4}  {:<8} {:<11} {:<24} CWD\n", "ID", "KIND", "STATUS", "TITLE");
    for t in list {
        let status = match (&t.exit, t.prompt) {
            (Some(e), _) => e.code.map_or("exited".to_string(), |c| format!("exited {c}")),
            (None, Some(true)) => "at prompt".to_string(),
            (None, _) => "running".to_string(),
        };
        out.push_str(&format!(
            "{:>4}  {:<8} {:<11} {:<24} {}\n",
            t.id,
            format!("{:?}", t.kind).to_lowercase(),
            status,
            t.title,
            t.reported_cwd.as_deref().unwrap_or(&t.cwd),
        ));
    }
    out
}
