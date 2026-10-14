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
    // A tracker left at its defaults is not written out.
    #[serde(skip_serializing_if = "TrackerSettings::is_default")]
    pub github: TrackerSettings,
    #[serde(skip_serializing_if = "TrackerSettings::is_default")]
    pub linear: TrackerSettings,
    #[serde(skip_serializing_if = "TrackerSettings::is_default")]
    pub jira: TrackerSettings,
    #[serde(skip_serializing_if = "TrackerSettings::is_default")]
    pub clickup: TrackerSettings,
    /// What links a session to a task without a stored link (X44).
    #[serde(skip_serializing_if = "LinkRules::is_default")]
    pub link: LinkRules,
    /// Signed-in accounts of Linear, Jira and ClickUp (GitHub uses `gh`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub connections: Vec<Connection>,
}

/// "Link a session to an issue when…" (X44 Branch names and linking).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LinkRules {
    /// Its branch name contains the issue key.
    pub branch: bool,
    /// Its pull request mentions the key or closes the issue.
    pub pr: bool,
    /// Its name looks like an issue title: only ever a suggestion.
    pub title: bool,
}

impl Default for LinkRules {
    fn default() -> Self {
        Self {
            branch: true,
            pr: true,
            title: true,
        }
    }
}

impl LinkRules {
    fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

/// One signed-in account of a tracker on one site; its token is in the Keychain
/// under `id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Connection {
    /// `kind:site`, see [`connection_id`].
    pub id: String,
    pub kind: crate::TrackerKind,
    /// The Linear organisation, the Jira host or the ClickUp workspace id.
    pub site: String,
    /// Who it is signed in as, for the Settings row.
    pub account: String,
    /// `api_key`, `token` or `oauth`.
    pub auth: String,
    #[serde(default)]
    pub sources: Vec<Source>,
    /// Tracker state name → column, where the user changed the default (X44).
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub states: crate::states::Mapping,
}

/// A team, project or list the user shows tasks from, with where its
/// sessions start (X44 Sources).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Source {
    /// The team key, project key or list id.
    pub key: String,
    pub name: String,
    /// The moonlet project its sessions start in; empty until chosen.
    #[serde(default)]
    pub project: String,
    /// `host/workspaceId` of the workspace that shows it; empty until chosen.
    #[serde(default)]
    pub workspace: String,
    /// All open issues, rather than only the account's (X44 Shows).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub all: bool,
}

/// A connection's stable id: its tracker and site, so session links survive
/// reconnecting and resolve on another Mac (X44).
pub fn connection_id(kind: crate::TrackerKind, site: &str) -> String {
    let kind = match kind {
        crate::TrackerKind::Linear => "linear",
        crate::TrackerKind::Jira => "jira",
        crate::TrackerKind::Clickup => "clickup",
        crate::TrackerKind::Github => "github",
    };
    format!("{kind}:{}", site.to_ascii_lowercase())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Sync {
    /// Seconds between refreshes; 0 refreshes only on demand.
    pub interval: u64,
    /// Notify when a linked task changes state outside moonlet.
    pub notify: bool,
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
        Self {
            interval: 60,
            notify: true,
        }
    }
}

impl TrackerSettings {
    fn is_default(&self) -> bool {
        *self == Self::default()
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
        assert!(c.sync.notify);
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
             notify = true\n\
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

    #[test]
    fn connections_with_their_sources() {
        let text = r#"
[[connections]]
id = "jira:acme.atlassian.net"
kind = "jira"
site = "acme.atlassian.net"
account = "Sam Rivera"
auth = "token"

[[connections.sources]]
key = "OPS"
name = "Operations"
project = "p1"
workspace = "local/acme"
"#;
        let c = parse(text).unwrap();
        assert_eq!(
            c.connections,
            [Connection {
                id: "jira:acme.atlassian.net".into(),
                kind: crate::TrackerKind::Jira,
                site: "acme.atlassian.net".into(),
                account: "Sam Rivera".into(),
                auth: "token".into(),
                sources: vec![Source {
                    key: "OPS".into(),
                    name: "Operations".into(),
                    project: "p1".into(),
                    workspace: "local/acme".into(),
                    all: false,
                }],
                states: Default::default(),
            }]
        );
        assert_eq!(parse(&to_toml(&c)).unwrap(), c);
        assert_eq!(
            connection_id(crate::TrackerKind::Jira, "ACME.atlassian.net"),
            "jira:acme.atlassian.net"
        );
        // Each tracker has its own branch names and rules.
        assert_eq!(c.jira.rules.session_starts, Rule::Auto);
    }

    #[test]
    fn state_mapping_and_link_rules() {
        let text = r#"
[link]
pr = false

[[connections]]
id = "linear:acme"
kind = "linear"
site = "acme"
account = "Ada Lovelace"
auth = "api_key"

[connections.states]
QA = "in_review"
Backlog = "todo"
"#;
        let c = parse(text).unwrap();
        assert_eq!(
            (c.link.branch, c.link.pr, c.link.title),
            (true, false, true)
        );
        assert_eq!(
            c.connections[0].states.get("QA"),
            Some(&crate::states::Column::InReview)
        );
        assert_eq!(parse(&to_toml(&c)).unwrap(), c);
        // At their defaults, neither is written.
        let plain = to_toml(&TrackersConfig::default());
        assert!(
            !plain.contains("[link]") && !plain.contains("states"),
            "{plain}"
        );
    }
}
