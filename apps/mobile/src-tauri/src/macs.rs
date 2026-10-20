//! The phone's connections (X39, X40): one [`Host`] per paired Mac, over TCP
//! to the Mac's Tailscale addresses with the device token, and one per SSH
//! host the Mac routes to (`<mac id>/<alias>`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use moonlet_link::{
    BoxFuture, Connector, Events, Host, HostInfo, HostOptions, HostStatus, Reader, Writer,
};
use moonlet_proto::methods::MobileHost;
use moonlet_proto::{Frame, Message, RpcError, read_frame, write_frame};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::net::TcpStream;

/// The phone app's name in `hello`.
pub const CLIENT: &str = "moonlet-mobile";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);

/// A paired Mac. Its token is kept in the [`Tokens`] store, never in the
/// app's file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SavedMac {
    /// The device id the Mac gave this phone; also the Mac's host id here.
    pub id: String,
    pub name: String,
    /// `ip:port`s from the pairing link, tried in order.
    pub addrs: Vec<String>,
    #[serde(skip)]
    pub token: String,
}

/// Where device tokens live: the Keychain in the app, memory in tests. A
/// token gives full access to the Mac (X39).
pub trait Tokens: Send + Sync + 'static {
    fn get(&self, mac: &str) -> Option<String>;
    fn set(&self, mac: &str, token: &str) -> Result<()>;
    fn delete(&self, mac: &str);
}

#[derive(Default)]
pub struct MemoryTokens(Mutex<HashMap<String, String>>);

impl Tokens for MemoryTokens {
    fn get(&self, mac: &str) -> Option<String> {
        self.0.lock().unwrap().get(mac).cloned()
    }
    fn set(&self, mac: &str, token: &str) -> Result<()> {
        self.0.lock().unwrap().insert(mac.into(), token.into());
        Ok(())
    }
    fn delete(&self, mac: &str) {
        self.0.lock().unwrap().remove(mac);
    }
}

/// Tokens in the Keychain, one generic password per Mac. On iOS the item is
/// readable while the phone is unlocked, and only on this device.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub struct Keychain {
    pub service: String,
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
impl Tokens for Keychain {
    fn get(&self, mac: &str) -> Option<String> {
        use security_framework::passwords::{PasswordOptions, generic_password};
        let bytes =
            generic_password(PasswordOptions::new_generic_password(&self.service, mac)).ok()?;
        String::from_utf8(bytes).ok()
    }
    fn set(&self, mac: &str, token: &str) -> Result<()> {
        use security_framework::passwords::{PasswordOptions, set_generic_password_options};
        #[allow(unused_mut)]
        let mut opts = PasswordOptions::new_generic_password(&self.service, mac);
        // Not in backups, not on another device. (A macOS build is for
        // development; its unsigned binary has no data protection keychain.)
        #[cfg(target_os = "ios")]
        {
            use security_framework::access_control::{ProtectionMode, SecAccessControl};
            let ac = SecAccessControl::create_with_protection(
                Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
                0,
            )
            .map_err(|e| anyhow!("cannot protect the token: {e}"))?;
            opts.set_access_control(ac);
        }
        set_generic_password_options(token.as_bytes(), opts)
            .map_err(|e| anyhow!("cannot keep the token in the Keychain: {e}"))
    }
    fn delete(&self, mac: &str) {
        let _ = security_framework::passwords::delete_generic_password(&self.service, mac);
    }
}

/// A host as the webview lists it: the link's info plus how it is reached.
#[derive(Debug, Clone, Serialize)]
pub struct HostEntry {
    #[serde(flatten)]
    pub info: HostInfo,
    /// The paired Mac this host is reached through (itself for a Mac).
    pub mac: String,
    /// The Mac's name, for a host routed through it.
    pub via: Option<String>,
}

/// Sends an `auth` frame on `stream` and reads the daemon's answer.
async fn authenticate(stream: &mut TcpStream, auth: Message) -> Result<Message> {
    write_frame(stream, &Frame::Json(auth)).await?;
    match tokio::time::timeout(AUTH_TIMEOUT, read_frame(stream))
        .await
        .context("the Mac did not answer")??
    {
        Some(Frame::Json(m @ Message::Authed { .. })) => Ok(m),
        Some(Frame::Json(Message::Response { error: Some(e), .. })) => Err(anyhow!(e.message)),
        Some(other) => bail!("unexpected reply {other:?}"),
        None => bail!("the Mac closed the connection"),
    }
}

