//! Connections over the tailnet (X39, X57): TCP to a daemon's Tailscale
//! addresses, an `auth` with a pairing code or a device token, then the
//! normal protocol. The phone app, the desktop app and (X41) a worker's
//! daemon share it.

use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use moonlet_proto::methods::DeviceKind;
use moonlet_proto::{Frame, Message, PROTOCOL_VERSION, RpcError, read_frame, write_frame};
use serde_json::{Value, json};
use tokio::net::TcpStream;

use crate::{BoxFuture, Connector, NeedsUpdate, Reader, Refused, Writer};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
/// A host downloads a release before it answers `daemon.update`.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(360);

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
        ..
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

/// Why pairing with host `name` failed, as the app's Add host dialog and a
/// worker pairing with its central host (X61) say it.
pub fn pair_error_text(name: &str, error: &anyhow::Error) -> String {
    if error.downcast_ref::<Refused>().is_some() {
        format!("The code was not accepted. Start pairing again on {name}.")
    } else {
        format!("Cannot pair with {name}: {error:#}")
    }
}

/// Asks a paired daemon to update itself to `version` (X69). The request
/// goes in place of `hello`, so it works whatever protocol either side
/// speaks; this exchange never changes. A daemon from before X69 closes the
/// connection instead of answering, which gives `too_old`.
pub async fn update(addrs: &[String], token: &str, version: &str) -> Result<Value, RpcError> {
    let unreachable = |e: anyhow::Error| RpcError::new("unreachable", format!("{e:#}"));
    let mut stream = dial(addrs).await.map_err(unreachable)?;
    let auth = Message::Auth {
        token: Some(token.into()),
        pair: None,
        device: None,
        route: None,
        kind: None,
    };
    let authed = authenticate(&mut stream, auth).await.map_err(|e| match e.downcast_ref::<Refused>() {
        Some(Refused(m)) => RpcError::new("refused", m.clone()),
        None => unreachable(e),
    })?;
    let Message::Authed { daemon_version, host, .. } = authed else {
        return Err(RpcError::new("unreachable", "the host did not authenticate"));
    };
    let request = Message::Request {
        id: 1,
        method: moonlet_proto::methods::DAEMON_UPDATE.into(),
        params: json!({ "version": version }),
    };
    write_frame(&mut stream, &Frame::Json(request)).await.map_err(|e| unreachable(e.into()))?;
    let too_old = || {
        RpcError::new(
            "too_old",
            format!(
                "{} runs moonlet {}, which can't be updated from here",
                host.as_deref().unwrap_or("The host"),
                daemon_version.as_deref().unwrap_or("from before 0.1.26")
            ),
        )
    };
    let answer = tokio::time::timeout(UPDATE_TIMEOUT, async {
        loop {
            match read_frame(&mut stream).await {
                Ok(Some(Frame::Json(Message::Response { id: 1, result, error }))) => {
                    return match error {
                        Some(e) => Err(e),
                        None => Ok(result.unwrap_or(Value::Null)),
                    };
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => return Err(too_old()),
            }
        }
    })
    .await;
    answer.unwrap_or_else(|_| Err(RpcError::new("timeout", "the host did not answer")))
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
                    os,
                    ..
                } = &reply
                && *p != PROTOCOL_VERSION
            {
                return Err(NeedsUpdate {
                    daemon_version: daemon_version.clone().unwrap_or_default(),
                    os: os.clone(),
                }
                .into());
            }
            let (r, w) = stream.into_split();
            Ok((Box::new(r) as Reader, Box::new(w) as Writer))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_code_says_to_start_again_on_the_host() {
        let refused = anyhow::Error::new(Refused("this phone is not paired with this Mac".into()));
        assert_eq!(
            pair_error_text("studio-mini", &refused),
            "The code was not accepted. Start pairing again on studio-mini."
        );
        let unreachable = anyhow!("100.101.102.103:47428: Connection refused")
            .context("cannot reach the host over Tailscale");
        assert_eq!(
            pair_error_text("studio-mini", &unreachable),
            "Cannot pair with studio-mini: cannot reach the host over Tailscale: 100.101.102.103:47428: Connection refused"
        );
    }

    /// A daemon from before X69 authenticates, then closes the connection on
    /// anything but `hello`.
    #[tokio::test]
    async fn a_host_from_before_the_update_request_is_too_old() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let _auth = read_frame(&mut s).await.unwrap();
            let authed = Message::Authed {
                device_id: "d1".into(),
                token: None,
                protocol: Some(6),
                daemon_version: Some("0.1.33".into()),
                host: Some("studio-mini".into()),
                os: Some("macos".into()),
            };
            write_frame(&mut s, &Frame::Json(authed)).await.unwrap();
            let _request = read_frame(&mut s).await.unwrap();
        });
        let e = update(&[addr], "token", "0.1.34").await.unwrap_err();
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            ("too_old", "studio-mini runs moonlet 0.1.33, which can't be updated from here")
        );
    }

    #[tokio::test]
    async fn a_host_that_no_longer_knows_this_mac_refuses() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let _auth = read_frame(&mut s).await.unwrap();
            let no = Message::err(0, RpcError::new("unauthorized", "this device is not paired"));
            write_frame(&mut s, &Frame::Json(no)).await.unwrap();
        });
        let e = update(&[addr], "token", "0.1.34").await.unwrap_err();
        assert_eq!((e.code.as_str(), e.message.as_str()), ("refused", "this device is not paired"));
    }
}
