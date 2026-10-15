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
}
