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
    /// What Tasks mode shows, one board at a time (X50).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub boards: Vec<Board>,
    /// Workspaces (`host/workspaceId`) whose X44 sources and GitHub
    /// repositories the app has turned into boards, once (X50).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub migrated: Vec<String>,
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
    /// Jira's sign-in email, so Reconnect asks only for a new token (X44).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default)]
    pub sources: Vec<Source>,
    /// Tracker state name → column, where the user changed the default (X44).
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub states: crate::states::Mapping,
}

/// A team, project or list the user shows tasks from, and the workspace
/// that shows it (X44 Sources). The projects its sessions start in are in
/// each project's Project settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Source {
    /// The team key, project key or list id.
    pub key: String,
    pub name: String,
    /// `host/workspaceId` of the workspace that shows it; empty until chosen.
    #[serde(default)]
    pub workspace: String,
}

/// One view of one tracker in a workspace, shown in Tasks mode (X50): the
/// tracker's columns in its own order, its filter and the projects its
/// sessions start in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Board {
    /// Made by the app when the board is added; never shown.
    pub id: String,
    pub name: String,
    /// The connection id; `github:github.com` for GitHub.
    pub connection: String,
    /// `host/workspaceId` of the workspace that shows it.
    pub workspace: String,
    pub origin: Origin,
    /// JQL added with AND to a Jira board's filter or query.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub narrow: String,
    /// Only issues with one of these labels (Linear, GitHub repository, ClickUp).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Assignee::is_me")]
    pub assignee: Assignee,
    #[serde(default)]
    pub finished: Finished,
    /// In the board's order. Empty until the first sync reads the tracker's
    /// own statuses (a board migrated from a source, X50).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub columns: Vec<BoardColumn>,
    /// The old connection's state mapping, kept for a migrated board until its
    /// columns are read: state name → category.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub states: crate::states::Mapping,
    /// Where new sessions from the board start, first match wins.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<RepoRule>,
    /// The fields its cards show besides the X45 card.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cards: Vec<CardField>,
    #[serde(default = "yes", skip_serializing_if = "is_true")]
    pub pinned: bool,
}

fn yes() -> bool {
    true
}

fn is_true(b: &bool) -> bool {
    *b
}

/// What a board is built from (X50 Add a board, step 1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Origin {
    /// An existing Jira board, by id: its columns, WIP limits and filter.
    JiraBoard {
        board: u64,
    },
    Jql {
        query: String,
    },
    /// A Linear team, by key.
    LinearTeam {
        team: String,
    },
    GithubProject {
        owner: String,
        number: u64,
    },
    /// A repository's issues (`owner/name`): columns Open and Closed.
    GithubRepo {
        repo: String,
    },
    ClickupList {
        list: String,
    },
}

/// Whose issues a board shows until the header's Assignee filter says otherwise.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Assignee {
    #[default]
    Me,
    Anyone,
}

impl Assignee {
    fn is_me(&self) -> bool {
        *self == Assignee::Me
    }
}

/// Which finished issues a board keeps: those finished in the last N days
/// (`finished = 14`), or only the active sprint, cycle or iteration's
/// (`finished = "sprint"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Finished {
    Days(u32),
    #[serde(with = "sprint")]
    Sprint,
}

impl Default for Finished {
    fn default() -> Self {
        Finished::Days(14)
    }
}

/// `Finished::Sprint` as the string `"sprint"`.
mod sprint {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    pub fn serialize<S: Serializer>(s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str("sprint")
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<(), D::Error> {
        match String::deserialize(d)?.as_str() {
            "sprint" => Ok(()),
            other => Err(D::Error::custom(format!(
                "finished is a number of days or \"sprint\", not \"{other}\""
            ))),
        }
    }
}

/// One of a board's columns, named as the tracker names it (X50).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoardColumn {
    pub name: String,
    /// The tracker's statuses in it: Jira status ids, else state names.
    pub statuses: Vec<String>,
    /// What moonlet treats it as, for out of sync and Keep in step.
    pub category: crate::states::Column,
    #[serde(default, skip_serializing_if = "Show::is_show")]
    pub show: Show,
    /// Jira's column limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wip: Option<u32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Show {
    #[default]
    Show,
    Fold,
    Hide,
}

