//! moonletd at system start, before anyone logs in (X113): a launch daemon
//! plist in `/Library/LaunchDaemons` that runs the user's own `moonletd` as
//! the user, written with an administrator's password. Nothing of moonlet
//! runs as root.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result, bail};
use base64::Engine;

/// The user's choice in `~/.moonlet/app.toml`, which the daemon started at
/// boot reads too: off, it exits without serving.
pub const CHOICE: &str = "start_daemon_at_boot";

/// One launch and one toggle at a time, as for the login item.
static LOCK: Mutex<()> = Mutex::new(());

/// The launch daemon's label for the user `uid`.
pub fn label(uid: u32) -> String {
    format!("dev.onedevstudio.moonlet.boot.{uid}")
}

/// Where the launch daemon's plist for the user `uid` lives.
pub fn plist_path(uid: u32) -> PathBuf {
    PathBuf::from(format!("/Library/LaunchDaemons/{}.plist", label(uid)))
}

/// The user the daemon runs as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub name: String,
    pub uid: u32,
    /// The primary group's name.
    pub group: String,
    pub home: PathBuf,
    pub shell: PathBuf,
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The plist that runs `program` (the app's own `moonletd`) as `a` at
/// system start. launchd sets no `HOME`, `USER` or `SHELL` for a daemon,
/// so the plist does.
pub fn plist(a: &Account, program: &Path) -> String {
    let s = |v: &str| format!("<string>{}</string>", xml_escape(v));
    let home = a.home.display().to_string();
    let shell = a.shell.display().to_string();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by moonlet (X113): starts this user's moonletd at system start,
     as the user. Settings › App › General › Background daemon removes it. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  {label}
  <key>Program</key>
  {program}
  <key>ProgramArguments</key>
  <array>
    <string>moonletd</string>
    <string>daemon</string>
    <string>--boot</string>
  </array>
  <key>UserName</key>
  {name}
  <key>GroupName</key>
  {group}
  <key>InitGroups</key>
  <true/>
  <key>WorkingDirectory</key>
  {home}
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    {home}
    <key>USER</key>
    {name}
    <key>LOGNAME</key>
    {name}
    <key>SHELL</key>
    {shell}
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>dev.onedevstudio.moonlet</string>
  </array>
</dict>
</plist>
"#,
        label = s(&label(a.uid)),
        program = s(&program.display().to_string()),
        name = s(&a.name),
        group = s(&a.group),
        home = s(&home),
        shell = s(&shell),
    )
}

/// The shell command, run as root, that writes `xml` as the plist of the
/// user `uid`. The plist comes from the command itself, never from a file
/// a process of the user's could swap before root reads it; the command
/// holds only base64 and fixed paths.
pub fn install_command(uid: u32, xml: &str) -> String {
    let path = plist_path(uid);
    let path = path.display();
    format!(
        "umask 022 && /bin/echo {b64} | /usr/bin/base64 -D -o {path} && /usr/sbin/chown root:wheel {path} && /bin/chmod 644 {path}",
        b64 = base64::engine::general_purpose::STANDARD.encode(xml)
    )
}

/// The shell command, run as root, that deletes the plist of the user
/// `uid`. It boots no job out: a daemon that serves keeps serving.
pub fn remove_command(uid: u32) -> String {
    format!("/bin/rm -f {}", plist_path(uid).display())
}

/// The AppleScript that runs `command` as root after macOS asks for an
/// administrator's password.
pub fn with_administrator(command: &str) -> Result<String> {
    if command.contains(['"', '\\', '\'', '\n', '$', '`']) {
        bail!("refusing to run a command that needs quoting as root");
    }
    Ok(format!(
        "do shell script \"{command}\" with administrator privileges"
    ))
}

/// What Settings says about the launch daemon.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BootState {
    /// The plist the app would write is there, and Login Items allows it.
    On,
    /// Switched off in System Settings › Login Items.
    RequiresApproval,
    /// A plist that differs, as when the app moved: Repair writes it again.
    Stale,
    /// The user turned it off, but the plist is still there: harmless, as
    /// the daemon exits without serving, and Remove deletes it.
    LeftBehind,
    Off,
}

