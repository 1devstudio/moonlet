//! The script a cloud machine runs at its first boot (X63): it joins the
//! tailnet, installs moonlet, pairs with the central host and runs the
//! project's machine setup.

/// What the script needs.
#[derive(Debug, Clone, PartialEq)]
pub struct CloudInit {
    pub name: String,
    /// The one-off Tailscale key.
    pub tailscale_key: String,
    /// The central host's moonlet version, installed exactly.
    pub version: String,
    /// The central host's tailnet addresses, `ip:port`.
    pub addrs: Vec<String>,
    pub join_code: String,
    /// `[heavy] machine_setup`: its path and content.
    pub machine_setup: Option<(String, String)>,
}

/// `s` in single quotes, for `sh`.
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// `s` as a JSON string, inside a double-quoted `sh` word. It is written with
/// `printf '%s'`, which, unlike dash's `echo`, decodes no backslashes.
fn json_in_double_quotes(s: &str) -> String {
    serde_json::to_string(s)
        .unwrap_or_default()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('$', "\\$")
        .replace('`', "\\`")
}

/// The `user_data` of a machine.
pub fn render(c: &CloudInit) -> String {
    use base64::Engine;
    let install = format!(
        "curl -fsSL https://github.com/1devstudio/moonlet/releases/download/v{}/install.sh | sh -s -- --no-pair --no-listen",
        c.version
    );
    let join = format!(
        "~/.moonlet/bin/moonletd join {} {} --name {}",
        quote(&c.addrs.join(",")),
        quote(&c.join_code),
        quote(&c.name)
    );
    // moonletd runs as `moonlet`: as Tailscale's operator, it may run
    // `tailscale logout` when the machine is removed.
    let mut out = format!(
        r#"#!/bin/sh
# moonlet cloud worker {name} (X63)
set -eu
useradd --create-home --shell /bin/sh moonlet
loginctl enable-linger moonlet
mkdir -p /var/log/moonlet /var/lib/moonlet
as_moonlet() {{
  runuser -l moonlet -c "export XDG_RUNTIME_DIR=/run/user/$(id -u moonlet); $1"
}}
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --auth-key={key} --hostname={qname} --operator=moonlet
as_moonlet {install}
as_moonlet {join}
"#,
        name = c.name,
        key = quote(&c.tailscale_key),
        qname = quote(&c.name),
        install = quote(&install),
        join = quote(&join),
    );
    // After pairing, so the central host can show its progress; as root.
    if let Some((path, content)) = &c.machine_setup {
        let b64 = base64::engine::general_purpose::STANDARD.encode(content);
        let path = json_in_double_quotes(path);
        out.push_str(&format!(
            r#"echo '{b64}' | base64 -d > /var/lib/moonlet/machine-setup.sh
started=$(date +%s)
printf '%s\n' "{{\"path\":{path},\"started\":$started}}" > /var/lib/moonlet/machine-setup.json
status=0
sh /var/lib/moonlet/machine-setup.sh > /var/log/moonlet/machine-setup.log 2>&1 || status=$?
printf '%s\n' "{{\"path\":{path},\"started\":$started,\"ended\":$(date +%s),\"exit\":$status}}" > /var/lib/moonlet/machine-setup.json
"#
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_the_worked_cloud_init_script() {
        let script = render(&CloudInit {
            name: "moonlet-shop-7k2q".into(),
            tailscale_key: "fake-tailscale-auth-key".into(),
            version: "0.1.29".into(),
            addrs: vec!["100.101.102.103:47428".into()],
            join_code: "7KQ2MXW9PD".into(),
            machine_setup: Some((
                "scripts/ci-deps.sh".into(),
                "apt-get install -y nodejs\n".into(),
            )),
        });
        assert_eq!(
            script,
            r#"#!/bin/sh
# moonlet cloud worker moonlet-shop-7k2q (X63)
set -eu
useradd --create-home --shell /bin/sh moonlet
loginctl enable-linger moonlet
mkdir -p /var/log/moonlet /var/lib/moonlet
as_moonlet() {
  runuser -l moonlet -c "export XDG_RUNTIME_DIR=/run/user/$(id -u moonlet); $1"
}
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --auth-key='fake-tailscale-auth-key' --hostname='moonlet-shop-7k2q' --operator=moonlet
as_moonlet 'curl -fsSL https://github.com/1devstudio/moonlet/releases/download/v0.1.29/install.sh | sh -s -- --no-pair --no-listen'
as_moonlet '~/.moonlet/bin/moonletd join '\''100.101.102.103:47428'\'' '\''7KQ2MXW9PD'\'' --name '\''moonlet-shop-7k2q'\'''
echo 'YXB0LWdldCBpbnN0YWxsIC15IG5vZGVqcwo=' | base64 -d > /var/lib/moonlet/machine-setup.sh
started=$(date +%s)
printf '%s\n' "{\"path\":\"scripts/ci-deps.sh\",\"started\":$started}" > /var/lib/moonlet/machine-setup.json
status=0
sh /var/lib/moonlet/machine-setup.sh > /var/log/moonlet/machine-setup.log 2>&1 || status=$?
printf '%s\n' "{\"path\":\"scripts/ci-deps.sh\",\"started\":$started,\"ended\":$(date +%s),\"exit\":$status}" > /var/lib/moonlet/machine-setup.json
"#
        );
    }

    #[test]
    fn a_machine_without_machine_setup_runs_none() {
        let script = render(&CloudInit {
            name: "moonlet-shop-7k2q".into(),
            tailscale_key: "k".into(),
            version: "0.1.29".into(),
            addrs: vec![
                "100.101.102.103:47428".into(),
                "100.101.102.104:47428".into(),
            ],
            join_code: "C".into(),
            machine_setup: None,
        });
        assert!(
            script.ends_with("--name '\\''moonlet-shop-7k2q'\\'''\n"),
            "{script}"
        );
        assert!(
            script.contains("join '\\''100.101.102.103:47428,100.101.102.104:47428'\\''"),
            "{script}"
        );
    }
}
