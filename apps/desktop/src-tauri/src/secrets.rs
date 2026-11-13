//! Tracker tokens (X44): the macOS Keychain, one generic password holding
//! every connection's token (X91). e2e builds use a 0600 file instead, so
//! tests never prompt.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

pub trait Secrets: Send + Sync {
    fn get(&self, id: &str) -> Option<String>;
    fn set(&self, id: &str, token: &str) -> Result<(), String>;
    fn delete(&self, id: &str);
}

/// The store this build uses, one per process: the Keychain, or
/// `secrets.json` in an e2e build.
pub fn store() -> &'static dyn Secrets {
    static STORE: OnceLock<Box<dyn Secrets>> = OnceLock::new();
    STORE.get_or_init(new_store).as_ref()
}

fn new_store() -> Box<dyn Secrets> {
    #[cfg(all(target_os = "macos", not(feature = "e2e")))]
    return Box::new(OneItem::new(Keychain { service: "dev.onedevstudio.moonlet.trackers".into() }));
    #[allow(unreachable_code)]
    Box::new(FileSecrets(moonlet_core::paths::home().join("secrets.json")))
}

/// The generic passwords of one Keychain service, by account. A read by a
/// binary the item does not trust (every dev build, a build not signed with
/// the Developer ID) asks for the login password, once per item.
pub trait Items: Send + Sync {
    /// `Ok(None)` when there is no such item; `Err` when it could not be
    /// read, as when the user refused the password.
    fn read(&self, account: &str) -> Result<Option<Vec<u8>>, String>;
    fn write(&self, account: &str, data: &[u8]) -> Result<(), String>;
    fn remove(&self, account: &str);
}

/// The account of the one item holding every token. Connection ids are
/// `<kind>:<site>`, so none is this; an id that is (a hand-edited
/// `trackers.toml`) is refused rather than reaching the item.
const TOKENS_ACCOUNT: &str = "tokens";

/// Connection id to token.
type Tokens = BTreeMap<String, String>;

/// Every token in one Keychain item, read once per app start and kept in
/// memory (X91): a start asks for the password once at most, not once per
/// connection and request.
pub struct OneItem<I> {
    items: I,
    cache: Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    /// The item as read, or why it could not be.
    all: Option<Result<Tokens, String>>,
    /// Connections whose item of their own, from before X91, was old_items_checked
    /// for: each is read once per start at most.
    old_items_checked: BTreeSet<String>,
}

#[cfg_attr(feature = "e2e", allow(dead_code))]
impl<I: Items> OneItem<I> {
    pub fn new(items: I) -> Self {
        Self { items, cache: Mutex::default() }
    }

    fn load(&self) -> Result<Tokens, String> {
        match self.items.read(TOKENS_ACCOUNT)? {
            None => Ok(Tokens::new()),
            Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("the Keychain's tracker tokens cannot be read: {e}")),
        }
    }

    /// Changes the item as it is now, not as this process last read it: a
    /// dev build beside the app may have saved a token since. An item that
    /// cannot be read is never overwritten. This start uses the change even
    /// when the Keychain could not keep it: a refreshed Linear sign-in has
    /// already spent its old refresh token.
    fn change(&self, cache: &mut Cache, edit: impl Fn(&mut Tokens)) -> Result<(), String> {
        if let Some(Ok(tokens)) = cache.all.as_mut() {
            edit(tokens);
        }
        let mut all = self.load()?;
        edit(&mut all);
        self.items.write(TOKENS_ACCOUNT, &serde_json::to_vec(&all).map_err(|e| e.to_string())?)?;
        cache.all = Some(Ok(all));
        Ok(())
    }
}