/// The state from the user's choice, the plist on disk (`None` when there
/// is none), the plist the app would write now, and whether Login Items
/// allows it.
pub fn state(choice: bool, installed: Option<&str>, wanted: &str, allowed: bool) -> BootState {
    match (choice, installed) {
        (_, None) => BootState::Off,
        (false, Some(_)) => BootState::LeftBehind,
        (true, Some(on_disk)) if on_disk != wanted => BootState::Stale,
        (true, Some(_)) if !allowed => BootState::RequiresApproval,
        (true, Some(_)) => BootState::On,
    }
}

/// What still stops the Mac being useful before login.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Facts {
    /// The Tailscale app (App Store or Standalone) is installed.
    pub tailscale_app: bool,
    /// The open-source `tailscaled` runs as a launch daemon.
    pub tailscaled: bool,
    pub filevault: bool,
    pub auto_login: bool,
}

/// The warnings Settings shows below the line, by name.
pub fn warnings(f: Facts) -> Vec<&'static str> {
    let mut out = Vec::new();
    if f.tailscale_app && !f.tailscaled {
        out.push("tailscale");
    }
    if f.filevault {
        out.push("filevault");
    }
    if !f.auto_login {
        out.push("auto_login");
    }
    out
}

/// What Settings shows.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct Status {
    pub state: BootState,
    pub warnings: Vec<&'static str>,
}

/// This user's account, from the user database.
#[cfg(unix)]
pub fn this_account() -> Result<Account> {
    use std::ffi::CStr;
    let text = |p: *const libc::c_char| unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
    let mut buf = vec![0 as libc::c_char; 16 * 1024];
    // SAFETY: the reentrant lookups write only into `pw`, `gr` and `buf`,
    // which outlive every read of them.
    unsafe {
        let uid = libc::getuid();
        let mut pw: libc::passwd = std::mem::zeroed();
        let mut found: *mut libc::passwd = std::ptr::null_mut();
        if libc::getpwuid_r(uid, &mut pw, buf.as_mut_ptr(), buf.len(), &mut found) != 0
            || found.is_null()
        {
            bail!("cannot read this user's account");
        }
        let (name, home, shell, gid) = (
            text(pw.pw_name),
            text(pw.pw_dir),
            text(pw.pw_shell),
            pw.pw_gid,
        );
        let mut gr: libc::group = std::mem::zeroed();
        let mut found: *mut libc::group = std::ptr::null_mut();
        if libc::getgrgid_r(gid, &mut gr, buf.as_mut_ptr(), buf.len(), &mut found) != 0
            || found.is_null()
        {
            bail!("cannot read this user's group");
        }
        Ok(Account {
            name,
            uid,
            group: text(gr.gr_name),
            home: home.into(),
            shell: shell.into(),
        })
    }
}

/// The plist the app would write now: for this user, running this app's
/// own `moonletd`.
fn wanted() -> Result<(Account, String)> {
    let account = this_account()?;
    let exe = std::env::current_exe()?;
    let program = exe
        .parent()
        .context("the app has no folder")?
        .join("moonletd");
    let xml = plist(&account, &program);
    Ok((account, xml))
}

fn facts() -> Facts {
    let exists = |p: &str| Path::new(p).exists();
    let auto_login = std::process::Command::new("/usr/bin/defaults")
        .args([
            "read",
            "/Library/Preferences/com.apple.loginwindow",
            "autoLoginUser",
        ])
        .output()
        .is_ok_and(|o| o.status.success());
    let filevault = std::process::Command::new("/usr/bin/fdesetup")
        .arg("isactive")
        .output()
        .is_ok_and(|o| o.status.success());
    Facts {
        tailscale_app: exists("/Applications/Tailscale.app"),
        tailscaled: exists("/Library/LaunchDaemons/com.tailscale.tailscaled.plist"),
        filevault,
        auto_login,
    }
}

/// The state for Settings.
pub fn status() -> Result<Status> {
    let (account, xml) = wanted()?;
    let path = plist_path(account.uid);
    let installed = std::fs::read_to_string(&path).ok();
    let choice =
        crate::login_item::saved_flag(&crate::login_item::app_toml(), CHOICE).unwrap_or(false);
    let allowed = sm::allowed(&path);
    Ok(Status {
        state: state(choice, installed.as_deref(), &xml, allowed),
        warnings: warnings(facts()),
    })
}

