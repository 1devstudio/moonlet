//! Keys and issue URLs a user pastes into the link dialog (X46).

use crate::TrackerKind;

/// What a pasted key or URL points at. `kind` is `None` for a bare
/// `ABC-123`, which Linear and Jira share; `site` is the Linear organisation,
/// the Jira host or the ClickUp workspace id when the URL names one.
///
/// `site` comes from the user's clipboard: use it only to pick one of the
/// connections the user made, never as a host to send a token to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pasted {
    pub kind: Option<TrackerKind>,
    pub key: String,
    pub site: Option<String>,
}

pub fn parse_pasted(input: &str) -> Option<Pasted> {
    let input = input.trim();
    match input
        .strip_prefix("https://")
        .or_else(|| input.strip_prefix("http://"))
    {
        Some(rest) => parse_url(rest),
        None => parse_bare(input),
    }
}

/// `#42` (GitHub), `CU-86abc123` (ClickUp) or `ABC-123` (Linear or Jira).
fn parse_bare(input: &str) -> Option<Pasted> {
    let bare = |kind, key: String| {
        Some(Pasted {
            kind,
            key,
            site: None,
        })
    };
    if let Some(n) = input.strip_prefix('#') {
        return match n.parse::<u64>() {
            Ok(n) => bare(Some(TrackerKind::Github), format!("#{n}")),
            Err(_) => None,
        };
    }
    if let Some(key) = issue_key(input) {
        // `CU-12` too: a Linear or Jira team may be keyed "CU".
        return bare(None, key);
    }
    let (prefix, id) = input.split_once('-')?;
    if prefix.eq_ignore_ascii_case("cu")
        && !id.is_empty()
        && id.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return bare(Some(TrackerKind::Clickup), clickup_key(id));
    }
    None
}

/// `ABC-123` in upper case: letters and digits starting with a letter, `-`,
/// then digits.
fn issue_key(input: &str) -> Option<String> {
    let (prefix, id) = input.split_once('-')?;
    let prefix_ok = prefix.starts_with(|c: char| c.is_ascii_alphabetic())
        && prefix.chars().all(|c| c.is_ascii_alphanumeric());
    let id_ok = !id.is_empty() && id.chars().all(|c| c.is_ascii_digit());
    (prefix_ok && id_ok).then(|| input.to_ascii_uppercase())
}

/// A ClickUp task without a custom ID, keyed the way ClickUp's GitHub
/// integration names it in branches.
fn clickup_key(task_id: &str) -> String {
    format!("CU-{}", task_id.to_ascii_lowercase())
}

