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
    /// Another member, worker id `to`, reached through this member's
    /// central host with `peer.call` (X89).
    Relay(Arc<moonlet_link::Host>, String),
}

impl Peer {
    /// Who sent a run's output or `exec.done`, as [`crate::exec::Runs`]
    /// keys them.
    pub fn id(&self) -> ClientId {
        match self {
            Peer::Conn(c) => c.id,
            Peer::Link(_) | Peer::Relay(..) => LINK_PEER,
        }
    }

    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, RpcError> {
        match self {
            Peer::Conn(c) => c.request(method, params, timeout).await,
            Peer::Link(h) => match tokio::time::timeout(timeout, h.request(method, params)).await {
                Ok(reply) => reply,
                Err(_) => Err(RpcError::new("timeout", format!("{method} timed out"))),
            },
            Peer::Relay(h, to) => {
                let call = moonlet_proto::methods::PeerCall {
                    to: Some(to.clone()),
                    from: None,
                    method: method.to_string(),
                    params,
                };
                let call = serde_json::to_value(call).unwrap();
                match tokio::time::timeout(timeout, h.request(moonlet_proto::methods::PEER_CALL, call)).await {
                    Ok(reply) => reply,
                    Err(_) => Err(RpcError::new("timeout", format!("{method} timed out"))),
                }
            }
        }
    }

    /// [`Peer::request`] whose timeout starts once what was queued before
    /// it, such as a pack, is written.
    pub async fn request_after_queue(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, RpcError> {
        match self {
            Peer::Conn(c) => c.request_after_queue(method, params, timeout).await,
            Peer::Link(_) | Peer::Relay(..) => self.request(method, params, timeout).await,
        }
    }

    pub fn send_pack(&self, pack: &[u8]) -> Result<u32, RpcError> {
        match self {
            Peer::Conn(c) => c.send_pack(pack),
            Peer::Link(h) | Peer::Relay(h, _) => h.send_pack(pack),
        }
    }

    pub fn take_pack(&self, transfer: u32) -> Option<Vec<u8>> {
        match self {
            Peer::Conn(c) => c.take_pack(transfer),
            Peer::Link(h) | Peer::Relay(h, _) => h.take_pack(transfer),
        }
    }

    /// Output of run `run` going back to the host that routed it.
    pub fn send_run_output(&self, run: u32, stream: u8, data: Vec<u8>) -> bool {
        match self {
            Peer::Conn(c) => c.tx.send(Frame::RunOutput { run, stream, data }),
            Peer::Link(h) | Peer::Relay(h, _) => h.send_run_output(run, stream, data).is_ok(),
        }
    }

    /// The connection went away, or the link is not connected now.
    pub fn is_gone(&self) -> bool {
        match self {
            Peer::Conn(c) => c.is_gone(),
            Peer::Link(h) | Peer::Relay(h, _) => !matches!(h.info().status, moonlet_link::HostStatus::Connected),
        }
    }

    /// Which connection of the link a run started on (X89): a link that
    /// connected again lost what the old connection carried. None for a
    /// server connection, which never comes back as itself.
    pub fn generation(&self) -> Option<u64> {
        match self {
            Peer::Conn(_) => None,
            Peer::Link(h) | Peer::Relay(h, _) => Some(h.connection()),
        }
    }

    /// On a runner: whether the host that routed a run here, which came on
    /// the link's connection `started` ([`Peer::generation`]), may have
    /// given it up. It has then counted the run as lost, so the run stops
    /// rather than go on unobserved (X89).
    pub fn gave_up(&self, started: Option<u64>) -> bool {
        match self {
            Peer::Conn(c) => c.is_gone(),
            Peer::Link(h) | Peer::Relay(h, _) => given_up(
                !self.is_gone(),
                Some(h.connection()) != started,
                h.silent_for(),
                silence_limit(),
            ),
        }
    }

    /// A cloud machine's connection, which gets only the files of a run.
    pub fn is_cloud(&self) -> bool {
        match self {
            Peer::Conn(c) => c.cloud.load(std::sync::atomic::Ordering::Relaxed),
            Peer::Link(_) | Peer::Relay(..) => false,
        }
    }
}

/// How long a runner's link may hear nothing from its central host before
/// the host counts as gone: it pings every linked worker every 10 s, and
/// drops one after 3 missed pings, so by then the host has given up too.
/// `MOONLET_TEST_LINK_SILENCE_MS` sets it in tests.
pub fn silence_limit() -> Duration {
    std::env::var("MOONLET_TEST_LINK_SILENCE_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .map_or(Duration::from_secs(45), Duration::from_millis)
}

/// Whether a runner counts the host whose run it runs as having given the
/// run up (X89): the link is down, it connected again since the run started
/// (the host counts a run on a replaced connection as lost, and nothing
/// picks it up again), or it heard nothing for `limit`, as a host that went
/// away without closing the link leaves it.
pub fn given_up(connected: bool, reconnected: bool, silent: Duration, limit: Duration) -> bool {
    !connected || reconnected || silent >= limit
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_runner_gives_a_run_up_once_its_link_drops_connects_again_or_goes_silent() {
        let limit = Duration::from_secs(45);
        let quiet = Duration::from_secs(9);
        // Linked on the same connection, pinged lately: the run goes on.
        assert!(!given_up(true, false, quiet, limit));
        // The link is down.
        assert!(given_up(false, false, quiet, limit));
        // It connected again since the run started, however quickly.
        assert!(given_up(true, true, Duration::ZERO, limit));
        // Nothing heard for 45 s, the connection still open.
        assert!(given_up(true, false, Duration::from_secs(45), limit));
        assert!(!given_up(true, false, Duration::from_secs(44), limit));
    }
}
