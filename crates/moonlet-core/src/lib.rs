//! Core logic of `moonletd`: PTYs, terminal state, sessions, agent state,
//! repos and worktree workspaces, git and files.

pub mod agent;
pub mod chat;
pub mod client;
pub mod commands;
pub mod fs;
pub mod git;
pub mod history;
pub mod hooks;
pub mod node;
pub mod paths;
pub mod project_config;
pub mod pty;
pub mod session;
pub mod shell;
pub mod term;
pub mod terminal;
pub mod terminal_read;
