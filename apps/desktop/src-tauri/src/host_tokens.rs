//! Where the app keeps its tokens for tailnet hosts (X57): in the one
//! Keychain item that holds the tracker tokens (X91), so a start still asks
//! for the password once at most. `app-hosts.json` keeps the rest, and the
//! token's hash for this Mac's daemon (X41).

use crate::secrets::Secrets;
use moonlet_core::ssh::TailnetHost;

/// A host's key in the Keychain item: this Mac's device id on the host, so
/// two homes that pair with one host (a dev build's scratch home beside the
/// app) never share a key.
pub fn key(device_id: &str) -> String {
    format!("host:{device_id}")
}

/// A tailnet host as the app holds it: `host.token` is the token, or `""`
/// when it could not be read from the Keychain.
#[derive(Clone, Debug, PartialEq)]
pub struct HeldHost {
    pub host: TailnetHost,
    /// The Keychain holds the token, so the file need not.
    pub in_store: bool,
}

impl HeldHost {
    /// A host just paired: its token goes to the Keychain at the next save.
    pub fn paired(host: TailnetHost) -> Self {
        Self {
            host,
            in_store: false,
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
                return HeldHost {
                    host: t,
                    in_store: false,
                };
            }
            let token = store.get(&key(&t.device_id));
            HeldHost {
                in_store: token.is_some(),
                host: TailnetHost {
                    token: token.unwrap_or_default(),
                    ..t
                },
            }
        })
        .collect()
}

/// What `app-hosts.json` keeps for `held`. A token not in the store yet is
/// moved there first, and leaves the file only once the store has kept it;
/// one the store refuses stays in the file as it was. A token that could not
/// be read is written as the file had it.
pub fn file_entry(held: &mut HeldHost, store: &dyn Secrets) -> TailnetHost {
    let token = &held.host.token;
    if token.is_empty() {
        return held.host.clone();
    }
    if !held.in_store {
        match store.set(&key(&held.host.device_id), token) {
            Ok(()) => held.in_store = true,
            Err(e) => {
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

/// Removes a forgotten host's token from the store.
pub fn forget(held: &HeldHost, store: &dyn Secrets) {
    if held.in_store {
        store.delete(&key(&held.host.device_id));
    }
}

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
            [("host:d1".to_string(), "tok-1".to_string())]
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
        let (tokens, written) = start(vec![mini("d1", "tok-1", "")], &keychain);
        assert_eq!(tokens, ["tok-1"], "the host connects with the file's token");
        assert_eq!(written, [mini("d1", "tok-1", "")]);
        assert!(keychain.tokens().is_empty());

        // It is moved at a later start, once the Keychain takes it.
        let keychain = FakeKeychain::default();
        let (tokens, written) = start(written, &keychain);
        assert_eq!(tokens, ["tok-1"]);
        assert_eq!(written, [mini("d1", "", TOK_1_SHA256)]);
    }

    #[test]
    fn a_host_already_moved_needs_nothing_written() {
        let keychain = FakeKeychain::with(&[("host:d1", "tok-1")]);
        let (tokens, written) = start(vec![mini("d1", "", TOK_1_SHA256)], &keychain);
        assert_eq!(tokens, ["tok-1"]);
        assert_eq!(written, [mini("d1", "", TOK_1_SHA256)]);
        assert!(keychain.writes().is_empty(), "{:?}", keychain.writes());
    }

    #[test]
    fn a_token_the_keychain_cannot_read_leaves_the_host_without_one_and_the_file_as_it_was() {
        let keychain = FakeKeychain {
            refuses_reads: true,
            ..FakeKeychain::with(&[("host:d1", "tok-1")])
        };
        let (tokens, written) = start(vec![mini("d1", "", TOK_1_SHA256)], &keychain);
        assert_eq!(tokens, [""]);
        assert_eq!(written, [mini("d1", "", TOK_1_SHA256)]);
        assert!(keychain.writes().is_empty(), "{:?}", keychain.writes());
        assert_eq!(
            keychain.tokens(),
            [("host:d1".to_string(), "tok-1".to_string())]
        );
    }

    #[test]
    fn pairing_again_puts_the_new_token_in_the_keychain() {
        let keychain = FakeKeychain::with(&[("host:d1", "tok-1")]);
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
            [("host:d2".to_string(), "tok-2".to_string())]
        );

        // A build from before this change paired again and wrote its token
        // into the file under the same device id: the Keychain takes it.
        let (tokens, written) = start(vec![mini("d2", "tok-3", "")], &keychain);
        assert_eq!(tokens, ["tok-3"]);
        assert_eq!(written[0].token, "");
        assert_eq!(
            keychain.tokens(),
            [("host:d2".to_string(), "tok-3".to_string())]
        );
    }
}