impl<I: Items> Secrets for OneItem<I> {
    fn get(&self, id: &str) -> Option<String> {
        if id == TOKENS_ACCOUNT {
            return None;
        }
        let mut cache = self.cache.lock().unwrap();
        let tokens = cache.all.get_or_insert_with(|| self.load()).as_ref().ok()?;
        if let Some(token) = tokens.get(id) {
            return Some(token.clone());
        }
        // Saved before X91, in an item of its own: moved into the one item.
        if !cache.old_items_checked.insert(id.into()) {
            return None;
        }
        let token = String::from_utf8(self.items.read(id).ok()??).ok()?;
        if self.change(&mut cache, |all| {
            all.insert(id.into(), token.clone());
        })
        .is_ok()
        {
            self.items.remove(id);
        }
        Some(token)
    }
    fn set(&self, id: &str, token: &str) -> Result<(), String> {
        if id == TOKENS_ACCOUNT {
            return Err(format!("{id} is not a connection id"));
        }
        let mut cache = self.cache.lock().unwrap();
        self.change(&mut cache, |all| {
            all.insert(id.into(), token.into());
        })
    }
    fn delete(&self, id: &str) {
        if id == TOKENS_ACCOUNT {
            return;
        }
        let mut cache = self.cache.lock().unwrap();
        let _ = self.change(&mut cache, |all| {
            all.remove(id);
        });
        self.items.remove(id);
    }
}

/// The login Keychain's generic passwords of one service.
#[cfg(all(target_os = "macos", not(feature = "e2e")))]
pub struct Keychain {
    pub service: String,
}

#[cfg(all(target_os = "macos", not(feature = "e2e")))]
impl Items for Keychain {
    fn read(&self, account: &str) -> Result<Option<Vec<u8>>, String> {
        const NOT_FOUND: i32 = -25300; // errSecItemNotFound
        match security_framework::passwords::get_generic_password(&self.service, account) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(e) => Err(format!("cannot read the tokens in the Keychain: {e}")),
        }
    }
    fn write(&self, account: &str, data: &[u8]) -> Result<(), String> {
        security_framework::passwords::set_generic_password(&self.service, account, data)
            .map_err(|e| format!("cannot keep the token in the Keychain: {e}"))
    }
    fn remove(&self, account: &str) {
        let _ = security_framework::passwords::delete_generic_password(&self.service, account);
    }
}

/// Tokens in a JSON file readable only by the user (e2e builds).
pub struct FileSecrets(pub PathBuf);

impl FileSecrets {
    fn read(&self) -> BTreeMap<String, String> {
        std::fs::read(&self.0)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }
    fn write(&self, all: &BTreeMap<String, String>) -> Result<(), String> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let tmp = self.0.with_extension("json.tmp");
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        f.write_all(&serde_json::to_vec(all).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.0).map_err(|e| e.to_string())
    }
}

