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
//! * `kind = 4` — git pack data: `[u32 BE transfer id][bytes]`, between a
//!   worker and its central host (X60). See [`pack_frames`].
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
pub const PROTOCOL_VERSION: u32 = 5;

/// Upper bound for a single frame. Larger frames are a protocol error.
pub const MAX_FRAME_LEN: usize = 16 * 1024 * 1024;

pub type TerminalId = u32;

/// One unit on the wire.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Json(Message),
    Output { terminal: TerminalId, data: Vec<u8> },
    Input { terminal: TerminalId, data: Vec<u8> },
    /// A chunk of a git pack (X60). A transfer is its chunks in order, then
    /// an empty one; the JSON message that uses it names its transfer id.
    Pack { transfer: u32, data: Vec<u8> },
}

impl Frame {
    pub fn json(message: Message) -> Self {
        Frame::Json(message)
    }
}

pub(crate) const KIND_JSON: u8 = 1;
pub(crate) const KIND_OUTPUT: u8 = 2;
pub(crate) const KIND_INPUT: u8 = 3;
pub(crate) const KIND_PACK: u8 = 4;

/// A pack travels in chunks of at most this many bytes, so a large one
/// never holds up terminal output on the same connection.
pub const PACK_CHUNK: usize = 1024 * 1024;

/// The frames that carry `data` as transfer `transfer`: chunks of at most
/// [`PACK_CHUNK`] bytes, then an empty one.
pub fn pack_frames(transfer: u32, data: &[u8]) -> Vec<Frame> {
    data.chunks(PACK_CHUNK)
        .map(|c| c.to_vec())
        .chain(std::iter::once(Vec::new()))
        .map(|data| Frame::Pack { transfer, data })
        .collect()
}

/// Puts packs back together from their [`Frame::Pack`] chunks, by
/// transfer id.
#[derive(Default)]
pub struct PackAssembler {
    partial: std::collections::HashMap<u32, Vec<u8>>,
    done: std::collections::HashMap<u32, Vec<u8>>,
}

impl PackAssembler {
    /// Adds a chunk; an empty one completes its transfer.
    pub fn push(&mut self, transfer: u32, data: Vec<u8>) {
        if data.is_empty() {
            let pack = self.partial.remove(&transfer).unwrap_or_default();
            self.done.insert(transfer, pack);
        } else {
            self.partial.entry(transfer).or_default().extend_from_slice(&data);
        }
    }

    /// A completed transfer's pack, once.
    pub fn take(&mut self, transfer: u32) -> Option<Vec<u8>> {
        self.done.remove(&transfer)
    }
}
