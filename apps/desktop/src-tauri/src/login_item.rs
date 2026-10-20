//! The daemon's login item (X56): a launch agent that ships inside
//! `moonlet.app` and that the app registers with `SMAppService`.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

const CHOICE: &str = "start_daemon_at_login";
/// The agent plist in `Contents/Library/LaunchAgents`.
const PLIST_NAME: &str = "dev.onedevstudio.moonlet.moonletd.plist";
/// The S1b agent that `moonletd service install` wrote.
const OLD_PLIST: &str = "Library/LaunchAgents/dev.onedevstudio.moonlet.daemon.plist";

/// `~/.moonlet/app.toml`, where the app keeps the user's choice.
pub fn app_toml() -> PathBuf {
    moonlet_core::paths::home().join("app.toml")
}

fn read_table(file: &Path) -> Option<toml::Table> {
    let text = std::fs::read_to_string(file).ok()?;
    toml::from_str(&text)
        .map_err(|e| tracing::warn!("{} does not parse: {e}", file.display()))
        .ok()
}

/// Whether the user wants the daemon to start at login, if they ever said.
pub fn saved_choice(file: &Path) -> Option<bool> {
    read_table(file)?.get(CHOICE)?.as_bool()
}

/// Saves the user's choice, keeping the file's other keys.
pub fn save_choice(file: &Path, on: bool) -> Result<()> {
    let mut table = read_table(file).unwrap_or_default();
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
pub enum State {
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
        state: State,
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

/// Decides the launch from the saved choice, whether the S1b plist is in
/// `~/Library/LaunchAgents`, and the login item's state. The login item is
/// on by default, and someone who had the S1b agent wanted it on.
pub fn on_launch(choice: Option<bool>, old_plist: bool, state: State) -> Launch {
    let on = old_plist || choice.unwrap_or(true);
    Launch {
        remove_old_plist: old_plist,
        record: old_plist.then_some(true),
        register: on && state == State::NotRegistered,
    }
}

/// Whether this app runs from a bundle that carries the agent: release and
/// `pnpm bundle` builds. Dev and e2e builds use the S1b plist instead.
pub fn bundled() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| {
            Some(
                exe.parent()?
                    .parent()?
                    .join("Library/LaunchAgents")
                    .join(PLIST_NAME),
            )
        })
        .is_some_and(|p| p.exists())
}

/// Registers the login item unless the user turned it off, and moves an
/// S1b agent over (X56). Errors are logged; the next launch tries again.
pub fn launch() {
    let old = dirs::home_dir().map(|h| h.join(OLD_PLIST));
    let had_old = old.as_ref().is_some_and(|p| p.exists());
    let plan = on_launch(saved_choice(&app_toml()), had_old, sm::state());
    if let Some(on) = plan.record {
        if let Err(e) = save_choice(&app_toml(), on) {
            tracing::warn!("cannot save the login item choice: {e:#}");
        }
    }
    if plan.register {
        if let Err(e) = sm::register() {
            // Keep the S1b agent until the login item takes over.
            tracing::warn!("cannot register the login item: {e:#}");
            return;
        }
    }
    if let (true, Some(old)) = (plan.remove_old_plist, old) {
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

/// The Settings toggle: saves the choice and registers or unregisters the
/// login item. Unregistering stops a daemon that the login item runs.
pub fn set(on: bool) -> Result<Service> {
    save_choice(&app_toml(), on)?;
    if on {
        if sm::state() != State::Enabled {
            sm::register()?;
        }
        // Switched off in Login Items: only the user can allow it there.
        if sm::state() == State::RequiresApproval {
            sm::open_settings();
        }
    } else if matches!(sm::state(), State::Enabled | State::RequiresApproval) {
        sm::unregister()?;
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

    use super::{PLIST_NAME, State};

    fn service() -> Retained<SMAppService> {
        // SAFETY: plain class method taking a valid NSString.
        unsafe { SMAppService::agentServiceWithPlistName(&NSString::from_str(PLIST_NAME)) }
    }

    pub fn state() -> State {
        // SAFETY: reads the service's status.
        match unsafe { service().status() } {
            SMAppServiceStatus::Enabled => State::Enabled,
            SMAppServiceStatus::RequiresApproval => State::RequiresApproval,
            SMAppServiceStatus::NotRegistered => State::NotRegistered,
            _ => State::NotFound,
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

    use super::State;

    pub fn state() -> State {
        State::NotFound
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
                state: State::RequiresApproval
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
            on_launch(None, false, State::NotRegistered),
            Launch {
                register: true,
                ..NOTHING
            }
        );
    }

    #[test]
    fn a_launch_leaves_the_login_item_alone_when_the_user_turned_it_off() {
        assert_eq!(on_launch(Some(false), false, State::NotRegistered), NOTHING);
        // Turned off in System Settings › Login Items: only the user can allow it again.
        assert_eq!(
            on_launch(Some(true), false, State::RequiresApproval),
            NOTHING
        );
        assert_eq!(on_launch(None, false, State::RequiresApproval), NOTHING);
    }

    #[test]
    fn a_launch_does_nothing_when_the_login_item_is_already_on() {
        assert_eq!(on_launch(None, false, State::Enabled), NOTHING);
        assert_eq!(on_launch(Some(true), false, State::Enabled), NOTHING);
    }

    #[test]
    fn the_old_plist_is_replaced_by_the_login_item_and_counts_as_on() {
        assert_eq!(
            on_launch(Some(false), true, State::NotRegistered),
            Launch {
                remove_old_plist: true,
                record: Some(true),
                register: true
            }
        );
        assert_eq!(
            on_launch(None, true, State::Enabled),
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

    /// A key of the bundled agent plist, as `plutil` reads it.
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
