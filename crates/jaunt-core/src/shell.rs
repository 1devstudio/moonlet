//! Shell integration (T3): zsh, bash and fish sessions emit OSC 133 prompt
//! marks and OSC 7 working-directory updates, after the user's own startup
//! files have run unchanged.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::Result;

const ZSH_HOOKS: &str = r#"
__jaunt_precmd() {
  local ret=$?
  if [[ -n $__jaunt_ran ]]; then printf '\e]133;D;%s\a' "$ret"; fi
  unset __jaunt_ran
  printf '\e]7;file://%s%s\a' "${HOST}" "${PWD// /%20}"
  printf '\e]133;A\a'
}
__jaunt_preexec() { printf '\e]133;C\a'; __jaunt_ran=1; }
autoload -Uz add-zsh-hook
add-zsh-hook precmd __jaunt_precmd
add-zsh-hook preexec __jaunt_preexec
"#;

/// One zsh startup file: run the user's version with their ZDOTDIR, then
/// point ZDOTDIR back at us so the next startup file is ours too.
fn zsh_file(name: &str, last_for_login: bool, add_hooks: bool) -> String {
    let mut s = format!(
        "# jaunt shell integration; runs the user's {name} unchanged.\n\
         JAUNT_ZDOTDIR=\"$ZDOTDIR\"\n\
         ZDOTDIR=\"${{JAUNT_USER_ZDOTDIR:-$HOME}}\"\n\
         [[ -f \"$ZDOTDIR/{name}\" ]] && source \"$ZDOTDIR/{name}\"\n\
         JAUNT_USER_ZDOTDIR=\"$ZDOTDIR\"\n\
         ZDOTDIR=\"$JAUNT_ZDOTDIR\"\n"
    );
    if add_hooks {
        s.push_str("if [[ -o interactive && -z $__jaunt_hooked ]]; then\n  __jaunt_hooked=1\n");
        s.push_str(ZSH_HOOKS);
        s.push_str("fi\n");
        // Non-login shells read nothing after .zshrc: hand ZDOTDIR back now.
        s.push_str("[[ -o login ]] || ZDOTDIR=\"$JAUNT_USER_ZDOTDIR\"\n");
    }
    if last_for_login {
        s.push_str("ZDOTDIR=\"$JAUNT_USER_ZDOTDIR\"\n");
    }
    s
}

const BASH_RC: &str = r#"# jaunt shell integration for bash: login semantics, then hooks.
[ -f /etc/profile ] && . /etc/profile
if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
elif [ -f "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
elif [ -f "$HOME/.profile" ]; then . "$HOME/.profile"
fi
case "$-" in *i*) [ -z "$__jaunt_bashrc_done" ] && [ -f "$HOME/.bashrc" ] && ! grep -q bashrc "$HOME/.bash_profile" 2>/dev/null && . "$HOME/.bashrc" ;; esac
__jaunt_prompt() {
  local ret=$?
  if [ -n "$__jaunt_ran" ]; then printf '\e]133;D;%s\a' "$ret"; fi
  __jaunt_ran=
  printf '\e]7;file://%s%s\a' "$HOSTNAME" "${PWD// /%20}"
  printf '\e]133;A\a'
  __jaunt_armed=1
}
__jaunt_debug() {
  [ -n "$__jaunt_armed" ] || return 0
  case "$BASH_COMMAND" in __jaunt_*) return 0 ;; esac
  __jaunt_armed=
  __jaunt_ran=1
  printf '\e]133;C\a'
}
trap '__jaunt_debug' DEBUG
PROMPT_COMMAND="__jaunt_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
"#;

const FISH_CONF: &str = r#"# jaunt shell integration for fish
if status is-interactive
  function __jaunt_prompt --on-event fish_prompt
    if set -q __jaunt_ran
      printf '\e]133;D;%s\a' $__jaunt_status
      set -e __jaunt_ran
    end
    printf '\e]7;file://%s%s\a' (hostname) (string replace -a ' ' '%20' -- $PWD)
    printf '\e]133;A\a'
  end
  function __jaunt_preexec --on-event fish_preexec
    printf '\e]133;C\a'
    set -g __jaunt_ran 1
  end
  function __jaunt_postexec --on-event fish_postexec
    set -g __jaunt_status $status
  end
end
"#;

pub fn dir() -> PathBuf {
    crate::paths::home().join("shell")
}

fn write_if_changed(path: &Path, content: &str) -> Result<()> {
    if std::fs::read_to_string(path).ok().as_deref() == Some(content) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(())
}

/// Writes the integration scripts (idempotent).
pub fn install(root: &Path) -> Result<()> {
    let zsh = root.join("zsh");
    write_if_changed(&zsh.join(".zshenv"), &zsh_file(".zshenv", false, false))?;
    write_if_changed(&zsh.join(".zprofile"), &zsh_file(".zprofile", false, false))?;
    write_if_changed(&zsh.join(".zshrc"), &zsh_file(".zshrc", false, true))?;
    write_if_changed(&zsh.join(".zlogin"), &zsh_file(".zlogin", true, false))?;
    write_if_changed(&root.join("bash").join("rc"), BASH_RC)?;
    write_if_changed(
        &root
            .join("data")
            .join("fish")
            .join("vendor_conf.d")
            .join("jaunt.fish"),
        FISH_CONF,
    )?;
    Ok(())
}

