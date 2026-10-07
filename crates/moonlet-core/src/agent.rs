//! Agent state per session (A1).
//!
//! Sources in priority order: agent hooks (`moonlet hook …`), process exit,
//! terminal signals (OSC 9/777 notifications), then heuristics (bell,
//! output activity). A report from a lower-priority source is ignored while
//! a higher-priority one is fresh, so heuristics never fight hooks.

use std::time::{Duration, Instant};

use moonlet_proto::types::{AgentState, StateSource};

/// How long a report from a higher-priority source shadows lower ones.
const SHADOW: Duration = Duration::from_secs(20);

#[derive(Debug, Clone)]
pub struct AgentTracker {
    pub state: AgentState,
    pub message: Option<String>,
    source: Option<StateSource>,
    updated: Instant,
    /// True once any hook has reported for this session; activity
    /// heuristics are disabled from then on.
    pub hooks_seen: bool,
}

impl Default for AgentTracker {
    fn default() -> Self {
        Self {
            state: AgentState::Idle,
            message: None,
            source: None,
            updated: Instant::now(),
            hooks_seen: false,
        }
    }
}

impl AgentTracker {
    /// Applies a report. Returns true if the visible state or message changed.
    pub fn report(
        &mut self,
        state: AgentState,
        source: StateSource,
        message: Option<String>,
    ) -> bool {
        self.report_at(state, source, message, Instant::now())
    }

    pub fn report_at(
        &mut self,
        state: AgentState,
        source: StateSource,
        message: Option<String>,
        now: Instant,
    ) -> bool {
        if source == StateSource::Hook {
            self.hooks_seen = true;
        }
        if let Some(current) = self.source
            && source < current
            && now.duration_since(self.updated) < SHADOW
        {
            return false;
        }
        let changed = self.state != state || self.message != message;
        self.state = state;
        self.message = message;
        self.source = Some(source);
        self.updated = now;
        changed
    }

    /// Output arrived. Without hooks, activity means the agent is working.
    pub fn on_output(&mut self, now: Instant) -> bool {
        if self.hooks_seen || self.state == AgentState::Working {
            return false;
        }
        // Do not flip a fresh blocked/done back to working on a redraw.
        if matches!(
            self.state,
            AgentState::Blocked | AgentState::Done | AgentState::Error
        ) && now.duration_since(self.updated) < Duration::from_secs(3)
        {
            return false;
        }
        self.report_at(AgentState::Working, StateSource::Heuristic, None, now)
    }

    /// No output for a while. Without hooks, a quiet agent is idle.
    pub fn on_quiet(&mut self, now: Instant) -> bool {
        if self.hooks_seen || self.state != AgentState::Working {
            return false;
        }
        self.report_at(AgentState::Idle, StateSource::Heuristic, None, now)
    }
}

/// Guesses which agent a command line runs.
pub fn detect_agent(command: &str) -> Option<&'static str> {
    let first = command.split_whitespace().find(|w| !w.contains('='))?;
    let bin = first.rsplit('/').next().unwrap_or(first);
    match bin {
        "claude" => Some("claude"),
        "codex" => Some("codex"),
        _ => None,
    }
}

/// Whether a state should raise a notification.
pub fn needs_attention(state: AgentState) -> bool {
    matches!(
        state,
        AgentState::Blocked | AgentState::Done | AgentState::Error
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hooks_shadow_heuristics() {
        let t0 = Instant::now();
        let mut a = AgentTracker::default();
        assert!(a.report_at(
            AgentState::Blocked,
            StateSource::Hook,
            Some("approve".into()),
            t0
        ));
        assert!(!a.report_at(
            AgentState::Working,
            StateSource::Heuristic,
            None,
            t0 + Duration::from_secs(1)
        ));
        assert_eq!(a.state, AgentState::Blocked);
        assert!(
            !a.on_output(t0 + Duration::from_secs(60)),
            "activity ignored once hooks are seen"
        );
        assert!(a.report_at(
            AgentState::Working,
            StateSource::Hook,
            None,
            t0 + Duration::from_secs(2)
        ));
    }

    #[test]
    fn heuristics_without_hooks() {
        let t0 = Instant::now();
        let mut a = AgentTracker::default();
        assert!(a.on_output(t0));
        assert_eq!(a.state, AgentState::Working);
        assert!(a.on_quiet(t0 + Duration::from_secs(5)));
        assert_eq!(a.state, AgentState::Idle);
        assert!(a.report_at(
            AgentState::Blocked,
            StateSource::Terminal,
            None,
            t0 + Duration::from_secs(6)
        ));
        assert!(
            !a.on_output(t0 + Duration::from_secs(7)),
            "redraw right after a notification keeps blocked"
        );
    }

    #[test]
    fn lower_source_wins_after_shadow_expires() {
        let t0 = Instant::now();
        let mut a = AgentTracker::default();
        a.report_at(AgentState::Done, StateSource::Process, None, t0);
        assert!(a.report_at(
            AgentState::Blocked,
            StateSource::Terminal,
            None,
            t0 + SHADOW + Duration::from_secs(1)
        ));
    }

    #[test]
    fn detects_agents() {
        assert_eq!(detect_agent("claude --continue"), Some("claude"));
        assert_eq!(detect_agent("FOO=1 /usr/local/bin/codex"), Some("codex"));
        assert_eq!(detect_agent("zsh"), None);
    }
}
