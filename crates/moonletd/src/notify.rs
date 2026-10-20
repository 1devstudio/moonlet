//! systemd's notify protocol (X58): under a `Type=notify` unit, the daemon
//! says when it is ready, and a daemon taking over in a live upgrade (S3)
//! names itself as the service's main process, so systemd follows it
//! instead of stopping the unit when the old daemon exits. Without
//! `NOTIFY_SOCKET` (launchd, a terminal) nothing is sent.

use std::os::unix::net::UnixDatagram;

/// Sends `msg` to `$NOTIFY_SOCKET`, if set. Failures are logged only.
pub fn notify(msg: &str) {
    let Some(path) = std::env::var_os("NOTIFY_SOCKET") else {
        return;
    };
    if let Err(e) = send(&path, msg) {
        tracing::warn!("cannot notify systemd: {e}");
    }
}

fn send(path: &std::ffi::OsStr, msg: &str) -> std::io::Result<()> {
    let sock = UnixDatagram::unbound()?;
    let bytes = path.as_encoded_bytes();
    // `@name` is a socket in Linux's abstract namespace.
    #[cfg(target_os = "linux")]
    if let Some(name) = bytes.strip_prefix(b"@") {
        use std::os::linux::net::SocketAddrExt;
        let addr = std::os::unix::net::SocketAddr::from_abstract_name(name)?;
        return sock.send_to_addr(msg.as_bytes(), &addr).map(|_| ());
    }
    let _ = bytes;
    sock.send_to(msg.as_bytes(), path).map(|_| ())
}

/// The daemon serves: its socket is bound.
pub fn ready() {
    notify("READY=1");
}

/// This process now runs the service, after taking over from the old daemon.
pub fn took_over() {
    notify(&format!("MAINPID={}\nREADY=1", std::process::id()));
}
