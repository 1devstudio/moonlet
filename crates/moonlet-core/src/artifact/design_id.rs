//! A design artifact's id (X114), from where the design lives:
//! `design:workspace:<workspace>:<slug>`, `design:library:<slug>`,
//! `design:session:<session>:<slug>` or `design:project:<project>:<slug>`.
//! The app builds the same ids (`designArtifactId` in `lib/artifacts.ts`).

/// Where a design lives, as its artifact id says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesignHome {
    Workspace(String),
    /// The library (X95): shared with every workspace.
    Library,
    Session(String),
    /// Merged into a project, read from it.
    Project(String),
}

/// The artifact id of design `slug` living in `home`.
pub fn design_id(home: &DesignHome, slug: &str) -> String {
    match home {
        DesignHome::Workspace(ws) => format!("design:workspace:{ws}:{slug}"),
        DesignHome::Library => format!("design:library:{slug}"),
        DesignHome::Session(s) => format!("design:session:{s}:{slug}"),
        DesignHome::Project(p) => format!("design:project:{p}:{slug}"),
    }
}

/// Where a design artifact id says its design lives, and its slug; none
/// for an id that is not a design's.
pub fn parse_design_id(id: &str) -> Option<(DesignHome, String)> {
    let parts: Vec<&str> = id.split(':').collect();
    let (home, slug) = match parts.as_slice() {
        ["design", "workspace", ws, slug] => (DesignHome::Workspace(ws.to_string()), slug),
        ["design", "library", slug] => (DesignHome::Library, slug),
        ["design", "session", s, slug] => (DesignHome::Session(s.to_string()), slug),
        ["design", "project", p, slug] => (DesignHome::Project(p.to_string()), slug),
        _ => return None,
    };
    (!slug.is_empty()).then(|| (home, slug.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_design_id_names_where_the_design_lives_and_reads_back() {
        let cases = [
            (
                DesignHome::Workspace("a1b2c3d4e5f6".into()),
                "design:workspace:a1b2c3d4e5f6:settings-page",
            ),
            (DesignHome::Library, "design:library:settings-page"),
            (
                DesignHome::Session("0f9e8d7c6b5a".into()),
                "design:session:0f9e8d7c6b5a:settings-page",
            ),
            (
                DesignHome::Project("p1".into()),
                "design:project:p1:settings-page",
            ),
        ];
        for (home, id) in cases {
            assert_eq!(design_id(&home, "settings-page"), id);
            assert_eq!(
                parse_design_id(id),
                Some((home, "settings-page".to_string()))
            );
        }
        assert_eq!(parse_design_id("plan:a1b2c3d4e5f6:search-plan"), None);
        assert_eq!(parse_design_id("design:library:"), None);
        assert_eq!(parse_design_id("design:workspace:a1b2c3d4e5f6"), None);
    }
}
