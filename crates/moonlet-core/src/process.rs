//! What the kernel says about another process (X75): the executable it runs
//! and its parent, never what the process claims about itself.

use std::path::PathBuf;

/// The executable process `pid` runs; `None` when there is no such process
/// or this one may not see it.
pub fn executable(pid: u32) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStringExt;
        let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: proc_pidpath writes at most `buf.len()` bytes into `buf`
        // and returns how many it wrote.
        let n = unsafe { libc::proc_pidpath(pid as i32, buf.as_mut_ptr().cast(), buf.len() as u32) };
        if n <= 0 {
            return None;
        }
        buf.truncate(n as usize);
        Some(PathBuf::from(std::ffi::OsString::from_vec(buf)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        // An executable deleted or replaced since the process started reads
        // as "<path> (deleted)", which names no file: never another one.
        std::fs::read_link(format!("/proc/{pid}/exe")).ok()
    }
}

/// The file name of the executable process `pid` runs, from
/// [`executable`]: `None` when the kernel does not say, as on Linux for a
/// process that hides its executable.
pub fn name(pid: u32) -> Option<String> {
    let exe = executable(pid)?;
    exe.file_name().map(|n| n.to_string_lossy().into_owned())
}

/// Whether a process runs with `pid`, one this user may signal or not, such
/// as launchd (X83). Never signals it.
pub fn runs(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    match nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None) {
        Ok(()) => true,
        Err(e) => e == nix::errno::Errno::EPERM,
    }
}