/// Runs `command` as root, once an administrator gave their password.
/// `Ok(false)` when they cancelled.
fn as_administrator(command: &str) -> Result<bool> {
    let script = with_administrator(command)?;
    let out = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()?;
    if out.status.success() {
        return Ok(true);
    }
    let err = String::from_utf8_lossy(&out.stderr);
    if err.contains("-128") {
        return Ok(false);
    }
    bail!("macOS did not write the launch daemon: {}", err.trim())
}

/// The Settings switch. On: saves the choice, then writes the plist with
/// an administrator's password; cancelled, the choice goes back to off.
/// Off: saves the choice at once, so a daemon started at boot exits without
/// serving, then deletes the plist with the password; cancelled, it stays,
/// harmless, and Settings offers Remove. `repair` writes it again.
pub fn set(action: &str) -> Result<Status> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let file = crate::login_item::app_toml();
    let (account, xml) = wanted()?;
    match action {
        "install" | "repair" => {
            if !crate::login_item::installed(&std::env::current_exe()?) {
                bail!(
                    "Move moonlet to Applications first: macOS would start the daemon from where moonlet runs now."
                );
            }
            if !crate::login_item::starts_at_login() {
                bail!(
                    "Turn on Start the moonlet daemon at login first: it takes over from the daemon started at system start once you log in."
                );
            }
            crate::login_item::save_flag(&file, CHOICE, true)?;
            match as_administrator(&install_command(account.uid, &xml)) {
                Ok(true) => {}
                // Cancelled or failed: the choice goes back to off.
                Ok(false) => {
                    crate::login_item::save_flag(&file, CHOICE, false)?;
                    bail!(
                        "Not turned on: macOS needs an administrator's password to start moonletd at system start."
                    );
                }
                Err(e) => {
                    crate::login_item::save_flag(&file, CHOICE, false)?;
                    return Err(e);
                }
            }
        }
        "uninstall" => {
            crate::login_item::save_flag(&file, CHOICE, false)?;
            if plist_path(account.uid).exists() && !as_administrator(&remove_command(account.uid))?
            {
                tracing::info!("the launch daemon plist stays: the password was cancelled");
            }
        }
        "status" => {}
        other => bail!("unknown action {other}"),
    }
    drop(_guard);
    status()
}

#[cfg(target_os = "macos")]
mod sm {
    use std::path::Path;

    use objc2_foundation::{NSString, NSURL};
    use objc2_service_management::{SMAppService, SMAppServiceStatus};

    /// Whether Login Items allows the plist at `path`.
    pub fn allowed(path: &Path) -> bool {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.display().to_string()));
        // SAFETY: a class method taking a valid file URL.
        let status = unsafe { SMAppService::statusForLegacyURL(&url) };
        status != SMAppServiceStatus::RequiresApproval
    }
}

#[cfg(not(target_os = "macos"))]
mod sm {
    pub fn allowed(_: &std::path::Path) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alex() -> Account {
        Account {
            name: "alex".into(),
            uid: 501,
            group: "staff".into(),
            home: "/Users/alex".into(),
            shell: "/bin/zsh".into(),
        }
    }

    const PROGRAM: &str = "/Applications/moonlet.app/Contents/MacOS/moonletd";

    #[test]
    fn the_boot_plist_runs_moonletd_as_its_user() {
        let xml = plist(&alex(), Path::new(PROGRAM));
        assert_eq!(
            xml,
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by moonlet (X113): starts this user's moonletd at system start,
     as the user. Settings › App › General › Background daemon removes it. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.onedevstudio.moonlet.boot.501</string>
  <key>Program</key>
  <string>/Applications/moonlet.app/Contents/MacOS/moonletd</string>
  <key>ProgramArguments</key>
  <array>
    <string>moonletd</string>
    <string>daemon</string>
    <string>--boot</string>
  </array>
  <key>UserName</key>
  <string>alex</string>
  <key>GroupName</key>
  <string>staff</string>
  <key>InitGroups</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>/Users/alex</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/alex</string>
    <key>USER</key>
    <string>alex</string>
    <key>LOGNAME</key>
    <string>alex</string>
    <key>SHELL</key>
    <string>/bin/zsh</string>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>dev.onedevstudio.moonlet</string>
  </array>
</dict>
</plist>
"#
        );
        #[cfg(target_os = "macos")]
        {
            let dir = tempfile::tempdir().unwrap();
            let file = dir.path().join("boot.plist");
            std::fs::write(&file, &xml).unwrap();
            let lint = std::process::Command::new("plutil")
                .arg("-lint")
                .arg(&file)
                .output()
                .unwrap();
            assert!(
                lint.status.success(),
                "{}",
                String::from_utf8_lossy(&lint.stdout)
            );
        }
    }

