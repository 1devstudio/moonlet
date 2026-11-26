//! Artifacts (X114): plans and designs any session can refer to.
//!
//! This module keeps **plan artifacts**: every `ExitPlanMode` plan a
//! session's chat proposes, as versions of that chat's plan, in
//! `~/.moonlet/artifacts/plans/<session id>/<key>/`. Designs stay where the
//! design store keeps them.

pub mod plans;

pub use plans::{Plan, Plans, Proposal, Version, VersionState, display_name, parse_id, plan_key, snippet};
