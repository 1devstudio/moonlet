//! `~/.moonlet/trackers.toml`: the app's tracker settings (X44). Tokens are
//! never here; they live in the macOS Keychain.

use serde::{Deserialize, Serialize};

/// A Keep in step rule's setting (X46).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Rule {
    Auto,
    Suggest,
    Off,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TrackersConfig {
    pub sync: Sync,
    pub github: TrackerSettings,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Sync {
    /// Seconds between refreshes; 0 refreshes only on demand.
    pub interval: u64,
}

/// One tracker's settings: branch names and the Keep in step rules.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TrackerSettings {
    /// Empty: the tracker's default template.
    pub branch_template: String,
    pub max_length: usize,
    pub rules: Rules,
}

/// The five rules of X46, with the spec's defaults.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Rules {
    /// A session starts from an issue: move it to In Progress (GitHub: assign it).
    pub session_starts: Rule,
    /// A pull request opens: move the issue to In Review.
    pub pr_opens: Rule,
    /// Every session's PR is merged: move the issue to Done (GitHub: close it).
    pub all_merged: Rule,
    /// A pull request opens: comment its link (GitHub: `Closes #<n>` in its body).
    pub pr_comment: Rule,
    /// The issue moves to Done: archive its sessions and remove their worktrees.
    pub issue_done: Rule,
}

impl Default for Sync {
    fn default() -> Self {
        Self { interval: 60 }
    }
}

impl Default for TrackerSettings {
    fn default() -> Self {
        Self {
            branch_template: String::new(),
            max_length: crate::branch::DEFAULT_MAX_LEN,
            rules: Rules::default(),
        }
    }
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            session_starts: Rule::Auto,
            pr_opens: Rule::Auto,
            all_merged: Rule::Suggest,
            pr_comment: Rule::Auto,
            issue_done: Rule::Suggest,
        }
    }
}

/// The text of `trackers.toml`. The app owns the file and rewrites it whole.
pub fn to_toml(config: &TrackersConfig) -> String {
    let body = toml::to_string(config).unwrap_or_default();
    format!(
        "# moonlet's task tracker settings (X44), written by the app.\n\
         # Tokens are not stored here: they live in the macOS Keychain.\n\n{body}"
    )
}

/// Reads `trackers.toml`; missing keys take their defaults.
pub fn parse(text: &str) -> Result<TrackersConfig, String> {
    toml::from_str(text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_file_means_the_spec_defaults() {
        let c = parse("").unwrap();
        assert_eq!(c.sync.interval, 60);
        assert_eq!(c.github.branch_template, "");
        assert_eq!(c.github.max_length, 48);
        assert_eq!(
            [
                c.github.rules.session_starts,
                c.github.rules.pr_opens,
                c.github.rules.all_merged,
                c.github.rules.pr_comment,
                c.github.rules.issue_done
            ],
            [
                Rule::Auto,
                Rule::Auto,
                Rule::Suggest,
                Rule::Auto,
                Rule::Suggest
            ]
        );
    }

    #[test]
    fn the_file_the_app_writes() {
        let mut c = TrackersConfig::default();
        c.sync.interval = 300;
        c.github.branch_template = "{user}/{number}-{title}".into();
        c.github.rules.all_merged = Rule::Auto;
        let text = to_toml(&c);
        assert_eq!(
            text,
            "# moonlet's task tracker settings (X44), written by the app.\n\
             # Tokens are not stored here: they live in the macOS Keychain.\n\
             \n\
             [sync]\n\
             interval = 300\n\
             \n\
             [github]\n\
             branch_template = \"{user}/{number}-{title}\"\n\
             max_length = 48\n\
             \n\
             [github.rules]\n\
             session_starts = \"auto\"\n\
             pr_opens = \"auto\"\n\
             all_merged = \"auto\"\n\
             pr_comment = \"auto\"\n\
             issue_done = \"suggest\"\n"
        );
        assert_eq!(parse(&text).unwrap(), c);
    }

    #[test]
    fn a_bad_rule_names_its_key() {
        let err = parse("[github.rules]\nall_merged = \"always\"\n").unwrap_err();
        assert!(err.contains("all_merged"), "{err}");
    }
}
