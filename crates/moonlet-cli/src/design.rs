//! Decisions behind `moonlet design` (X64), kept apart from the socket so
//! they can be tested on plain data.

use std::path::Path;

use moonlet_proto::TerminalId;

/// The workspace, and the design system or the design when there is one,
/// that a folder under `~/.moonlet/design` belongs to: the sync agent works in
/// its system's folder and a design's agent in its design's (X65), so their
/// commands need no arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub workspace: String,
    pub system: Option<String>,
    pub design: Option<String>,
}

pub fn locate(cwd: &Path, design_root: &Path) -> Option<Located> {
    let mut parts = cwd
        .strip_prefix(design_root)
        .ok()?
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned());
    let workspace = parts.next()?;
    let (system, design) = match parts.next().as_deref() {
        Some("systems") => (parts.next(), None),
        Some("designs") => (None, parts.next()),
        _ => (None, None),
    };
    Some(Located { workspace, system, design })
}

/// The name of a design made without `--name` (X65): the first words of its
/// brief, up to its first punctuation, five at most.
pub fn name_from_brief(brief: &str) -> String {
    let head = brief.split(['.', ',', ';', ':', '!', '?', '\n']).next().unwrap_or("");
    let words: Vec<&str> = head.split_whitespace().take(5).collect();
    if words.is_empty() { "Design".into() } else { words.join(" ") }
}

/// The workspace of the session the agent's terminal belongs to, from
/// `(terminal, session)` and `(session, workspace)` pairs.
pub fn workspace_of_terminal(
    terminals: &[(TerminalId, Option<String>)],
    sessions: &[(String, Option<String>)],
    terminal: TerminalId,
) -> Option<String> {
    let session = terminals
        .iter()
        .find(|(id, _)| *id == terminal)?
        .1
        .as_ref()?;
    sessions.iter().find(|(id, _)| id == session)?.1.clone()
}

/// The design system a session design made with `design new --here` is
/// on (X65): `named` when given, else the workspace's one design system
/// whose sources include the session's project at `project`. `systems` are
/// each system's slug and source folders. Several, or none, is an error
/// saying what to do.
pub fn pick_system(systems: &[(String, Vec<String>)], project: &str, named: Option<&str>) -> Result<String, String> {
    if let Some(named) = named {
        return match systems.iter().any(|(slug, _)| slug == named) {
            true => Ok(named.to_string()),
            false => Err(format!("no design system \"{named}\" in this workspace")),
        };
    }
    let built: Vec<&str> = systems
        .iter()
        .filter(|(_, sources)| sources.iter().any(|s| s == project))
        .map(|(slug, _)| slug.as_str())
        .collect();
    match built.as_slice() {
        [one] => Ok(one.to_string()),
        [] => Err("no design system is built from this project: make one with `/moonlet-design sync`, or pick one with --system".into()),
        several => Err(format!(
            "several design systems are built from this project: {}. Pick one with --system",
            several.join(", ")
        )),
    }
}

/// A `--viewport` such as `900x700`.
pub fn parse_viewport(v: &str) -> Result<(u32, u32), String> {
    let size = |n: &str| n.parse::<u32>().ok().filter(|n| *n > 0);
    v.split_once('x')
        .and_then(|(w, h)| Some((size(w)?, size(h)?)))
        .ok_or_else(|| format!("{v} is not a viewport such as 900x700"))
}

