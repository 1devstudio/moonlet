//! `moonlet ps` and `moonlet kill` (X83): a session's processes as a table,
//! and what stopping them did.

use moonlet_proto::methods::{ProcessOrigin, ProcessesKilled, SessionProcess, SessionProcesses};

/// The table `moonlet ps` prints, ages taken at `now` (milliseconds since
/// the epoch): pid, name, origin, age, CPU time and memory, then the
/// leftovers under their own heading.
pub fn table(list: &SessionProcesses, now: u64) -> String {
    if list.processes.is_empty() && list.leftovers.is_empty() {
        return "Nothing runs in this session.\n".into();
    }
    let all = || list.processes.iter().chain(&list.leftovers);
    let width = all().map(|p| origin(p).chars().count()).max().unwrap_or(0).max("ORIGIN".len());
    let line = |pid: &str, name: &str, origin: &str, age: &str, cpu: &str, mem: &str| {
        format!("{pid:>7}  {name:<16}  {origin:<width$}  {age:>5}  {cpu:>8}  {mem:>9}\n")
    };
    let row = |p: &SessionProcess| {
        let dash = || "-".to_string();
        let age = p.started.map(|s| age(now.saturating_sub(s) / 1000)).unwrap_or_else(dash);
        let cpu = p.cpu_ms.map(cpu).unwrap_or_else(dash);
        let mem = p.rss.map(memory).unwrap_or_else(dash);
        line(&p.pid.to_string(), &p.name, &origin(p), &age, &cpu, &mem)
    };
    let mut out = line("PID", "NAME", "ORIGIN", "AGE", "CPU", "MEMORY");
    for p in &list.processes {
        out.push_str(&row(p));
    }
    if !list.leftovers.is_empty() {
        out.push_str("\nLeft in the worktree, stopped only by pid:\n");
        for p in &list.leftovers {
            out.push_str(&row(p));
        }
    }
    out
}

/// What a process belongs to, as `moonlet ps` says it.
fn origin(p: &SessionProcess) -> String {
    let mut origin = match &p.origin {
        ProcessOrigin::Terminal { id, title } => format!("terminal {id} ({title})"),
        ProcessOrigin::Run { id, title } => format!("run {id} ({title})"),
        ProcessOrigin::Agent { id, title } => format!("agent {id} ({title})"),
        ProcessOrigin::Leftover { parent } => parent.clone(),
    };
    if p.tab {
        origin.push_str(", the tab's own");
    }
    origin
}

/// "42s", "45m", "2h", "6d": the largest whole unit.
fn age(secs: u64) -> String {
    match secs {
        s if s < 60 => format!("{s}s"),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h", s / 3600),
        s => format!("{}d", s / 86_400),
    }
}

/// "8.0s", "1m12s", "3h05m".
fn cpu(ms: u64) -> String {
    let s = ms / 1000;
    match ms {
        ms if ms < 60_000 => format!("{:.1}s", ms as f64 / 1000.0),
        ms if ms < 3_600_000 => format!("{}m{:02}s", s / 60, s % 60),
        _ => format!("{}h{:02}m", s / 3600, s / 60 % 60),
    }
}

/// "900 KB", "210.0 MB", "3.0 GB".
fn memory(bytes: u64) -> String {
    const MB: u64 = 1 << 20;
    match bytes {
        b if b < MB => format!("{} KB", b >> 10),
        b if b < MB << 10 => format!("{:.1} MB", b as f64 / MB as f64),
        b => format!("{:.1} GB", b as f64 / (MB << 10) as f64),
    }
}

/// What `moonlet kill` prints for the processes it stopped.
pub fn stopped(killed: &ProcessesKilled) -> String {
    if killed.ended.is_empty() {
        return "nothing to stop\n".into();
    }
    killed
        .ended
        .iter()
        .map(|pid| format!("stopped {pid}\n"))
        .collect()
}