/// The parent of process `pid`.
pub fn parent(pid: u32) -> Option<u32> {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: proc_pidinfo writes at most `size` bytes into `info`.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let n = unsafe {
            libc::proc_pidinfo(
                pid as i32,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        (n == size).then_some(info.pbi_ppid)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // The field after the state, counted after the command name, which
        // may hold spaces.
        stat[stat.rfind(')')? + 2..].split(' ').nth(1)?.parse().ok()
    }
}

/// Whether process `pid` runs as root: its real and effective uid both 0,
/// as the kernel says (Linux, `/proc/<pid>/status`; `Some(false)` when that
/// cannot be read). `None` on macOS, where it is not read.
pub fn runs_as_root(pid: u32) -> Option<bool> {
    #[cfg(target_os = "linux")]
    {
        Some(std::fs::read_to_string(format!("/proc/{pid}/status")).is_ok_and(|s| root_in_status(&s)))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

/// The name the kernel keeps for process `pid`: on Linux its `comm`, the
/// file name it was started as (up to 15 bytes), which the kernel shows even
/// for a process whose executable it hides, such as root's. `None` on
/// macOS, where [`executable`] says more.
pub fn kernel_name(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
        Some(comm.strip_suffix('\n').unwrap_or(&comm).to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

/// Whether a `/proc/<pid>/status` text names root as both the real and
/// the effective uid (its `Uid:` line: real, effective, saved, fs).
pub fn root_in_status(status: &str) -> bool {
    let Some(line) = status.lines().find_map(|l| l.strip_prefix("Uid:")) else {
        return false;
    };
    let mut ids = line.split_whitespace().map(|v| v.parse::<u32>().ok());
    matches!((ids.next(), ids.next()), (Some(Some(0)), Some(Some(0))))
}

/// The working directory of process `pid` (X83); `None` when the kernel does
/// not say, as for another user's process.
pub fn cwd(pid: u32) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStringExt;
        // SAFETY: proc_pidinfo writes at most `size` bytes into `info`.
        let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as i32;
        let n = unsafe { libc::proc_pidinfo(pid as i32, libc::PROC_PIDVNODEPATHINFO, 0, (&mut info as *mut libc::proc_vnodepathinfo).cast(), size) };
        if n != size {
            return None;
        }
        // A NUL-terminated path, kept as 32 rows of 32 bytes.
        let bytes: Vec<u8> = info.pvi_cdir.vip_path.iter().flatten().map(|&c| c as u8).take_while(|&b| b != 0).collect();
        (!bytes.is_empty()).then(|| PathBuf::from(std::ffi::OsString::from_vec(bytes)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
    }
}

/// What process `pid` used so far, as the kernel counts it (X83).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    /// CPU time, user and system, in milliseconds.
    pub cpu_ms: u64,
    /// Resident memory, in bytes.
    pub rss: u64,
}

/// The CPU time and memory process `pid` uses; `None` when the kernel does not say.
pub fn usage(pid: u32) -> Option<Usage> {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: proc_pidinfo writes at most `size` bytes into `info`.
        let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_taskinfo>() as i32;
        let n = unsafe { libc::proc_pidinfo(pid as i32, libc::PROC_PIDTASKINFO, 0, (&mut info as *mut libc::proc_taskinfo).cast(), size) };
        if n != size {
            return None;
        }
        let (numer, denom) = timebase();
        let ns = (info.pti_total_user as u128 + info.pti_total_system as u128) * numer / denom;
        Some(Usage { cpu_ms: (ns / 1_000_000) as u64, rss: info.pti_resident_size })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // Counted after the command name, which may hold spaces: utime and
        // stime are fields 14 and 15, rss (in pages) field 24.
        let fields: Vec<&str> = stat[stat.rfind(')')? + 2..].split(' ').collect();
        let ticks: u64 = fields.get(11)?.parse::<u64>().ok()? + fields.get(12)?.parse::<u64>().ok()?;
        let pages: u64 = fields.get(21)?.parse().ok()?;
        // SAFETY: sysconf only reads a system setting.
        let (hz, page) = unsafe { (libc::sysconf(libc::_SC_CLK_TCK), libc::sysconf(libc::_SC_PAGESIZE)) };
        Some(Usage { cpu_ms: ticks * 1000 / hz.max(1) as u64, rss: pages * page.max(0) as u64 })
    }
}

/// Mach ticks to nanoseconds, as a fraction: 1/1 on Intel, not on Apple silicon.
#[cfg(target_os = "macos")]
#[allow(deprecated)] // libc points to the mach2 crate for this one call.
fn timebase() -> (u128, u128) {
    let mut base = libc::mach_timebase_info { numer: 0, denom: 0 };
    // SAFETY: mach_timebase_info only fills `base`.
    let ok = unsafe { libc::mach_timebase_info(&mut base) } == 0 && base.denom != 0;
    if ok { (base.numer as u128, base.denom as u128) } else { (1, 1) }
}

/// A start time from [`crate::pty::process_start`] in milliseconds since the
/// epoch, for showing only: on Linux it is worked out from the boot time the
/// kernel gives now, which moves when the clock is adjusted. Compare starts
/// as the kernel keeps them (X83).
pub fn started_ms(start: u64) -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        Some(start / 1000)
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Clock ticks since boot, which is in seconds since the epoch.
        // SAFETY: sysconf only reads a system setting.
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as u64;
        Some(boot_time()? * 1000 + start * 1000 / hz)
    }
}

/// The session process `pid` is in: its leader's pid.
pub fn session_of(pid: u32) -> Option<u32> {
    // SAFETY: getsid only reads the process table.
    let sid = unsafe { libc::getsid(pid as i32) };
    u32::try_from(sid).ok()
}

/// The nearest `hops` ancestors of process `pid`, parent first, with the
/// executable each runs; it stops at the first the kernel does not show,
/// and before launchd or init.
pub fn ancestors(pid: u32, hops: usize) -> Vec<(u32, Option<PathBuf>)> {
    let mut out = Vec::new();
    let mut at = pid;
    while out.len() < hops {
        match parent(at) {
            Some(p) if p > 1 => {
                out.push((p, executable(p)));
                at = p;
            }
            _ => break,
        }
    }
    out
}

/// One process as the kernel lists it: its pid, its parent's, and when it
/// started (see [`crate::pty::process_start`]). Never its arguments, which
/// can hold tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub start: u64,
}

/// When the machine booted: microseconds since the epoch on macOS, seconds on
/// Linux. `None` when the kernel does not say.
pub fn boot_time() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        let mut tv: libc::timeval = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of::<libc::timeval>();
        let mut mib = [libc::CTL_KERN, libc::KERN_BOOTTIME];
        // SAFETY: sysctl writes at most `size` bytes into `tv`.
        let r = unsafe { libc::sysctl(mib.as_mut_ptr(), 2, (&mut tv as *mut libc::timeval).cast(), &mut size, std::ptr::null_mut(), 0) };
        (r == 0).then(|| tv.tv_sec as u64 * 1_000_000 + tv.tv_usec as u64)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let stat = std::fs::read_to_string("/proc/stat").ok()?;
        stat.lines().find_map(|l| l.strip_prefix("btime "))?.trim().parse().ok()
    }
}

/// How many units of [`boot_time`] make a second.
#[cfg(target_os = "macos")]
pub const BOOT_TIME_PER_SEC: u64 = 1_000_000;
/// How many units of [`boot_time`] make a second.
#[cfg(not(target_os = "macos"))]
pub const BOOT_TIME_PER_SEC: u64 = 1;

