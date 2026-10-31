//! Core logic of `moonletd`: PTYs, terminal state, sessions, agent state,
//! repos and worktree workspaces, git and files.

pub mod account;
pub mod agent;
pub mod bundle;
pub mod chat;
pub mod claude_update;
pub mod client;
pub mod commands;
pub mod design;
pub mod fs;
pub mod gh_issues;
pub mod gh_projects;
pub mod git;
pub mod git_settings;
pub mod hash;
pub mod heavy;
pub mod history;
pub mod hooks;
pub mod identity;
pub mod job_summary;
pub mod node;
pub mod paths;
pub mod profiles;
pub mod repo_clone;
pub mod project_config;
pub mod pty;
pub mod session;
pub mod shell;
pub mod tasks;
pub mod ssh;
pub mod sync;
pub mod tailnet;
pub mod term;
pub mod terminal;
pub mod terminal_read;
pub mod transcript;
