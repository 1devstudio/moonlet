//! Sign-ins open where the user is (X75). Every terminal and agent moonlet
//! starts gets `BROWSER` and `GH_BROWSER` set to `moonlet-open`, and an
//! `open` (macOS) or `xdg-open` (Linux) first on its `PATH` that hands an
//! `http` or `https` URL to it. `moonlet-open` gives the URL to its
//! daemon, which opens it on the client the user used last.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

/// The longest URL `moonlet-open` takes.
pub const MAX_URL: usize = 8 * 1024;

/// Refuses a URL `moonlet-open` does not hand on: one that is not `http`
/// or `https`, is over [`MAX_URL`], or holds a space or a control
/// character.
pub fn check_url(url: &str) -> Result<()> {
    if url.len() > MAX_URL {
        bail!("the URL is over 8 KiB");
    }
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        bail!("only http and https URLs open elsewhere");
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        bail!("the URL holds a space or a control character");
    }
    Ok(())
}

/// Where the opener and the shims are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opener {
    /// `$MOONLET_HOME/opener/moonlet-open`.
    pub open: PathBuf,
    /// `$MOONLET_HOME/opener/shims`, first on the processes' `PATH`.
    pub shims: PathBuf,
}

/// `s` quoted for `sh`.
fn quoted(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The shim named `name` (`open` or `xdg-open`): one `http` or `https` URL
/// alone goes to the opener, anything else to the first of `system` that
/// exists, unchanged. A URL the opener cannot hand on, as while the daemon
/// is down, goes to the system's opener too.
fn shim(open: &Path, name: &str, system: &[&str]) -> String {
    let others: Vec<String> = system.iter().map(|s| quoted(s)).collect();
    format!(
        "#!/bin/sh\n\
         # moonlet (X75): a URL opens where you are; anything else as usual.\n\
         if [ \"$#\" -eq 1 ]; then\n\
         \x20 case \"$1\" in [Hh][Tt][Tt][Pp]://*|[Hh][Tt][Tt][Pp][Ss]://*) {open} \"$1\" && exit 0 ;; esac\n\
         fi\n\
         for o in {others}; do\n\
         \x20 [ -x \"$o\" ] && exec \"$o\" \"$@\"\n\
         done\n\
         echo \"{name}: not found\" >&2\n\
         exit 3\n",
        open = quoted(&open.display().to_string()),
        others = others.join(" "),
    )
}

/// Writes `moonlet-open`, which hands its argument to the `moonlet` CLI at
/// `cli`, and the shim for this system, under `home/opener`. `system` is where
/// the system's own opener may be, tried in order.
pub fn install(home: &Path, cli: &Path, name: &str, system: &[&str]) -> Result<Opener> {
    use std::os::unix::fs::PermissionsExt;
    // Its own folder: `bin` holds moonlet's binaries, which updates replace.
    let bin = home.join("opener");
    let shims = bin.join("shims");
    std::fs::create_dir_all(&shims).with_context(|| format!("cannot make {}", shims.display()))?;
    let open = bin.join("moonlet-open");
    let write = |path: &Path, text: String| -> Result<()> {
        let tmp = path.with_extension("moonlet-new");
        std::fs::write(&tmp, text)?;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
        std::fs::rename(&tmp, path).with_context(|| format!("cannot write {}", path.display()))
    };
    write(
        &open,
        format!(
            "#!/bin/sh\n# moonlet (X75): opens the URL where you are.\nexec {} open-url \"$@\"\n",
            quoted(&cli.display().to_string())
        ),
    )?;
    write(&shims.join(name), shim(&open, name, system))?;
    Ok(Opener { open, shims })
}

/// [`install`] for this system: `open` on macOS, `xdg-open` elsewhere.
pub fn install_here(home: &Path, cli: &Path) -> Result<Opener> {
    if cfg!(target_os = "macos") {
        install(home, cli, "open", &["/usr/bin/open"])
    } else {
        install(
            home,
            cli,
            "xdg-open",
            &[
                "/usr/bin/xdg-open",
                "/usr/local/bin/xdg-open",
                "/bin/xdg-open",
            ],
        )
    }
}

/// What a terminal or agent gets so its URLs open where the user is: the
/// opener as `BROWSER` and `GH_BROWSER`, and the shims before `path`, also
/// as `MOONLET_SHIMS` for a login shell to put first again after the
/// system's profile reordered `PATH`.
pub fn env(o: &Opener, path: Option<&str>) -> Vec<(String, String)> {
    let open = o.open.display().to_string();
    let shims = o.shims.display().to_string();
    vec![
        ("BROWSER".into(), open.clone()),
        ("GH_BROWSER".into(), open),
        ("MOONLET_SHIMS".into(), shims.clone()),
        (
            "PATH".into(),
            match path.filter(|p| !p.is_empty()) {
                Some(p) => format!("{shims}:{p}"),
                None => shims,
            },
        ),
    ]
}

/// A client the user was active in: a member's app, by worker id, or a
/// phone, by its device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Client {
    Member(String),
    Phone(String),
}

