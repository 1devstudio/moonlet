//! Where the app keeps its tokens for tailnet hosts (X57): in the one
//! Keychain item that holds the tracker tokens (X91), so a start still asks
//! for the password once at most. `app-hosts.json` keeps the rest, and the
//! token's hash for this Mac's daemon (X41).

use crate::secrets::Secrets;
use moonlet_core::ssh::TailnetHost;
use serde::{Deserialize, Serialize};

/// A host's key in the Keychain item: its name and this Mac's device id on
/// it. Two homes that pair with one host (a dev build's scratch home beside
/// the app) get two device ids, and a host cannot pick a device id that
/// lands on another host's key, since names are unique.
pub fn key(host: &TailnetHost) -> String {
    format!("host:{}:{}", host.id, host.device_id)
}

/// What the Keychain keeps for a host: the token, and the addresses it may
/// be sent to. The app connects to these, not to the file's, so editing
/// `app-hosts.json` cannot send the token anywhere else.
#[derive(Serialize, Deserialize)]
struct Kept {
    token: String,
    addrs: Vec<String>,
}

/// A tailnet host as the app holds it: `host.token` is the token, or `""`
/// when it could not be read from the Keychain.
#[derive(Clone, Debug, PartialEq)]
pub struct HeldHost {
    pub host: TailnetHost,
    /// The Keychain holds the token, so the file need not.
    pub in_store: bool,
    /// The Keychain refused the token this start: it is not asked again
    /// until the host is paired again or the app starts again, as X91 asks
    /// no more after a refusal.
    pub refused: bool,
}

impl HeldHost {
    /// A host just paired: its token goes to the Keychain at the next save.
    pub fn paired(host: TailnetHost) -> Self {
        Self {
            host,
            in_store: false,
            refused: false,
        }
    }
}

/// The hosts in `app-hosts.json`, with their tokens. A token still in the
/// file is used as it is and moved at the next save; the others come from
/// the store.
pub fn load(file: Vec<TailnetHost>, store: &dyn Secrets) -> Vec<HeldHost> {
    file.into_iter()
        .map(|t| {
            if !t.token.is_empty() {
                return HeldHost::paired(t);
            }
            let kept = store
                .get(&key(&t))
                .and_then(|v| serde_json::from_str::<Kept>(&v).ok());
            match kept {
                Some(k) => HeldHost {
                    in_store: true,
                    refused: false,
                    host: TailnetHost {
                        token: k.token,
                        addrs: k.addrs,
                        ..t
                    },
                },
                None => HeldHost::paired(t),
            }
        })
        .collect()
}

/// What `app-hosts.json` keeps for `held`. A token not in the store yet is
/// moved there first, and leaves the file only once the store has kept it;
/// one the store refuses stays in the file as it was, and is not offered
/// again this start. A token that could not be read is written as the file
/// had it.
pub fn file_entry(held: &mut HeldHost, store: &dyn Secrets) -> TailnetHost {
    let token = &held.host.token;
    if token.is_empty() || held.refused {
        return held.host.clone();
    }
    if !held.in_store {
        let kept = serde_json::to_string(&Kept {
            token: token.clone(),
            addrs: held.host.addrs.clone(),
        })
        .expect("a host's token serializes");
        match store.set(&key(&held.host), &kept) {
            Ok(()) => held.in_store = true,
            Err(e) => {
                held.refused = true;
                tracing::warn!(
                    host = held.host.id,
                    "its token stays in app-hosts.json: {e}"
                );
                return held.host.clone();
            }
        }
    }
    TailnetHost {
        token: String::new(),
        token_sha256: moonlet_core::hash::sha256_hex(token.as_bytes()),
        ..held.host.clone()
    }
}

/// Removes a forgotten host's token from the store, also when this start
/// could not read it.
pub fn forget(held: &HeldHost, store: &dyn Secrets) {
    store.delete(&key(&held.host));
}

/// The host to connect to, Make central host with or update, which needs
/// its token: one the Keychain did not give this start cannot be used.
pub fn usable(host: &TailnetHost) -> Result<&TailnetHost, String> {
    if host.token.is_empty() {
        return Err(NO_TOKEN.into());
    }
    Ok(host)
}

