use serde::{Deserialize, Serialize};
use serde_json::Value;

/// JSON messages carried in `kind = 1` frames.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Message {
    /// First message from the client. The daemon closes the connection if
    /// `protocol` does not match its own [`crate::PROTOCOL_VERSION`].
    Hello {
        protocol: u32,
        client: String,
        /// This Mac's app credential (X75), sent to its own daemon's socket
        /// alone: the connection counts as the app. Daemons before X75
        /// ignore it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_token: Option<String>,
    },
    /// Daemon's reply to `Hello`.
    Welcome {
        protocol: u32,
        daemon_version: String,
        host: String,
        pid: u32,
    },
    Request {
        id: u64,
        method: String,
        #[serde(default)]
        params: Value,
    },
    Response {
        id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<RpcError>,
    },
    /// Unsolicited notification from the daemon.
    Event {
        name: String,
        #[serde(default)]
        data: Value,
    },
    /// First message on a phone connection, before `Hello` (X39): a device
    /// `token`, or a `pair` code with the `device` name to pair, and with
    /// `kind` what is pairing (X57, phone when absent). `route` asks the
    /// daemon to connect through to one of its SSH hosts.
    Auth {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pair: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        device: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        route: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<crate::methods::DeviceKind>,
    },
    /// The daemon's reply to a good `Auth`. `token` is set only when a
    /// pairing just created the device: the phone keeps it. The daemon's
    /// `protocol`, `daemon_version` and `host` label come before `Hello`, so a
    /// client learns them even when the protocols differ (X57). Daemons
    /// before X57 leave them out.
    Authed {
        device_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        protocol: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        daemon_version: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        host: Option<String>,
        /// `macos` or `linux`, so a client can say how to update the host (X58).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        os: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[error("{code}: {message}")]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

impl RpcError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl Message {
    /// A success response; a result that fails to serialise becomes an
    /// `internal` error instead of a silent `null`.
    pub fn ok(id: u64, result: impl Serialize) -> Self {
        match serde_json::to_value(result) {
            Ok(v) => Message::Response {
                id,
                result: Some(v),
                error: None,
            },
            Err(e) => Message::err(id, RpcError::new("internal", e.to_string())),
        }
    }

    pub fn err(id: u64, error: RpcError) -> Self {
        Message::Response {
            id,
            result: None,
            error: Some(error),
        }
    }

    pub fn event(name: impl Into<String>, data: impl Serialize) -> Self {
        Message::Event {
            name: name.into(),
            data: serde_json::to_value(data).unwrap_or(Value::Null),
        }
    }
}
