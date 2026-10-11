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
    let mut out = format!("{:>4}  {:<8} {:<11} {:<8} {:<24} CWD\n", "ID", "KIND", "STATUS", "LAST", "TITLE");
    for t in list {
        let status = match (&t.exit, t.prompt) {
            (Some(e), _) => e.code.map_or("exited".to_string(), |c| format!("exited {c}")),
            (None, Some(true)) => "at prompt".to_string(),
            (None, _) => "running".to_string(),
        };
        // The last command's exit code (X31), never its command line.
        let last = t.last_exit.map_or(String::new(), |e| format!("exit {e}"));
        out.push_str(&format!(
            "{:>4}  {:<8} {:<11} {:<8} {:<24} {}\n",
            t.id,
            format!("{:?}", t.kind).to_lowercase(),
            status,
            last,
            t.title,
            t.reported_cwd.as_deref().unwrap_or(&t.cwd),
        ));
    }
    out
}
