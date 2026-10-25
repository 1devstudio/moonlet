//! How moonlet starts a design system's sync agent (X64, ADR 0013): Claude
//! Code in the system's folder, the source projects added read only, and
//! allowed to run moonlet's `design` commands without asking.

use std::path::Path;

use anyhow::{Result, bail};

use super::anchor::CardStatus;
use super::designs::DesignConfig;
use super::store::SystemConfig;

/// What the daemon starts the agent with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub cwd: String,
    /// The source folders, which it may read but never edit.
    pub add_dirs: Vec<String>,
    /// Claude's `--settings`: an `Edit` deny rule per source, and the
    /// `design` commands of moonlet's binary allowed.
    pub settings: String,
    pub title: String,
    pub mode: String,
    /// Its first message.
    pub prompt: String,
}

/// What the agent is asked to do.
pub enum Task<'a> {
    /// Build the system from nothing.
    Build,
    /// Sync it again: these cards changed since the last sync.
    Resync(&'a [CardStatus]),
}

/// The launch of the sync agent of the system in `dir`. `sources` are the
/// source folders as real paths (no symlinks: Claude matches its rules on
/// those), and `bin` the real path of the `moonlet` binary. A command naming
/// it through a variable such as `$MOONLET_BIN` is never allowed by a rule.
pub fn sync_launch(
    dir: &Path,
    config: &SystemConfig,
    sources: &[String],
    bin: &Path,
    task: Task,
) -> Result<Launch> {
    no_pattern(sources)?;
    let bin = bin.display();
    // `Edit(//abs/**)`: an absolute path, as Claude's rules write one. It
    // covers every tool that edits files; `--add-dir` alone would not.
    let deny: Vec<String> = sources.iter().map(|s| format!("Edit(/{s}/**)")).collect();
    // Only what a sync needs: reporting a step (any summary), the check (with
    // or without rendering the cards) and the sync record of this folder's
    // system, with no other arguments, and a card's screenshot for grading.
    // `progress`, `snap` and `synced` take no system or workspace: they act
    // only on the system of the folder they run in.
    let allow = [
        format!("Bash({bin} design system progress:*)"),
        format!("Bash({bin} design check)"),
        format!("Bash({bin} design check --render)"),
        format!("Bash({bin} design snap:*)"),
        format!("Bash({bin} design system synced)"),
    ];
    let settings = serde_json::json!({ "permissions": { "allow": allow, "deny": deny } });
    let listed: String = sources
        .iter()
        .map(|s| format!("- {s} (read only)\n"))
        .collect();
    let mut prompt = match task {
        Task::Build => format!(
            "Build the design system \"{}\" in this folder from the code of:\n{listed}\nFollow the moonlet-design skill: Inventory, Tokens, Cards, Layouts.",
            config.name
        ),
        Task::Resync(cards) => format!(
            "Sync the design system \"{}\" in this folder with the code of:\n{listed}\n{}\nFollow the moonlet-design skill's sync: rewrite only these cards, and leave a card edited by hand as it is, with your version of each of its files you change beside it as <name>.proposed.html, <name>.proposed.css or <name>.proposed.prompt.md.",
            config.name,
            changes(cards)
        ),
    };
    prompt.push_str(&format!(
        " Run moonlet's commands with this exact path:\n\
- after each step: {bin} design system progress <step> <summary>\n\
- to check your work: {bin} design check\n\
- to render every card in the app and judge it: {bin} design check --render\n\
- to see a card, for grading: {bin} design snap <card> [--variant <variant>]\n\
- when every step is done: {bin} design system synced\n"
    ));
    Ok(Launch {
        cwd: dir.display().to_string(),
        add_dirs: sources.to_vec(),
        settings: settings.to_string(),
        title: format!("Design · {}", config.name),
        mode: "acceptEdits".into(),
        prompt,
    })
}

/// The design rules (X65), as the `moonlet-design` skill installs them in
/// `designs.md`: one text, which a design's first message also carries.
pub const DESIGN_RULES: &str = include_str!("../skill/moonlet-design/designs.md");