/// Which boot of the machine this is, a new id at each: `kern.bootsessionuuid`
/// on macOS, `/proc/sys/kernel/random/boot_id` on Linux. Unlike
/// [`boot_time`], which is the clock now less the time since boot, a clock
/// change leaves it as it was. `None` when the kernel does not say.
pub fn boot_id() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let mut buf = [0u8; 64];
        let mut size = buf.len();
        // SAFETY: sysctlbyname writes at most `size` bytes into `buf`.
        let r = unsafe { libc::sysctlbyname(c"kern.bootsessionuuid".as_ptr(), buf.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) };
        if r != 0 {
            return None;
        }
        let id = std::ffi::CStr::from_bytes_until_nul(&buf[..size]).ok()?.to_str().ok()?.trim().to_string();
        (!id.is_empty()).then_some(id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?.trim().to_string();
        (!id.is_empty()).then_some(id)
    }
}

/// Every process this one may see, with its parent and start time (X79).
pub fn table() -> Table {
    Table::new(crate::pty::all_pids().into_iter().filter_map(|pid| u32::try_from(pid).ok().filter(|&p| p > 0)).filter_map(proc_of))
}

/// Processes as the kernel listed them at one moment, each under its
/// parent, so a process's descendants are found by looking at each of them
/// once, not at every process for each (X79).
#[derive(Debug, Default)]
pub struct Table {
    all: Vec<Proc>,
    children: std::collections::HashMap<u32, Vec<Proc>>,
    by_pid: std::collections::HashMap<u32, Proc>,
}

/// Every process listed, for a look through them all.
impl std::ops::Deref for Table {
    type Target = [Proc];
    fn deref(&self) -> &[Proc] {
        &self.all
    }
}

impl Table {
    pub fn new(procs: impl IntoIterator<Item = Proc>) -> Self {
        let mut children: std::collections::HashMap<u32, Vec<Proc>> = std::collections::HashMap::new();
        let mut by_pid = std::collections::HashMap::new();
        let all: Vec<Proc> = procs.into_iter().collect();
        for &p in &all {
            children.entry(p.ppid).or_default().push(p);
            by_pid.insert(p.pid, p);
        }
        Self { all, children, by_pid }
    }

    /// Process `pid` as listed, if it was.
    pub fn get(&self, pid: u32) -> Option<Proc> {
        self.by_pid.get(&pid).copied()
    }

    /// Whether the process listed as `pid` started at `start`.
    pub fn has(&self, pid: u32, start: u64) -> bool {
        self.get(pid).is_some_and(|p| p.start == start)
    }

    /// The processes that descend from `root`: its children, theirs, and so
    /// on, in no particular order. Not `root` itself.
    pub fn descendants(&self, root: u32) -> Vec<Proc> {
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::from([root]);
        let mut parents = vec![root];
        while let Some(p) = parents.pop() {
            for c in self.children.get(&p).into_iter().flatten() {
                if seen.insert(c.pid) {
                    out.push(*c);
                    parents.push(c.pid);
                }
            }
        }
        out
    }
}

/// Process `pid`'s parent and start time, read in one go.
fn proc_of(pid: u32) -> Option<Proc> {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: proc_pidinfo writes at most `size` bytes into `info`.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let n = unsafe { libc::proc_pidinfo(pid as i32, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
        // The same start as `pty::process_start`: microseconds since the epoch.
        (n == size).then(|| Proc { pid, ppid: info.pbi_ppid, start: info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // Counted after the command name, which may hold spaces: the parent
        // is the second field there, the start time (as `pty::process_start`)
        // the twentieth.
        let mut fields = stat[stat.rfind(')')? + 2..].split(' ');
        let ppid = fields.nth(1)?.parse().ok()?;
        let start = fields.nth(17)?.parse().ok()?;
        Some(Proc { pid, ppid, start })
    }
}

/// The processes an agent started, noted while the agent still runs: once it
/// exits, they belong to launchd (init on Linux) and nothing links them to it
/// any more (X79).
#[derive(Debug, Default)]
pub struct Family {
    known: std::collections::HashMap<u32, u64>,
}

impl Family {
    /// Notes the descendants of `root` in `table`.
    pub fn note(&mut self, table: &Table, root: u32) {
        // Ended ones go: what is left are processes that still run, the agent's
        // descendants or, once their parent is gone, launchd's.
        self.known.retain(|&pid, &mut start| table.has(pid, start));
        for p in table.descendants(root) {
            self.known.insert(p.pid, p.start);
        }
    }

    /// Each noted process, as pid and start time.
    pub fn members(&self) -> impl Iterator<Item = (u32, u64)> + '_ {
        self.known.iter().map(|(&pid, &start)| (pid, start))
    }

    /// A family of the processes `members` names (pid, start time).
    pub fn of(members: impl IntoIterator<Item = (u32, u64)>) -> Family {
        Family { known: members.into_iter().collect() }
    }

    /// Takes on what `other` noted, as when a restarted agent inherits what
    /// the one before it left running.
    pub fn adopt(&mut self, other: Family) {
        self.known.extend(other.known);
    }

    /// Whether nothing is noted.
    pub fn is_empty(&self) -> bool {
        self.known.is_empty()
    }

    /// Sends `signal` (`None` only checks) to every noted process that still
    /// runs, and forgets the rest. A pid that now belongs to a process
    /// started later is someone else's, and is left alone. Returns whether
    /// any noted process still runs.
    pub fn signal(&mut self, signal: Option<nix::sys::signal::Signal>) -> bool {
        self.known.retain(|&pid, &mut start| crate::pty::process_start(pid) == Some(start));
        for &pid in self.known.keys() {
            let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), signal);
        }
        !self.known.is_empty()
    }
}