    #[test]
    fn a_name_with_markup_stays_text_in_the_plist() {
        let mut a = alex();
        a.home = "/Users/a&b <c>".into();
        let xml = plist(&a, Path::new(PROGRAM));
        assert!(
            xml.contains("<string>/Users/a&amp;b &lt;c&gt;</string>"),
            "{xml}"
        );
    }

    #[test]
    fn the_privileged_command_writes_only_the_plist() {
        assert_eq!(
            install_command(501, "<plist/>\n"),
            "umask 022 && /bin/echo PHBsaXN0Lz4K | /usr/bin/base64 -D -o /Library/LaunchDaemons/dev.onedevstudio.moonlet.boot.501.plist && /usr/sbin/chown root:wheel /Library/LaunchDaemons/dev.onedevstudio.moonlet.boot.501.plist && /bin/chmod 644 /Library/LaunchDaemons/dev.onedevstudio.moonlet.boot.501.plist"
        );
        assert_eq!(
            remove_command(501),
            "/bin/rm -f /Library/LaunchDaemons/dev.onedevstudio.moonlet.boot.501.plist"
        );
        assert_eq!(
            with_administrator(&remove_command(501)).unwrap(),
            "do shell script \"/bin/rm -f /Library/LaunchDaemons/dev.onedevstudio.moonlet.boot.501.plist\" with administrator privileges"
        );
        // Whatever the account holds, it reaches root only as base64.
        let mut a = alex();
        a.name = "x\"; rm -rf / #".into();
        let command = install_command(501, &plist(&a, Path::new(PROGRAM)));
        assert!(with_administrator(&command).is_ok(), "{command}");
        assert!(!command.contains("rm -rf"));
        assert!(with_administrator("echo \"hi\"").is_err());
        assert!(with_administrator("echo $HOME").is_err());
    }

    #[test]
    fn the_boot_state_follows_the_plist() {
        let wanted = "<plist>now</plist>";
        assert_eq!(state(true, Some(wanted), wanted, true), BootState::On);
        assert_eq!(
            state(true, Some(wanted), wanted, false),
            BootState::RequiresApproval
        );
        assert_eq!(
            state(true, Some("<plist>moved</plist>"), wanted, true),
            BootState::Stale
        );
        assert_eq!(
            state(false, Some(wanted), wanted, true),
            BootState::LeftBehind
        );
        assert_eq!(state(false, None, wanted, true), BootState::Off);
        // Turned on, but the password was never given.
        assert_eq!(state(true, None, wanted, true), BootState::Off);
    }

    #[test]
    fn the_boot_choice_is_kept_in_app_toml() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("app.toml");
        std::fs::write(&file, "start_daemon_at_login = true\n").unwrap();
        crate::login_item::save_flag(&file, CHOICE, true).unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "start_daemon_at_boot = true\nstart_daemon_at_login = true\n"
        );
        assert_eq!(crate::login_item::saved_flag(&file, CHOICE), Some(true));
    }

    #[test]
    fn the_account_is_the_one_id_prints() {
        let id = |flag: &str| {
            String::from_utf8(
                std::process::Command::new("id")
                    .arg(flag)
                    .output()
                    .unwrap()
                    .stdout,
            )
            .unwrap()
            .trim()
            .to_string()
        };
        let a = this_account().unwrap();
        assert_eq!(
            (a.uid.to_string(), a.name.clone(), a.group.clone()),
            (id("-u"), id("-un"), id("-gn"))
        );
    }

    #[test]
    fn warns_only_about_what_applies() {
        let ready = Facts {
            tailscale_app: true,
            tailscaled: true,
            filevault: false,
            auto_login: true,
        };
        assert!(warnings(ready).is_empty());
        assert_eq!(
            warnings(Facts {
                tailscaled: false,
                ..ready
            }),
            ["tailscale"]
        );
        assert_eq!(
            warnings(Facts {
                tailscale_app: false,
                tailscaled: false,
                ..ready
            }),
            Vec::<&str>::new()
        );
        assert_eq!(
            warnings(Facts {
                filevault: true,
                auto_login: false,
                ..ready
            }),
            ["filevault", "auto_login"]
        );
    }
}