/// The launch of the agent of the workspace design in `dir` (X65): Claude Code
/// in the design's folder, its design system's folder `system_dir` (a real
/// path) added read only, allowed to check its pages without asking. Its first
/// message is the brief, with the design system's `README.md` and the design
/// rules.
pub fn design_launch(
    dir: &Path,
    config: &DesignConfig,
    system_dir: &Path,
    readme: &str,
    bin: &Path,
) -> Result<Launch> {
    let system = system_dir.display().to_string();
    no_pattern(std::slice::from_ref(&system))?;
    let bin = bin.display();
    // Every Claude Code tool that edits files is denied in the design system;
    // the design's own folder is covered by Accept edits.
    let deny = [format!("Edit(/{system}/**)")];
    // The check of this folder's design, and its fix, with no other arguments.
    let allow = [
        format!("Bash({bin} design check)"),
        format!("Bash({bin} design check --fix)"),
    ];
    let settings = serde_json::json!({ "permissions": { "allow": allow, "deny": deny } });
    // The rules as the skill installs them, without its install mark.
    let rules = DESIGN_RULES
        .split_once("-->\n")
        .map_or(DESIGN_RULES, |(_, rest)| rest)
        .trim_start();
    let prompt = format!(
        "{brief}\n\n---\nThis is the design \"{name}\" in this folder, on the design system \"{slug}\" at {system} (read only). Its README.md:\n\n{readme}\n\n{rules}\nRun moonlet's commands with this exact path:\n\
- to check your pages: {bin} design check\n\
- to give elements without an id, or with a repeated one, the next free ids: {bin} design check --fix\n",
        brief = config.brief.trim(),
        name = config.name,
        slug = config.system,
        readme = readme.trim_end(),
    );
    Ok(Launch {
        cwd: dir.display().to_string(),
        add_dirs: vec![system],
        settings: settings.to_string(),
        title: format!("Design · {}", config.name),
        mode: "acceptEdits".into(),
        prompt,
    })
}

/// Claude reads a rule's path as a glob: a folder named with `*?[]{}` would
/// deny something else than itself, so it is refused.
fn no_pattern(folders: &[String]) -> Result<()> {
    if let Some(bad) = folders
        .iter()
        .find(|s| s.contains(['*', '?', '[', ']', '{', '}']))
    {
        bail!(
            "{bad} has a character Claude's permission rules read as a pattern; move or rename the folder"
        );
    }
    Ok(())
}

/// The cards a re-sync covers, one line each.
fn changes(cards: &[CardStatus]) -> String {
    let mut out = String::from("Since the last sync:\n");
    for c in cards {
        let mut what = if c.new {
            "new, not in the last sync".to_string()
        } else if c.orphaned {
            "orphaned: its sources are gone; leave it for the user".to_string()
        } else if !c.changed_sources.is_empty() {
            format!("its sources changed: {}", c.changed_sources.join(", "))
        } else if c.exceptions_changed {
            "its settings in config.toml changed".to_string()
        } else {
            String::new()
        };
        // Whatever else changed, a card edited by hand is never overwritten.
        if c.edited_by_hand && !c.new && !c.orphaned {
            what = if what.is_empty() {
                "edited by hand; keep it".into()
            } else {
                format!("{what}; edited by hand, so write a proposal")
            };
        }
        out.push_str(&format!("- {}: {what}\n", c.path));
    }
    out
}

/// What a design system's or design's agent waits for from the user (X64).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NeedsYou {
    /// `question` or `approval`.
    pub kind: String,
    pub text: String,
}

