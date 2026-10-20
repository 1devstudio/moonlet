//! The daemon's login item (X56): a launch agent that ships inside
//! `moonlet.app` and that the app registers with `SMAppService`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result, bail};

const CHOICE: &str = "start_daemon_at_login";
/// The agent plist in `Contents/Library/LaunchAgents`.
const PLIST_NAME: &str = "dev.onedevstudio.moonlet.moonletd.plist";
/// The S1b agent that `moonletd service install` wrote.
const OLD_PLIST: &str = "Library/LaunchAgents/dev.onedevstudio.moonlet.daemon.plist";

/// `~/.moonlet/app.toml`, where the app keeps the user's choice.
pub fn app_toml() -> PathBuf {
    moonlet_core::paths::home().join("app.toml")
}

/// The file's keys: none when it is missing, an error when it does not parse.
fn read_table(file: &Path) -> Result<Option<toml::Table>> {
    match std::fs::read_to_string(file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("cannot read {}", file.display())),
        Ok(text) => toml::from_str(&text)
            .map(Some)
            .with_context(|| format!("{} does not parse", file.display())),
    }
}

/// Whether the user wants the daemon to start at login, if they ever said.
/// A file that does not parse counts as no choice.
pub fn saved_choice(file: &Path) -> Option<bool> {
    let table = read_table(file)
        .map_err(|e| tracing::warn!("{e:#}"))
        .ok()??;
    table.get(CHOICE)?.as_bool()
}

/// Saves the user's choice, keeping the file's other keys. A file that does
/// not parse is left as it is, with an error.
pub fn save_choice(file: &Path, on: bool) -> Result<()> {
    let mut table = read_table(file)?.unwrap_or_default();
    table.insert(CHOICE.into(), toml::Value::Boolean(on));
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("toml.tmp");
    std::fs::write(&tmp, toml::to_string(&table)?)?;
    std::fs::rename(&tmp, file).with_context(|| format!("cannot save {}", file.display()))
}

/// The login item's state, as `SMAppService` reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginItemState {
    Enabled,
    /// Registered, but switched off in System Settings › Login Items.
    RequiresApproval,
    NotRegistered,
    /// The bundle has no agent plist.
    NotFound,
}

/// The S1b agent's state, from `moonletd service status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlistState {
    Loaded,
    Installed,
    NotInstalled,
}

/// What runs the daemon at login, as Settings shows it.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "mechanism", rename_all = "snake_case")]
pub enum Service {
    LoginItem {
        state: LoginItemState,
    },
    /// Builds without the bundled agent (dev, e2e) keep the S1b plist.
    Plist {
        state: PlistState,
        plist: String,
    },
}

impl Service {
    /// Reads the JSON that `moonletd service status` prints.
    pub fn from_moonletd(status: &serde_json::Value) -> Result<Service> {
        #[derive(serde::Deserialize)]
        struct Status {
            installed: bool,
            loaded: bool,
            plist: String,
        }
        let s: Status =
            serde_json::from_value(status.clone()).context("unexpected moonletd service status")?;
        let state = match (s.installed, s.loaded) {
            (_, true) => PlistState::Loaded,
            (true, false) => PlistState::Installed,
            (false, false) => PlistState::NotInstalled,
        };
        Ok(Service::Plist {
            state,
            plist: s.plist,
        })
    }
}

/// What the app does about the login item when it starts.
#[derive(Debug, PartialEq, Eq)]
pub struct Launch {
    /// Delete the S1b plist, leaving its agent and daemon running.
    pub remove_old_plist: bool,
    /// Save this as the user's choice.
    pub record: Option<bool>,
    pub register: bool,
}

/// The S1b agent in `~/Library/LaunchAgents`, if there is one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OldPlist {
    None,
    /// Runs the daemon on `~/.moonlet`: the login item replaces it.
    Ours,
    /// Sets `MOONLET_HOME`, as dev agents do: left alone.
    CustomHome,
}

