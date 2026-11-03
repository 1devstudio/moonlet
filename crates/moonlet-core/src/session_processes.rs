//! A session's processes (X83): what its terminals and agents run, and what
//! was left working in its worktree, named by their executables and stopped
//! on request. Never their arguments, which can hold tokens.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use moonlet_proto::TerminalId;
use moonlet_proto::methods::{ProcessOrigin, ProcessRef, SessionProcess, SessionProcesses};

use crate::process::Proc;

/// A terminal tab of a session: its shell leads the tab's session.
#[derive(Debug, Clone)]
pub struct Tab {
    pub id: TerminalId,
    pub title: String,
    pub leader: u32,
    /// Its shell exited, and was reaped: its pid may be another process's.
    pub exited: bool,
    /// A Run tab: it runs one of the session's scripts.
    pub run: bool,
}

/// A chat agent of a session: its process while it runs, and what it
/// started, as pid and start time (X79).
#[derive(Debug, Clone)]
pub struct Agent {
    pub id: TerminalId,
    pub title: String,
    pub pid: Option<u32>,
    pub family: Vec<(u32, u64)>,
}

/// A process found to be a session's, not yet described.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub proc: Proc,
    pub origin: ProcessOrigin,
    /// The tab's own: its shell, or the chat's agent.
    pub tab: bool,
}

/// The processes of `table` that belong to the session of `tabs` and
/// `agents`: every process in a tab's session (`session_of` says which a
/// process is in), each agent and what it started that still runs with the
/// same start. Tabs first, in the order given, then agents; each one's by
/// start time.
pub fn belonging(
    table: &[Proc],
    session_of: impl Fn(u32) -> Option<u32>,
    tabs: &[Tab],
    agents: &[Agent],
) -> Vec<Found> {
    let mut out: Vec<Found> = Vec::new();
    let add = |mut found: Vec<Found>, out: &mut Vec<Found>| {
        found.sort_by_key(|f| (!f.tab, f.proc.start, f.proc.pid));
        for f in found {
            if !out.iter().any(|o| o.proc.pid == f.proc.pid) {
                out.push(f);
            }
        }
    };
    // Each process's session, asked of the kernel once.
    let sessions: HashMap<u32, u32> = table
        .iter()
        .filter_map(|p| Some((p.pid, session_of(p.pid)?)))
        .collect();
    let sid = |pid: u32| sessions.get(&pid).copied();
    let by_pid: HashMap<u32, &Proc> = table.iter().map(|p| (p.pid, p)).collect();
    for t in tabs {
        // A reaped shell's pid that now leads a session leads someone else's (X79).
        if t.exited && sid(t.leader) == Some(t.leader) {
            continue;
        }
        let (id, title) = (t.id, t.title.clone());
        let origin = if t.run {
            ProcessOrigin::Run { id, title }
        } else {
            ProcessOrigin::Terminal { id, title }
        };
        let found = table
            .iter()
            .filter(|p| sid(p.pid) == Some(t.leader))
            .map(|p| Found {
                proc: *p,
                origin: origin.clone(),
                tab: p.pid == t.leader && !t.exited,
            })
            .collect();
        add(found, &mut out);
    }
    for a in agents {
        let origin = ProcessOrigin::Agent {
            id: a.id,
            title: a.title.clone(),
        };
        let own = a
            .pid
            .and_then(|pid| by_pid.get(&pid).copied())
            .map(|p| Found {
                proc: *p,
                origin: origin.clone(),
                tab: true,
            });
        let started = a
            .family
            .iter()
            .filter_map(|&(pid, start)| by_pid.get(&pid).copied().filter(|p| p.start == start));
        let found = own
            .into_iter()
            .chain(started.map(|p| Found {
                proc: *p,
                origin: origin.clone(),
                tab: false,
            }))
            .collect();
        add(found, &mut out);
    }
    out
}

/// The processes of `table` left working in `worktree`: launchd's (init's)
/// children whose working directory (`cwd_of`) is the worktree or inside it,
/// other than those `taken` and `skip` (this daemon), by start time.
pub fn leftovers(
    table: &[Proc],
    taken: &[Found],
    worktree: &Path,
    cwd_of: impl Fn(u32) -> Option<PathBuf>,
    skip: u32,
) -> Vec<Proc> {
    let mut out: Vec<Proc> = table
        .iter()
        .filter(|p| {
            p.ppid == 1 && p.pid != skip && p.pid > 1 && !taken.iter().any(|f| f.proc.pid == p.pid)
        })
        .filter(|p| cwd_of(p.pid).is_some_and(|c| c.starts_with(worktree)))
        .copied()
        .collect();
    out.sort_by_key(|p| (p.start, p.pid));
    out
}