/// The first thing the agent's chat waits for, from its pending asks.
pub fn needs_you(pending: &[moonlet_proto::types::PermissionAsk]) -> Option<NeedsYou> {
    let ask = pending.first()?;
    Some(if ask.tool == "AskUserQuestion" {
        NeedsYou {
            kind: "question".into(),
            text: ask.summary.clone(),
        }
    } else {
        NeedsYou {
            kind: "approval".into(),
            text: format!("{}: {}", ask.tool, ask.summary),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn config() -> SystemConfig {
        SystemConfig {
            name: "moonlet desktop".into(),
            created_at: 1,
            cover: None,
            cards: BTreeMap::new(),
        }
    }

    #[test]
    fn the_first_sync_agent_reads_the_sources_and_may_only_run_design_commands() {
        let launch = sync_launch(
            Path::new("/Users/alex/.moonlet/design/w1/systems/moonlet-desktop"),
            &config(),
            &["/Users/alex/Workspace/moonlet".to_string()],
            Path::new("/Applications/moonlet.app/Contents/MacOS/moonlet"),
            Task::Build,
        )
        .unwrap();
        assert_eq!(
            launch,
            Launch {
                cwd: "/Users/alex/.moonlet/design/w1/systems/moonlet-desktop".into(),
                add_dirs: vec!["/Users/alex/Workspace/moonlet".into()],
                settings: r#"{"permissions":{"allow":["Bash(/Applications/moonlet.app/Contents/MacOS/moonlet design system progress:*)","Bash(/Applications/moonlet.app/Contents/MacOS/moonlet design check)","Bash(/Applications/moonlet.app/Contents/MacOS/moonlet design check --render)","Bash(/Applications/moonlet.app/Contents/MacOS/moonlet design snap:*)","Bash(/Applications/moonlet.app/Contents/MacOS/moonlet design system synced)"],"deny":["Edit(//Users/alex/Workspace/moonlet/**)"]}}"#.into(),
                title: "Design · moonlet desktop".into(),
                mode: "acceptEdits".into(),
                prompt: "Build the design system \"moonlet desktop\" in this folder from the code of:
- /Users/alex/Workspace/moonlet (read only)

Follow the moonlet-design skill: Inventory, Tokens, Cards, Layouts. Run moonlet's commands with this exact path:
- after each step: /Applications/moonlet.app/Contents/MacOS/moonlet design system progress <step> <summary>
- to check your work: /Applications/moonlet.app/Contents/MacOS/moonlet design check
- to render every card in the app and judge it: /Applications/moonlet.app/Contents/MacOS/moonlet design check --render
- to see a card, for grading: /Applications/moonlet.app/Contents/MacOS/moonlet design snap <card> [--variant <variant>]
- when every step is done: /Applications/moonlet.app/Contents/MacOS/moonlet design system synced
"
                .into(),
            }
        );
    }

    #[test]
    fn a_resync_names_the_cards_that_changed_and_how() {
        let card = |path: &str, changed: &[&str], edited: bool, orphaned: bool| CardStatus {
            path: path.into(),
            changed_sources: changed.iter().map(|c| c.to_string()).collect(),
            edited_by_hand: edited,
            orphaned,
            new: false,
            exceptions_changed: false,
        };
        let cards = [
            card(
                "components/buttons/button/button.html",
                &["src/ui.tsx"],
                false,
                false,
            ),
            card(
                "components/custom/session-row/session-row.html",
                &["src/Sidebar.tsx"],
                true,
                false,
            ),
            card(
                "components/custom/toolbar/toolbar.html",
                &["src/Toolbar.tsx"],
                false,
                true,
            ),
        ];
        let launch = sync_launch(
            Path::new("/d"),
            &config(),
            &["/src".to_string()],
            Path::new("/bin/moonlet"),
            Task::Resync(&cards),
        )
        .unwrap();
        assert_eq!(
            launch.prompt,
            "Sync the design system \"moonlet desktop\" in this folder with the code of:
- /src (read only)

Since the last sync:
- components/buttons/button/button.html: its sources changed: src/ui.tsx
- components/custom/session-row/session-row.html: its sources changed: src/Sidebar.tsx; edited by hand, so write a proposal
- components/custom/toolbar/toolbar.html: orphaned: its sources are gone; leave it for the user

Follow the moonlet-design skill's sync: rewrite only these cards, and leave a card edited by hand as it is, with your version of each of its files you change beside it as <name>.proposed.html, <name>.proposed.css or <name>.proposed.prompt.md. Run moonlet's commands with this exact path:
- after each step: /bin/moonlet design system progress <step> <summary>
- to check your work: /bin/moonlet design check
- to render every card in the app and judge it: /bin/moonlet design check --render
- to see a card, for grading: /bin/moonlet design snap <card> [--variant <variant>]
- when every step is done: /bin/moonlet design system synced
"
        );
    }

    #[test]
    fn a_source_path_with_glob_characters_is_refused() {
        for bad in ["/code/app[1]", "/code/*", "/code/a?b", "/code/{a,b}"] {
            assert!(
                sync_launch(
                    Path::new("/d"),
                    &config(),
                    &[bad.to_string()],
                    Path::new("/bin/moonlet"),
                    Task::Build
                )
                .is_err(),
                "{bad} was accepted"
            );
        }
    }

    #[test]
    fn a_card_edited_by_hand_keeps_its_warning_whatever_else_changed() {
        let card = CardStatus {
            path: "components/custom/row/row.html".into(),
            changed_sources: vec![],
            edited_by_hand: true,
            orphaned: false,
            new: false,
            exceptions_changed: true,
        };
        let launch = sync_launch(
            Path::new("/d"),
            &config(),
            &[],
            Path::new("/bin/moonlet"),
            Task::Resync(std::slice::from_ref(&card)),
        )
        .unwrap();
        assert!(
            launch.prompt.contains("- components/custom/row/row.html: its settings in config.toml changed; edited by hand, so write a proposal\n"),
            "{}",
            launch.prompt
        );
    }

    #[test]
    fn the_first_pending_ask_says_what_the_agent_needs() {
        let ask = |tool: &str, summary: &str| moonlet_proto::types::PermissionAsk {
            id: "a".into(),
            tool: tool.into(),
            summary: summary.into(),
            input: serde_json::Value::Null,
            reason: None,
            can_always: false,
            diff: None,
            asked_at: None,
            agent: None,
        };
        assert_eq!(needs_you(&[]), None);
        assert_eq!(
            needs_you(&[
                ask("AskUserQuestion", "Which button set is current?"),
                ask("Bash", "ls")
            ]),
            Some(NeedsYou {
                kind: "question".into(),
                text: "Which button set is current?".into()
            })
        );
        assert_eq!(
            needs_you(&[ask("Bash", "find src -name '*.tsx'")]),
            Some(NeedsYou {
                kind: "approval".into(),
                text: "Bash: find src -name '*.tsx'".into()
            })
        );
    }

    #[test]
    fn a_designs_agent_reads_its_design_system_and_may_only_check_its_pages() {
        let config = DesignConfig {
            name: "Settings page".into(),
            system: "moonlet-desktop".into(),
            brief: "A settings page with General and Git sections".into(),
            viewport: "1440x900".into(),
            created_at: 1,
            session: None,
            pages: BTreeMap::new(),
        };
        let launch = design_launch(
            Path::new("/Users/alex/.moonlet/design/w1/designs/settings-page"),
            &config,
            Path::new("/Users/alex/.moonlet/design/w1/systems/moonlet-desktop"),
            "# moonlet desktop\n\nLink styles.css.\n",
            Path::new("/Applications/moonlet.app/Contents/MacOS/moonlet"),
        )
        .unwrap();
        assert_eq!(
            (launch.cwd.as_str(), launch.add_dirs.clone(), launch.title.as_str(), launch.mode.as_str()),
            (
                "/Users/alex/.moonlet/design/w1/designs/settings-page",
                vec!["/Users/alex/.moonlet/design/w1/systems/moonlet-desktop".to_string()],
                "Design · Settings page",
                "acceptEdits"
            )
        );
        assert_eq!(
            launch.settings,
            r#"{"permissions":{"allow":["Bash(/Applications/moonlet.app/Contents/MacOS/moonlet design check)","Bash(/Applications/moonlet.app/Contents/MacOS/moonlet design check --fix)"],"deny":["Edit(//Users/alex/.moonlet/design/w1/systems/moonlet-desktop/**)"]}}"#
        );
        // The brief first, then the design system's README and the rules.
        assert!(
            launch.prompt.starts_with(
                "A settings page with General and Git sections

---
This is the design \"Settings page\" in this folder, on the design system \"moonlet-desktop\" at /Users/alex/.moonlet/design/w1/systems/moonlet-desktop (read only). Its README.md:

# moonlet desktop

Link styles.css.

# Design rules
"
            ),
            "{}",
            launch.prompt
        );
        for rule in [
            "- **Link only the design system's `styles.css`**, from a page in `pages/` as `<link rel=\"stylesheet\" href=\"../../../systems/<system>/styles.css\">`",
            "- **Start from the design system**: its layouts in `ui_kits/`, the snippets in its cards",
            "- **Read a component's `.prompt.md` before you use it**, and use its classes instead of raw elements",
            "- **Keep `data-mid` on every element** of the body",
            "- **Write one page per variant**: `pages/index.html` first",
            "- **Run the check after each change**",
        ] {
            assert!(launch.prompt.contains(rule), "{rule}");
        }
        assert!(!launch.prompt.contains("Installed by moonlet"), "{}", launch.prompt);
        assert!(
            launch.prompt.ends_with(
                "Run moonlet's commands with this exact path:
- to check your pages: /Applications/moonlet.app/Contents/MacOS/moonlet design check
- to give elements without an id, or with a repeated one, the next free ids: /Applications/moonlet.app/Contents/MacOS/moonlet design check --fix
"
            ),
            "{}",
            launch.prompt
        );
    }

    #[test]
    fn a_design_system_folder_with_glob_characters_is_refused_for_a_design() {
        let config = DesignConfig {
            name: "x".into(),
            system: "s".into(),
            brief: String::new(),
            viewport: "1440x900".into(),
            created_at: 1,
            session: None,
            pages: BTreeMap::new(),
        };
        let refused = design_launch(Path::new("/d"), &config, Path::new("/home/a[1]/s"), "", Path::new("/bin/moonlet"));
        assert!(refused.is_err());
    }
}