/// Connects to the first address that answers.
async fn dial(addrs: &[String]) -> Result<TcpStream> {
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
    Err(last).context("cannot reach the Mac over Tailscale")
}

/// Pairs with the code from a `moonlet://pair` link; returns the Mac to keep.
pub async fn pair(name: &str, addrs: Vec<String>, code: &str, device: &str) -> Result<SavedMac> {
    let mut stream = dial(&addrs).await?;
    let reply = authenticate(
        &mut stream,
        Message::Auth {
            token: None,
            pair: Some(code.into()),
            device: Some(device.into()),
            route: None,
            kind: None,
        },
    )
    .await?;
    let Message::Authed {
        device_id,
        token: Some(token),
    } = reply
    else {
        bail!("the Mac did not hand out a token");
    };
    Ok(SavedMac {
        id: device_id,
        name: name.into(),
        addrs,
        token,
    })
}

struct MacConnector {
    mac: SavedMac,
    route: Option<String>,
}

impl Connector for MacConnector {
    fn connect(&self) -> BoxFuture<'_, Result<(Reader, Writer)>> {
        Box::pin(async move {
            let mut stream = dial(&self.mac.addrs).await?;
            authenticate(
                &mut stream,
                Message::Auth {
                    token: Some(self.mac.token.clone()),
                    pair: None,
                    device: None,
                    route: self.route.clone(),
                    kind: None,
                },
            )
            .await?;
            let (r, w) = stream.into_split();
            Ok((Box::new(r) as Reader, Box::new(w) as Writer))
        })
    }
}

/// Where statuses and events go: the webview, through the app.
pub trait Sink: Send + Sync + 'static {
    fn status(&self, entry: &HostEntry);
    fn event(&self, host: &str, name: String, data: Value);
}

struct PhoneEvents {
    phone: Weak<Phone>,
}

impl Events for PhoneEvents {
    fn status(&self, info: &HostInfo) {
        let Some(phone) = self.phone.upgrade() else {
            return;
        };
        if let Some(entry) = phone.entry_for(info) {
            phone.sink.status(&entry);
        }
        // A Mac that connects tells which SSH hosts it reaches.
        if info.status == HostStatus::Connected
            && phone.macs.lock().unwrap().iter().any(|m| m.id == info.id)
        {
            let rt = phone.rt.clone();
            let id = info.id.clone();
            rt.spawn(async move { phone.sync_routes(&id).await });
        }
    }

    fn event(&self, host: &str, name: String, data: Value) {
        if let Some(phone) = self.phone.upgrade() {
            phone.sink.event(host, name, data);
        }
    }
}

pub struct Phone {
    file: PathBuf,
    tokens: Arc<dyn Tokens>,
    macs: Mutex<Vec<SavedMac>>,
    hosts: Mutex<HashMap<String, Arc<Host>>>,
    sink: Box<dyn Sink>,
    rt: tokio::runtime::Handle,
    me: Weak<Phone>,
}

