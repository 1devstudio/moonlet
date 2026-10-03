//! Core logic of `jauntd`: PTYs, terminal state, sessions, agent state,
//! repos and worktree workspaces, git and files.

pub mod agent;
pub mod client;
pub mod fs;
pub mod git;
pub mod history;
pub mod hooks;
pub mod paths;
pub mod pty;
pub mod session;
pub mod shell;
pub mod term;
pub mod terminal;