/// What `moonlet kill` fails with for the pids it did not stop: those that
/// run but are not the session's, those that had ended, and those that
/// outlived SIGKILL; `None` when it stopped every one.
pub fn not_stopped(killed: &ProcessesKilled) -> Option<String> {
    let list = |pids: &[u32]| pids.iter().map(u32::to_string).collect::<Vec<_>>().join(" ");
    let mut parts = Vec::new();
    if !killed.skipped.is_empty() {
        parts.push(format!("not processes of this session: {}", list(&killed.skipped)));
    }
    if !killed.gone.is_empty() {
        parts.push(format!("already ended: {}", list(&killed.gone)));
    }
    if !killed.still_running.is_empty() {
        parts.push(format!("still running after SIGKILL: {}", list(&killed.still_running)));
    }
    (!parts.is_empty()).then(|| parts.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_793_700_000_000;

    fn process(
        pid: u32,
        name: &str,
        origin: ProcessOrigin,
        tab: bool,
        age_s: u64,
        cpu_ms: u64,
        rss: u64,
    ) -> SessionProcess {
        SessionProcess {
            pid,
            name: name.into(),
            origin,
            tab,
            started: Some(NOW - age_s * 1000),
            cpu_ms: Some(cpu_ms),
            rss: Some(rss),
        }
    }

    #[test]
    fn ps_prints_name_pid_origin_age_cpu_and_memory_never_arguments() {
        let dev = ProcessOrigin::Terminal {
            id: 2,
            title: "dev".into(),
        };
        let claude = ProcessOrigin::Agent {
            id: 3,
            title: "claude".into(),
        };
        let list = SessionProcesses {
            processes: vec![
                process(4100, "zsh", dev.clone(), true, 3 * 86_400, 1_200, 4 << 20),
                process(4242, "vite", dev, false, 2 * 3600 + 60, 72_500, 210 << 20),
                process(
                    4300,
                    "claude",
                    claude.clone(),
                    true,
                    45 * 60,
                    8_000,
                    380 << 20,
                ),
                process(4310, "tail", claude, false, 42, 0, 900 << 10),
                SessionProcess {
                    pid: 4320,
                    name: "?".into(),
                    origin: ProcessOrigin::Run {
                        id: 5,
                        title: "test".into(),
                    },
                    tab: false,
                    started: None,
                    cpu_ms: None,
                    rss: None,
                },
            ],
            // On a Linux host, left to init.
            leftovers: vec![process(
                5151,
                "node",
                ProcessOrigin::Leftover {
                    parent: "init".into(),
                },
                false,
                6 * 86_400,
                3 * 3600 * 1000 + 5 * 60_000,
                3 << 30,
            )],
        };
        assert_eq!(
            table(&list, NOW),
            "    PID  NAME              ORIGIN                             AGE       CPU     MEMORY
   4100  zsh               terminal 2 (dev), the tab's own     3d      1.2s     4.0 MB
   4242  vite              terminal 2 (dev)                    2h     1m12s   210.0 MB
   4300  claude            agent 3 (claude), the tab's own    45m      8.0s   380.0 MB
   4310  tail              agent 3 (claude)                   42s      0.0s     900 KB
   4320  ?                 run 5 (test)                         -         -          -

Left in the worktree, stopped only by pid:
   5151  node              init                                6d     3h05m     3.0 GB
"
        );
        assert_eq!(
            table(&SessionProcesses::default(), NOW),
            "Nothing runs in this session.\n"
        );
    }

    #[test]
    fn kill_says_which_pids_it_stopped() {
        assert_eq!(
            stopped(&ProcessesKilled {
                ended: vec![4242, 5151],
                ..ProcessesKilled::default()
            }),
            "stopped 4242\nstopped 5151\n"
        );
        assert_eq!(stopped(&ProcessesKilled::default()), "nothing to stop\n");
    }

    #[test]
    fn kill_fails_naming_pids_not_the_sessions_apart_from_those_already_ended() {
        let killed = |skipped: Vec<u32>, gone: Vec<u32>| ProcessesKilled {
            ended: vec![4242],
            skipped,
            gone,
            ..ProcessesKilled::default()
        };
        assert_eq!(
            not_stopped(&killed(vec![999, 1000], vec![5151])).as_deref(),
            Some("not processes of this session: 999 1000; already ended: 5151")
        );
        assert_eq!(
            not_stopped(&killed(vec![], vec![5151])).as_deref(),
            Some("already ended: 5151")
        );
        assert_eq!(
            not_stopped(&killed(vec![999], vec![])).as_deref(),
            Some("not processes of this session: 999")
        );
        assert_eq!(not_stopped(&killed(vec![], vec![])), None);
    }

    #[test]
    fn kill_fails_naming_pids_that_still_run_after_their_stop() {
        let killed = ProcessesKilled {
            ended: vec![4242],
            still_running: vec![4250],
            ..ProcessesKilled::default()
        };
        assert_eq!(stopped(&killed), "stopped 4242\n");
        assert_eq!(
            not_stopped(&killed).as_deref(),
            Some("still running after SIGKILL: 4250")
        );
    }
}
