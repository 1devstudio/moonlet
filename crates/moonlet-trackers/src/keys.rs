//! Issue keys such as `MOON-142` found in branch names and PR text (X44).

/// Whether `text` (a branch name, a PR title) contains `key`, ignoring case,
/// with no letter or digit right before or after it: `moon-142-x` carries
/// `MOON-142`, `moon-1420` does not.
pub fn mentions_key(text: &str, key: &str) -> bool {
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

/// The issue number a GitHub branch starts with: `42-fix-login` is issue 42,
/// as `gh issue develop` names it (X44). Whether it is that repository's
/// issue depends on the project's `origin`, which the caller knows.
pub fn github_branch_number(branch: &str) -> Option<u64> {
    let (number, rest) = branch.split_once('-')?;
    if rest.is_empty() || number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    number.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_branch_carries_the_key_in_lower_case() {
        assert!(mentions_key("moon-142-remote-hosts", "MOON-142"));
    }

    #[test]
    fn a_longer_number_or_prefix_is_another_key() {
        assert!(!mentions_key("moon-1420-other", "MOON-142"));
        assert!(!mentions_key("xmoon-142", "MOON-142"));
        assert!(mentions_key("feat/MOON-142", "MOON-142"));
        assert!(mentions_key("moon-1420-and-moon-142", "MOON-142"));
    }

    #[test]
    fn a_github_branch_starts_with_the_issue_number() {
        // `gh issue develop 42` names the branch `42-<title>`.
        assert_eq!(github_branch_number("42-fix-login"), Some(42));
        assert_eq!(github_branch_number("142x-fix"), None);
        assert_eq!(github_branch_number("fix-42-login"), None);
        assert_eq!(github_branch_number("42"), None);
    }
}
