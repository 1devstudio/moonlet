//! `moonletd tailnet on|off|status` and `moonletd pair` (X57): tailnet access
//! and pairing from a terminal, for a host without the app, such as a Linux
//! server (X58).

use std::io::IsTerminal;
use std::path::Path;
use std::time::Duration;

use anyhow::Result;
use moonlet_core::client::Client;
use moonlet_proto::methods::{self as m, MobilePairing, MobileStatus};
use moonlet_proto::{Frame, Message, RpcError};
use qrcodegen::{QrCode, QrCodeEcc};
use serde_json::json;
use tokio::signal::unix::{SignalKind, signal};

/// A connection with the app credential (X75): on a host without the app,
/// the user manages phones and pairing from a terminal instead.
pub async fn connect_as_app(socket: &Path, client: &str) -> Result<Client> {
    let token = moonlet_core::app_token::read(&moonlet_core::app_token::file());
    Client::connect_with(socket, client, token.as_deref()).await
}

/// `moonletd tailnet on|off|status`: changes or shows tailnet access and
/// prints its status line. `on` waits a little for the listener.
pub async fn tailnet(socket: &Path, enable: Option<bool>) -> Result<()> {
    let mut c = connect_as_app(socket, "moonletd-tailnet").await?;
    let mut st: MobileStatus = match enable {
        Some(enabled) => {
            c.request(m::MOBILE_SET_ENABLED, json!({ "enabled": enabled }))
                .await?
        }
        None => c.request(m::MOBILE_STATUS, json!({})).await?,
    };
    if enable == Some(true) {
        for _ in 0..100 {
            if !st.tailscale || !st.listening.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            st = c.request(m::MOBILE_STATUS, json!({})).await?;
        }
    }
    println!("{}", status_line(&st));
    Ok(())
}

/// `moonletd pair`: shows a pairing code and waits until a device uses it,
/// it runs out, or Ctrl-C cancels it. Returns the exit status.
pub async fn pair(socket: &Path, name: Option<String>) -> Result<i32> {
    // Registered before the code shows, so Ctrl-C always cancels it.
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut c = connect_as_app(socket, "moonletd-pair").await?;
    let p: MobilePairing = match c.request(m::MOBILE_PAIR_START, json!({ "kind": "desktop" })).await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{}", pair_error(&e));
            return Ok(1);
        }
    };
    if std::io::stdout().is_terminal() {
        for line in qr_lines(&p.url) {
            println!("{line}");
        }
        println!();
    }
    println!("Pair a Mac: in moonlet, Settings › Machines › Hosts › Add host, enter");
    println!("  Name: {}", name.as_deref().unwrap_or(&p.host));
    println!("  Code: {}", display_code(&p.code));
    println!(
        "{}",
        expires_in(p.expires_at.saturating_sub(moonlet_core::paths::now_ms()))
    );
    println!("Or paste this link:");
    println!("{}", p.url);
    loop {
        tokio::select! {
            frame = c.next_frame() => match frame? {
                Some(Frame::Json(Message::Event { name, data })) if name == m::EV_MOBILE_PAIRED => {
                    println!("Paired with {}", data["device"]["name"].as_str().unwrap_or("a device"));
                    return Ok(0);
                }
                Some(Frame::Json(Message::Event { name, data })) if name == m::EV_MOBILE_PAIR_ENDED => {
                    eprintln!("{}", ended(data["reason"].as_str().unwrap_or("")));
                    return Ok(1);
                }
                Some(_) => {}
                None => anyhow::bail!("the daemon closed the connection"),
            },
            _ = interrupt.recv() => {
                let _: bool = c.request(m::MOBILE_PAIR_CANCEL, json!({})).await?;
                eprintln!("{}", ended("cancelled"));
                return Ok(1);
            }
        }
    }
}

/// What `moonletd pair` says when it cannot start.
fn pair_error(e: &anyhow::Error) -> String {
    match e.downcast_ref::<RpcError>().map(|e| e.code.as_str()) {
        Some("mobile_off") => "Tailnet access is off. Run `moonletd tailnet on` first.".into(),
        Some("no_tailscale") => "Tailscale is not running on this machine.".into(),
        _ => format!("Cannot start pairing: {e:#}"),
    }
}

/// Why a pairing ended without a device, as Settings says it (X39).
fn ended(reason: &str) -> &'static str {
    match reason {
        "expired" => "The code expired. Start again.",
        "too_many_attempts" => "Too many wrong attempts. Start again.",
        _ => "Pairing was cancelled.",
    }
}

