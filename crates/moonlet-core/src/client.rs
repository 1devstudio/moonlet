//! Small request/response client for the daemon socket, used by the CLI,
//! `moonletd proxy` and tests. The desktop app has its own streaming client.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use moonlet_proto::{Frame, Message, PROTOCOL_VERSION, read_frame, write_frame};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::net::UnixStream;

pub struct Client {
    stream: UnixStream,
    next_id: u64,
    pub welcome: Message,
    /// Frames that arrived while waiting for a response.
    pub backlog: Vec<Frame>,
}

impl Client {
    pub async fn connect(path: &Path, client: &str) -> Result<Client> {
        Self::connect_with(path, client, None).await
    }

    /// [`Self::connect`] as this Mac's app, `moonlet-app`, with the
    /// credential the daemon of `home` (its `MOONLET_HOME`) wrote (X75).
    pub async fn connect_app(path: &Path, home: &Path) -> Result<Client> {
        let token = crate::app_token::read(&crate::app_token::file_in(home));
        Self::connect_with(path, "moonlet-app", token.as_deref()).await
    }

    /// [`Self::connect`] with this Mac's app credential (X75), which the
    /// daemon of the socket's home wrote: the connection counts as the app.
    pub async fn connect_with(
        path: &Path,
        client: &str,
        app_token: Option<&str>,
    ) -> Result<Client> {
        let mut stream = UnixStream::connect(path)
            .await
            .with_context(|| format!("cannot connect to {}", path.display()))?;
        write_frame(
            &mut stream,
            &Frame::Json(Message::Hello {
                protocol: PROTOCOL_VERSION,
                client: client.into(),
                app_token: app_token.map(str::to_string),
            }),
        )
        .await?;
        let welcome = match read_frame(&mut stream).await? {
            Some(Frame::Json(m @ Message::Welcome { .. })) => m,
            Some(Frame::Json(Message::Response { error: Some(e), .. })) => {
                bail!("daemon refused connection: {e}")
            }
            other => bail!("unexpected handshake reply: {other:?}"),
        };
        Ok(Client {
            stream,
            next_id: 1,
            welcome,
            backlog: Vec::new(),
        })
    }

    pub async fn request<P: Serialize, R: DeserializeOwned>(
        &mut self,
        method: &str,
        params: P,
    ) -> Result<R> {
        let id = self.next_id;
        self.next_id += 1;
        let params = serde_json::to_value(params)?;
        write_frame(
            &mut self.stream,
            &Frame::Json(Message::Request {
                id,
                method: method.into(),
                params,
            }),
        )
        .await?;
        loop {
            match read_frame(&mut self.stream).await? {
                None => bail!("daemon closed the connection"),
                Some(Frame::Json(Message::Response {
                    id: rid,
                    result,
                    error,
                })) if rid == id => {
                    if let Some(e) = error {
                        return Err(anyhow!(e));
                    }
                    return Ok(serde_json::from_value(
                        result.unwrap_or(serde_json::Value::Null),
                    )?);
                }
                Some(other) => self.backlog.push(other),
            }
        }
    }

    pub async fn send(&mut self, frame: &Frame) -> Result<()> {
        write_frame(&mut self.stream, frame).await?;
        Ok(())
    }

    pub async fn next_frame(&mut self) -> Result<Option<Frame>> {
        if !self.backlog.is_empty() {
            return Ok(Some(self.backlog.remove(0)));
        }
        Ok(read_frame(&mut self.stream).await?)
    }

    pub fn into_stream(self) -> UnixStream {
        self.stream
    }
}

/// Waits for a daemon socket to accept connections.
pub async fn wait_for_socket(path: &PathBuf, timeout: Duration) -> Result<()> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if UnixStream::connect(path).await.is_ok() {
            return Ok(());
        }
        if tokio::time::Instant::now() > deadline {
            bail!("daemon did not start within {timeout:?}");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