impl Phone {
    /// Loads the paired Macs from `file`, their tokens from `tokens`, and
    /// starts connecting to each. A Mac whose token is gone is dropped.
    pub fn start(
        file: PathBuf,
        tokens: Arc<dyn Tokens>,
        sink: impl Sink,
        rt: tokio::runtime::Handle,
    ) -> Arc<Phone> {
        let macs: Vec<SavedMac> = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<SavedMac>>(&s).ok())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|m| {
                Some(SavedMac {
                    token: tokens.get(&m.id)?,
                    ..m
                })
            })
            .collect();
        let phone = Arc::new_cyclic(|me| Phone {
            file,
            tokens,
            macs: Mutex::new(macs.clone()),
            hosts: Mutex::new(HashMap::new()),
            sink: Box::new(sink),
            rt,
            me: me.clone(),
        });
        for m in macs {
            phone.connect(&m, None);
        }
        phone
    }

    /// Writes the Macs, without tokens, readable by this user only.
    fn save(&self) {
        let macs = self.macs.lock().unwrap().clone();
        if let Err(e) = write_private(&self.file, &serde_json::to_vec_pretty(&macs).unwrap()) {
            tracing::warn!("cannot save paired Macs: {e:#}");
        }
    }

    fn connect(&self, mac: &SavedMac, route: Option<&MobileHost>) {
        let id = match route {
            Some(r) => format!("{}/{}", mac.id, r.id),
            None => mac.id.clone(),
        };
        let mut hosts = self.hosts.lock().unwrap();
        // Not for a Mac forgotten meanwhile, such as while its routes loaded.
        if hosts.contains_key(&id) || !self.macs.lock().unwrap().iter().any(|m| m.id == mac.id) {
            return;
        }
        let host = Host::start(
            HostOptions {
                id: id.clone(),
                label: route.map_or_else(|| mac.name.clone(), |r| r.label.clone()),
                remote: route.is_some(),
                client: CLIENT.into(),
            },
            Arc::new(MacConnector {
                mac: mac.clone(),
                route: route.map(|r| r.id.clone()),
            }),
            Arc::new(PhoneEvents {
                phone: self.me.clone(),
            }),
            self.rt.clone(),
        );
        hosts.insert(id, host);
    }

    /// Adds a Mac that just paired and connects to it.
    pub fn add(&self, mac: SavedMac) -> Result<HostEntry> {
        self.tokens.set(&mac.id, &mac.token)?;
        {
            let mut macs = self.macs.lock().unwrap();
            macs.retain(|m| m.id != mac.id);
            macs.push(mac.clone());
        }
        self.save();
        self.connect(&mac, None);
        Ok(self.entry(&mac.id).expect("just added"))
    }

    /// Forgets a Mac and the hosts reached through it.
    pub fn forget(&self, id: &str) {
        self.macs.lock().unwrap().retain(|m| m.id != id);
        self.save();
        self.tokens.delete(id);
        let prefix = format!("{id}/");
        let gone: Vec<Arc<Host>> = {
            let mut hosts = self.hosts.lock().unwrap();
            let ids: Vec<String> = hosts
                .keys()
                .filter(|k| *k == id || k.starts_with(&prefix))
                .cloned()
                .collect();
            ids.iter().filter_map(|k| hosts.remove(k)).collect()
        };
        for h in gone {
            h.stop();
        }
    }

    /// Connects to each SSH host the Mac reaches that is not connected yet.
    async fn sync_routes(&self, mac_id: &str) {
        let Ok(mac_host) = self.get(mac_id) else {
            return;
        };
        let Some(mac) = self
            .macs
            .lock()
            .unwrap()
            .iter()
            .find(|m| m.id == mac_id)
            .cloned()
        else {
            return;
        };
        let Ok(list) = mac_host
            .request(moonlet_proto::methods::MOBILE_HOSTS, Value::Null)
            .await
        else {
            return;
        };
        let routes: Vec<MobileHost> = serde_json::from_value(list).unwrap_or_default();
        for r in &routes {
            self.connect(&mac, Some(r));
        }
    }

    pub fn get(&self, id: &str) -> Result<Arc<Host>, RpcError> {
        self.hosts
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| RpcError::new("unknown_host", format!("unknown host {id}")))
    }

    fn entry_for(&self, info: &HostInfo) -> Option<HostEntry> {
        let macs = self.macs.lock().unwrap();
        let (mac_id, routed) = match info.id.split_once('/') {
            Some((m, _)) => (m, true),
            None => (info.id.as_str(), false),
        };
        let mac = macs.iter().find(|m| m.id == mac_id)?;
        Some(HostEntry {
            info: info.clone(),
            mac: mac.id.clone(),
            via: routed.then(|| mac.name.clone()),
        })
    }

    pub fn entry(&self, id: &str) -> Option<HostEntry> {
        let info = self.get(id).ok()?.info();
        self.entry_for(&info)
    }

    /// Macs first, in pairing order, each followed by its routed hosts.
    pub fn list(&self) -> Vec<HostEntry> {
        let order: Vec<String> = self
            .macs
            .lock()
            .unwrap()
            .iter()
            .map(|m| m.id.clone())
            .collect();
        let hosts: Vec<HostInfo> = self
            .hosts
            .lock()
            .unwrap()
            .values()
            .map(|h| h.info())
            .collect();
        let mut out: Vec<HostEntry> = hosts.iter().filter_map(|i| self.entry_for(i)).collect();
        out.sort_by_key(|e| {
            (
                order.iter().position(|m| *m == e.mac).unwrap_or(usize::MAX),
                e.via.is_some(),
                e.info.id.clone(),
            )
        });
        out
    }
}

/// Writes `bytes` to `path` with mode 0600, through a temporary file.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}