/// The card `card` names, relative to the folder `cwd` the command runs
/// in (or absolute), as a path in the design system at `system` (`/`
/// separated); `None` when it is not inside that system.
pub fn card_in_system(cwd: &Path, card: &str, system: &Path) -> Option<String> {
    use std::path::Component;
    if card.is_empty() {
        return None;
    }
    // `..` worked out by name, never by following links: the daemon reads
    // the card through handles inside the system anyway.
    let mut path = std::path::PathBuf::new();
    for c in cwd.join(card).components() {
        match c {
            Component::ParentDir => {
                path.pop();
            }
            Component::CurDir => {}
            other => path.push(other),
        }
    }
    let rel = path.strip_prefix(system).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn a_folder_of_a_design_system_names_its_workspace_and_system() {
        let root = PathBuf::from("/Users/alex/.moonlet/design");
        assert_eq!(
            locate(
                &root.join("w-1dev/systems/moonlet-desktop/components/buttons"),
                &root
            ),
            Some(Located {
                workspace: "w-1dev".into(),
                system: Some("moonlet-desktop".into()),
                design: None
            })
        );
        // A design's folder names its design (X65).
        assert_eq!(
            locate(&root.join("w-1dev/designs/settings-page/pages"), &root),
            Some(Located {
                workspace: "w-1dev".into(),
                system: None,
                design: Some("settings-page".into())
            })
        );
        assert_eq!(
            locate(&root.join("w-1dev"), &root),
            Some(Located {
                workspace: "w-1dev".into(),
                system: None,
                design: None
            })
        );
        assert_eq!(
            locate(Path::new("/Users/alex/code/storefront"), &root),
            None
        );
        assert_eq!(locate(&root, &root), None);
    }

    #[test]
    fn a_design_without_a_name_is_named_after_its_briefs_first_words() {
        assert_eq!(
            name_from_brief("Pricing table for three plans, monthly and yearly"),
            "Pricing table for three plans"
        );
        assert_eq!(
            name_from_brief("A settings page with General and Git sections"),
            "A settings page with General"
        );
        assert_eq!(name_from_brief("  Onboarding.\nThree steps"), "Onboarding");
        assert_eq!(name_from_brief(" , "), "Design");
    }

    #[test]
    fn an_agents_terminal_names_its_sessions_workspace() {
        let terminals = [(3, Some("s1".to_string())), (4, None)];
        let sessions = [("s1".to_string(), Some("w-1dev".to_string()))];
        assert_eq!(
            workspace_of_terminal(&terminals, &sessions, 3),
            Some("w-1dev".into())
        );
        assert_eq!(workspace_of_terminal(&terminals, &sessions, 4), None);
        assert_eq!(workspace_of_terminal(&terminals, &sessions, 9), None);
    }

    #[test]
    fn a_viewport_is_a_width_and_a_height() {
        assert_eq!(parse_viewport("900x700"), Ok((900, 700)));
        assert_eq!(parse_viewport("1440x900"), Ok((1440, 900)));
        for bad in ["900", "0x700", "900x", "x700", "900X700", "-1x700", "wide"] {
            assert_eq!(
                parse_viewport(bad),
                Err(format!("{bad} is not a viewport such as 900x700")),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_card_is_named_from_the_folder_the_command_runs_in() {
        let system = PathBuf::from("/Users/alex/.moonlet/design/w1/systems/storefront");
        let card = "components/buttons/button/button.html";
        assert_eq!(card_in_system(&system, card, &system), Some(card.into()));
        assert_eq!(
            card_in_system(
                &system.join("components/buttons/button"),
                "button.html",
                &system
            ),
            Some(card.into())
        );
        assert_eq!(
            card_in_system(
                &system.join("components/forms"),
                "../buttons/button/button.html",
                &system
            ),
            Some(card.into())
        );
        assert_eq!(
            card_in_system(
                Path::new("/tmp"),
                "/Users/alex/.moonlet/design/w1/systems/storefront/components/buttons/button/button.html",
                &system
            ),
            Some(card.into())
        );
        // Never one outside the system.
        for (cwd, outside) in [
            (
                system.clone(),
                "../other/components/buttons/button/button.html",
            ),
            (system.clone(), "/etc/hosts"),
            (system.join("components"), "../../storefront2/x.html"),
            (system.clone(), ""),
        ] {
            assert_eq!(card_in_system(&cwd, outside, &system), None, "{outside}");
        }
    }

    #[test]
    fn a_session_design_takes_the_design_system_built_from_its_project_or_asks_which() {
        let system = |slug: &str, sources: &[&str]| (slug.to_string(), sources.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        let one = [system("moonlet-desktop", &["/Users/alex/code/moonlet"]), system("storefront", &["/Users/alex/code/shop"])];
        assert_eq!(pick_system(&one, "/Users/alex/code/moonlet", None), Ok("moonlet-desktop".into()));
        let several = [
            system("moonlet-desktop", &["/Users/alex/code/moonlet"]),
            system("moonlet-mobile", &["/Users/alex/code/shop", "/Users/alex/code/moonlet"]),
        ];
        assert_eq!(
            pick_system(&several, "/Users/alex/code/moonlet", None),
            Err("several design systems are built from this project: moonlet-desktop, moonlet-mobile. Pick one with --system".into())
        );
        assert_eq!(pick_system(&several, "/Users/alex/code/moonlet", Some("moonlet-mobile")), Ok("moonlet-mobile".into()));
        assert_eq!(
            pick_system(&one, "/Users/alex/code/blog", None),
            Err("no design system is built from this project: make one with `/moonlet-design sync`, or pick one with --system".into())
        );
        assert_eq!(
            pick_system(&one, "/Users/alex/code/blog", Some("nope")),
            Err("no design system \"nope\" in this workspace".into())
        );
    }
}