/// How long the user counts as being where they were last active.
pub const ACTIVE_MS: u64 = 15 * 60 * 1000;

/// Where a URL opens on the central host's say: the client the user used
/// last, and whether that was more than [`ACTIVE_MS`] ago, when the URL
/// also waits with **Open** in its session. None when the user was never
/// seen.
pub fn route(last: Option<&(Client, u64)>, now_ms: u64) -> Option<(Client, bool)> {
    let (client, at) = last?;
    Some((client.clone(), now_ms.saturating_sub(*at) > ACTIVE_MS))
}

/// Whether a member opens a URL of its own at once, without asking the
/// central host: the user was active in its app within [`ACTIVE_MS`].
pub fn opens_here(app_active_at: Option<u64>, now_ms: u64) -> bool {
    app_active_at.is_some_and(|at| now_ms.saturating_sub(at) <= ACTIVE_MS)
}

/// At most this many URLs wait for this Mac's app while it is not
/// connected…
pub const WAITING_MAX: usize = 5;
/// …each for as long as a sign-in's forward lasts.
pub const WAITING_MS: u64 = 10 * 60 * 1000;

/// URLs for this Mac's app that came while it was not connected (X75),
/// kept in memory for the app to take when it connects: the latest
/// [`WAITING_MAX`], none older than [`WAITING_MS`], and the same one once.
#[derive(Debug)]
pub struct Waiting<T> {
    kept: std::collections::VecDeque<(T, u64)>,
}

impl<T> Default for Waiting<T> {
    fn default() -> Self {
        Waiting {
            kept: Default::default(),
        }
    }
}

impl<T: PartialEq> Waiting<T> {
    /// Keeps `show`, which came at `now_ms`.
    pub fn keep(&mut self, show: T, now_ms: u64) {
        self.expire(now_ms);
        self.kept.retain(|(s, _)| *s != show);
        while self.kept.len() >= WAITING_MAX {
            self.kept.pop_front();
        }
        self.kept.push_back((show, now_ms));
    }

    /// Hands over what waits, oldest first, and forgets it.
    pub fn take(&mut self, now_ms: u64) -> Vec<T> {
        self.expire(now_ms);
        self.kept.drain(..).map(|(s, _)| s).collect()
    }

    fn expire(&mut self, now_ms: u64) {
        self.kept
            .retain(|(_, at)| now_ms.saturating_sub(*at) <= WAITING_MS);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moonlet_open_takes_only_http_and_https_up_to_8_kib() {
        assert!(check_url("https://accounts.google.com/o/oauth2/auth?client_id=1").is_ok());
        assert!(check_url("HTTP://localhost:8085/").is_ok());
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://x",
            "https://a b",
            "https://a\nb",
            "x",
        ] {
            assert!(check_url(bad).is_err(), "{bad:?}");
        }
        let long = format!("https://example.test/{}", "a".repeat(9 * 1024));
        assert!(check_url(&long).is_err());
    }