impl Show {
    fn is_show(&self) -> bool {
        *self == Show::Show
    }
}

/// "New sessions from this board start in": `project` when `when` matches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoRule {
    pub when: When,
    /// The moonlet project's id.
    pub project: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum When {
    #[serde(with = "default_rule")]
    Default,
    Component {
        component: String,
    },
    Label {
        label: String,
    },
}

/// `When::Default` as the string `"default"`.
mod default_rule {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    pub fn serialize<S: Serializer>(s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str("default")
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<(), D::Error> {
        match String::deserialize(d)?.as_str() {
            "default" => Ok(()),
            other => Err(D::Error::custom(format!(
                "a rule's when is \"default\", a component or a label, not \"{other}\""
            ))),
        }
    }
}

/// "Cards show" (X50 Add a board, step 4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardField {
    IssueType,
    /// Story points or estimate.
    Points,
    Assignee,
    /// Epic or parent.
    Parent,
    Due,
    Labels,
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
# Written before Assignee: me and Project settings took their place
# (X45, X44); read and dropped.
all = true
"#;
        let c = parse(text).unwrap();
        assert_eq!(c.connections[0].email, None);
        assert_eq!(
            c.connections,
            [Connection {
                id: "jira:acme.atlassian.net".into(),
                kind: crate::TrackerKind::Jira,
                site: "acme.atlassian.net".into(),
                account: "Sam Rivera".into(),
                auth: "token".into(),
                email: None,
                sources: vec![Source {
                    key: "OPS".into(),
                    name: "Operations".into(),
                    workspace: "local/acme".into(),
                }],
                states: Default::default(),
            }]
        );
        assert_eq!(parse(&to_toml(&c)).unwrap(), c);
        assert!(!to_toml(&c).contains("all ="), "{}", to_toml(&c));
        assert!(!to_toml(&c).contains("project ="), "{}", to_toml(&c));
        assert_eq!(
            connection_id(crate::TrackerKind::Jira, "ACME.atlassian.net"),
            "jira:acme.atlassian.net"
        );
        // Each tracker has its own branch names and rules.
        assert_eq!(c.jira.rules.session_starts, Rule::Auto);
    }

    #[test]
    fn a_jira_board_with_its_columns_rules_and_cards() {
        // The board of the "Add a board" design: WEB's Jira board, narrowed
        // to two components, with Backlog hidden and Done folded (X50).
        let text = r#"
[[boards]]
id = "b1"
name = "WEB · Website"
connection = "jira:acme.atlassian.net"
workspace = "local/acme"
narrow = "component in (frontend, design-system)"
assignee = "anyone"
finished = 14
cards = ["issue_type", "points", "assignee"]

[boards.origin]
kind = "jira_board"
board = 41

[[boards.columns]]
name = "Backlog"
statuses = ["10000"]
category = "todo"
show = "hide"

[[boards.columns]]
name = "In Progress"
statuses = ["3", "10012"]
category = "in_progress"
wip = 4

[[boards.columns]]
name = "Done"
statuses = ["10001", "10015"]
category = "done"
show = "fold"

[[boards.rules]]
when = "default"
project = "website"

[[boards.rules]]
when = { component = "design-system" }
project = "ui-kit"
"#;
        let c = parse(text).unwrap();
        assert_eq!(
            c.boards,
            [Board {
                id: "b1".into(),
                name: "WEB · Website".into(),
                connection: "jira:acme.atlassian.net".into(),
                workspace: "local/acme".into(),
                origin: Origin::JiraBoard { board: 41 },
                narrow: "component in (frontend, design-system)".into(),
                labels: vec![],
                assignee: Assignee::Anyone,
                finished: Finished::Days(14),
                columns: vec![
                    BoardColumn {
                        name: "Backlog".into(),
                        statuses: vec!["10000".into()],
                        category: crate::states::Column::Todo,
                        show: Show::Hide,
                        wip: None,
                    },
                    BoardColumn {
                        name: "In Progress".into(),
                        statuses: vec!["3".into(), "10012".into()],
                        category: crate::states::Column::InProgress,
                        show: Show::Show,
                        wip: Some(4),
                    },
                    BoardColumn {
                        name: "Done".into(),
                        statuses: vec!["10001".into(), "10015".into()],
                        category: crate::states::Column::Done,
                        show: Show::Fold,
                        wip: None,
                    },
                ],
                states: Default::default(),
                rules: vec![
                    RepoRule {
                        when: When::Default,
                        project: "website".into(),
                    },
                    RepoRule {
                        when: When::Component {
                            component: "design-system".into()
                        },
                        project: "ui-kit".into(),
                    },
                ],
                cards: vec![CardField::IssueType, CardField::Points, CardField::Assignee],
                pinned: true,
            }]
        );
        assert_eq!(parse(&to_toml(&c)).unwrap(), c);
    }

    #[test]
    fn a_board_written_with_only_its_essentials_takes_the_defaults() {
        let text = r#"
[[boards]]
id = "b2"
name = "Moonlet"
connection = "linear:1devstudio"
workspace = "local/1devstudio"
finished = "sprint"
origin = { kind = "linear_team", team = "MOON" }
"#;
        let c = parse(&format!("migrated = [\"local/1devstudio\"]\n{text}")).unwrap();
        assert_eq!(c.migrated, ["local/1devstudio"]);
        assert_eq!(parse(&to_toml(&c)).unwrap(), c);
        let b = &parse(text).unwrap().boards[0];
        assert_eq!(
            b.origin,
            Origin::LinearTeam {
                team: "MOON".into()
            }
        );
        assert_eq!(b.finished, Finished::Sprint);
        assert_eq!(b.assignee, Assignee::Me);
        assert!(b.pinned);
        assert!(b.columns.is_empty() && b.rules.is_empty() && b.cards.is_empty());
        // Defaults are not written back.
        let written = to_toml(&parse(text).unwrap());
        for key in [
            "assignee", "pinned", "narrow", "labels", "columns", "rules", "cards", "states",
        ] {
            assert!(
                !written.contains(&format!("{key} =")) && !written.contains(&format!(".{key}]")),
                "{key} in {written}"
            );
        }
    }

    #[test]
    fn every_origin_reads_back() {
        for (toml_origin, origin) in [
            (
                r#"{ kind = "jql", query = "project = OPS" }"#,
                Origin::Jql {
                    query: "project = OPS".into(),
                },
            ),
            (
                r#"{ kind = "github_project", owner = "acme", number = 3 }"#,
                Origin::GithubProject {
                    owner: "acme".into(),
                    number: 3,
                },
            ),
            (
                r#"{ kind = "github_repo", repo = "acme/web" }"#,
                Origin::GithubRepo {
                    repo: "acme/web".into(),
                },
            ),
            (
                r#"{ kind = "clickup_list", list = "901" }"#,
                Origin::ClickupList { list: "901".into() },
            ),
        ] {
            let text = format!(
                "[[boards]]\nid = \"b\"\nname = \"n\"\nconnection = \"c\"\nworkspace = \"w\"\norigin = {toml_origin}\n"
            );
            let c = parse(&text).unwrap();
            assert_eq!(c.boards[0].origin, origin);
            assert_eq!(parse(&to_toml(&c)).unwrap(), c);
        }
    }

    #[test]
    fn a_jira_connection_keeps_its_email_for_reconnecting() {
        let text = r#"
[[connections]]
id = "jira:acme.atlassian.net"
kind = "jira"
site = "acme.atlassian.net"
account = "Sam Rivera"
auth = "token"
email = "sam@acme.example"
"#;
        let c = parse(text).unwrap();
        assert_eq!(c.connections[0].email.as_deref(), Some("sam@acme.example"));
        assert!(to_toml(&c).contains("email = \"sam@acme.example\""));
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