impl OldPlist {
    /// Classifies the S1b plist from its text.
    pub fn from_text(text: &str) -> OldPlist {
        if text.contains("<key>MOONLET_HOME</key>") {
            OldPlist::CustomHome
        } else {
            OldPlist::Ours
        }
    }
}

/// Decides the launch from the saved choice, the S1b plist and the login
/// item's state. The login item is on by default, and someone who had the
/// S1b agent wanted it on. The S1b plist goes only once the login item runs
/// or is about to, so the daemon always has something to start it.
pub fn on_launch(choice: Option<bool>, old: OldPlist, state: LoginItemState) -> Launch {
    let ours = old == OldPlist::Ours;
    let on = ours || choice.unwrap_or(true);
    let register = on && state == LoginItemState::NotRegistered;
    let takes_over = ours && (register || state == LoginItemState::Enabled);
    Launch {
        remove_old_plist: takes_over,
        record: takes_over.then_some(true),
        register: register && (!ours || takes_over),
    }
}

/// One launch or toggle at a time: each reads the state, acts on it and
/// saves the choice, and must not interleave with the other.
static LOCK: Mutex<()> = Mutex::new(());

/// Where a bundle running `exe` keeps the agent plist.
pub fn bundled_agent(exe: &Path) -> Option<PathBuf> {
    Some(
        exe.parent()?
            .parent()?
            .join("Library/LaunchAgents")
            .join(PLIST_NAME),
    )
}

/// Whether this app runs from a bundle that carries the agent: release and
/// `pnpm bundle` builds. Dev and e2e builds use the S1b plist instead.
pub fn bundled() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| bundled_agent(&exe))
        .is_some_and(|p| p.exists())
}

/// Whether `exe` runs from where the app is installed, not from its DMG or
/// a copy that Gatekeeper's App Translocation made: the login item would
/// start the daemon from there.
pub fn installed(exe: &Path) -> bool {
    let path = exe.to_string_lossy();
    !path.starts_with("/Volumes/") && !path.contains("/AppTranslocation/")
}

/// Registers the login item unless the user turned it off, and moves an
/// S1b agent over (X56). Errors are logged; the next launch tries again.
pub fn launch() {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match std::env::current_exe() {
        Ok(exe) if installed(&exe) => {}
        Ok(exe) => {
            tracing::info!(
                "no login item from {}: moonlet is not installed there",
                exe.display()
            );
            return;
        }
        Err(e) => {
            tracing::warn!("cannot tell where moonlet runs: {e}");
            return;
        }
    }
    let old_path = dirs::home_dir().map(|h| h.join(OLD_PLIST));
    let old = old_path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map_or(OldPlist::None, |text| OldPlist::from_text(&text));
    let plan = on_launch(saved_choice(&app_toml()), old, sm::state());
    if plan.register {
        if let Err(e) = sm::register() {
            // Keep the S1b agent until the login item takes over.
            tracing::warn!("cannot register the login item: {e:#}");
            return;
        }
    }
    if let Some(on) = plan.record {
        if let Err(e) = save_choice(&app_toml(), on) {
            tracing::warn!("cannot save the login item choice: {e:#}");
        }
    }
    // Only once the login item will start the daemon at the next login.
    if let (true, Some(old), LoginItemState::Enabled) =
        (plan.remove_old_plist, old_path, sm::state())
    {
        // Not booted out: its daemon serves every session until logout.
        match std::fs::remove_file(&old) {
            Ok(()) => tracing::info!("replaced {} with the login item", old.display()),
            Err(e) => tracing::warn!("cannot remove {}: {e}", old.display()),
        }
    }
}

/// The login item's state for Settings.
pub fn status() -> Service {
    Service::LoginItem { state: sm::state() }
}

/// What turning the toggle on does, given the login item's state.
#[derive(Debug, PartialEq, Eq)]
pub enum TurnOn {
    Register,
    /// Switched off in Login Items: only the user can allow it there.
    OpenLoginItems,
    Nothing,
    Unavailable,
}