    /// A folder with the opener and a shim whose CLI and system opener
    /// record their arguments.
    fn installed(name: &str) -> (tempfile::TempDir, Opener, PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let recorder = |path: &Path, log: &Path| {
            std::fs::write(
                path,
                format!("#!/bin/sh\nprintf '%s\\n' \"$@\" >> '{}'\n", log.display()),
            )
            .unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        let cli_log = dir.path().join("cli.log");
        let system_log = dir.path().join("system.log");
        let cli = dir.path().join("moonlet");
        let system = dir.path().join("system-open");
        recorder(&cli, &cli_log);
        recorder(&system, &system_log);
        let o = install(
            &dir.path().join("home"),
            &cli,
            name,
            &["/nowhere/open", system.to_str().unwrap()],
        )
        .unwrap();
        (dir, o, cli_log, system_log)
    }

    fn run(path: &Path, args: &[&str]) -> i32 {
        std::process::Command::new(path)
            .args(args)
            .status()
            .unwrap()
            .code()
            .unwrap()
    }

    fn read(p: &Path) -> String {
        std::fs::read_to_string(p).unwrap_or_default()
    }

    #[test]
    fn the_open_shim_hands_on_urls_and_passes_everything_else_to_usr_bin_open() {
        let (_dir, o, cli, system) = installed("open");
        let shim = o.shims.join("open");
        assert_eq!(run(&shim, &["https://github.com/login/device"]), 0);
        assert_eq!(read(&cli), "open-url\nhttps://github.com/login/device\n");
        // A scheme in capitals is as much a web URL.
        assert_eq!(run(&shim, &["HTTPS://github.com/login/device"]), 0);
        assert_eq!(
            read(&cli),
            "open-url\nhttps://github.com/login/device\nopen-url\nHTTPS://github.com/login/device\n"
        );
        assert_eq!(run(&shim, &["."]), 0);
        assert_eq!(run(&shim, &["-a", "Cursor", "https://x.test"]), 0);
        assert_eq!(run(&shim, &["file:///tmp/a.html"]), 0);
        assert_eq!(
            read(&system),
            ".\n-a\nCursor\nhttps://x.test\nfile:///tmp/a.html\n"
        );
    }

    #[test]
    fn the_xdg_open_shim_hands_on_urls_and_passes_everything_else_on() {
        let (_dir, o, cli, system) = installed("xdg-open");
        let shim = o.shims.join("xdg-open");
        assert_eq!(run(&shim, &["http://localhost:8085/?code=4"]), 0);
        assert_eq!(run(&shim, &["Http://localhost:8085/?code=5"]), 0);
        assert_eq!(run(&shim, &["/home/me/report.pdf"]), 0);
        assert_eq!(
            read(&cli),
            "open-url\nhttp://localhost:8085/?code=4\nopen-url\nHttp://localhost:8085/?code=5\n"
        );
        assert_eq!(read(&system), "/home/me/report.pdf\n");
    }

    #[test]
    fn a_url_the_daemon_cannot_take_goes_to_the_system_opener() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, o, _cli, system) = installed("open");
        // The CLI fails, as it does while the daemon is down.
        let cli = dir.path().join("moonlet");
        std::fs::write(&cli, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(run(&o.shims.join("open"), &["https://example.test/"]), 0);
        assert_eq!(read(&system), "https://example.test/\n");
    }

    #[test]
    fn at_most_five_urls_wait_for_the_app_each_for_ten_minutes_and_once() {
        let mut w = Waiting::default();
        for (url, at) in [
            ("a", 0),
            ("b", 1),
            ("c", 2),
            ("d", 3),
            ("e", 4),
            ("f", 5),
            ("c", 6),
        ] {
            w.keep(url, at);
        }
        assert_eq!(w.take(7), ["b", "d", "e", "f", "c"]);
        assert_eq!(w.take(8), Vec::<&str>::new());
        w.keep("g", 0);
        w.keep("h", 1_000);
        assert_eq!(w.take(600_500), ["h"]);
    }

    #[test]
    fn the_url_opens_where_the_user_was_last_active() {
        let min = 60_000;
        let now = 100 * min;
        let book = Client::Member("book".into());
        let phone = Client::Phone("iphone".into());
        assert_eq!(
            route(Some(&(book.clone(), now - min)), now),
            Some((book.clone(), false))
        );
        assert_eq!(
            route(Some(&(phone.clone(), now - 15 * min)), now),
            Some((phone.clone(), false))
        );
        // Nobody active in the last 15 minutes: the last one, and it waits.
        assert_eq!(
            route(Some(&(book.clone(), now - 16 * min)), now),
            Some((book, true))
        );
        assert_eq!(route(None, now), None);
    }

    #[test]
    fn with_the_central_host_offline_the_url_opens_only_where_the_user_is_active() {
        let min = 60_000;
        let now = 100 * min;
        assert!(opens_here(Some(now - 14 * min), now));
        assert!(!opens_here(Some(now - 16 * min), now));
        // An app merely open, never touched, does not count.
        assert!(!opens_here(None, now));
    }

    #[test]
    fn browser_and_gh_browser_name_the_opener_and_the_shims_come_first() {
        let o = Opener {
            open: "/h/opener/moonlet-open".into(),
            shims: "/h/opener/shims".into(),
        };
        assert_eq!(
            env(&o, Some("/usr/bin:/bin")),
            [
                ("BROWSER".to_string(), "/h/opener/moonlet-open".to_string()),
                ("GH_BROWSER".to_string(), "/h/opener/moonlet-open".to_string()),
                ("MOONLET_SHIMS".to_string(), "/h/opener/shims".to_string()),
                ("PATH".to_string(), "/h/opener/shims:/usr/bin:/bin".to_string()),
            ]
        );
    }
}