/// Adjusts argv and env so an interactive shell loads the integration.
/// Returns the args unchanged for unknown shells or when disabled.
pub fn apply(
    root: &Path,
    program: &str,
    args: Vec<String>,
    env: &mut BTreeMap<String, String>,
) -> Vec<String> {
    if env.get("JAUNT_SHELL_INTEGRATION").map(String::as_str) == Some("0") || install(root).is_err()
    {
        return args;
    }
    let name = program.rsplit('/').next().unwrap_or(program);
    match name {
        "zsh" => {
            if let Some(user) = env.get("ZDOTDIR").cloned() {
                env.insert("JAUNT_USER_ZDOTDIR".into(), user);
            }
            env.insert("ZDOTDIR".into(), root.join("zsh").display().to_string());
            args
        }
        "bash" => {
            // A login bash ignores --rcfile; our rc reproduces login startup itself.
            let rest: Vec<String> = args
                .into_iter()
                .filter(|a| a != "-l" && a != "--login")
                .collect();
            let mut out = vec![
                "--rcfile".to_string(),
                root.join("bash").join("rc").display().to_string(),
                "-i".into(),
            ];
            out.extend(rest);
            out
        }
        "fish" => {
            let ours = root.join("data").display().to_string();
            let existing = env
                .get("XDG_DATA_DIRS")
                .cloned()
                .unwrap_or_else(|| "/usr/local/share:/usr/share".into());
            env.insert("XDG_DATA_DIRS".into(), format!("{ours}:{existing}"));
            args
        }
        _ => args,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::TerminalManager;
    use jaunt_proto::Frame;
    use jaunt_proto::methods::TerminalCreate;
    use std::time::Duration;

    async fn run_shell(shell: &str) -> Option<String> {
        if !Path::new(shell).exists() {
            return None;
        }
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("shell");
        let mut env: BTreeMap<String, String> = BTreeMap::from([
            ("HOME".into(), home.path().display().to_string()),
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("SHELL".into(), shell.into()),
        ]);
        let args = apply(&root, shell, vec!["-l".into()], &mut env);
        let mgr = TerminalManager::new(home.path().join("s.sock"), env);
        let mut command = vec![shell.to_string()];
        command.extend(args);
        let info = mgr
            .create(TerminalCreate {
                cwd: home.path().display().to_string(),
                command,
                ..Default::default()
            })
            .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        mgr.attach(info.id, 1, tx, None).unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;
        mgr.write(info.id, b"false\n".to_vec()).unwrap();
        let mut out = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !out.contains("133;D;1") {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(Frame::Output { data, .. })) => {
                    out.push_str(&String::from_utf8_lossy(&data))
                }
                _ => break,
            }
        }
        // Let the next prompt's marks reach the terminal state.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let prompt = mgr.get(info.id).map(|t| t.info().prompt);
        let _ = mgr.kill(info.id, true);
        assert_eq!(prompt, Some(Some(true)), "back at a prompt after `false`");
        Some(out)
    }

    #[tokio::test]
    async fn zsh_emits_prompt_marks_and_cwd() {
        let Some(out) = run_shell("/bin/zsh").await else {
            return;
        };
        assert!(out.contains("\x1b]133;A\x07"), "prompt mark: {out:?}");
        assert!(out.contains("\x1b]133;C\x07"), "output mark: {out:?}");
        assert!(
            out.contains("\x1b]133;D;1\x07"),
            "exit status of `false`: {out:?}"
        );
        assert!(out.contains("\x1b]7;file://"), "cwd: {out:?}");
    }

    #[tokio::test]
    async fn bash_emits_prompt_marks_and_cwd() {
        let Some(out) = run_shell("/bin/bash").await else {
            return;
        };
        assert!(out.contains("\x1b]133;A\x07"), "prompt mark: {out:?}");
        assert!(out.contains("\x1b]133;D;1\x07"), "exit status: {out:?}");
        assert!(out.contains("\x1b]7;file://"), "cwd: {out:?}");
    }

    #[test]
    fn opt_out_and_unknown_shells() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = BTreeMap::from([("JAUNT_SHELL_INTEGRATION".to_string(), "0".to_string())]);
        assert_eq!(
            apply(dir.path(), "/bin/zsh", vec!["-l".into()], &mut env),
            vec!["-l"]
        );
        assert!(!env.contains_key("ZDOTDIR"));
        let mut env = BTreeMap::new();
        assert_eq!(
            apply(dir.path(), "/usr/bin/nu", vec!["-l".into()], &mut env),
            vec!["-l"]
        );
        let mut env = BTreeMap::from([("ZDOTDIR".to_string(), "/u/z".to_string())]);
        apply(dir.path(), "/bin/zsh", vec![], &mut env);
        assert_eq!(env["JAUNT_USER_ZDOTDIR"], "/u/z");
        assert!(dir.path().join("zsh/.zshrc").exists());
        assert!(
            dir.path()
                .join("data/fish/vendor_conf.d/jaunt.fish")
                .exists()
        );
    }
}
