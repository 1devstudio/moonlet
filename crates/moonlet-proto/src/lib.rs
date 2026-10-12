//! Wire protocol spoken between `moonletd`, the `moonlet` CLI and the desktop app.
//!
//! A connection is a byte stream (Unix socket locally, SSH stdio remotely)
//! carrying length-prefixed frames:
//!
//! ```text
//! [u32 BE length of the rest][u8 kind][payload]
//! ```
//!
//! * `kind = 1` — a JSON [`Message`] (handshake, request, response, event).
//! * `kind = 2` — PTY output: `[u32 BE session id][raw bytes]`, daemon to client.
//! * `kind = 3` — PTY input: `[u32 BE session id][raw bytes]`, client to daemon.
//!
//! PTY bytes never go through JSON, so busy terminals stay cheap.

mod codec;
mod message;
pub mod methods;
pub mod types;

pub use codec::{FrameDecoder, ProtoError, encode_frame};
#[cfg(feature = "tokio")]
pub use codec::{read_frame, write_frame};
pub use message::{Message, RpcError};

/// Bumped on any incompatible change to framing, messages or method shapes.
pub const PROTOCOL_VERSION: u32 = 3;

/// Upper bound for a single frame. Larger frames are a protocol error.
pub const MAX_FRAME_LEN: usize = 16 * 1024 * 1024;

pub type TerminalId = u32;

/// One unit on the wire.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Json(Message),
    Output { terminal: TerminalId, data: Vec<u8> },
    Input { terminal: TerminalId, data: Vec<u8> },
}

impl Frame {
    pub fn json(message: Message) -> Self {
        Frame::Json(message)
    }
}

pub(crate) const KIND_JSON: u8 = 1;
pub(crate) const KIND_OUTPUT: u8 = 2;
pub(crate) const KIND_INPUT: u8 = 3;
