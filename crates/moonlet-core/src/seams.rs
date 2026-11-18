//! Test seams: environment variables that only tests set, to stand in for
//! Tailscale, the app, sshd, a clock or a timer. A release build drops them
//! from its own environment before it starts, so a copy installed for real
//! behaves the same whatever environment it is started with. Debug builds,
//! which the tests and the e2e app run, keep them.

/// Seams outside the `MOONLET_TEST_` prefix.
const NAMED: [&str; 3] = [
    "MOONLET_MOBILE_ADDRS",
    "MOONLET_TAILSCALE",
    "MOONLET_TAILSCALE_CALLS",
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

    const ENV: [&str; 9] = [
        "PATH",
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
