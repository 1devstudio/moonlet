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
}
