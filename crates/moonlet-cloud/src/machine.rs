//! A cloud machine's name and labels (X63).

use std::collections::BTreeMap;

/// `moonlet-<project>-<suffix>`, in the characters a host name takes, cut
/// to `max` characters by shortening the project's part.
pub fn machine_name(project: &str, suffix: &str, max: usize) -> String {
    // Lowercase letters, digits and single dashes, none at either end.
    let mut part = String::new();
    for c in project.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            part.push(c);
        } else if !part.ends_with('-') {
            part.push('-');
        }
    }
    let room = max.saturating_sub("moonlet-".len() + 1 + suffix.len());
    let part: String = part.trim_matches('-').chars().take(room).collect();
    let part = part.trim_end_matches('-');
    if part.is_empty() {
        format!("moonlet-{suffix}")
    } else {
        format!("moonlet-{part}-{suffix}")
    }
}

/// 4 random lowercase letters and digits.
pub fn suffix() -> String {
    use std::hash::{BuildHasher, Hasher};
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    // Std's per-process random keys, mixed with the time: enough for a name.
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
    );
    let mut n = h.finish();
    (0..4)
        .map(|_| {
            let c = ALPHABET[(n % ALPHABET.len() as u64) as usize] as char;
            n /= ALPHABET.len() as u64;
            c
        })
        .collect()
}

/// The labels of a machine: the central host's id, the machine's id and
/// the first 12 hex digits of the sha256 of the project's identity.
pub fn labels(host_id: &str, machine_id: &str, identity: &str) -> BTreeMap<String, String> {
    use sha2::{Digest, Sha256};
    let hash: String = Sha256::digest(identity.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    [
        ("moonlet-host", host_id.to_string()),
        ("moonlet-machine", machine_id.to_string()),
        ("moonlet-project", hash[..12].to_string()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_fit_the_providers_limit_and_characters() {
        assert_eq!(machine_name("shop", "7k2q", 63), "moonlet-shop-7k2q");
        assert_eq!(
            machine_name("Shop App_2", "7k2q", 63),
            "moonlet-shop-app-2-7k2q"
        );
        assert_eq!(machine_name("--café--", "7k2q", 63), "moonlet-caf-7k2q");
        assert_eq!(
            machine_name("a-very-long-project-name", "7k2q", 24),
            "moonlet-a-very-long-7k2q"
        );
        // Never ends the project's part on a dash.
        assert_eq!(
            machine_name("abcdefghi-jkl", "7k2q", 23),
            "moonlet-abcdefghi-7k2q"
        );
        let s = suffix();
        assert_eq!(s.len(), 4);
        assert!(
            s.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()),
            "{s}"
        );
    }

    #[test]
    fn labels_carry_the_host_machine_and_project() {
        let l = labels(
            "c3f1a9e2b7d04c55",
            "m7k2q",
            "github.com/acme/shop 4171b03ff0d2bd434751f17bc9d34da784f97e72",
        );
        let want: BTreeMap<String, String> = [
            ("moonlet-host", "c3f1a9e2b7d04c55"),
            ("moonlet-machine", "m7k2q"),
            ("moonlet-project", "ed24a5573a72"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert_eq!(l, want);
    }
}
