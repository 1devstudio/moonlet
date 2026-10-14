//! OAuth with PKCE (RFC 7636) for Linear (X44): no client secret, a loopback
//! redirect, and a `state` that must come back unchanged.

use sha2::{Digest, Sha256};

const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Base64url without padding.
fn b64url(bytes: &[u8]) -> String {
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().fold(0u32, |n, b| (n << 8) | *b as u32) << (8 * (3 - chunk.len()));
        for i in 0..=chunk.len() {
            out.push(B64URL[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

/// A random code verifier (43 characters of base64url) from 32 random bytes.
pub fn pkce_verifier(random: [u8; 32]) -> String {
    b64url(&random)
}

/// The `S256` code challenge of `verifier`.
pub fn pkce_challenge(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            // Bytes, not `&s[..]`: a `%` before a multibyte letter must not
            // slice inside it.
            b'%' => match b
                .get(i + 1..i + 3)
                .and_then(|h| std::str::from_utf8(h).ok())
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                Some(v) => {
                    out.push(v);
                    i += 2;
                }
                None => out.push(b'%'),
            },
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The authorize URL the browser opens.
pub fn authorize_url(
    base: &str,
    client_id: &str,
    redirect: &str,
    state: &str,
    challenge: &str,
    scope: &str,
) -> String {
    format!(
        "{base}?response_type=code&client_id={}&redirect_uri={}&state={}&code_challenge={}&code_challenge_method=S256&scope={}",
        encode(client_id),
        encode(redirect),
        encode(state),
        encode(challenge),
        encode(scope)
    )
}

/// The form body that trades the code for tokens (PKCE: no client secret).
pub fn token_body(client_id: &str, code: &str, redirect: &str, verifier: &str) -> String {
    format!(
        "grant_type=authorization_code&client_id={}&code={}&redirect_uri={}&code_verifier={}",
        encode(client_id),
        encode(code),
        encode(redirect),
        encode(verifier)
    )
}

/// The form body that trades a refresh token for new tokens.
pub fn refresh_body(client_id: &str, refresh: &str) -> String {
    format!(
        "grant_type=refresh_token&client_id={}&refresh_token={}",
        encode(client_id),
        encode(refresh)
    )
}

/// OAuth tokens and when the access token expires.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Tokens {
    pub access: String,
    /// Each refresh returns a new one.
    pub refresh: Option<String>,
    pub expires_ms: u64,
}

impl Tokens {
    /// Whether to refresh before using it: a minute before it expires.
    pub fn needs_refresh(&self, now_ms: u64) -> bool {
        now_ms.saturating_add(60_000) >= self.expires_ms
    }
}

/// The token endpoint's answer, read at `now_ms`.
pub fn parse_tokens(raw: &[u8], now_ms: u64) -> Result<Tokens, crate::ApiError> {
    let v: serde_json::Value = serde_json::from_slice(raw)
        .map_err(|e| crate::ApiError::new(format!("Linear answered with something else: {e}")))?;
    let access = v["access_token"].as_str().ok_or_else(|| crate::ApiError {
        auth: true,
        message: format!(
            "Linear refused the sign-in: {}",
            v["error"].as_str().unwrap_or("no token")
        ),
    })?;
    Ok(Tokens {
        access: access.into(),
        refresh: v["refresh_token"].as_str().map(String::from),
        // Without `expires_in` the token does not expire.
        expires_ms: v["expires_in"]
            .as_u64()
            .map_or(u64::MAX, |s| now_ms + s * 1000),
    })
}

/// The authorization code from the loopback callback's path and query, if
/// it answers this request (`state`).
pub fn parse_callback(path_and_query: &str, state: &str) -> Result<String, String> {
    let (path, query) = path_and_query
        .split_once('?')
        .unwrap_or((path_and_query, ""));
    if path != "/callback" {
        return Err("not the sign-in callback".into());
    }
    let get = |name: &str| {
        query.split('&').find_map(|kv| {
            kv.split_once('=')
                .filter(|(k, _)| *k == name)
                .map(|(_, v)| decode(v))
        })
    };
    if get("state").as_deref() != Some(state) {
        return Err("the sign-in came back for another request".into());
    }
    if let Some(e) = get("error") {
        return Err(format!(
            "Linear said: {}",
            get("error_description").unwrap_or(e)
        ));
    }
    get("code")
        .filter(|c| !c.is_empty())
        .ok_or_else(|| "the sign-in came back without a code".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_challenge_of_rfc_7636_appendix_b() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn the_authorize_url_carries_the_challenge_and_the_loopback_redirect() {
        assert_eq!(
            authorize_url(
                "https://linear.app/oauth/authorize",
                "client-1",
                "http://127.0.0.1:53682/callback",
                "st4te",
                "E9Mel",
                "read,write"
            ),
            "https://linear.app/oauth/authorize?response_type=code&client_id=client-1\
             &redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fcallback&state=st4te\
             &code_challenge=E9Mel&code_challenge_method=S256&scope=read%2Cwrite"
        );
    }

    #[test]
    fn a_percent_before_a_multibyte_letter_is_kept() {
        assert_eq!(
            parse_callback("/callback?code=%a\u{e9}&state=st4te", "st4te"),
            Ok("%a\u{e9}".into())
        );
    }

    #[test]
    fn the_callback_gives_the_code_only_with_the_right_state() {
        assert_eq!(
            parse_callback("/callback?code=abc%2B1&state=st4te", "st4te"),
            Ok("abc+1".into())
        );
        assert_eq!(
            parse_callback("/callback?code=abc&state=other", "st4te"),
            Err("the sign-in came back for another request".into())
        );
        assert_eq!(
            parse_callback(
                "/callback?error=access_denied&error_description=The+user+denied&state=st4te",
                "st4te"
            ),
            Err("Linear said: The user denied".into())
        );
        assert_eq!(
            parse_callback("/favicon.ico", "st4te"),
            Err("not the sign-in callback".into())
        );
    }

    #[test]
    fn token_exchange_and_refresh_bodies() {
        assert_eq!(
            token_body(
                "client-1",
                "abc+1",
                "http://127.0.0.1:53682/callback",
                "verifier"
            ),
            "grant_type=authorization_code&client_id=client-1&code=abc%2B1\
             &redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fcallback&code_verifier=verifier"
        );
        assert_eq!(
            refresh_body("client-1", "r1"),
            "grant_type=refresh_token&client_id=client-1&refresh_token=r1"
        );
        let tokens = parse_tokens(br#"{"access_token":"a1","token_type":"Bearer","expires_in":86399,"refresh_token":"r2","scope":"read,write"}"#, 1_000).unwrap();
        assert_eq!(
            tokens,
            Tokens {
                access: "a1".into(),
                refresh: Some("r2".into()),
                expires_ms: 1_000 + 86_399_000
            }
        );
        assert!(parse_tokens(br#"{"error":"invalid_grant"}"#, 0).is_err());
    }

    #[test]
    fn a_token_is_refreshed_a_minute_before_it_expires() {
        let tokens = parse_tokens(br#"{"access_token":"a1","expires_in":3600}"#, 0).unwrap();
        assert!(!tokens.needs_refresh(3_539_999));
        assert!(tokens.needs_refresh(3_540_000));
        // An answer without `expires_in` does not expire.
        let forever = parse_tokens(br#"{"access_token":"a1"}"#, 0).unwrap();
        assert!(!forever.needs_refresh(10_000_000_000_000));
    }
}