/// What stopping some pids of a session does, before any is signalled.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Stopping {
    /// The processes to end, as pid and start time.
    pub targets: Vec<(u32, u64)>,
    /// Named pids of processes that run but are neither the session's nor
    /// left in its worktree.
    pub skipped: Vec<u32>,
    /// Named pids no process runs with any more, or whose listed process has
    /// ended and left its pid to another.
    pub gone: Vec<u32>,
}

/// What to stop of `found` and `leftovers`. No `pids`: every found process
/// but the tabs' own, never a leftover. An empty `pids` stops nothing; a
/// tab's own process is stopped when named. A pid named with the start it
/// was listed with (`started_ms` says a process's) is gone once its start
/// differs. A pid that is neither is skipped while a process `runs` with it,
/// readable by this user or not, and gone otherwise.
pub fn to_stop(
    found: &[Found],
    leftovers: &[Proc],
    pids: Option<&[ProcessRef]>,
    started_ms: impl Fn(u64) -> Option<u64>,
    runs: impl Fn(u32) -> bool,
) -> Stopping {
    let Some(pids) = pids else {
        return Stopping {
            targets: found
                .iter()
                .filter(|f| !f.tab)
                .map(|f| (f.proc.pid, f.proc.start))
                .collect(),
            ..Stopping::default()
        };
    };
    let mut out = Stopping::default();
    for &named in pids {
        let (pid, started) = match named {
            ProcessRef::Pid(pid) => (pid, None),
            ProcessRef::Listed { pid, started } => (pid, Some(started)),
        };
        match found
            .iter()
            .map(|f| &f.proc)
            .chain(leftovers)
            .find(|p| p.pid == pid)
        {
            Some(p) if started.is_some() && started_ms(p.start) != started => out.gone.push(pid),
            Some(p) if !out.targets.contains(&(p.pid, p.start)) => {
                out.targets.push((p.pid, p.start))
            }
            Some(_) => {}
            None if runs(pid) => out.skipped.push(pid),
            None => out.gone.push(pid),
        }
    }
    out
}

/// Ends `targets` (pid and start time): SIGTERM, then SIGKILL after
/// [`crate::process::TERM_GRACE`] to those still running. A pid whose start
/// time is no longer the one given is another process's, and is left alone.
/// Returns once the signalled ones are gone, or SIGKILL could not end them.
pub async fn end(targets: Vec<(u32, u64)>) -> Ending {
    let (live, gone): (Vec<_>, Vec<_>) = targets
        .into_iter()
        .partition(|&(pid, start)| crate::pty::process_start(pid) == Some(start));
    crate::process::Doomed {
        group: None,
        family: crate::process::Family::of(live.clone()),
    }
    .end()
    .await;
    Ending {
        gone: gone.into_iter().map(|t| t.0).collect(),
        ..after_ending(&live, crate::pty::process_start)
    }
}

/// What ending some processes did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Ending {
    /// Signalled, and no longer running.
    pub ended: Vec<u32>,
    /// Ended, or their pid another process's, before they were signalled.
    pub gone: Vec<u32>,
    /// Signalled, and still running: not this user's to signal, say.
    pub still_running: Vec<u32>,
}

/// Sorts the `signalled` processes (pid and start time) by whether they
/// still run with the same start, as `start_of` says now.
pub fn after_ending(signalled: &[(u32, u64)], start_of: impl Fn(u32) -> Option<u64>) -> Ending {
    let mut out = Ending::default();
    for &(pid, start) in signalled {
        if start_of(pid) == Some(start) {
            out.still_running.push(pid);
        } else {
            out.ended.push(pid);
        }
    }
    out
}

