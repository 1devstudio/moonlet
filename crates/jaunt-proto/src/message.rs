use serde::{Deserialize, Serialize};
use serde_json::Value;

/// JSON messages carried in `kind = 1` frames.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Message {
    /// First message from the client. The daemon closes the connection if
    /// `protocol` does not match its own [`crate::PROTOCOL_VERSION`].
    Hello { protocol: u32, client: String },
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
