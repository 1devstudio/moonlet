//! Tailscale addresses (X39, X57): which addresses are on the tailnet, and
//! where a host typed by name listens.

use std::net::{IpAddr, SocketAddr};

/// The port a daemon's tailnet listener uses unless told otherwise (X39).
pub const DEFAULT_PORT: u16 = 47428;

/// Tailscale's IPv4 range (`100.64.0.0/10`) and IPv6 prefix (`fd7a:115c:a1e0::/48`).
pub fn is_tailscale(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 100 && (o[1] & 0xc0) == 64
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0
        }
    }
}

/// Splits `build-box:47500` into the name and the port, 47428 by default.
pub fn name_and_port(typed: &str) -> (&str, u16) {
    match typed.rsplit_once(':') {
        Some((name, port)) if !name.contains(':') => match port.parse() {
            Ok(p) => (name, p),
            Err(_) => (typed, DEFAULT_PORT),
        },
        _ => (typed, DEFAULT_PORT),
    }
}

/// Where the daemon of a host typed as `typed` listens, from the addresses
/// its name `resolved` to. Only Tailscale addresses count, so a pairing code
/// never goes to a machine off the tailnet.
pub fn listener_addrs(typed: &str, resolved: &[IpAddr]) -> Result<Vec<String>, String> {
    let (name, port) = name_and_port(typed);
    let on_tailnet: Vec<String> = resolved
        .iter()
        .filter(|ip| is_tailscale(**ip))
        .map(|ip| SocketAddr::new(*ip, port).to_string())
        .collect();
    match (on_tailnet.is_empty(), resolved.first()) {
        (false, _) => Ok(on_tailnet),
        (true, Some(ip)) => Err(format!(
            "{name} is not on your tailnet (it resolves to {ip})."
        )),
        (true, None) => Err(format!(
            "{name} was not found. Is Tailscale running on this Mac?"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ips(list: &[&str]) -> Vec<IpAddr> {
        list.iter().map(|a| a.parse().unwrap()).collect()
    }

    #[test]
    fn a_name_on_the_tailnet_gives_its_listener_addresses() {
        assert_eq!(
            listener_addrs(
                "studio-mini",
                &ips(&["100.101.102.103", "fd7a:115c:a1e0::1"])
            ),
            Ok(vec![
                "100.101.102.103:47428".to_string(),
                "[fd7a:115c:a1e0::1]:47428".to_string()
            ])
        );
        assert_eq!(
            listener_addrs("build-box:47500", &ips(&["100.88.1.20"])),
            Ok(vec!["100.88.1.20:47500".to_string()])
        );
        // Only the tailnet addresses of a name that has others too.
        assert_eq!(
            listener_addrs("studio-mini", &ips(&["192.168.1.23", "100.101.102.103"])),
            Ok(vec!["100.101.102.103:47428".to_string()])
        );
    }

    #[test]
    fn a_name_off_the_tailnet_gets_no_code() {
        assert_eq!(
            listener_addrs("studio-mini", &ips(&["203.0.113.7"])),
            Err("studio-mini is not on your tailnet (it resolves to 203.0.113.7).".to_string())
        );
        assert_eq!(
            listener_addrs("studio-mini", &[]),
            Err("studio-mini was not found. Is Tailscale running on this Mac?".to_string())
        );
    }

    #[test]
    fn only_tailscale_addresses_count() {
        // Addresses as `ifconfig` lists them on a Mac with Tailscale.
        for a in [
            "100.101.102.103",
            "100.64.0.1",
            "100.127.255.254",
            "fd7a:115c:a1e0::1234:5678",
        ] {
            assert!(is_tailscale(a.parse().unwrap()), "{a}");
        }
        for a in [
            "192.168.1.23",
            "100.63.255.255",
            "100.128.0.1",
            "127.0.0.1",
            "fe80::1",
            "fd7a:115c:a1e1::1",
        ] {
            assert!(!is_tailscale(a.parse().unwrap()), "{a}");
        }
    }
}