pub const NO_TOKEN: &str = "moonlet could not read this Mac's token for the host from the Keychain. Quit moonlet and open it again.";

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    /// The Keychain item as the app sees it through `Secrets`, with the
    /// writes it was asked for: each is a change a dev build may prompt for.
    #[derive(Default)]
    struct FakeKeychain {
        tokens: Mutex<BTreeMap<String, String>>,
        writes: Mutex<Vec<String>>,
        /// Saving fails, as when the user cancels the password prompt.
        refuses_writes: bool,
        /// Reading fails, so every token reads as missing.
        refuses_reads: bool,
    }

    impl FakeKeychain {
        fn with(tokens: &[(&str, &str)]) -> Self {
            let k = Self::default();
            for (id, t) in tokens {
                k.tokens
                    .lock()
                    .unwrap()
                    .insert(id.to_string(), t.to_string());
            }
            k
        }
        fn tokens(&self) -> Vec<(String, String)> {
            self.tokens.lock().unwrap().clone().into_iter().collect()
        }
        fn writes(&self) -> Vec<String> {
            self.writes.lock().unwrap().clone()
        }
    }

    impl Secrets for FakeKeychain {
        fn get(&self, id: &str) -> Option<String> {
            if self.refuses_reads {
                return None;
            }
            self.tokens.lock().unwrap().get(id).cloned()
        }
        fn set(&self, id: &str, token: &str) -> Result<(), String> {
            self.writes.lock().unwrap().push(id.into());
            if self.refuses_writes {
                return Err("User canceled the operation.".into());
            }
            self.tokens.lock().unwrap().insert(id.into(), token.into());
            Ok(())
        }
        fn delete(&self, id: &str) {
            self.writes.lock().unwrap().push(id.into());
            self.tokens.lock().unwrap().remove(id);
        }
    }

    /// studio-mini as `app-hosts.json` holds it, with `token` and `hash`.
    fn mini(device_id: &str, token: &str, hash: &str) -> TailnetHost {
        TailnetHost {
            id: "studio-mini".into(),
            device_id: device_id.into(),
            addrs: vec!["100.101.102.103:47428".into()],
            token: token.into(),
            token_sha256: hash.into(),
        }
    }

    /// What the Keychain item keeps for studio-mini with `token`.
    fn kept(token: &str) -> String {
        format!(r#"{{"token":"{token}","addrs":["100.101.102.103:47428"]}}"#)
    }

    fn entry(key: &str, value: &str) -> (String, String) {
        (key.to_string(), value.to_string())
    }

    const TOK_1_SHA256: &str = "65dcf16ea3dfa49069628089eb4a75483070f5584b2a21ee64912b5f621f12da";
    const TOK_2_SHA256: &str = "b9d7f2826c798e990d30dd291fddb436a01327c293788ce57195e60c7efb82b2";

    /// One start of the app: what it connects with, and what it writes.
    fn start(file: Vec<TailnetHost>, store: &dyn Secrets) -> (Vec<String>, Vec<TailnetHost>) {
        let mut held = load(file, store);
        let tokens = held.iter().map(|h| h.host.token.clone()).collect();
        let written = held.iter_mut().map(|h| file_entry(h, store)).collect();
        (tokens, written)
    }

    #[test]
    fn a_token_in_the_file_moves_into_the_keychain_and_out_of_the_file() {
        let keychain = FakeKeychain::default();
        let (tokens, written) = start(vec![mini("d1", "tok-1", "")], &keychain);
        assert_eq!(tokens, ["tok-1"]);
        assert_eq!(written, [mini("d1", "", TOK_1_SHA256)]);
        assert_eq!(
            keychain.tokens(),
            [entry("host:studio-mini:d1", &kept("tok-1"))]
        );

        // The next start reads it from the Keychain.
        let (tokens, _) = start(written, &keychain);
        assert_eq!(tokens, ["tok-1"]);
    }

    #[test]
    fn a_keychain_that_refuses_the_token_leaves_the_file_as_it_was() {
        let keychain = FakeKeychain {
            refuses_writes: true,
            ..Default::default()
        };
        let mut held = load(vec![mini("d1", "tok-1", "")], &keychain);
        assert_eq!(
            held[0].host.token, "tok-1",
            "the host connects with the file's token"
        );
        let written = vec![file_entry(&mut held[0], &keychain)];
        assert_eq!(written, [mini("d1", "tok-1", "")]);
        assert!(keychain.tokens().is_empty());
        // Later saves this start (adding an SSH host) do not ask again.
        assert_eq!(file_entry(&mut held[0], &keychain), mini("d1", "tok-1", ""));
        assert_eq!(keychain.writes(), ["host:studio-mini:d1"]);

        // It is moved at a later start, once the Keychain takes it.
        let keychain = FakeKeychain::default();
        let (tokens, written) = start(written, &keychain);
        assert_eq!(tokens, ["tok-1"]);
        assert_eq!(written, [mini("d1", "", TOK_1_SHA256)]);
    }

    #[test]
    fn a_host_already_moved_needs_nothing_written() {
        let keychain = FakeKeychain::with(&[("host:studio-mini:d1", &kept("tok-1"))]);
        let (tokens, written) = start(vec![mini("d1", "", TOK_1_SHA256)], &keychain);
        assert_eq!(tokens, ["tok-1"]);
        assert_eq!(written, [mini("d1", "", TOK_1_SHA256)]);
        assert!(keychain.writes().is_empty(), "{:?}", keychain.writes());
    }

    #[test]
    fn a_token_the_keychain_cannot_read_leaves_the_host_without_one_and_the_file_as_it_was() {
        let keychain = FakeKeychain {
            refuses_reads: true,
            ..FakeKeychain::with(&[("host:studio-mini:d1", &kept("tok-1"))])
        };
        let mut held = load(vec![mini("d1", "", TOK_1_SHA256)], &keychain);
        assert_eq!(held[0].host.token, "");
        assert_eq!(usable(&held[0].host), Err("moonlet could not read this Mac's token for the host from the Keychain. Quit moonlet and open it again.".to_string()));
        assert_eq!(
            file_entry(&mut held[0], &keychain),
            mini("d1", "", TOK_1_SHA256)
        );
        assert!(keychain.writes().is_empty(), "{:?}", keychain.writes());
        assert_eq!(
            keychain.tokens(),
            [entry("host:studio-mini:d1", &kept("tok-1"))]
        );

        // Removing the host still deletes its token.
        forget(&held[0], &keychain);
        assert!(keychain.tokens().is_empty());
    }

    #[test]
    fn the_token_goes_only_to_the_addresses_it_was_kept_with() {
        let keychain = FakeKeychain::with(&[("host:studio-mini:d1", &kept("tok-1"))]);
        // Another process of the user edits the file's addresses.
        let mut edited = mini("d1", "", TOK_1_SHA256);
        edited.addrs = vec!["127.0.0.1:47999".into()];
        let mut held = load(vec![edited], &keychain);
        assert_eq!(held[0].host.addrs, ["100.101.102.103:47428"]);
        assert_eq!(
            usable(&held[0].host).unwrap().addrs,
            ["100.101.102.103:47428"]
        );
        // The next save writes the kept addresses back.
        assert_eq!(
            file_entry(&mut held[0], &keychain),
            mini("d1", "", TOK_1_SHA256)
        );
    }

    #[test]
    fn a_host_cannot_take_another_hosts_key_with_its_device_id() {
        let keychain = FakeKeychain::with(&[("host:studio-mini:d1", &kept("tok-1"))]);
        // build-box answers pairing with studio-mini's device id.
        let mut box_host = HeldHost::paired(TailnetHost {
            id: "build-box".into(),
            addrs: vec!["100.88.1.20:47428".into()],
            ..mini("d1", "tok-2", "")
        });
        file_entry(&mut box_host, &keychain);
        let (tokens, _) = start(vec![mini("d1", "", TOK_1_SHA256)], &keychain);
        assert_eq!(tokens, ["tok-1"], "studio-mini's token was replaced");
    }

    #[test]
    fn pairing_again_puts_the_new_token_in_the_keychain() {
        let keychain = FakeKeychain::with(&[("host:studio-mini:d1", &kept("tok-1"))]);
        let mut held = load(vec![mini("d1", "", TOK_1_SHA256)], &keychain);
        // The user forgets studio-mini and pairs with it again.
        forget(&held[0], &keychain);
        held[0] = HeldHost::paired(mini("d2", "tok-2", ""));
        assert_eq!(
            file_entry(&mut held[0], &keychain),
            mini("d2", "", TOK_2_SHA256)
        );
        assert_eq!(
            keychain.tokens(),
            [entry("host:studio-mini:d2", &kept("tok-2"))]
        );

        // A build from before this change paired again and wrote its token
        // into the file under the same device id: the Keychain takes it.
        let (tokens, written) = start(vec![mini("d2", "tok-3", "")], &keychain);
        assert_eq!(tokens, ["tok-3"]);
        assert_eq!(written[0].token, "");
        assert_eq!(
            keychain.tokens(),
            [entry("host:studio-mini:d2", &kept("tok-3"))]
        );
    }
}