/// How long a stopped agent and what it started get after SIGTERM.
pub const TERM_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

/// A stopped agent's process group and the processes it started, or what a
/// crashed daemon's agents left (X79), on the way out.
pub struct Doomed {
    pub group: Option<nix::unistd::Pid>,
    /// The agent that leads `group`, as pid and start time, when it still
    /// ran as it was stopped: until it exits, a crash would leave it running.
    pub agent: Option<(u32, u64)>,
    pub family: Family,
}

impl Doomed {
    /// Sends `signal` (`None` only checks) to the group and the family;
    /// whether any of them still runs.
    pub fn signal(&mut self, signal: impl Into<Option<nix::sys::signal::Signal>>) -> bool {
        let signal = signal.into();
        // A group found empty is gone for good: its id may be a new group's next.
        let group = match self.group {
            Some(g) if nix::sys::signal::killpg(g, signal).is_ok() => true,
            _ => {
                self.group = None;
                false
            }
        };
        let family = self.family.signal(signal);
        group || family
    }

    /// Whether any of it still runs.
    pub fn running(&mut self) -> bool {
        self.signal(None)
    }

    /// Waits up to `limit` for all of it to be gone.
    async fn gone_within(&mut self, limit: std::time::Duration) {
        let end = std::time::Instant::now() + limit;
        while self.running() && std::time::Instant::now() < end {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    /// SIGTERM, then SIGKILL to whatever still runs after [`TERM_GRACE`];
    /// returns once all of it is gone, or a second after the SIGKILL.
    pub async fn end(mut self) {
        self.signal(nix::sys::signal::Signal::SIGTERM);
        self.gone_within(TERM_GRACE).await;
        if self.signal(nix::sys::signal::Signal::SIGKILL) {
            self.gone_within(std::time::Duration::from_secs(1)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descendants_are_children_and_theirs_but_not_others() {
        // An agent (100) with a shell (101) running a pipeline (102, 103) and
        // an MCP server (104); another session's shell (200) runs `tail` (201).
        let p = |pid, ppid| Proc { pid, ppid, start: pid as u64 };
        let table = Table::new([p(1, 0), p(100, 50), p(101, 100), p(102, 101), p(103, 101), p(104, 100), p(200, 1), p(201, 200)]);
        let mut pids: Vec<u32> = table.descendants(100).iter().map(|p| p.pid).collect();
        pids.sort();
        assert_eq!(pids, [101, 102, 103, 104]);
        assert!(table.descendants(104).is_empty());
    }

    #[test]
    fn a_deep_tree_is_walked_in_one_pass() {
        // 20,000 processes, each the child of the one before: one look at
        // each, not one look at the whole table per process.
        let table = Table::new((1..=20_000).map(|pid| Proc { pid, ppid: pid - 1, start: pid as u64 }));
        let started = std::time::Instant::now();
        let found = table.descendants(1).len();
        let took = started.elapsed();
        assert_eq!(found, 19_999);
        assert!(took < std::time::Duration::from_secs(1), "took {took:?}");
    }

    #[test]
    fn a_family_forgets_a_process_no_longer_in_the_table() {
        let p = |pid, ppid, start| Proc { pid, ppid, start };
        let mut family = Family::default();
        family.note(&Table::new([p(100, 50, 1), p(101, 100, 2), p(102, 100, 3)]), 100);
        // 101 ended; 102's pid now belongs to a process that started later.
        family.note(&Table::new([p(100, 50, 1), p(102, 1, 9)]), 100);
        assert!(family.members().next().is_none());
    }

    #[test]
    fn a_family_signals_only_processes_that_still_run() {
        // A shell whose child sleeps: the shell is the root, the sleep its family.
        let mut shell = std::process::Command::new("/bin/sh").args(["-c", "/bin/sleep 30 & wait"]).spawn().unwrap();
        let mut family = Family::default();
        for _ in 0..50 {
            family.note(&table(), shell.id());
            if family.signal(None) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(family.signal(None), "the shell's sleep was never seen");
        family.signal(Some(nix::sys::signal::Signal::SIGKILL));
        shell.wait().unwrap();
        // The sleep, reparented and reaped, is no longer in the family.
        for _ in 0..50 {
            if !family.signal(None) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("the killed sleep still counts as running");
    }

    #[test]
    fn root_is_both_the_real_and_the_effective_uid() {
        // From /proc/<pid>/status on Ubuntu 24.04: runuser started by
        // cloud-init, then a user's process.
        let runuser = "Name:\trunuser\nUmask:\t0022\nState:\tS (sleeping)\nTgid:\t1412\nPid:\t1412\nPPid:\t1398\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\n";
        assert!(root_in_status(runuser));
        let user = "Name:\trunuser\nPid:\t2210\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n";
        assert!(!root_in_status(user));
        // Root in name only: effective uid the user's.
        assert!(!root_in_status("Uid:\t0\t1000\t0\t1000\n"));
        assert!(!root_in_status("Uid:\t1000\t0\t0\t0\n"));
        assert!(!root_in_status("Name:\trunuser\n"));
        assert!(!root_in_status(""));
    }

    #[test]
    fn a_child_s_executable_name_and_parent_are_what_the_kernel_says() {
        let mut child = std::process::Command::new("/bin/sleep").arg("5").spawn().unwrap();
        let pid = child.id();
        let exe = executable(pid);
        let named = name(pid);
        let parent_of_child = parent(pid);
        let kernel = kernel_name(pid);
        let root = runs_as_root(pid);
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(exe.as_deref().and_then(|e| e.file_name()), Some("sleep".as_ref()));
        assert_eq!(named.as_deref(), Some("sleep"));
        assert_eq!(parent_of_child, Some(std::process::id()));
        #[cfg(target_os = "linux")]
        {
            assert_eq!(kernel.as_deref(), Some("sleep"));
            assert_eq!(root, Some(false));
        }
        #[cfg(target_os = "macos")]
        assert_eq!((kernel, root), (None, None));
    }

    #[test]
    fn a_child_s_working_directory_and_usage_are_what_the_kernel_says() {
        let dir = tempfile::tempdir().unwrap();
        let before = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        let mut child = std::process::Command::new("/bin/sleep").arg("5").current_dir(dir.path()).spawn().unwrap();
        let pid = child.id();
        let at = cwd(pid);
        let used = usage(pid);
        let started = crate::pty::process_start(pid).and_then(started_ms);
        let session = session_of(pid);
        child.kill().unwrap();
        child.wait().unwrap();
        let after = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        assert_eq!(at, Some(dir.path().canonicalize().unwrap()));
        let used = used.expect("no usage for a child");
        assert!(used.rss > 0, "a running sleep has resident memory");
        assert!(used.cpu_ms < 5_000, "a sleep used {} ms of CPU", used.cpu_ms);
        // Linux counts the start in clock ticks: 10 ms each.
        let started = started.expect("no start time for a child");
        assert!(started + 1_000 >= before && started <= after + 1_000, "started {started}, spawned between {before} and {after}");
        // SAFETY: getsid only reads the process table.
        assert_eq!(session, Some(unsafe { libc::getsid(0) } as u32));
        assert_eq!((cwd(99_999_999), usage(99_999_999), session_of(99_999_999)), (None, None, None));
    }

    #[test]
    fn a_child_s_ancestors_start_with_this_process() {
        let mut child = std::process::Command::new("/bin/sleep").arg("5").spawn().unwrap();
        let up = ancestors(child.id(), 4);
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(up[0], (std::process::id(), std::env::current_exe().ok()));
        assert!(up.len() <= 4);
    }

    #[test]
    fn a_process_that_does_not_exist_has_none() {
        // Above any pid the kernel hands out.
        let pid = 99_999_999;
        assert_eq!(executable(pid), None);
        assert_eq!(name(pid), None);
        assert_eq!(parent(pid), None);
        assert_eq!(kernel_name(pid), None);
        #[cfg(target_os = "linux")]
        assert_eq!(runs_as_root(pid), Some(false));
    }
}