pub fn toggle_on(state: LoginItemState) -> TurnOn {
    match state {
        LoginItemState::NotRegistered => TurnOn::Register,
        LoginItemState::RequiresApproval => TurnOn::OpenLoginItems,
        LoginItemState::Enabled => TurnOn::Nothing,
        LoginItemState::NotFound => TurnOn::Unavailable,
    }
}

/// The Settings toggle: registers or unregisters the login item and saves
/// the choice. Unregistering stops a daemon that the login item runs.
pub fn set(on: bool) -> Result<Service> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let file = app_toml();
    if !on {
        if matches!(
            sm::state(),
            LoginItemState::Enabled | LoginItemState::RequiresApproval
        ) {
            sm::unregister()?;
        }
        save_choice(&file, false)?;
        return Ok(status());
    }
    if !installed(&std::env::current_exe()?) {
        bail!(
            "Move moonlet to Applications first: macOS would start the daemon from where moonlet runs now."
        );
    }
    save_choice(&file, true)?;
    match toggle_on(sm::state()) {
        TurnOn::Register => {
            sm::register()?;
            if sm::state() == LoginItemState::RequiresApproval {
                sm::open_settings();
            }
        }
        TurnOn::OpenLoginItems => sm::open_settings(),
        TurnOn::Nothing => {}
        TurnOn::Unavailable => bail!("macOS cannot find moonlet's login item. Reinstall moonlet."),
    }
    Ok(status())
}

pub fn open_settings() {
    sm::open_settings();
}

#[cfg(target_os = "macos")]
mod sm {
    use anyhow::{Result, anyhow};
    use objc2::rc::Retained;
    use objc2_foundation::NSString;
    use objc2_service_management::{SMAppService, SMAppServiceStatus};

    use super::{LoginItemState, PLIST_NAME};

    fn service() -> Retained<SMAppService> {
        // SAFETY: plain class method taking a valid NSString.
        unsafe { SMAppService::agentServiceWithPlistName(&NSString::from_str(PLIST_NAME)) }
    }

    pub fn state() -> LoginItemState {
        // SAFETY: reads the service's status.
        match unsafe { service().status() } {
            SMAppServiceStatus::Enabled => LoginItemState::Enabled,
            SMAppServiceStatus::RequiresApproval => LoginItemState::RequiresApproval,
            SMAppServiceStatus::NotRegistered => LoginItemState::NotRegistered,
            _ => LoginItemState::NotFound,
        }
    }

    pub fn register() -> Result<()> {
        // SAFETY: registers the bundle's own agent; errors come back as NSError.
        unsafe { service().registerAndReturnError() }
            .map_err(|e| anyhow!("cannot add the login item: {}", e.localizedDescription()))
    }

    pub fn unregister() -> Result<()> {
        // SAFETY: as register.
        unsafe { service().unregisterAndReturnError() }
            .map_err(|e| anyhow!("cannot remove the login item: {}", e.localizedDescription()))
    }

    pub fn open_settings() {
        // SAFETY: opens System Settings › Login Items.
        unsafe { SMAppService::openSystemSettingsLoginItems() }
    }
}

#[cfg(not(target_os = "macos"))]
mod sm {
    use anyhow::{Result, bail};

    use super::LoginItemState;

