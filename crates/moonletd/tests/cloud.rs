//! X63 end to end: cloud workers' settings, machines made with the fake
//! provider, idle time, limits and the sweep. Needs `moonletd` built
//! (`cargo test --workspace`).

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use moonlet_core::client::{Client, wait_for_socket};
use moonlet_proto::methods::{DeviceKind, MobilePairing};
use moonlet_proto::{Frame, Message};
use serde_json::{Value, json};

struct Daemon {
    home: tempfile::TempDir,
    socket: PathBuf,
    child: Child,
}

impl Daemon {
    async fn start(home: tempfile::TempDir, env: &[(&str, &str)]) -> Daemon {
        let socket = home.path().join("run").join("d.sock");
        let child = spawn(home.path(), &socket, env).await;
        Daemon {
            home,
            socket,
            child,
        }
    }

    async fn app(&self) -> Client {
        Client::connect(&self.socket, "moonlet-app").await.unwrap()
    }

    async fn call<T: serde::de::DeserializeOwned>(&self, method: &str, params: Value) -> T {
        self.app().await.request(method, params).await.unwrap()
    }

    async fn fails(&self, method: &str, params: Value) -> String {
        let e = self
            .app()
            .await
            .request::<_, Value>(method, params)
            .await
            .unwrap_err();
        e.to_string()
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

async fn spawn(home: &Path, socket: &Path, env: &[(&str, &str)]) -> Child {
    let child = Command::new(env!("CARGO_BIN_EXE_moonletd"))
        .arg("daemon")
        .env("MOONLET_HOME", home)
        .env("MOONLET_SOCK", socket)
        .env("CLAUDE_CONFIG_DIR", home.join("claude"))
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    wait_for_socket(&socket.to_path_buf(), Duration::from_secs(15))
        .await
        .unwrap();
    child
}

/// A central host listening on the loopback for paired devices.
async fn listening() -> (Daemon, String) {
    let home = tempfile::tempdir().unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    std::fs::write(
        home.path().join("mobile.json"),
        format!(r#"{{ "enabled": true, "port": {port} }}"#),
    )
    .unwrap();
    let d = Daemon::start(home, &[("MOONLET_MOBILE_ADDRS", "127.0.0.1")]).await;
    let addr = format!("127.0.0.1:{port}");
    for _ in 0..100 {
        let st: Value = d.call("mobile.status", json!({})).await;
        if st["listening"]
            .as_array()
            .is_some_and(|l| l.contains(&json!(addr)))
        {
            return (d, addr);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("never listened on {addr}");
}

async fn pair(d: &Daemon, addr: &str, device: &str, kind: DeviceKind) -> String {
    let p: MobilePairing = d.call("mobile.pair_start", json!({})).await;
    moonlet_link::tailnet::pair(&[addr.to_string()], &p.code, device, kind)
        .await
        .unwrap()
        .token
}

/// The error code a paired device gets for `method`, or None.
async fn as_device(addr: &str, token: &str, method: &str, params: Value) -> Option<String> {
    use moonlet_proto::{read_frame, write_frame};
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let auth = Message::Auth {
        token: Some(token.into()),
        pair: None,
        device: None,
        route: None,
        kind: None,
    };
    write_frame(&mut s, &Frame::Json(auth)).await.unwrap();
    read_frame(&mut s).await.unwrap();
    let hello = Message::Hello {
        protocol: moonlet_proto::PROTOCOL_VERSION,
        client: "moonlet-app".into(),
    };
    write_frame(&mut s, &Frame::Json(hello)).await.unwrap();
    read_frame(&mut s).await.unwrap();
    let req = Message::Request {
        id: 7,
        method: method.into(),
        params,
    };
    write_frame(&mut s, &Frame::Json(req)).await.unwrap();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(10), read_frame(&mut s))
            .await
            .expect("no reply")
            .unwrap();
        if let Some(Frame::Json(Message::Response { id: 7, error, .. })) = frame {
            return error.map(|e| e.code);
        }
    }
}

fn settings() -> Value {
    json!({
        "providers": { "hetzner": { "token": "hc-secret-token" } },
        "tailscale": { "client_id": "kQ7cLient1CNTRL", "client_secret": "tskey-client-secret", "tag": "tag:moonlet-worker" },
        "idle_minutes": 15,
        "max_machines": 2,
        "max_hours_month": 40
    })
}

#[tokio::test]
async fn cloud_get_returns_no_secrets() {
    let d = Daemon::start(tempfile::tempdir().unwrap(), &[]).await;
    let _: Value = d.call("cloud.set", settings()).await;
    let got: Value = d.call("cloud.get", json!({})).await;
    assert_eq!(
        got["providers"],
        json!({ "hetzner": { "has_token": true } })
    );
    assert_eq!(
        got["tailscale"],
        json!({ "client_id": "kQ7cLient1CNTRL", "has_client_secret": true, "tag": "tag:moonlet-worker" })
    );
    assert_eq!(
        (
            got["idle_minutes"].clone(),
            got["max_machines"].clone(),
            got["max_hours_month"].clone()
        ),
        (json!(15), json!(2), json!(40))
    );
    let text = got.to_string();
    assert!(
        !text.contains("hc-secret-token") && !text.contains("tskey-client-secret"),
        "{text}"
    );
    // Kept for the central host alone.
    let file = d.home.path().join("cloud.json");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(
        std::fs::read_to_string(&file)
            .unwrap()
            .contains("hc-secret-token")
    );
    // A field left out keeps its value; Hetzner is the provider on offer.
    let _: Value = d.call("cloud.set", json!({ "idle_minutes": 0 })).await;
    let got: Value = d.call("cloud.get", json!({})).await;
    assert_eq!(got["idle_minutes"], json!(0));
    assert_eq!(got["providers"]["hetzner"]["has_token"], json!(true));
    assert_eq!(got["kinds"][0]["id"], json!("hetzner"));
    assert_eq!(got["kinds"][0]["fields"][0]["secret"], json!(true));
    assert_eq!(
        d.fails("cloud.set", json!({ "idle_minutes": 1441 })).await,
        "invalid_params: the idle time is from 0 to 1440 minutes"
    );
}

#[tokio::test]
async fn cloud_set_from_the_cli_or_a_phone_is_forbidden() {
    let (d, addr) = listening().await;
    let mut cli = Client::connect(&d.socket, "moonlet-cli").await.unwrap();
    let e = cli
        .request::<_, Value>("cloud.set", settings())
        .await
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        "forbidden: only the moonlet app manages cloud workers"
    );
    let phone = pair(&d, &addr, "Alex's iPhone", DeviceKind::Phone).await;
    assert_eq!(
        as_device(&addr, &phone, "cloud.set", settings())
            .await
            .as_deref(),
        Some("forbidden")
    );
    let desktop = pair(&d, &addr, "Alex's MacBook Pro", DeviceKind::Desktop).await;
    assert_eq!(
        as_device(&addr, &desktop, "cloud.set", settings()).await,
        None
    );
}
