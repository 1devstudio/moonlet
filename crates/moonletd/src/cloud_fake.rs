//! The fake cloud provider (X63), for tests only: on with
//! `MOONLET_CLOUD_FAKE=<dir>`. It "creates" a machine by starting a scratch
//! `moonletd` in `<dir>/<id>` that runs the same join steps as a real
//! machine's first-boot script, read from its `user_data`. "Destroy" stops
//! it. Files in `<dir>` steer it: `no-join` (machines never join),
//! `fail-destroy` (a number: that many destroy calls fail), `slow-create`
//! (create takes that many ms).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use moonlet_cloud::{
    CloudError, Listed, MachineInfo, MachineState, MachineType, NewMachine, Provider, ProviderInfo,
};
use serde_json::{Value, json};

pub struct Fake {
    dir: PathBuf,
    next: AtomicU32,
}

/// The fake provider, when `MOONLET_CLOUD_FAKE` names its folder.
pub fn from_env() -> Option<Fake> {
    let dir = PathBuf::from(std::env::var_os("MOONLET_CLOUD_FAKE")?);
    Some(Fake {
        next: AtomicU32::new(count(&dir)),
        dir,
    })
}

pub fn info() -> ProviderInfo {
    ProviderInfo {
        id: "fake".into(),
        label: "Fake cloud".into(),
        fields: vec![],
        max_name: 63,
        tailnet_key: false,
    }
}

fn count(dir: &Path) -> u32 {
    std::fs::read_dir(dir).map_or(0, |d| d.count() as u32)
}

fn now_ms() -> u64 {
    moonlet_core::paths::now_ms()
}

/// The text between `before` and the next `after` in `s`.
fn between<'a>(s: &'a str, before: &str, after: &str) -> Option<&'a str> {
    let start = s.find(before)? + before.len();
    let end = s[start..].find(after)? + start;
    Some(&s[start..end])
}

impl Fake {
    fn machine(&self, id: &str) -> PathBuf {
        self.dir.join(id)
    }

    fn steer(&self, name: &str) -> Option<String> {
        std::fs::read_to_string(self.dir.join(name))
            .ok()
            .map(|s| s.trim().to_string())
    }
}

/// Boots machine `dir` as its first-boot script would: the daemon, the
/// join, then the machine setup.
async fn boot(dir: PathBuf, user_data: String, join: bool) {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("moonletd"));
    let home = dir.join("home");
    let socket = home.join("run").join("d.sock");
    let setup_dir = dir.join("setup");
    let _ = std::fs::create_dir_all(&setup_dir);
    // `tailscale` on the machine is a stub that notes its arguments in the
    // fake's folder: the real one would log the test's own Mac out.
    let stub = dir.join("tailscale");
    let calls = dir.parent().unwrap_or(&dir).join("tailscale-calls");
    let _ = std::fs::write(&stub, format!("#!/bin/sh\necho \"$*\" >> '{}'\n", calls.display()));
    let _ = std::fs::set_permissions(&stub, std::os::unix::fs::PermissionsExt::from_mode(0o755));
    // With a long home the daemon's own socket directory is elsewhere, so
    // this one must exist, private, before it binds.
    let _ = moonlet_core::paths::ensure_private_dir(socket.parent().unwrap_or(&home));
    let mut cmd = tokio::process::Command::new(&exe);
    cmd.arg("daemon")
        .env("MOONLET_HOME", &home)
        .env("MOONLET_SOCK", &socket)
        .env("HOME", &home)
        .env("SHELL", "/bin/sh")
        .env("MOONLET_MOBILE_ADDRS", "127.0.0.2")
        .env("MOONLET_MACHINE_SETUP_DIR", &setup_dir)
        .env("MOONLET_TAILSCALE", &stub)
        // A fresh machine: idle, whatever the central host's test load.
        .env("MOONLET_TEST_LOAD", "0.5")
        .env_remove("MOONLET_CLOUD_FAKE")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let Ok(child) = cmd.spawn() else { return };
    if let Some(pid) = child.id() {
        let _ = std::fs::write(dir.join("pid"), pid.to_string());
    }
    // The daemon outlives this task: destroy stops it by its pid.
    std::mem::forget(child);
    for _ in 0..300 {
        if socket.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    if !join {
        return;
    }
    // `moonletd join '<addrs>' '<code>' --name '<name>'`, as user_data has it.
    let q = "'\\''";
    let line = user_data
        .lines()
        .find(|l| l.contains("moonletd join"))
        .unwrap_or_default();
    let mut parts = line.split(q).skip(1).step_by(2);
    let (Some(addrs), Some(code), Some(name)) = (parts.next(), parts.next(), parts.next()) else {
        return;
    };
    let joined = tokio::process::Command::new(&exe)
        .args(["join", addrs, code, "--name", name])
        .env("MOONLET_SOCK", &socket)
        .env("MOONLET_HOME", &home)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;
    if !joined.is_ok_and(|s| s.success()) {
        return;
    }
    // The machine setup, as root would run it: started, then ended.
    let Some(b64) = between(&user_data, "echo '", "' | base64 -d") else {
        return;
    };
    let path = between(&user_data, "\\\"path\\\":", ",\\\"started").unwrap_or("\"\"");
    let content = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap_or_default()
    };
    let json_file = setup_dir.join("machine-setup.json");
    let started = now_ms() / 1000;
    let path: Value = serde_json::from_str(&path.replace("\\\"", "\"")).unwrap_or(json!(""));
    let _ = std::fs::write(
        &json_file,
        json!({ "path": path, "started": started }).to_string(),
    );
    let status = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(String::from_utf8_lossy(&content).to_string())
        .current_dir(&dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map_or(127, |s| s.code().unwrap_or(1));
    let _ = std::fs::write(
        &json_file,
        json!({ "path": path, "started": started, "ended": now_ms() / 1000, "exit": status })
            .to_string(),
    );
}

