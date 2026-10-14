//! Issue keys such as `MOON-142` found in branch names and PR text (X44).

/// Whether `text` (a branch name, a PR title) contains `key`, ignoring case,
/// with no letter or digit right before or after it: `moon-142-x` carries
/// `MOON-142`, `moon-1420` does not.
pub fn branch_has_key(text: &str, key: &str) -> bool {
    if key.is_empty() {
        return false;
    }
    let hay = text.to_ascii_lowercase();
    let needle = key.to_ascii_lowercase();
    let bytes = hay.as_bytes();
    let mut from = 0;
    while let Some(at) = hay[from..].find(&needle) {
        let start = from + at;
        let end = start + needle.len();
        let before = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
        let after = end == bytes.len() || !bytes[end].is_ascii_alphanumeric();
        if before && after {
            return true;
        }
        from = start + 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_branch_carries_the_key_in_lower_case() {
        assert!(branch_has_key("moon-142-remote-hosts", "MOON-142"));
    }

    #[test]
    fn a_longer_number_or_prefix_is_another_key() {
        assert!(!branch_has_key("moon-1420-other", "MOON-142"));
        assert!(!branch_has_key("xmoon-142", "MOON-142"));
        assert!(branch_has_key("feat/MOON-142", "MOON-142"));
        assert!(branch_has_key("moon-1420-and-moon-142", "MOON-142"));
    }
}