fn parse_url(rest: &str) -> Option<Pasted> {
    // The authority ends where a URL parser would end it, so a pasted
    // `user@evil.com#.atlassian.net` is never taken for a Jira site.
    let end = rest.find(['/', '?', '#', '\\']).unwrap_or(rest.len());
    let (authority, after) = rest.split_at(end);
    let host = authority
        .rsplit_once(':')
        .filter(|(_, port)| !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()))
        .map_or(authority, |(host, _)| host)
        .to_ascii_lowercase();
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return None;
    }
    let path = after.strip_prefix('/').unwrap_or("");
    let path = path.split('#').next().unwrap_or("");
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let found = |kind, key: String, site: Option<&str>| {
        Some(Pasted {
            kind: Some(kind),
            key,
            site: site.map(String::from),
        })
    };
    match (host.as_str(), &segs[..]) {
        ("linear.app", [org, "issue", key, ..]) => {
            found(TrackerKind::Linear, issue_key(key)?, Some(org))
        }
        (jira, segs)
            if jira
                .strip_suffix(".atlassian.net")
                .is_some_and(|name| !name.is_empty() && !name.starts_with('.')) =>
        {
            let key = match segs {
                ["browse", key, ..] => Some(*key),
                _ => query
                    .split('&')
                    .find_map(|kv| kv.strip_prefix("selectedIssue=")),
            }?;
            found(TrackerKind::Jira, issue_key(key)?, Some(jira))
        }
        ("app.clickup.com", ["t", team, custom]) => {
            found(TrackerKind::Clickup, issue_key(custom)?, Some(team))
        }
        ("app.clickup.com", ["t", id]) => found(TrackerKind::Clickup, clickup_key(id), None),
        ("github.com", [owner, repo, "issues", n, ..]) => {
            let n: u64 = n.parse().ok()?;
            found(TrackerKind::Github, format!("{owner}/{repo}#{n}"), None)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_linear_issue_url() {
        assert_eq!(
            parse_pasted("https://linear.app/1devstudio/issue/MOON-142/remote-hosts-sidebar"),
            Some(Pasted {
                kind: Some(TrackerKind::Linear),
                key: "MOON-142".into(),
                site: Some("1devstudio".into()),
            })
        );
    }

    #[test]
    fn jira_browse_and_board_urls() {
        let want = Some(Pasted {
            kind: Some(TrackerKind::Jira),
            key: "OPS-12".into(),
            site: Some("acme.atlassian.net".into()),
        });
        assert_eq!(
            parse_pasted("https://acme.atlassian.net/browse/OPS-12"),
            want
        );
        assert_eq!(
            parse_pasted(
                "https://acme.atlassian.net/jira/software/projects/OPS/boards/1?selectedIssue=OPS-12"
            ),
            want
        );
    }

    #[test]
    fn clickup_task_urls_with_and_without_a_custom_id() {
        assert_eq!(
            parse_pasted("https://app.clickup.com/t/86abc123"),
            Some(Pasted {
                kind: Some(TrackerKind::Clickup),
                key: "CU-86abc123".into(),
                site: None
            })
        );
        assert_eq!(
            parse_pasted("https://app.clickup.com/t/9012345/MOON-12"),
            Some(Pasted {
                kind: Some(TrackerKind::Clickup),
                key: "MOON-12".into(),
                site: Some("9012345".into()),
            })
        );
    }

    #[test]
    fn a_github_issue_url() {
        assert_eq!(
            parse_pasted("https://github.com/1devstudio/moonlet/issues/42#issuecomment-1"),
            Some(Pasted {
                kind: Some(TrackerKind::Github),
                key: "1devstudio/moonlet#42".into(),
                site: None,
            })
        );
        assert_eq!(
            parse_pasted("https://github.com/1devstudio/moonlet/pull/42"),
            None
        );
    }

    #[test]
    fn a_host_with_userinfo_or_odd_characters_is_not_a_tracker() {
        // A URL parser would send these to evil.com; the suffix check must not
        // name them a Jira site.
        assert_eq!(
            parse_pasted("https://user@evil.com#.atlassian.net/browse/OPS-12"),
            None
        );
        assert_eq!(
            parse_pasted("https://evil.com\\.atlassian.net/browse/OPS-12"),
            None
        );
        assert_eq!(
            parse_pasted("https://evil.com?.atlassian.net/browse/OPS-12"),
            None
        );
        assert_eq!(
            parse_pasted("https://ACME.atlassian.net:443/browse/OPS-12").map(|p| p.site),
            Some(Some("acme.atlassian.net".into()))
        );
    }

    #[test]
    fn bare_keys() {
        let bare = |kind, key: &str| {
            Some(Pasted {
                kind,
                key: key.into(),
                site: None,
            })
        };
        assert_eq!(parse_pasted(" moon-142 "), bare(None, "MOON-142"));
        assert_eq!(
            parse_pasted("CU-86ABC123"),
            bare(Some(TrackerKind::Clickup), "CU-86abc123")
        );
        assert_eq!(parse_pasted("#42"), bare(Some(TrackerKind::Github), "#42"));
        assert_eq!(parse_pasted("MOON-"), None);
        assert_eq!(parse_pasted("142"), None);
        assert_eq!(parse_pasted("changelog themes"), None);
    }

    #[test]
    fn a_digits_only_cu_key_could_be_any_tracker() {
        // A Linear or Jira team keyed "CU" has keys like CU-12 too; ClickUp
        // ids carry letters.
        assert_eq!(
            parse_pasted("cu-12"),
            Some(Pasted {
                kind: None,
                key: "CU-12".into(),
                site: None
            })
        );
    }

    #[test]
    fn a_trailing_slash_keeps_the_clickup_custom_id() {
        assert_eq!(
            parse_pasted("https://app.clickup.com/t/9012345/MOON-12/"),
            Some(Pasted {
                kind: Some(TrackerKind::Clickup),
                key: "MOON-12".into(),
                site: Some("9012345".into()),
            })
        );
    }

    #[test]
    fn urls_without_a_key_are_not_tasks() {
        for url in [
            "https://acme.atlassian.net/browse/",
            "https://acme.atlassian.net/jira/software/projects/OPS/boards/1?selectedIssue=",
            "https://acme.atlassian.net/browse/not a key",
            "https://linear.app/1devstudio/issue/",
            "https://linear.app/1devstudio/issue/settings",
            "https://.atlassian.net/browse/OPS-12",
        ] {
            assert_eq!(parse_pasted(url), None, "{url}");
        }
    }
}
