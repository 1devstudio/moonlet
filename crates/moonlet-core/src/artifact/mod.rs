//! Artifacts (X114): plans and designs any session can refer to.
//!
//! This module keeps **plan artifacts**: every `ExitPlanMode` plan a
//! session's chat proposes, as versions of that chat's plan, in
//! `~/.moonlet/artifacts/plans/<session id>/<key>/`. Designs stay where the
//! design store keeps them.

pub mod design_id;
pub mod plans;
pub mod refs;

pub use design_id::{DesignHome, design_id, parse_design_id};

pub use plans::{Plan, Plans, Proposal, Version, VersionState, display_name, parse_id, plan_key, snippet};

/// A name safe as one path component of the artifacts folder: letters,
/// digits, `.`, `_` and `-`, not starting with a dot, at most 160 bytes.
pub(crate) fn safe_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 160
        && !s.starts_with('.')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}
