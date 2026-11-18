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

/// The tailnet as this machine's Tailscale reports it: its own addresses
/// and every device it may hear from. An address in Tailscale's range is
/// not enough: 100.64.0.0/10 is the carrier-grade NAT range, which a phone
/// tether, a carrier, another VPN or a cloud network also hands out.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tailnet {
    /// This machine's addresses, IPv4 first.
    pub own: Vec<IpAddr>,
    /// This machine's and its peers' addresses.
    members: Vec<IpAddr>,
}

impl Tailnet {
    /// From `tailscale status --json`; `None` unless Tailscale is running
    /// (`BackendState` `Running`). Only addresses in Tailscale's range count,
    /// whatever else the output holds.
    pub fn from_status(json: &[u8]) -> Option<Tailnet> {
        let v: serde_json::Value = serde_json::from_slice(json).ok()?;
        if v["BackendState"] != "Running" {
            return None;
        }
        let addrs = |node: &serde_json::Value| -> Vec<IpAddr> {
            node["TailscaleIPs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|a| a.as_str()?.parse::<IpAddr>().ok())
                .filter(|ip| is_tailscale(*ip))
                .collect()
        };
        let mut own = addrs(&v["Self"]);
        if own.is_empty() {
            own = addrs(&v);
        }
        Some(Tailnet::new(
            own,
            v["Peer"]
                .as_object()
                .into_iter()
                .flatten()
                .flat_map(|(_, p)| addrs(p))
                .collect(),
        ))
    }

    /// A tailnet of `own` addresses and `peers`, taken as they are: the
    /// test seam's (`MOONLET_MOBILE_ADDRS`) is loopback.
    pub fn new(mut own: Vec<IpAddr>, peers: Vec<IpAddr>) -> Tailnet {
        own.sort_by_key(|ip| (ip.is_ipv6(), *ip));
        own.dedup();
        let mut members: Vec<IpAddr> = own.iter().copied().chain(peers).collect();
        members.sort();
        members.dedup();
        Tailnet { own, members }
    }

    /// This tailnet's peers with `own` as this machine's addresses, for the
    /// test seam.
    pub fn with_own(self, own: Vec<IpAddr>) -> Tailnet {
        Tailnet::new(own, self.members)
    }

    /// The addresses to listen on: this machine's Tailscale addresses that
    /// one of its interfaces (`local`) has.
    pub fn listen_on(&self, local: &[IpAddr]) -> Vec<IpAddr> {
        self.own
            .iter()
            .copied()
            .filter(|ip| local.contains(ip))
            .collect()
    }

    /// Whether a connection from `peer` comes from a device of this tailnet,
    /// this machine included.
    pub fn lets_in(&self, peer: IpAddr) -> bool {
        self.members.contains(&peer.to_canonical())
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

/// Checks the addresses of a pasted pairing link: each must be on the
/// tailnet, or this machine's loopback. A forged link could otherwise point
/// the app at a machine off the tailnet, which would then run its sessions.
pub fn link_addrs_allowed(addrs: &[String]) -> Result<(), String> {
    for a in addrs {
        let ok = a
            .parse::<SocketAddr>()
            .is_ok_and(|s| is_tailscale(s.ip()) || s.ip().is_loopback());
        if !ok {
            return Err(format!(
                "The link points at {a}, which is not on your tailnet."
            ));
        }
    }
    Ok(())
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
    fn a_link_may_point_only_at_the_tailnet_or_this_machine() {
        assert_eq!(
            link_addrs_allowed(&[
                "100.101.102.103:47428".into(),
                "[fd7a:115c:a1e0::1]:47428".into()
            ]),
            Ok(())
        );
        // The e2e tests pair with a daemon on this machine.
        assert_eq!(link_addrs_allowed(&["127.0.0.1:50123".into()]), Ok(()));
        assert_eq!(
            link_addrs_allowed(&["100.101.102.103:47428".into(), "203.0.113.7:47428".into()]),
            Err("The link points at 203.0.113.7:47428, which is not on your tailnet.".to_string())
        );
        assert_eq!(
            link_addrs_allowed(&["studio-mini:47428".into()]),
            Err("The link points at studio-mini:47428, which is not on your tailnet.".to_string())
        );
    }

    /// `tailscale status --json` while Tailscale runs, cut down to the
    /// fields read here. The field names are Tailscale's `ipnstate.Status`;
    /// the names and addresses are made up.
    const RUNNING: &str = r#"{
      "Version": "1.90.6-t0123456789-gabcdef012",
      "BackendState": "Running",
      "TailscaleIPs": ["100.101.102.103", "fd7a:115c:a1e0::1"],
      "Self": {
        "ID": "nSelf1CNTRL",
        "HostName": "studio-mini",
        "DNSName": "studio-mini.tail1234.ts.net.",
        "TailscaleIPs": ["100.101.102.103", "fd7a:115c:a1e0::1"],
        "Online": true
      },
      "Peer": {
        "nodekey:0a1b": {
          "HostName": "Alex's iPhone",
          "DNSName": "alexs-iphone.tail1234.ts.net.",
          "TailscaleIPs": ["100.88.1.20", "fd7a:115c:a1e0::2"],
          "Online": true
        },
        "nodekey:2c3d": {
          "HostName": "build-box",
          "DNSName": "build-box.tail1234.ts.net.",
          "TailscaleIPs": ["100.77.3.4"],
          "Online": false
        },
        "nodekey:4e5f": { "HostName": "no-addresses-yet", "TailscaleIPs": null }
      }
    }"#;

    #[test]
    fn tailscale_says_this_machines_addresses_and_its_peers() {
        let t = Tailnet::from_status(RUNNING.as_bytes()).unwrap();
        assert_eq!(t.own, ips(&["100.101.102.103", "fd7a:115c:a1e0::1"]));
        for a in ["100.101.102.103", "100.88.1.20", "fd7a:115c:a1e0::2", "100.77.3.4"] {
            assert!(t.lets_in(a.parse().unwrap()), "{a}");
        }
    }

    #[test]
    fn a_tailscale_that_is_not_running_gives_no_tailnet() {
        for state in ["Stopped", "NeedsLogin", "NeedsMachineAuth", "Starting", "NoState"] {
            let status = RUNNING.replace(r#""Running""#, &format!("{state:?}"));
            assert_eq!(Tailnet::from_status(status.as_bytes()), None, "{state}");
        }
        assert_eq!(Tailnet::from_status(b""), None);
        assert_eq!(
            Tailnet::from_status(b"failed to connect to local tailscaled; it doesn't appear to be running"),
            None
        );
    }

    #[test]
    fn an_address_tailscale_does_not_report_is_not_listened_on() {
        let t = Tailnet::from_status(RUNNING.as_bytes()).unwrap();
        // This machine's interfaces: Tailscale's, a phone tether's address
        // in the same 100.64.0.0/10 range, and the LAN's.
        let local = ips(&["100.101.102.103", "100.72.5.9", "192.168.1.23", "fd7a:115c:a1e0::1"]);
        assert_eq!(t.listen_on(&local), ips(&["100.101.102.103", "fd7a:115c:a1e0::1"]));
        // An address Tailscale reports that no interface here has cannot be bound.
        assert_eq!(t.listen_on(&ips(&["100.72.5.9"])), Vec::<IpAddr>::new());
    }

    #[test]
    fn only_tailscale_range_addresses_count_whatever_tailscale_says() {
        let status = RUNNING
            .replace(r#"["100.101.102.103", "fd7a:115c:a1e0::1"]"#, r#"["100.101.102.103", "192.0.2.4"]"#)
            .replace(r#"["100.77.3.4"]"#, r#"["198.51.100.9"]"#);
        let t = Tailnet::from_status(status.as_bytes()).unwrap();
        assert_eq!(t.own, ips(&["100.101.102.103"]));
        assert_eq!(t.listen_on(&ips(&["100.101.102.103", "192.0.2.4"])), ips(&["100.101.102.103"]));
        assert!(!t.lets_in("198.51.100.9".parse().unwrap()));
        assert!(!t.lets_in("192.0.2.4".parse().unwrap()));
    }

    #[test]
    fn only_peers_tailscale_lists_are_let_in() {
        let t = Tailnet::from_status(RUNNING.as_bytes()).unwrap();
        for a in [
            // In 100.64.0.0/10 but no device of this tailnet: a tether, a
            // carrier's NAT, another VPN.
            "100.100.20.30",
            "100.64.0.1",
            "fd7a:115c:a1e0::99",
            "192.168.1.40",
            "127.0.0.1",
        ] {
            assert!(!t.lets_in(a.parse().unwrap()), "{a}");
        }
        // A peer seen through an IPv6 socket as `::ffff:100.88.1.20`.
        assert!(t.lets_in("::ffff:100.88.1.20".parse().unwrap()));
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
