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

#[cfg(test)]
mod tests {
    use super::*;

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