/// Tailnet access as one line, the way Settings says it (X39), for a machine
/// that may not be a Mac.
pub fn status_line(st: &MobileStatus) -> String {
    if !st.enabled {
        "Tailnet access is off".into()
    } else if !st.tailscale {
        "Tailscale is not running on this machine".into()
    } else if st.listening.is_empty() {
        "Starting…".into()
    } else {
        format!("Listening on {}", st.listening.join(", "))
    }
}

/// `7KQ2MX9PDA` as `7KQ2M-X9PDA`, easier to read and type.
pub fn display_code(code: &str) -> String {
    if code.len() == 10 {
        format!("{}-{}", &code[..5], &code[5..])
    } else {
        code.into()
    }
}

/// "Expires in m:ss", rounded up to the second.
pub fn expires_in(ms_left: u64) -> String {
    let secs = ms_left.div_ceil(1000);
    format!("Expires in {}:{:02}", secs / 60, secs % 60)
}

/// `text` as a QR code in half-block characters, two modules per row, with
/// a quiet zone of two modules. Light modules are drawn, so the code reads
/// on a dark terminal.
pub fn qr_lines(text: &str) -> Vec<String> {
    const QUIET: i32 = 2;
    let Ok(qr) = QrCode::encode_text(text, QrCodeEcc::Low) else {
        return Vec::new();
    };
    let n = qr.size() + 2 * QUIET;
    // Outside the code, `get_module` is light.
    let light = |x: i32, y: i32| y >= n || !qr.get_module(x - QUIET, y - QUIET);
    (0..n)
        .step_by(2)
        .map(|y| {
            (0..n)
                .map(|x| match (light(x, y), light(x, y + 1)) {
                    (true, true) => '█',
                    (true, false) => '▀',
                    (false, true) => '▄',
                    (false, false) => ' ',
                })
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(enabled: bool, addresses: &[&str], listening: &[&str]) -> MobileStatus {
        MobileStatus {
            enabled,
            port: 47428,
            tailscale: !addresses.is_empty(),
            addresses: addresses.iter().map(|a| a.to_string()).collect(),
            listening: listening.iter().map(|a| a.to_string()).collect(),
            host: "build-box".into(),
            devices: vec![],
        }
    }

    #[test]
    fn the_status_line_says_where_it_listens() {
        assert_eq!(
            status_line(&status(false, &["100.88.1.20"], &[])),
            "Tailnet access is off"
        );
        assert_eq!(
            status_line(&status(true, &[], &[])),
            "Tailscale is not running on this machine"
        );
        assert_eq!(
            status_line(&status(true, &["100.88.1.20"], &[])),
            "Starting…"
        );
        assert_eq!(
            status_line(&status(
                true,
                &["100.88.1.20", "fd7a:115c:a1e0::1"],
                &["100.88.1.20:47428", "[fd7a:115c:a1e0::1]:47428"]
            )),
            "Listening on 100.88.1.20:47428, [fd7a:115c:a1e0::1]:47428"
        );
    }

    #[test]
    fn a_code_shows_in_two_groups_of_five() {
        assert_eq!(display_code("7KQ2MX9PDA"), "7KQ2M-X9PDA");
    }

    #[test]
    fn the_time_left_rounds_up_to_the_second() {
        assert_eq!(expires_in(300_000), "Expires in 5:00");
        assert_eq!(expires_in(299_001), "Expires in 5:00");
        assert_eq!(expires_in(61_000), "Expires in 1:01");
        assert_eq!(expires_in(0), "Expires in 0:00");
    }

    #[test]
    fn the_qr_code_is_square_with_a_quiet_zone() {
        let lines =
            qr_lines("moonlet://pair?v=1&host=build-box&addr=100.88.1.20%3A47428&code=7KQ2MX9PDA");
        // Two modules per character row, so the rows are half the width.
        let width = lines[0].chars().count();
        assert!(width >= 25, "{width}");
        assert_eq!(lines.len(), width.div_ceil(2));
        assert!(lines.iter().all(|l| l.chars().count() == width));
        // Light modules are drawn, as `qrencode -t UTF8` does, so the code
        // reads on a dark terminal: the quiet zone's first row is all light.
        assert!(lines[0].chars().all(|c| c == '█'), "{:?}", lines[0]);
    }
}
