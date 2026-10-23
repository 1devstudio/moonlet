//! How moonlet starts a design system's sync agent (X64, ADR 0013): Claude
//! Code in the system's folder, the source projects added read only, and
//! allowed to run moonlet's `design` commands without asking.

use std::path::Path;

use anyhow::{Result, bail};

use super::anchor::CardStatus;
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
    // Claude reads a rule's path as a glob: a folder named with `*?[]{}`
    // would deny something else than itself, so it is refused.
    if let Some(bad) = sources
        .iter()
        .find(|s| s.contains(['*', '?', '[', ']', '{', '}']))
    {
        bail!(
            "{bad} has a character Claude's permission rules read as a pattern; move or rename the folder"
        );
    }
    let bin = bin.display();
    // `Edit(//abs/**)`: an absolute path, as Claude's rules write one. It
    // covers every tool that edits files; `--add-dir` alone would not.
    let deny: Vec<String> = sources.iter().map(|s| format!("Edit(/{s}/**)")).collect();
    // Only what a sync needs: reporting a step (any summary), and the check
    // and the sync record of this folder's system, with no other arguments.
    // `progress` and `synced` take no system or workspace: they act only on
    // the system of the folder they run in.
    let allow = [
        format!("Bash({bin} design system progress:*)"),
        format!("Bash({bin} design check)"),
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
            "Sync the design system \"{}\" in this folder with the code of:\n{listed}\n{}\nFollow the moonlet-design skill's sync: rewrite only these cards, and write a card edited by hand as <name>.proposed.html beside it.",
            config.name,
            changes(cards)
        ),
    };
    prompt.push_str(&format!(
        " Run moonlet's commands with this exact path:\n\
- after each step: {bin} design system progress <step> <summary>\n\
- to check your work: {bin} design check\n\
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
                settings: r#"{"permissions":{"allow":["Bash(/Applications/moonlet.app/Contents/MacOS/moonlet design system progress:*)","Bash(/Applications/moonlet.app/Contents/MacOS/moonlet design check)","Bash(/Applications/moonlet.app/Contents/MacOS/moonlet design system synced)"],"deny":["Edit(//Users/alex/Workspace/moonlet/**)"]}}"#.into(),
                title: "Design · moonlet desktop".into(),
                mode: "acceptEdits".into(),
                prompt: "Build the design system \"moonlet desktop\" in this folder from the code of:
- /Users/alex/Workspace/moonlet (read only)

Follow the moonlet-design skill: Inventory, Tokens, Cards, Layouts. Run moonlet's commands with this exact path:
- after each step: /Applications/moonlet.app/Contents/MacOS/moonlet design system progress <step> <summary>
- to check your work: /Applications/moonlet.app/Contents/MacOS/moonlet design check
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

Follow the moonlet-design skill's sync: rewrite only these cards, and write a card edited by hand as <name>.proposed.html beside it. Run moonlet's commands with this exact path:
- after each step: /bin/moonlet design system progress <step> <summary>
- to check your work: /bin/moonlet design check
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
}
