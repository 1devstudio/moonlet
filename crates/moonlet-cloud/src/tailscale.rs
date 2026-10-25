//! One-off Tailscale keys for cloud machines (X63), minted with the user's
//! OAuth client. The client's secret never leaves the central host.

use std::sync::Arc;

use crate::{Body, CloudError, Request, Transport};

pub const API: &str = "https://api.tailscale.com/api/v2";

/// The user's OAuth client and the tag every machine gets.
#[derive(Debug, Clone, PartialEq)]
pub struct OAuthClient {
    pub id: String,
    pub secret: String,
    pub tag: String,
}

/// A one-off, ephemeral, preauthorized key with `client.tag`, valid an hour,
/// for machine `name`.
pub async fn machine_key(
    client: &OAuthClient,
    name: &str,
    transport: Arc<dyn Transport>,
) -> Result<String, CloudError> {
    let token = token(client, &transport).await?;
    new_key(client, &token, &format!("moonlet {name}"), &transport)
        .await
        .map(|(_, key)| key)
}

/// Whether `client` can make machines' keys: it makes a test key and
/// revokes it at once.
pub async fn check(client: &OAuthClient, transport: Arc<dyn Transport>) -> Result<(), CloudError> {
    let token = token(client, &transport).await?;
    let (id, _) = new_key(client, &token, "moonlet check", &transport).await?;
    let r = transport
        .send(Request {
            method: "DELETE",
            url: format!("{API}/tailnet/-/keys/{id}"),
            headers: vec![("Authorization".into(), format!("Bearer {token}"))],
            body: None,
        })
        .await
        .map_err(|e| CloudError::Network(format!("cannot reach Tailscale: {e}")))?;
    if (200..300).contains(&r.status) {
        Ok(())
    } else {
        Err(answered(r.status, &r.body))
    }
}

/// An access token for `client`.
async fn token(client: &OAuthClient, transport: &Arc<dyn Transport>) -> Result<String, CloudError> {
    let token = transport
        .send(Request {
            method: "POST",
            url: format!("{API}/oauth/token"),
            headers: vec![],
            body: Some(Body::Form(vec![
                ("client_id".into(), client.id.clone()),
                ("client_secret".into(), client.secret.clone()),
                ("grant_type".into(), "client_credentials".into()),
            ])),
        })
        .await
        .map_err(|e| CloudError::Network(format!("cannot reach Tailscale: {e}")))?;
    match token.status {
        200..=299 => {}
        // The client or its secret is wrong.
        400 | 401 | 403 => {
            return Err(CloudError::Refused(
                "Tailscale refused the OAuth client. Check it in Settings › Cloud workers.".into(),
            ));
        }
        status => return Err(answered(status, &token.body)),
    }
    json(&token.body)?["access_token"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| CloudError::Network("Tailscale gave no access token".into()))
}

/// A new key, described as `description`: its id and the key.
async fn new_key(
    client: &OAuthClient,
    token: &str,
    description: &str,
    transport: &Arc<dyn Transport>,
) -> Result<(String, String), CloudError> {
    let key = transport
        .send(Request {
            method: "POST",
            url: format!("{API}/tailnet/-/keys"),
            headers: vec![("Authorization".into(), format!("Bearer {token}"))],
            body: Some(Body::Json(serde_json::json!({
                "capabilities": { "devices": { "create": {
                    "reusable": false,
                    "ephemeral": true,
                    "preauthorized": true,
                    "tags": [client.tag],
                } } },
                "expirySeconds": 3600,
                "description": description,
            }))),
        })
        .await
        .map_err(|e| CloudError::Network(format!("cannot reach Tailscale: {e}")))?;
    if !(200..300).contains(&key.status) {
        // A refusal says why in JSON; anything else is an outage.
        let Some(why) = serde_json::from_slice::<serde_json::Value>(&key.body)
            .ok()
            .and_then(|v| v["message"].as_str().map(String::from))
        else {
            return Err(answered(key.status, &key.body));
        };
        return Err(CloudError::Provider(format!(
            "Tailscale refused the key: {why}"
        )));
    }
    let body = json(&key.body)?;
    let id = body["id"].as_str().unwrap_or_default().to_string();
    body["key"]
        .as_str()
        .map(|k| (id, k.to_string()))
        .ok_or_else(|| CloudError::Network("Tailscale gave no key".into()))
}

/// An answer that is neither success nor a refusal: its status and text.
fn answered(status: u16, body: &[u8]) -> CloudError {
    CloudError::Provider(format!(
        "Tailscale answered {status} {}",
        String::from_utf8_lossy(body).trim()
    ))
}