impl Secrets for FileSecrets {
    fn get(&self, id: &str) -> Option<String> {
        self.read().remove(id)
    }
    fn set(&self, id: &str, token: &str) -> Result<(), String> {
        let mut all = self.read();
        all.insert(id.into(), token.into());
        self.write(&all)
    }
    fn delete(&self, id: &str) {
        let mut all = self.read();
        if all.remove(id).is_some() {
            let _ = self.write(&all);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// The login Keychain as a binary it does not trust sees it: each read
    /// of an item asks for the password, so the test lists the prompts.
    #[derive(Clone, Default)]
    struct PromptingKeychain {
        items: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
        prompts: Arc<Mutex<Vec<String>>>,
        /// The user presses Cancel in every password prompt.
        refused: Arc<Mutex<bool>>,
        /// Saving an item fails.
        unwritable: Arc<Mutex<bool>>,
    }

    impl PromptingKeychain {
        fn with(items: &[(&str, &str)]) -> Self {
            let k = PromptingKeychain::default();
            for (account, data) in items {
                k.items.lock().unwrap().insert(account.to_string(), data.as_bytes().to_vec());
            }
            k
        }
        /// The prompts since the last call.
        fn prompts(&self) -> Vec<String> {
            std::mem::take(&mut *self.prompts.lock().unwrap())
        }
        /// The items PromptingKeychain Access lists under the service.
        fn accounts(&self) -> Vec<String> {
            self.items.lock().unwrap().keys().cloned().collect()
        }
    }

    impl Items for PromptingKeychain {
        fn read(&self, account: &str) -> Result<Option<Vec<u8>>, String> {
            let found = self.items.lock().unwrap().get(account).cloned();
            if found.is_some() {
                self.prompts.lock().unwrap().push(account.to_string());
                if *self.refused.lock().unwrap() {
                    return Err("User canceled the operation.".into());
                }
            }
            Ok(found)
        }
        fn write(&self, account: &str, data: &[u8]) -> Result<(), String> {
            if *self.unwritable.lock().unwrap() {
                return Err("cannot keep the token in the Keychain".into());
            }
            self.items.lock().unwrap().insert(account.to_string(), data.to_vec());
            Ok(())
        }
        fn remove(&self, account: &str) {
            self.items.lock().unwrap().remove(account);
        }
    }

    #[test]
    fn three_connections_ask_for_the_keychain_password_once_per_start() {
        let keychain = PromptingKeychain::with(&[(
            "tokens",
            r#"{"clickup:9012":"pk_clickup","jira:acme.atlassian.net":"kim@acme.dev:ATATT3x","linear:acme":"lin_api_key"}"#,
        )]);
        let store = OneItem::new(keychain.clone());
        for _ in 0..3 {
            assert_eq!(store.get("jira:acme.atlassian.net").as_deref(), Some("kim@acme.dev:ATATT3x"));
            assert_eq!(store.get("clickup:9012").as_deref(), Some("pk_clickup"));
            assert_eq!(store.get("linear:acme").as_deref(), Some("lin_api_key"));
        }
        assert_eq!(keychain.prompts(), vec!["tokens"]);
    }

    #[test]
    fn a_file_store_keeps_tokens_private_and_forgets_them() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.json");
        let store = FileSecrets(path.clone());
        assert_eq!(store.get("jira:acme.atlassian.net"), None);
        store.set("jira:acme.atlassian.net", "ATATT3x-secret").unwrap();
        store.set("linear:acme", "lin_api_key").unwrap();
        assert_eq!(store.get("jira:acme.atlassian.net").as_deref(), Some("ATATT3x-secret"));
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        store.delete("jira:acme.atlassian.net");
        assert_eq!(store.get("jira:acme.atlassian.net"), None);
        assert_eq!(store.get("linear:acme").as_deref(), Some("lin_api_key"));
    }

    #[test]
    fn tokens_kept_one_item_per_connection_move_into_the_one_item() {
        let keychain = PromptingKeychain::with(&[("jira:acme.atlassian.net", "kim@acme.dev:ATATT3x"), ("linear:acme", "lin_api_key")]);
        let first = OneItem::new(keychain.clone());
        assert_eq!(first.get("jira:acme.atlassian.net").as_deref(), Some("kim@acme.dev:ATATT3x"));
        assert_eq!(first.get("linear:acme").as_deref(), Some("lin_api_key"));
        assert_eq!(keychain.accounts(), vec!["tokens"]);
        keychain.prompts();

        let next_start = OneItem::new(keychain.clone());
        assert_eq!(next_start.get("jira:acme.atlassian.net").as_deref(), Some("kim@acme.dev:ATATT3x"));
        assert_eq!(next_start.get("linear:acme").as_deref(), Some("lin_api_key"));
        assert_eq!(keychain.prompts(), vec!["tokens"]);
    }

    #[test]
    fn a_token_another_moonlet_saved_meanwhile_is_kept() {
        let keychain = PromptingKeychain::with(&[("tokens", r#"{"linear:acme":"lin_api_key"}"#)]);
        let app = OneItem::new(keychain.clone());
        assert_eq!(app.get("linear:acme").as_deref(), Some("lin_api_key"));
        let dev_build = OneItem::new(keychain.clone());
        dev_build.set("jira:acme.atlassian.net", "kim@acme.dev:ATATT3x").unwrap();
        app.set("clickup:9012", "pk_clickup").unwrap();

        let next_start = OneItem::new(keychain.clone());
        assert_eq!(next_start.get("linear:acme").as_deref(), Some("lin_api_key"));
        assert_eq!(next_start.get("jira:acme.atlassian.net").as_deref(), Some("kim@acme.dev:ATATT3x"));
        assert_eq!(next_start.get("clickup:9012").as_deref(), Some("pk_clickup"));
    }

    #[test]
    fn cancelling_the_password_prompt_asks_no_more_and_keeps_the_tokens() {
        let saved = r#"{"jira:acme.atlassian.net":"kim@acme.dev:ATATT3x"}"#;
        let keychain = PromptingKeychain::with(&[("tokens", saved)]);
        *keychain.refused.lock().unwrap() = true;
        let store = OneItem::new(keychain.clone());
        for _ in 0..3 {
            assert_eq!(store.get("jira:acme.atlassian.net"), None);
            assert_eq!(store.get("linear:acme"), None);
        }
        assert_eq!(keychain.prompts(), vec!["tokens"]);
        assert!(store.set("linear:acme", "lin_api_key").is_err());
        store.delete("jira:acme.atlassian.net");
        assert_eq!(keychain.items.lock().unwrap().get("tokens").map(|b| String::from_utf8(b.clone()).unwrap()).as_deref(), Some(saved));
    }

    #[test]
    fn cancelling_the_prompt_for_a_token_kept_on_its_own_asks_no_more() {
        let keychain = PromptingKeychain::with(&[("jira:acme.atlassian.net", "kim@acme.dev:ATATT3x")]);
        *keychain.refused.lock().unwrap() = true;
        let store = OneItem::new(keychain.clone());
        for _ in 0..3 {
            assert_eq!(store.get("jira:acme.atlassian.net"), None);
        }
        assert_eq!(keychain.prompts(), vec!["jira:acme.atlassian.net"]);
        assert_eq!(keychain.accounts(), vec!["jira:acme.atlassian.net"]);
    }

    /// Against the real PromptingKeychain, under a throwaway service; run by hand with
    /// `cargo test -p moonlet-app --lib secrets -- --ignored`.
    #[cfg(all(target_os = "macos", not(feature = "e2e")))]
    #[test]
    #[ignore]
    fn the_keychain_keeps_every_token_in_one_item() {
        let service = format!("dev.onedevstudio.moonlet.trackers.test-{}", std::process::id());
        let keychain = || super::Keychain { service: service.clone() };
        keychain().write("linear:acme", b"lin_api_key").unwrap();
        let store = OneItem::new(keychain());
        assert_eq!(store.get("jira:acme.atlassian.net"), None);
        store.set("jira:acme.atlassian.net", "kim@acme.dev:ATATT3x").unwrap();
        assert_eq!(store.get("linear:acme").as_deref(), Some("lin_api_key"));
        assert_eq!(keychain().read("linear:acme"), Ok(None));
        let next_start = OneItem::new(keychain());
        assert_eq!(next_start.get("jira:acme.atlassian.net").as_deref(), Some("kim@acme.dev:ATATT3x"));
        assert_eq!(next_start.get("linear:acme").as_deref(), Some("lin_api_key"));
        next_start.delete("jira:acme.atlassian.net");
        next_start.delete("linear:acme");
        keychain().remove("tokens");
        assert_eq!(keychain().read("tokens"), Ok(None));
    }

    #[test]
    fn no_connection_can_reach_the_item_holding_every_token() {
        let saved = r#"{"linear:acme":"lin_api_key"}"#;
        let keychain = PromptingKeychain::with(&[("tokens", saved)]);
        let store = OneItem::new(keychain.clone());
        assert_eq!(store.get("tokens"), None);
        assert!(store.set("tokens", "x").is_err());
        store.delete("tokens");
        assert_eq!(keychain.accounts(), vec!["tokens"]);
        assert_eq!(OneItem::new(keychain.clone()).get("linear:acme").as_deref(), Some("lin_api_key"));
    }

    #[test]
    fn a_token_that_cannot_move_still_works_for_the_rest_of_the_start() {
        let keychain = PromptingKeychain::with(&[("jira:acme.atlassian.net", "kim@acme.dev:ATATT3x")]);
        *keychain.unwritable.lock().unwrap() = true;
        let store = OneItem::new(keychain.clone());
        for _ in 0..3 {
            assert_eq!(store.get("jira:acme.atlassian.net").as_deref(), Some("kim@acme.dev:ATATT3x"));
        }
        assert_eq!(keychain.accounts(), vec!["jira:acme.atlassian.net"]);
    }

    #[test]
    fn a_token_saved_while_the_keychain_refuses_is_used_for_the_rest_of_the_start() {
        // A Linear refresh spends the old refresh token: a command that
        // waited for it must use the new tokens, even when they could not
        // be kept.
        let keychain = PromptingKeychain::with(&[("tokens", r#"{"linear:acme":"old"}"#)]);
        let store = OneItem::new(keychain.clone());
        assert_eq!(store.get("linear:acme").as_deref(), Some("old"));
        *keychain.refused.lock().unwrap() = true;
        assert!(store.set("linear:acme", "new").is_err());
        assert_eq!(store.get("linear:acme").as_deref(), Some("new"));
        *keychain.refused.lock().unwrap() = false;
        assert_eq!(OneItem::new(keychain.clone()).get("linear:acme").as_deref(), Some("old"));
    }
}
