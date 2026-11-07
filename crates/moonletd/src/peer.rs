//! The other end of a routed command (X62, X89): a worker's connection to
//! this central host, or this member's link to its central host. Routing
//! goes both ways over a link since X89, so the router and the runner talk
//! through one type whichever side dialed.

use std::sync::Arc;
use std::time::Duration;

use moonlet_core::terminal::ClientId;
use moonlet_proto::{Frame, RpcError};
use serde_json::Value;

use crate::server::Conn;

/// The id a run's output and `exec.done` come from when the other end is
/// this member's central host, over its link: no server connection has it.
pub const LINK_PEER: ClientId = ClientId::MAX;

#[derive(Clone)]
pub enum Peer {
    /// A member's or cloud machine's connection to this central host.
    Conn(Arc<Conn>),
    /// This member's link to its central host.
    Link(Arc<moonlet_link::Host>),
}

impl Peer {
    /// Who sent a run's output or `exec.done`, as [`crate::exec::Runs`]
    /// keys them.
    pub fn id(&self) -> ClientId {
        match self {
            Peer::Conn(c) => c.id,
            Peer::Link(_) => LINK_PEER,
        }
    }

    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, RpcError> {
        match self {
            Peer::Conn(c) => c.request(method, params, timeout).await,
            Peer::Link(h) => match tokio::time::timeout(timeout, h.request(method, params)).await {
                Ok(reply) => reply,
                Err(_) => Err(RpcError::new("timeout", format!("{method} timed out"))),
            },
        }
    }

    /// [`Peer::request`] whose timeout starts once what was queued before
    /// it, such as a pack, is written.
    pub async fn request_after_queue(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, RpcError> {
        match self {
            Peer::Conn(c) => c.request_after_queue(method, params, timeout).await,
            Peer::Link(_) => self.request(method, params, timeout).await,
        }
    }

    pub fn send_pack(&self, pack: &[u8]) -> Result<u32, RpcError> {
        match self {
            Peer::Conn(c) => c.send_pack(pack),
            Peer::Link(h) => h.send_pack(pack),
        }
    }

    pub fn take_pack(&self, transfer: u32) -> Option<Vec<u8>> {
        match self {
            Peer::Conn(c) => c.take_pack(transfer),
            Peer::Link(h) => h.take_pack(transfer),
        }
    }

    /// Output of run `run` going back to the host that routed it.
    pub fn send_run_output(&self, run: u32, stream: u8, data: Vec<u8>) -> bool {
        match self {
            Peer::Conn(c) => c.tx.send(Frame::RunOutput { run, stream, data }),
            Peer::Link(h) => h.send_run_output(run, stream, data).is_ok(),
        }
    }

    /// The connection went away, or the link is not connected now.
    pub fn is_gone(&self) -> bool {
        match self {
            Peer::Conn(c) => c.is_gone(),
            Peer::Link(h) => !matches!(h.info().status, moonlet_link::HostStatus::Connected),
        }
    }

    /// A cloud machine's connection, which gets only the files of a run.
    pub fn is_cloud(&self) -> bool {
        match self {
            Peer::Conn(c) => c.cloud.load(std::sync::atomic::Ordering::Relaxed),
            Peer::Link(_) => false,
        }
    }
}
