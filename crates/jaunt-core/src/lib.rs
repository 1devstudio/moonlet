//! Core logic of `jauntd`: PTYs, terminal state, sessions, agent state,
//! repos and worktree workspaces, git and files.

pub mod agent;
pub mod client;
pub mod paths;
pub mod pty;
pub mod session;
pub mod term;
