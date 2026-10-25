//! Decisions behind `moonlet design` (X64), kept apart from the socket so
//! they can be tested on plain data.

use std::path::Path;

use moonlet_proto::TerminalId;

/// The workspace, and the design system when there is one, that a folder
/// under `~/.moonlet/design` belongs to: the sync agent works in its system's
/// folder, so its commands need no arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub workspace: String,
    pub system: Option<String>,
}

pub fn locate(cwd: &Path, design_root: &Path) -> Option<Located> {
    let mut parts = cwd
        .strip_prefix(design_root)
        .ok()?
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned());
    let workspace = parts.next()?;
    let system = match parts.next().as_deref() {
        Some("systems") => parts.next(),
        _ => None,
    };
    Some(Located { workspace, system })
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
                system: Some("moonlet-desktop".into())
            })
        );
        assert_eq!(
            locate(&root.join("w-1dev/designs/settings-page"), &root),
            Some(Located {
                workspace: "w-1dev".into(),
                system: None
            })
        );
        assert_eq!(
            locate(Path::new("/Users/alex/code/storefront"), &root),
            None
        );
        assert_eq!(locate(&root, &root), None);
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
}