/// Describes each found process and leftover from what the kernel says now.
pub fn describe(found: &[Found], leftovers: &[Proc]) -> SessionProcesses {
    let one = |p: &Proc, origin: ProcessOrigin, tab: bool| {
        let usage = crate::process::usage(p.pid);
        SessionProcess {
            pid: p.pid,
            name: crate::process::name(p.pid)
                .or_else(|| crate::process::kernel_name(p.pid))
                .unwrap_or_else(|| "?".into()),
            origin,
            tab,
            started: crate::process::started_ms(p.start),
            cpu_ms: usage.map(|u| u.cpu_ms),
            rss: usage.map(|u| u.rss),
        }
    };
    SessionProcesses {
        processes: found
            .iter()
            .map(|f| one(&f.proc, f.origin.clone(), f.tab))
            .collect(),
        leftovers: leftovers
            .iter()
            .map(|p| {
                let parent = if cfg!(target_os = "macos") { "launchd" } else { "init" };
                one(p, ProcessOrigin::Leftover { parent: parent.into() }, false)
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn p(pid: u32, ppid: u32, start: u64) -> Proc {
        Proc { pid, ppid, start }
    }

    fn pids(found: &[Found]) -> Vec<(u32, bool)> {
        found.iter().map(|f| (f.proc.pid, f.tab)).collect()
    }

    #[test]
    fn a_sessions_processes_are_its_tabs_sessions_and_its_agents_families() {
        // Tab 1's zsh (100) runs vite (101) and, in a group of its own, tail
        // (102, started first); another session's shell (200) is not the
        // session's. Tab 2's shell exited and its pid now leads a new session
        // (400). Run tab 3's shell exited too, leaving a job (501). Chat 7's agent
        // (300) started a server (301); 302 has ended and 303's pid is reused.
        let table = [
            p(100, 50, 10),
            p(101, 100, 12),
            p(102, 1, 11),
            p(200, 1, 13),
            p(400, 1, 40),
            p(501, 1, 50),
            p(300, 50, 30),
            p(301, 1, 31),
            p(303, 1, 99),
        ];
        let session_of = |pid| {
            Some(match pid {
                101 | 102 => 100,
                501 => 500,
                301 => 301,
                other => other,
            })
        };
        let tabs = [
            Tab {
                id: 1,
                title: "zsh".into(),
                leader: 100,
                exited: false,
                run: false,
            },
            Tab {
                id: 2,
                title: "old".into(),
                leader: 400,
                exited: true,
                run: false,
            },
            Tab {
                id: 3,
                title: "dev".into(),
                leader: 500,
                exited: true,
                run: true,
            },
        ];
        let agents = [Agent {
            id: 7,
            title: "Claude".into(),
            pid: Some(300),
            family: vec![(301, 31), (302, 32), (303, 33)],
        }];
        let found = belonging(&table, session_of, &tabs, &agents);
        assert_eq!(
            pids(&found),
            [
                (100, true),
                (102, false),
                (101, false),
                (501, false),
                (300, true),
                (301, false)
            ]
        );
        assert_eq!(
            found[0].origin,
            ProcessOrigin::Terminal {
                id: 1,
                title: "zsh".into()
            }
        );
        assert_eq!(
            found[3].origin,
            ProcessOrigin::Run {
                id: 3,
                title: "dev".into()
            }
        );
        assert_eq!(
            found[5].origin,
            ProcessOrigin::Agent {
                id: 7,
                title: "Claude".into()
            }
        );
    }

    #[test]
    fn leftovers_are_launchd_children_working_in_the_worktree() {
        let table = [
            p(600, 1, 60),
            p(601, 1, 61),
            p(602, 1, 59),
            p(603, 5, 63),
            p(101, 1, 12),
            p(604, 1, 64),
            p(50, 1, 5),
        ];
        let cwd = |pid| {
            Some(PathBuf::from(match pid {
                600 => "/w/s1/web",
                601 => "/w/s10",
                602 | 603 | 101 | 50 => "/w/s1",
                _ => return None,
            }))
        };
        let taken = [Found {
            proc: p(101, 1, 12),
            origin: ProcessOrigin::Terminal {
                id: 1,
                title: "zsh".into(),
            },
            tab: false,
        }];
        let left: Vec<u32> = leftovers(&table, &taken, Path::new("/w/s1"), cwd, 50)
            .iter()
            .map(|p| p.pid)
            .collect();
        assert_eq!(left, [602, 600]);
    }

    fn listed() -> (Vec<Found>, Vec<Proc>) {
        let term = ProcessOrigin::Terminal {
            id: 1,
            title: "zsh".into(),
        };
        let found = vec![
            Found {
                proc: p(100, 50, 10),
                origin: term.clone(),
                tab: true,
            },
            Found {
                proc: p(101, 100, 12),
                origin: term,
                tab: false,
            },
            Found {
                proc: p(300, 50, 30),
                origin: ProcessOrigin::Agent {
                    id: 7,
                    title: "Claude".into(),
                },
                tab: true,
            },
            Found {
                proc: p(301, 1, 31),
                origin: ProcessOrigin::Agent {
                    id: 7,
                    title: "Claude".into(),
                },
                tab: false,
            },
        ];
        (found, vec![p(600, 1, 60)])
    }

    #[test]
    fn stopping_all_spares_the_tabs_own_processes_and_leftovers() {
        let (found, left) = listed();
        assert_eq!(
            to_stop(&found, &left, None, Some, runs),
            Stopping {
                targets: vec![(101, 12), (301, 31)],
                ..Stopping::default()
            }
        );
    }

    /// Whether a process runs with `pid`: no process has 998; 999 is another
    /// session's shell, and 1 is launchd, which this user may not read.
    fn runs(pid: u32) -> bool {
        pid != 998
    }

    fn plain(pids: &[u32]) -> Vec<ProcessRef> {
        pids.iter().map(|&pid| ProcessRef::Pid(pid)).collect()
    }

    #[test]
    fn stopping_by_pid_skips_pids_that_are_not_the_sessions() {
        let (found, left) = listed();
        assert_eq!(
            to_stop(
                &found,
                &left,
                Some(&plain(&[101, 600, 999, 100, 101, 998, 1])),
                Some,
                runs
            ),
            Stopping {
                targets: vec![(101, 12), (600, 60), (100, 10)],
                skipped: vec![999, 1],
                gone: vec![998],
            }
        );
        assert_eq!(
            to_stop(&found, &left, Some(&[]), Some, runs),
            Stopping::default(),
            "an empty list stops nothing"
        );
    }

    #[test]
    fn stopping_a_pid_listed_with_another_start_leaves_it_alone() {
        let (found, left) = listed();
        // Each start is shown as is: vite started at 12, the leftover at 60.
        let named = [
            ProcessRef::Listed {
                pid: 101,
                started: 12,
            },
            ProcessRef::Listed {
                pid: 600,
                started: 59,
            },
            ProcessRef::Pid(301),
            // A row listed before pid 100 went to the tab's new shell.
            ProcessRef::Listed {
                pid: 100,
                started: 7,
            },
        ];
        assert_eq!(
            to_stop(&found, &left, Some(&named), Some, runs),
            Stopping {
                targets: vec![(101, 12), (301, 31)],
                skipped: vec![],
                gone: vec![600, 100],
            }
        );
    }

    /// A `sleep` left to launchd, as a leftover is: its pid.
    fn orphan_sleep() -> u32 {
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", "/bin/sleep 30 >/dev/null 2>&1 & echo $!"])
            .output()
            .unwrap();
        String::from_utf8(out.stdout)
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    #[tokio::test]
    async fn ending_skips_a_pid_whose_start_changed() {
        let pid = orphan_sleep();
        let start = crate::pty::process_start(pid).unwrap();
        assert_eq!(
            end(vec![(pid, start + 1)]).await,
            Ending {
                gone: vec![pid],
                ..Ending::default()
            }
        );
        assert_eq!(
            crate::pty::process_start(pid),
            Some(start),
            "a pid listed with another start was signalled"
        );
        assert_eq!(
            end(vec![(pid, start)]).await,
            Ending {
                ended: vec![pid],
                ..Ending::default()
            }
        );
        assert_eq!(
            crate::pty::process_start(pid),
            None,
            "the sleep outlived its ending"
        );
    }

    #[test]
    fn a_process_still_running_after_its_ending_is_not_reported_ended() {
        // 4242 could not be signalled and runs on; 4250 is gone; 4310's pid
        // is another process's now, so the one signalled ended.
        let now = |pid| match pid {
            4242 => Some(12),
            4310 => Some(99),
            _ => None,
        };
        assert_eq!(
            after_ending(&[(4242, 12), (4250, 13), (4310, 14)], now),
            Ending {
                ended: vec![4250, 4310],
                still_running: vec![4242],
                ..Ending::default()
            }
        );
    }
}
