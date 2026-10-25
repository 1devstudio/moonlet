//! Cards rendered by the moonlet app (X64, ADR 0013): the render check and
//! snapshots need the app's WebKit, so the daemon asks the app that said it
//! renders (`design.render.ready`) with a `design.render` event, sent on that
//! connection alone, and waits for its `design.render.done`. Never a phone,
//! never an agent's CLI.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use moonlet_core::design::render::NO_APP;
use moonlet_core::terminal::{ClientId, ClientTx};
use moonlet_proto::methods::{DesignRender, DesignRenderDone, EV_DESIGN_RENDER};
use moonlet_proto::{Frame, Message, RpcError};
use tokio::sync::oneshot;

/// How long the app has for one card.
const PER_CARD: Duration = Duration::from_secs(30);

type Reply = oneshot::Sender<Result<DesignRenderDone, RpcError>>;

#[derive(Default)]
pub struct Renders {
    /// The app's connection, once it said it renders.
    app: Mutex<Option<(ClientId, ClientTx)>>,
    /// Renders sent to the app, by id, with the connection they went to.
    waiting: Mutex<HashMap<u64, (ClientId, Reply)>>,
    next: AtomicU64,
}

/// No app renders cards for this daemon.
pub fn no_app() -> RpcError {
    RpcError::new("no_app", NO_APP)
}

impl Renders {
    /// The connection `client` is the Mac's app, which renders from now on.
    pub fn ready(&self, client: ClientId, tx: ClientTx) {
        *self.app.lock().unwrap() = Some((client, tx));
    }

    /// `client` went away: if it was the app, nothing renders until an app
    /// says it does again, and every card it was rendering fails.
    pub fn disconnected(&self, client: ClientId) {
        let mut app = self.app.lock().unwrap();
        if app.as_ref().is_some_and(|(id, _)| *id == client) {
            *app = None;
        }
        drop(app);
        let mut waiting = self.waiting.lock().unwrap();
        let gone: Vec<u64> = waiting
            .iter()
            .filter(|(_, (c, _))| *c == client)
            .map(|(id, _)| *id)
            .collect();
        for id in gone {
            if let Some((_, reply)) = waiting.remove(&id) {
                let _ = reply.send(Err(no_app()));
            }
        }
    }

    /// Whether an app renders now.
    pub fn has_app(&self) -> bool {
        self.app.lock().unwrap().is_some()
    }

    /// Asks the app to render `ask` (its `id` is set here) and waits for
    /// its answer: `no_app` without one, `timeout` after [`PER_CARD`].
    pub async fn render(&self, mut ask: DesignRender) -> Result<DesignRenderDone, RpcError> {
        let Some((client, tx)) = self.app.lock().unwrap().clone() else {
            return Err(no_app());
        };
        ask.id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let id = ask.id;
        let (reply, rx) = oneshot::channel();
        self.waiting.lock().unwrap().insert(id, (client, reply));
        if !tx.send(Frame::Json(Message::event(EV_DESIGN_RENDER, &ask))) {
            self.waiting.lock().unwrap().remove(&id);
            return Err(no_app());
        }
        match tokio::time::timeout(PER_CARD, rx).await {
            Ok(Ok(done)) => done,
            Ok(Err(_)) => Err(no_app()),
            Err(_) => {
                self.waiting.lock().unwrap().remove(&id);
                Err(RpcError::new(
                    "timeout",
                    format!(
                        "the app did not render {} in {} s",
                        ask.path,
                        PER_CARD.as_secs()
                    ),
                ))
            }
        }
    }

    /// The app's answer from connection `client`; only a render sent to
    /// that connection is answered by it.
    pub fn done(&self, client: ClientId, done: DesignRenderDone) -> Result<(), RpcError> {
        let mut waiting = self.waiting.lock().unwrap();
        match waiting.get(&done.id) {
            Some((c, _)) if *c == client => {}
            _ => {
                return Err(RpcError::new(
                    "invalid_params",
                    format!("no render {} waits for this connection", done.id),
                ));
            }
        }
        if let Some((_, reply)) = waiting.remove(&done.id) {
            let _ = reply.send(Ok(done));
        }
        Ok(())
    }
}
