//! Google Cloud's sign-in (X67): a service-account key, and the access
//! tokens it gets from Google's server-to-server OAuth flow.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use ring::signature::RsaKeyPair;
use serde_json::Value;

use crate::{Body, CloudError, Request, Transport};

pub const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const SCOPE: &str = "https://www.googleapis.com/auth/compute";

/// A service-account key, as Google Cloud's console downloads it.
#[derive(Clone)]
pub struct ServiceAccountKey {
    pub project_id: String,
    pub client_email: String,
    pub private_key_id: String,
    private_key: Arc<RsaKeyPair>,
}

impl std::fmt::Debug for ServiceAccountKey {
    // Never the private key.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServiceAccountKey")
            .field("project_id", &self.project_id)
            .field("client_email", &self.client_email)
            .field("private_key_id", &self.private_key_id)
            .finish_non_exhaustive()
    }
}

/// Reads a key's JSON, or says what is wrong with it.
pub fn read_key(json: &str) -> Result<ServiceAccountKey, String> {
    let not = |why: &str| format!("That is not a Google Cloud service-account key: {why}.");
    let v: Value = serde_json::from_str(json.trim()).map_err(|_| not("it is not JSON"))?;
    if v["type"] != "service_account" {
        return Err(not("its type is not service_account"));
    }
    let field = |name: &str| {
        v[name]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .ok_or_else(|| not(&format!("it has no {name}")))
    };
    let (project_id, client_email, private_key_id) = (
        field("project_id")?,
        field("client_email")?,
        field("private_key_id")?,
    );
    let private_key =
        rsa_key(&field("private_key")?).ok_or_else(|| not("its private_key is not an RSA key"))?;
    Ok(ServiceAccountKey {
        project_id,
        client_email,
        private_key_id,
        private_key: Arc::new(private_key),
    })
}

/// The JWT that asks Google for an access token at `now` (Unix seconds),
/// for an hour, signed with RS256.
pub fn jwt(key: &ServiceAccountKey, now: u64) -> String {
    use base64::Engine;
    let b64 = |bytes: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let header = serde_json::json!({"alg": "RS256", "typ": "JWT", "kid": key.private_key_id});
    let claims = serde_json::json!({
        "iss": key.client_email,
        "scope": SCOPE,
        "aud": TOKEN_URL,
        "iat": now,
        "exp": now + 3600,
    });
    let signed = format!(
        "{}.{}",
        b64(header.to_string().as_bytes()),
        b64(claims.to_string().as_bytes())
    );
    let mut sig = vec![0; key.private_key.public().modulus_len()];
    // PKCS #1 v1.5 needs no randomness; ring takes it for blinding.
    key.private_key
        .sign(
            &ring::signature::RSA_PKCS1_SHA256,
            &ring::rand::SystemRandom::new(),
            signed.as_bytes(),
            &mut sig,
        )
        .expect("an RSA key signs");
    format!("{signed}.{}", b64(&sig))
}

/// Access tokens by key, kept until 5 minutes before they expire. One
/// is shared by every adapter the central host makes.
#[derive(Default)]
pub struct Tokens {
    cached: Mutex<HashMap<String, (String, u64)>>,
}

impl Tokens {
    /// An access token for `key`: the cached one, or a new one.
    pub async fn token(
        &self,
        key: &ServiceAccountKey,
        transport: &Arc<dyn Transport>,
    ) -> Result<String, CloudError> {
        let now = transport.now();
        let id = cache_id(key);
        if let Some((token, expires_at)) = self.cached.lock().unwrap().get(&id)
            && now + REUSE_MARGIN_SECS < *expires_at
        {
            return Ok(token.clone());
        }
        let r = transport
            .send(Request {
                method: "POST",
                url: TOKEN_URL.into(),
                headers: vec![],
                body: Some(Body::Form(vec![
                    (
                        "grant_type".into(),
                        "urn:ietf:params:oauth:grant-type:jwt-bearer".into(),
                    ),
                    ("assertion".into(), jwt(key, now)),
                ])),
            })
            .await
            .map_err(|e| CloudError::Network(format!("cannot reach Google: {e}")))?;
        let v: Value = serde_json::from_slice(&r.body).unwrap_or_default();
        match r.status {
            200..=299 => {}
            400 | 401 | 403 => {
                let why = v["error_description"]
                    .as_str()
                    .or(v["error"].as_str())
                    .unwrap_or("no reason given");
                return Err(CloudError::Refused(format!(
                    "Google Cloud refused the service-account key: {}. Check it in Settings › Cloud workers.",
                    why.trim_end_matches('.')
                )));
            }
            status => {
                return Err(CloudError::Provider(format!(
                    "{status} {}",
                    String::from_utf8_lossy(&r.body).trim()
                )));
            }
        }
        let token = v["access_token"]
            .as_str()
            .filter(|t| !t.is_empty())
            .ok_or_else(|| CloudError::Network("Google gave no access token".into()))?
            .to_string();
        let expires_at = now + v["expires_in"].as_u64().unwrap_or(0);
        self.cached
            .lock()
            .unwrap()
            .insert(id, (token.clone(), expires_at));
        Ok(token)
    }