    pub fn state() -> LoginItemState {
        LoginItemState::NotFound
    }
    pub fn register() -> Result<()> {
        bail!("login items are only available on macOS")
    }
    pub fn unregister() -> Result<()> {
        Ok(())
    }
    pub fn open_settings() {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const NOTHING: Launch = Launch {
        remove_old_plist: false,
        record: None,
        register: false,
    };

    #[test]
    fn the_app_hears_which_mechanism_runs_the_daemon_and_its_state() {
        let json = |s: Service| serde_json::to_value(s).unwrap();
        assert_eq!(
            json(Service::LoginItem {
                state: LoginItemState::RequiresApproval
            }),
            serde_json::json!({ "mechanism": "login_item", "state": "requires_approval" })
        );
        let plist = "/Users/alex/Library/LaunchAgents/dev.onedevstudio.moonlet.daemon.plist";
        let status = |installed: bool, loaded: bool| serde_json::json!({ "installed": installed, "loaded": loaded, "plist": plist });
        assert_eq!(
            json(Service::from_moonletd(&status(true, true)).unwrap()),
            serde_json::json!({ "mechanism": "plist", "state": "loaded", "plist": plist })
        );
        assert_eq!(
            json(Service::from_moonletd(&status(true, false)).unwrap()),
            serde_json::json!({ "mechanism": "plist", "state": "installed", "plist": plist })
        );
        assert_eq!(
            json(Service::from_moonletd(&status(false, false)).unwrap()),
            serde_json::json!({ "mechanism": "plist", "state": "not_installed", "plist": plist })
        );
    }

    #[test]
    fn a_first_launch_registers_the_login_item() {
        assert_eq!(
            on_launch(None, OldPlist::None, LoginItemState::NotRegistered),
            Launch {
                register: true,
                ..NOTHING
            }
        );
    }

    #[test]
    fn a_launch_leaves_the_login_item_alone_when_the_user_turned_it_off() {
        assert_eq!(
            on_launch(Some(false), OldPlist::None, LoginItemState::NotRegistered),
            NOTHING
        );
        // Turned off in System Settings › Login Items: only the user can allow it again.
        assert_eq!(
            on_launch(Some(true), OldPlist::None, LoginItemState::RequiresApproval),
            NOTHING
        );
        assert_eq!(
            on_launch(None, OldPlist::None, LoginItemState::RequiresApproval),
            NOTHING
        );
    }

    #[test]
    fn a_launch_does_nothing_when_the_login_item_is_already_on() {
        assert_eq!(
            on_launch(None, OldPlist::None, LoginItemState::Enabled),
            NOTHING
        );
        assert_eq!(
            on_launch(Some(true), OldPlist::None, LoginItemState::Enabled),
            NOTHING
        );
    }

    #[test]
    fn an_old_plist_that_sets_moonlet_home_is_told_apart() {
        let plain = "<dict>\n  <key>Label</key>\n  <string>dev.onedevstudio.moonlet.daemon</string>\n</dict>";
        let scratch = "<dict>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>MOONLET_HOME</key>\n    <string>/tmp/scratch</string>\n  </dict>\n</dict>";
        assert_eq!(OldPlist::from_text(plain), OldPlist::Ours);
        assert_eq!(OldPlist::from_text(scratch), OldPlist::CustomHome);
    }

    #[test]
    fn the_old_plist_stays_while_no_login_item_can_take_over() {
        // Switched off in Login Items, or unknown to macOS: nothing would
        // start the daemon at the next login without the old agent.
        assert_eq!(
            on_launch(None, OldPlist::Ours, LoginItemState::RequiresApproval),
            NOTHING
        );
        assert_eq!(
            on_launch(Some(true), OldPlist::Ours, LoginItemState::NotFound),
            NOTHING
        );
    }

    #[test]
    fn an_old_plist_with_its_own_moonlet_home_is_left_alone() {
        // A dev agent on a scratch home: the login item would run the
        // daemon on ~/.moonlet instead.
        assert_eq!(
            on_launch(
                Some(false),
                OldPlist::CustomHome,
                LoginItemState::NotRegistered
            ),
            NOTHING
        );
        assert_eq!(
            on_launch(None, OldPlist::CustomHome, LoginItemState::NotRegistered),
            Launch {
                register: true,
                ..NOTHING
            }
        );
    }

    #[test]
    fn the_old_plist_is_replaced_by_the_login_item_and_counts_as_on() {
        assert_eq!(
            on_launch(Some(false), OldPlist::Ours, LoginItemState::NotRegistered),
            Launch {
                remove_old_plist: true,
                record: Some(true),
                register: true
            }
        );
        assert_eq!(
            on_launch(None, OldPlist::Ours, LoginItemState::Enabled),
            Launch {
                remove_old_plist: true,
                record: Some(true),
                register: false
            }
        );
    }

    #[test]
    fn the_choice_is_kept_in_app_toml_and_missing_until_made() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("app.toml");
        assert_eq!(saved_choice(&file), None);
        save_choice(&file, false).unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "start_daemon_at_login = false\n"
        );
        assert_eq!(saved_choice(&file), Some(false));
        // Other keys survive a save.
        std::fs::write(&file, "theme = \"dark\"\nstart_daemon_at_login = false\n").unwrap();
        save_choice(&file, true).unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "start_daemon_at_login = true\ntheme = \"dark\"\n"
        );
        // A file that does not parse counts as no choice.
        std::fs::write(&file, "start_daemon_at_login = maybe").unwrap();
        assert_eq!(saved_choice(&file), None);
    }

    #[test]
    fn a_save_never_overwrites_an_app_toml_that_does_not_parse() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("app.toml");
        std::fs::write(&file, "theme = \"dark\"\nbroken =").unwrap();
        assert!(save_choice(&file, true).is_err());
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "theme = \"dark\"\nbroken ="
        );
    }

    #[test]
    fn turning_the_toggle_on_registers_or_sends_the_user_to_login_items() {
        assert_eq!(toggle_on(LoginItemState::NotRegistered), TurnOn::Register);
        assert_eq!(
            toggle_on(LoginItemState::RequiresApproval),
            TurnOn::OpenLoginItems
        );
        assert_eq!(toggle_on(LoginItemState::Enabled), TurnOn::Nothing);
        assert_eq!(toggle_on(LoginItemState::NotFound), TurnOn::Unavailable);
    }

    #[test]
    fn only_an_installed_app_registers_its_login_item() {
        let at = |p: &str| installed(Path::new(p));
        assert!(at("/Applications/moonlet.app/Contents/MacOS/moonlet-app"));
        assert!(at(
            "/Users/alex/Applications/moonlet.app/Contents/MacOS/moonlet-app"
        ));
        // Opened from the DMG, or moved by Gatekeeper's App Translocation.
        assert!(!at(
            "/Volumes/moonlet/moonlet.app/Contents/MacOS/moonlet-app"
        ));
        assert!(!at(
            "/private/var/folders/x1/abc/T/AppTranslocation/0F2A/d/moonlet.app/Contents/MacOS/moonlet-app"
        ));
    }

    #[test]
    fn the_agent_plist_is_looked_up_inside_the_running_bundle() {
        assert_eq!(
            bundled_agent(Path::new(
                "/Applications/moonlet.app/Contents/MacOS/moonlet-app"
            )),
            Some(PathBuf::from(
                "/Applications/moonlet.app/Contents/Library/LaunchAgents/dev.onedevstudio.moonlet.moonletd.plist"
            ))
        );
    }

    /// A key of the bundled agent plist, as `plutil` reads it.
    #[cfg(target_os = "macos")]
    fn key(path: &str) -> String {
        let plist = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("launchd/dev.onedevstudio.moonlet.moonletd.plist");
        let out = Command::new("plutil")
            .args(["-extract", path, "raw", "-o", "-"])
            .arg(&plist)
            .output()
            .expect("plutil runs");
        assert!(
            out.status.success(),
            "{path}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn the_bundled_agent_runs_the_bundles_moonletd_as_moonlet() {
        assert_eq!(key("Label"), "dev.onedevstudio.moonlet.moonletd");
        assert_eq!(key("BundleProgram"), "Contents/MacOS/moonletd");
        assert_eq!(key("ProgramArguments.0"), "moonletd");
        assert_eq!(key("ProgramArguments.1"), "daemon");
        assert_eq!(key("RunAtLoad"), "true");
        assert_eq!(key("KeepAlive.SuccessfulExit"), "false");
        assert_eq!(key("ProcessType"), "Interactive");
        assert_eq!(
            key("AssociatedBundleIdentifiers.0"),
            "dev.onedevstudio.moonlet"
        );
    }
}