fn json(body: &[u8]) -> Result<serde_json::Value, CloudError> {
    serde_json::from_slice(body)
        .map_err(|e| CloudError::Network(format!("Tailscale answered with something else: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Response;
    use std::sync::Mutex;
    use std::time::Duration;

    struct Script {
        answers: Mutex<Vec<(u16, &'static str)>>,
        sent: Mutex<Vec<Request>>,
    }

    #[async_trait::async_trait]
    impl Transport for Script {
        async fn send(&self, request: Request) -> Result<Response, String> {
            self.sent.lock().unwrap().push(request);
            let (status, body) = self.answers.lock().unwrap().remove(0);
            Ok(Response {
                status,
                headers: vec![],
                body: body.as_bytes().to_vec(),
            })
        }
        async fn sleep(&self, _: Duration) {}
        fn now(&self) -> u64 {
            0
        }
    }

    fn client() -> OAuthClient {
        OAuthClient {
            id: "kQ7cLient1CNTRL".into(),
            secret: "fake-tailscale-client-secret".into(),
            tag: "tag:moonlet-worker".into(),
        }
    }

    #[tokio::test]
    async fn asks_for_a_one_off_ephemeral_tagged_key_as_captured() {
        let script = Arc::new(Script {
            answers: Mutex::new(vec![
                (200, include_str!("fixtures/tailscale/oauth_token.json")),
                (200, include_str!("fixtures/tailscale/create_key.json")),
            ]),
            sent: Mutex::default(),
        });
        let key = machine_key(&client(), "moonlet-shop-7k2q", script.clone())
            .await
            .unwrap();
        assert_eq!(key, "fake-tailscale-auth-key");
        let sent = script.sent.lock().unwrap();
        assert_eq!(
            sent[0],
            Request {
                method: "POST",
                url: "https://api.tailscale.com/api/v2/oauth/token".into(),
                headers: vec![],
                body: Some(Body::Form(vec![
                    ("client_id".into(), "kQ7cLient1CNTRL".into()),
                    (
                        "client_secret".into(),
                        "fake-tailscale-client-secret".into()
                    ),
                    ("grant_type".into(), "client_credentials".into()),
                ])),
            }
        );
        assert_eq!(
            sent[1],
            Request {
                method: "POST",
                url: "https://api.tailscale.com/api/v2/tailnet/-/keys".into(),
                headers: vec![(
                    "Authorization".into(),
                    "Bearer fake-tailscale-access-token".into()
                )],
                body: Some(Body::Json(serde_json::json!({
                    "capabilities": { "devices": { "create": {
                        "reusable": false,
                        "ephemeral": true,
                        "preauthorized": true,
                        "tags": ["tag:moonlet-worker"]
                    } } },
                    "expirySeconds": 3600,
                    "description": "moonlet moonlet-shop-7k2q"
                }))),
            }
        );
    }

    #[tokio::test]
    async fn a_refused_client_or_tag_says_so() {
        let script = Arc::new(Script {
            answers: Mutex::new(vec![(
                401,
                include_str!("fixtures/tailscale/unauthorized.json"),
            )]),
            sent: Mutex::default(),
        });
        let e = machine_key(&client(), "m", script).await.unwrap_err();
        assert_eq!(
            e.to_string(),
            "Tailscale refused the OAuth client. Check it in Settings › Cloud workers."
        );
        let script = Arc::new(Script {
            answers: Mutex::new(vec![
                (200, include_str!("fixtures/tailscale/oauth_token.json")),
                (403, include_str!("fixtures/tailscale/bad_tags.json")),
            ]),
            sent: Mutex::default(),
        });
        let e = machine_key(&client(), "m", script).await.unwrap_err();
        assert_eq!(
            e.to_string(),
            "Tailscale refused the key: requested tags [tag:moonlet-worker] are invalid or not permitted"
        );
    }

    #[tokio::test]
    async fn check_makes_a_test_key_and_revokes_it() {
        let script = Arc::new(Script {
            answers: Mutex::new(vec![
                (200, include_str!("fixtures/tailscale/oauth_token.json")),
                (200, include_str!("fixtures/tailscale/create_key.json")),
                (200, include_str!("fixtures/tailscale/delete_key.json")),
            ]),
            sent: Mutex::default(),
        });
        assert_eq!(check(&client(), script.clone()).await, Ok(()));
        let sent = script.sent.lock().unwrap();
        assert_eq!(sent[1].method, "POST");
        assert_eq!(sent[2].method, "DELETE");
        assert_eq!(
            sent[2].url,
            "https://api.tailscale.com/api/v2/tailnet/-/keys/kAbC123CNTRL"
        );
        assert_eq!(sent[2].headers, sent[1].headers);
        // A client without the tag says so, as a machine's start would.
        let script = Arc::new(Script {
            answers: Mutex::new(vec![
                (200, include_str!("fixtures/tailscale/oauth_token.json")),
                (403, include_str!("fixtures/tailscale/bad_tags.json")),
            ]),
            sent: Mutex::default(),
        });
        assert_eq!(
            check(&client(), script).await.unwrap_err().to_string(),
            "Tailscale refused the key: requested tags [tag:moonlet-worker] are invalid or not permitted"
        );
    }

    #[tokio::test]
    async fn an_outage_is_not_a_refused_client() {
        // A rate limit or an error page says what happened, not "check the client".
        let script = Arc::new(Script {
            answers: Mutex::new(vec![(503, "Service Unavailable")]),
            sent: Mutex::default(),
        });
        let e = machine_key(&client(), "m", script).await.unwrap_err();
        assert_eq!(e.to_string(), "Tailscale answered 503 Service Unavailable");
        let script = Arc::new(Script {
            answers: Mutex::new(vec![
                (200, include_str!("fixtures/tailscale/oauth_token.json")),
                (502, "<html>Bad Gateway</html>"),
            ]),
            sent: Mutex::default(),
        });
        let e = machine_key(&client(), "m", script).await.unwrap_err();
        assert_eq!(
            e.to_string(),
            "Tailscale answered 502 <html>Bad Gateway</html>"
        );
    }
}
