//! `moonlet artifact` (X114): which of a workspace's artifacts `ls` shows.

use moonlet_proto::types::ArtifactInfo;

/// The artifacts `ls` shows: of `kind` when given; while searching, those
/// whose name has the text, ignoring case, or that the daemon found by
/// their text (`found`).
pub fn shown(
    list: Vec<ArtifactInfo>,
    kind: Option<&str>,
    search: Option<&str>,
    found: Option<&[String]>,
) -> Vec<ArtifactInfo> {
    let query = search
        .map(|q| q.trim().to_lowercase())
        .filter(|q| !q.is_empty());
    list.into_iter()
        .filter(|a| kind.is_none_or(|k| a.kind == k))
        .filter(|a| match &query {
            Some(q) => {
                a.name.to_lowercase().contains(q) || found.is_some_and(|f| f.contains(&a.id))
            }
            None => true,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use moonlet_proto::types::ArtifactHome;

    fn art(id: &str, kind: &str, name: &str) -> ArtifactInfo {
        ArtifactInfo {
            id: id.into(),
            kind: kind.into(),
            name: name.into(),
            home: ArtifactHome::default(),
            updated_at: 0,
            version: None,
            used_by: vec![],
        }
    }

    #[test]
    fn ls_shows_the_kind_asked_for_and_what_a_search_finds() {
        let list = vec![
            art("plan:s1:search", "plan", "Add search"),
            art(
                "design:workspace:w1:settings-page",
                "design",
                "Settings page",
            ),
            art("plan:s2:refunds", "plan", "Refunds"),
        ];
        let ids = |v: Vec<ArtifactInfo>| v.into_iter().map(|a| a.id).collect::<Vec<_>>();
        assert_eq!(
            ids(shown(list.clone(), Some("plan"), None, None)),
            ["plan:s1:search", "plan:s2:refunds"]
        );
        assert_eq!(
            ids(shown(list.clone(), None, Some("SETTINGS"), Some(&[]))),
            ["design:workspace:w1:settings-page"]
        );
        // A plan the daemon found by its text, whatever its name.
        assert_eq!(
            ids(shown(
                list.clone(),
                Some("plan"),
                Some("idempotent"),
                Some(&["plan:s2:refunds".to_string()])
            )),
            ["plan:s2:refunds"]
        );
        assert_eq!(ids(shown(list, None, None, None)).len(), 3);
    }
}
