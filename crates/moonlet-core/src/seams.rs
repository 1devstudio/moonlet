//! Test seams: environment variables that only tests set, to stand in for
//! Tailscale, the app, sshd, a cloud provider, a clock or a timer. A release
//! build drops them from its own environment before it starts, so in a copy
//! installed for real they do nothing, whoever starts it with them. Debug
//! builds, which the tests and the e2e app run, keep them.

/// Seams outside the `MOONLET_TEST_` prefix.
const NAMED: [&str; 7] = [
    "MOONLET_MOBILE_ADDRS",
    "MOONLET_TAILSCALE",
    "MOONLET_TAILSCALE_CALLS",
    // Claude Code's managed settings, whose deny rules a heavy command keeps (X62).
    "MOONLET_CLAUDE_MANAGED_SETTINGS",
    // The fake cloud provider and where its machines' setup is (X63).
    "MOONLET_CLOUD_FAKE",
    "MOONLET_MACHINE_SETUP_DIR",
    // git reaching an https origin on this machine (X60).
    "MOONLET_SYNC_LOCAL_ORIGINS",
];

/// Whether the variable `name` is a test seam.
pub fn is_seam(name: &str) -> bool {
    name.starts_with("MOONLET_TEST_") || NAMED.contains(&name)
}

/// Of the variables `names`, the ones a build drops: every seam in a
/// release build, none in a debug build.
pub fn dropped<I, S>(names: I, release: bool) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    if !release {
        return Vec::new();
    }
    names
        .into_iter()
        .filter(|n| is_seam(n.as_ref()))
        .map(|n| n.as_ref().to_string())
        .collect()
}

/// Drops the test seams from this process's environment in a release build.
///
/// # Safety
///
/// Changes the environment: call it first thing in `main`, before any
/// other thread starts.
pub unsafe fn drop_in_release() {
    let names: Vec<String> = std::env::vars_os()
        .filter_map(|(k, _)| k.into_string().ok())
        .collect();
    for name in dropped(names, !cfg!(debug_assertions)) {
        // SAFETY: the caller runs this before any other thread exists.
        unsafe { std::env::remove_var(name) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENV: [&str; 13] = [
        "PATH",
        "MOONLET_CLAUDE_MANAGED_SETTINGS",
        "MOONLET_CLOUD_FAKE",
        "MOONLET_MACHINE_SETUP_DIR",
        "MOONLET_SYNC_LOCAL_ORIGINS",
        "MOONLET_HOME",
        "MOONLET_SOCK",
        "MOONLET_TEST_APP_EXE",
        "MOONLET_TEST_SSHD_EXE",
        "MOONLET_TEST_UNREACHABLE_MS",
        "MOONLET_MOBILE_ADDRS",
        "MOONLET_TAILSCALE",
        "MOONLET_TESTING",
    ];

    #[test]
    fn a_release_build_drops_every_test_seam() {
        assert_eq!(
            dropped(ENV, true),
            [
                "MOONLET_CLAUDE_MANAGED_SETTINGS",
                "MOONLET_CLOUD_FAKE",
                "MOONLET_MACHINE_SETUP_DIR",
                "MOONLET_SYNC_LOCAL_ORIGINS",
                "MOONLET_TEST_APP_EXE",
                "MOONLET_TEST_SSHD_EXE",
                "MOONLET_TEST_UNREACHABLE_MS",
                "MOONLET_MOBILE_ADDRS",
                "MOONLET_TAILSCALE",
            ]
        );
    }

    #[test]
    fn a_debug_build_keeps_them_for_the_tests() {
        assert_eq!(dropped(ENV, false), Vec::<String>::new());
    }
}