    /// Drops `key`'s token: Compute Engine no longer takes it.
    pub fn forget(&self, key: &ServiceAccountKey) {
        self.cached.lock().unwrap().remove(&cache_id(key));
    }
}

/// A token is not reused within this many seconds of its expiry.
const REUSE_MARGIN_SECS: u64 = 300;

/// A new key for the same account gets its own token.
fn cache_id(key: &ServiceAccountKey) -> String {
    format!("{} {}", key.client_email, key.private_key_id)
}

/// A PKCS #8 PEM RSA private key.
fn rsa_key(pem: &str) -> Option<RsaKeyPair> {
    use base64::Engine;
    let body = pem
        .trim()
        .strip_prefix("-----BEGIN PRIVATE KEY-----")?
        .strip_suffix("-----END PRIVATE KEY-----")?;
    let b64: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    let der = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    RsaKeyPair::from_pkcs8(&der).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A key made for these tests (`fixtures/gcp/test_key.pem`), in the
    /// shape of a downloaded one.
    fn key_json() -> String {
        serde_json::json!({
            "type": "service_account",
            "project_id": "acme-moonlet",
            "private_key_id": "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
            "private_key": include_str!("fixtures/gcp/test_key.pem"),
            "client_email": "moonlet@acme-moonlet.iam.gserviceaccount.com",
            "client_id": "104857600000000000000",
            "token_uri": "https://oauth2.googleapis.com/token",
        })
        .to_string()
    }

    #[test]
    fn reads_a_service_account_key() {
        let k = read_key(&key_json()).unwrap();
        assert_eq!(k.project_id, "acme-moonlet");
        assert_eq!(
            k.client_email,
            "moonlet@acme-moonlet.iam.gserviceaccount.com"
        );
        assert_eq!(k.private_key_id, "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c");
    }
    #[test]
    fn refuses_what_is_not_a_service_account_key() {
        let with = |f: &dyn Fn(&mut Value)| {
            let mut v: Value = serde_json::from_str(&key_json()).unwrap();
            f(&mut v);
            read_key(&v.to_string()).unwrap_err()
        };
        assert_eq!(
            read_key("hc_7Kq2mXw9pD").unwrap_err(),
            "That is not a Google Cloud service-account key: it is not JSON."
        );
        // An OAuth client's JSON.
        assert_eq!(
            read_key(r#"{"installed":{"client_id":"1.apps.googleusercontent.com"}}"#).unwrap_err(),
            "That is not a Google Cloud service-account key: its type is not service_account."
        );
        assert_eq!(
            with(&|v| {
                v.as_object_mut().unwrap().remove("project_id");
            }),
            "That is not a Google Cloud service-account key: it has no project_id."
        );
        assert_eq!(
            with(&|v| v["client_email"] = "".into()),
            "That is not a Google Cloud service-account key: it has no client_email."
        );
        assert_eq!(
            with(&|v| v["private_key"] =
                "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n".into()),
            "That is not a Google Cloud service-account key: its private_key is not an RSA key."
        );
    }

    #[test]
    fn a_key_without_line_breaks_still_reads() {
        // A one-line field drops the pasted file's line breaks.
        let pretty =
            serde_json::to_string_pretty(&serde_json::from_str::<Value>(&key_json()).unwrap())
                .unwrap();
        assert!(pretty.contains('\n'));
        let k = read_key(&pretty.replace('\n', "")).unwrap();
        assert_eq!(k.project_id, "acme-moonlet");
    }
    #[test]
    fn signs_the_token_request_as_the_worked_jwt() {
        // `fixtures/gcp/worked_jwt.txt` was signed with `openssl dgst
        // -sha256 -sign test_key.pem` over the header and claims of X67.
        let k = read_key(&key_json()).unwrap();
        assert_eq!(
            jwt(&k, 1_761_400_000),
            include_str!("fixtures/gcp/worked_jwt.txt")
        );
    }
    /// Answers each request with the next of `answers`, records what was
    /// sent, and tells the time it is set to.
    struct Script {
        answers: Mutex<Vec<(u16, &'static str)>>,
        sent: Mutex<Vec<crate::Request>>,
        now: Mutex<u64>,
    }

    impl Script {
        fn new(answers: Vec<(u16, &'static str)>) -> Arc<Script> {
            Arc::new(Script {
                answers: Mutex::new(answers),
                sent: Mutex::default(),
                now: Mutex::new(1_761_400_000),
            })
        }
    }

    #[async_trait::async_trait]
    impl Transport for Script {
        async fn send(&self, request: crate::Request) -> Result<crate::Response, String> {
            self.sent.lock().unwrap().push(request);
            let (status, body) = self.answers.lock().unwrap().remove(0);
            Ok(crate::Response {
                status,
                headers: vec![],
                body: body.as_bytes().to_vec(),
            })
        }
        async fn sleep(&self, _: std::time::Duration) {}
        fn now(&self) -> u64 {
            *self.now.lock().unwrap()
        }
    }

    const TOKEN: &str =
        r#"{"access_token":"ya29.c.first","expires_in":3599,"token_type":"Bearer"}"#;

    #[tokio::test]
    async fn asks_for_a_token_with_the_signed_jwt() {
        let k = read_key(&key_json()).unwrap();
        let script = Script::new(vec![(200, TOKEN)]);
        let t: Arc<dyn Transport> = script.clone();
        assert_eq!(
            Tokens::default().token(&k, &t).await.unwrap(),
            "ya29.c.first"
        );
        let sent = script.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].method, "POST");
        assert_eq!(sent[0].url, "https://oauth2.googleapis.com/token");
        assert_eq!(
            sent[0].body,
            Some(crate::Body::Form(vec![
                (
                    "grant_type".into(),
                    "urn:ietf:params:oauth:grant-type:jwt-bearer".into()
                ),
                (
                    "assertion".into(),
                    include_str!("fixtures/gcp/worked_jwt.txt").into()
                ),
            ]))
        );
    }
    #[tokio::test]
    async fn reuses_the_token_until_five_minutes_before_it_expires() {
        let k = read_key(&key_json()).unwrap();
        const SECOND: &str =
            r#"{"access_token":"ya29.c.second","expires_in":3599,"token_type":"Bearer"}"#;
        let script = Script::new(vec![(200, TOKEN), (200, SECOND)]);
        let t: Arc<dyn Transport> = script.clone();
        let tokens = Tokens::default();
        assert_eq!(tokens.token(&k, &t).await.unwrap(), "ya29.c.first");
        // 3599 s, less 5 minutes: 3299 s after it was given.
        *script.now.lock().unwrap() += 3298;
        assert_eq!(tokens.token(&k, &t).await.unwrap(), "ya29.c.first");
        assert_eq!(script.sent.lock().unwrap().len(), 1);
        *script.now.lock().unwrap() += 1;
        assert_eq!(tokens.token(&k, &t).await.unwrap(), "ya29.c.second");
        assert_eq!(script.sent.lock().unwrap().len(), 2);
        // Forgotten, it is asked for again.
        let script = Script::new(vec![(200, TOKEN)]);
        let t: Arc<dyn Transport> = script.clone();
        tokens.forget(&k);
        assert_eq!(tokens.token(&k, &t).await.unwrap(), "ya29.c.first");
    }

    #[tokio::test]
    async fn a_refused_key_says_so() {
        let k = read_key(&key_json()).unwrap();
        let script = Script::new(vec![(
            400,
            r#"{"error":"invalid_grant","error_description":"Invalid JWT Signature."}"#,
        )]);
        let t: Arc<dyn Transport> = script.clone();
        assert_eq!(
            Tokens::default().token(&k, &t).await,
            Err(CloudError::Refused(
                "Google Cloud refused the service-account key: Invalid JWT Signature. Check it in Settings › Cloud workers.".into()
            ))
        );
    }
}
