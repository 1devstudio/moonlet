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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_child_s_executable_name_and_parent_are_what_the_kernel_says() {
        let mut child = std::process::Command::new("/bin/sleep").arg("5").spawn().unwrap();
        let pid = child.id();
        let exe = executable(pid);
        let named = name(pid);
        let parent_of_child = parent(pid);
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(exe.as_deref().and_then(|e| e.file_name()), Some("sleep".as_ref()));
        assert_eq!(named.as_deref(), Some("sleep"));
        assert_eq!(parent_of_child, Some(std::process::id()));
    }

    #[test]
    fn a_process_that_does_not_exist_has_none() {
        // Above any pid the kernel hands out.
        let pid = 99_999_999;
        assert_eq!(executable(pid), None);
        assert_eq!(name(pid), None);
        assert_eq!(parent(pid), None);
    }
}
