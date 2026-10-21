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

/// How much a connection's packs may hold, so a peer cannot fill the
/// memory of the side it sends to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackLimits {
    /// One pack.
    pub max_pack: usize,
    /// Every pack waiting on the connection, whole or in part, together.
    pub max_buffered: usize,
    /// Transfers waiting at once, whole or in part.
    pub max_transfers: usize,
    /// How long a whole pack waits for the request that takes it, and a
    /// pack in part for its next chunk.
    pub keep_done: std::time::Duration,
}

/// The largest pack a connection accepts.
pub const MAX_PACK_LEN: usize = 1024 * 1024 * 1024;

impl Default for PackLimits {
    fn default() -> Self {
        Self {
            max_pack: MAX_PACK_LEN,
            max_buffered: MAX_PACK_LEN,
            max_transfers: 16,
            keep_done: std::time::Duration::from_secs(60),
        }
    }
}

/// A pack chunk over one of the [`PackLimits`]. The connection that sent
/// it is closed.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PackError {
    #[error("pack {0} is over {1} bytes")]
    TooLarge(u32, usize),
    #[error("packs waiting are over {0} bytes")]
    TooMuch(usize),
    #[error("more than {0} packs are waiting")]
    TooMany(usize),
    #[error("pack {0} is already whole")]
    Complete(u32),
}

/// Puts packs back together from their [`Frame::Pack`] chunks, by
/// transfer id, within its [`PackLimits`].
#[derive(Default)]
pub struct PackAssembler {
    limits: PackLimits,
    /// Packs in part, with when their last chunk came.
    partial: std::collections::HashMap<u32, (Vec<u8>, std::time::Instant)>,
    done: std::collections::HashMap<u32, (Vec<u8>, std::time::Instant)>,
}

impl PackAssembler {
    pub fn new(limits: PackLimits) -> Self {
        Self {
            limits,
            ..Self::default()
        }
    }

    /// Adds a chunk; an empty one completes its transfer.
    pub fn push(&mut self, transfer: u32, data: Vec<u8>) -> Result<(), PackError> {
        self.drop_stale();
        let l = self.limits;
        if self.done.contains_key(&transfer) {
            return Err(PackError::Complete(transfer));
        }
        let waiting = self.partial.contains_key(&transfer) || self.done.contains_key(&transfer);
        if !waiting && self.partial.len() + self.done.len() >= l.max_transfers {
            return Err(PackError::TooMany(l.max_transfers));
        }
        if data.is_empty() {
            let pack = self.partial.remove(&transfer).map(|(p, _)| p).unwrap_or_default();
            self.done.insert(transfer, (pack, std::time::Instant::now()));
            return Ok(());
        }
        let so_far = self.partial.get(&transfer).map_or(0, |(p, _)| p.len());
        if so_far + data.len() > l.max_pack {
            return Err(PackError::TooLarge(transfer, l.max_pack));
        }
        let buffered: usize = self.partial.values().map(|(p, _)| p.len()).sum::<usize>()
            + self.done.values().map(|(p, _)| p.len()).sum::<usize>();
        if buffered + data.len() > l.max_buffered {
            return Err(PackError::TooMuch(l.max_buffered));
        }
        let (pack, at) = self
            .partial
            .entry(transfer)
            .or_insert_with(|| (Vec::new(), std::time::Instant::now()));
        pack.extend_from_slice(&data);
        *at = std::time::Instant::now();
        Ok(())
    }

    /// A completed transfer's pack, once.
    pub fn take(&mut self, transfer: u32) -> Option<Vec<u8>> {
        self.drop_stale();
        self.done.remove(&transfer).map(|(p, _)| p)
    }

    /// Drops whole packs no request took in time, and packs in part whose
    /// sender stopped sending.
    fn drop_stale(&mut self) {
        let keep = self.limits.keep_done;
        self.done.retain(|_, (_, at)| at.elapsed() < keep);
        self.partial.retain(|_, (_, at)| at.elapsed() < keep);
    }
}
