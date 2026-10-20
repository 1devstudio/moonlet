//! Connections over the tailnet (X39, X57): TCP to a daemon's Tailscale
//! addresses, an `auth` with a pairing code or a device token, then the
//! normal protocol. The phone app, the desktop app and (X41) a worker's
//! daemon share it.

use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use moonlet_proto::methods::DeviceKind;
use moonlet_proto::{Frame, Message, PROTOCOL_VERSION, read_frame, write_frame};
use tokio::net::TcpStream;

use crate::{BoxFuture, Connector, NeedsUpdate, Reader, Refused, Writer};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);

/// What a daemon handed out when a device paired with it.
#[derive(Debug, Clone, PartialEq)]
pub struct Paired {
    pub device_id: String,
    pub token: String,
    /// The daemon's protocol, version and host label; unknown for a daemon
    /// from before X57.
    pub protocol: Option<u32>,
    pub daemon_version: Option<String>,
    pub host: Option<String>,
}

/// Connects to the first address that answers.
pub async fn dial(addrs: &[String]) -> Result<TcpStream> {
    let mut last = anyhow!("no address to connect to");
    for a in addrs {
        match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(a)).await {
            Ok(Ok(s)) => {
                let _ = s.set_nodelay(true);
                return Ok(s);
            }
            Ok(Err(e)) => last = anyhow!("{a}: {e}"),
            Err(_) => last = anyhow!("{a}: timed out"),
        }
    }
    Err(last).context("cannot reach the host over Tailscale")
}

/// Sends an `auth` frame on `stream` and reads the daemon's answer. A
/// refusal is a [`Refused`] error.
pub async fn authenticate(stream: &mut TcpStream, auth: Message) -> Result<Message> {
    write_frame(stream, &Frame::Json(auth)).await?;
    match tokio::time::timeout(AUTH_TIMEOUT, read_frame(stream))
        .await
        .context("the host did not answer")??
    {
        Some(Frame::Json(m @ Message::Authed { .. })) => Ok(m),
        Some(Frame::Json(Message::Response { error: Some(e), .. })) if e.code == "unauthorized" => {
            Err(Refused(e.message).into())
        }
        Some(Frame::Json(Message::Response { error: Some(e), .. })) => Err(anyhow!(e.message)),
        Some(other) => bail!("unexpected reply {other:?}"),
        None => bail!("the host closed the connection"),
    }
}

/// Pairs with a one-time code; returns what to keep.
pub async fn pair(addrs: &[String], code: &str, device: &str, kind: DeviceKind) -> Result<Paired> {
    let mut stream = dial(addrs).await?;
    let reply = authenticate(
        &mut stream,
        Message::Auth {
            token: None,
            pair: Some(code.into()),
            device: Some(device.into()),
            route: None,
            kind: Some(kind),
        },
    )
    .await?;
    let Message::Authed {
        device_id,
        token: Some(token),
        protocol,
        daemon_version,
        host,
    } = reply
    else {
        bail!("the host did not hand out a token");
    };
    Ok(Paired {
        device_id,
        token,
        protocol,
        daemon_version,
        host,
    })
}

/// Reaches a paired daemon with its device token. With `route`, the daemon
/// connects through to one of its SSH hosts (X39).
pub struct TailnetConnector {
    pub addrs: Vec<String>,
    pub token: String,
    pub route: Option<String>,
}

impl Connector for TailnetConnector {
    fn connect(&self) -> BoxFuture<'_, Result<(Reader, Writer)>> {
        Box::pin(async move {
            let mut stream = dial(&self.addrs).await?;
            let reply = authenticate(
                &mut stream,
                Message::Auth {
                    token: Some(self.token.clone()),
                    pair: None,
                    device: None,
                    route: self.route.clone(),
                    kind: None,
                },
            )
            .await?;
            // A routed connection's daemon is the SSH host's, which answers
            // `hello` itself; `authed` speaks for the one we paired with.
            if self.route.is_none()
                && let Message::Authed {
                    protocol: Some(p),
                    daemon_version,
                    ..
                } = &reply
                && *p != PROTOCOL_VERSION
            {
                return Err(NeedsUpdate {
                    daemon_version: daemon_version.clone().unwrap_or_default(),
                }
                .into());
            }
            let (r, w) = stream.into_split();
            Ok((Box::new(r) as Reader, Box::new(w) as Writer))
        })
    }
}
