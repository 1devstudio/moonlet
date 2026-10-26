//! Bytes as lowercase hex, and the SHA-256 of bytes so: one build for a
//! page's version (X65), a snapshot's files (X65) and a phone's token (X39).

use sha2::{Digest, Sha256};

/// `bytes` as lowercase hex, two digits each.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The SHA-256 of `data`, in lowercase hex.
pub fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}