#[async_trait::async_trait]
impl Provider for Fake {
    fn info(&self) -> ProviderInfo {
        info()
    }

    async fn machine_types(&self, _location: &str) -> Result<Vec<MachineType>, CloudError> {
        Ok(vec![MachineType {
            name: "small".into(),
            cores: 2,
            memory_gb: 4.0,
            arch: crate::link::arch().into(),
        }])
    }

    async fn create(&self, m: &NewMachine) -> Result<String, CloudError> {
        let id = format!("f{}", self.next.fetch_add(1, Ordering::SeqCst) + 1);
        let dir = self.machine(&id);
        std::fs::create_dir_all(&dir).map_err(|e| CloudError::Provider(format!("500 {e}")))?;
        let meta = json!({ "name": m.name, "labels": m.labels, "created_at": now_ms() });
        let _ = std::fs::write(dir.join("meta.json"), meta.to_string());
        // Made, but slow to answer: what a crash in between leaves.
        if let Some(ms) = self
            .steer("slow-create")
            .and_then(|v| v.parse::<u64>().ok())
        {
            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        }
        let join = self.steer("no-join").is_none();
        tokio::spawn(boot(dir, m.user_data.clone(), join));
        Ok(id)
    }

    async fn get(&self, id: &str) -> Result<MachineInfo, CloudError> {
        let dir = self.machine(id);
        if !dir.join("meta.json").exists() {
            return Ok(MachineInfo {
                state: MachineState::Gone,
                ipv4: None,
            });
        }
        let up = dir.join("pid").exists();
        Ok(MachineInfo {
            state: if up {
                MachineState::Running
            } else {
                MachineState::Starting
            },
            ipv4: Some("127.0.0.1".into()),
        })
    }

    async fn list(&self, labels: &BTreeMap<String, String>) -> Result<Vec<Listed>, CloudError> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(&self.dir).into_iter().flatten().flatten() {
            let Ok(meta) = std::fs::read(e.path().join("meta.json")) else {
                continue;
            };
            let Ok(meta) = serde_json::from_slice::<Value>(&meta) else {
                continue;
            };
            let have: BTreeMap<String, String> =
                serde_json::from_value(meta["labels"].clone()).unwrap_or_default();
            if labels.iter().all(|(k, v)| have.get(k) == Some(v)) {
                out.push(Listed {
                    id: e.file_name().to_string_lossy().to_string(),
                    name: meta["name"].as_str().unwrap_or_default().to_string(),
                    labels: have,
                    created_at: meta["created_at"].as_u64().unwrap_or(0),
                });
            }
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    async fn destroy(&self, id: &str) -> Result<(), CloudError> {
        if let Some(n) = self
            .steer("fail-destroy")
            .and_then(|v| v.parse::<u32>().ok())
            && n > 0
        {
            let _ = std::fs::write(self.dir.join("fail-destroy"), (n - 1).to_string());
            return Err(CloudError::Provider("503 Service Unavailable".into()));
        }
        let dir = self.machine(id);
        if let Some(pid) = std::fs::read_to_string(dir.join("pid"))
            .ok()
            .and_then(|p| p.trim().parse::<i32>().ok())
        {
            let _ = nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(pid),
                nix::sys::signal::Signal::SIGKILL,
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }
}
