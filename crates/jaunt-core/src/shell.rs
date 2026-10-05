//! Shell integration (T3): zsh, bash and fish sessions emit OSC 133 prompt
//! marks and OSC 7 working-directory updates, after the user's own startup
//! files have run unchanged.
//!
//! Warp mode (T7): when `$JAUNT_CLASSIC_FILE` is set and that file does not
//! exist, the shell draws an empty prompt because the app's editor is the
//! input. The user's prompt is kept and comes back in classic mode.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::Result;

const ZSH_HOOKS: &str = r#"
__jaunt_precmd() {
  local ret=$?
  if [[ -n $__jaunt_ran ]]; then printf '\e]133;D;%s\a' "$ret"; fi
  unset __jaunt_ran
  __jaunt_urlpath "$PWD"
  printf '\e]7;file://%s%s\a' "${HOST}" "$REPLY"
  printf '\e]133;A\a'
}
__jaunt_preexec() { printf '\e]133;C\a'; __jaunt_ran=1; }
# Percent-encodes a path for OSC 7 (into $REPLY), byte by byte.
__jaunt_urlpath() {
  emulate -L zsh
  local LC_ALL=C s=$1 out= c i
  for (( i = 1; i <= ${#s}; i++ )); do
    c=$s[i]
    case $c in
      ([a-zA-Z0-9/._~-]) out+=$c ;;
      (*) printf -v c '%%%02X' "'$c"; out+=$c ;;
    esac
  done
  REPLY=$out
}
# Warp mode's prompt is one empty row, where the app draws the block
# header (T8); the command line is drawn bold.
__jaunt_warp_ps1=$'\n'
__jaunt_blank() {
  if [[ -n $JAUNT_CLASSIC_FILE && ! -e $JAUNT_CLASSIC_FILE ]]; then
    [[ $PROMPT != "$__jaunt_warp_ps1" ]] && __jaunt_ps1=$PROMPT
    [[ -n $RPROMPT ]] && __jaunt_rps1=$RPROMPT
    [[ -n $PS2 ]] && __jaunt_ps2=$PS2
    [[ -z $__jaunt_blanked ]] && __jaunt_zlehl=("${zle_highlight[@]}")
    PROMPT=$__jaunt_warp_ps1 RPROMPT='' PS2=''
    zle_highlight=("${(@)__jaunt_zlehl:#default:*}" default:bold)
    __jaunt_blanked=1
  elif [[ -n $__jaunt_blanked ]]; then
    PROMPT=$__jaunt_ps1 RPROMPT=$__jaunt_rps1 PS2=$__jaunt_ps2
    zle_highlight=("${__jaunt_zlehl[@]}")
    unset __jaunt_blanked
  fi
  # Stay last, after hooks that themes add later.
  precmd_functions=(${precmd_functions:#__jaunt_blank} __jaunt_blank)
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __jaunt_precmd
add-zsh-hook preexec __jaunt_preexec
add-zsh-hook precmd __jaunt_blank
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
  # Bold left on by an empty command line in Warp mode.
  printf '\e[0m'
  if [ -n "$__jaunt_ran" ]; then printf '\e]133;D;%s\a' "$ret"; fi
  __jaunt_ran=
  __jaunt_urlpath "$PWD"
  printf '\e]7;file://%s%s\a' "$HOSTNAME" "$__jaunt_url"
  printf '\e]133;A\a'
}
# Warp mode's prompt is one empty row, where the app draws the block
# header (T8), and leaves bold on for the command line; the DEBUG trap
# resets it before the command's output.
__jaunt_warp_ps1='\n\[\e[1m\]'
__jaunt_blank() {
  if [ -n "$JAUNT_CLASSIC_FILE" ] && [ ! -e "$JAUNT_CLASSIC_FILE" ]; then
    [ "$PS1" != "$__jaunt_warp_ps1" ] && __jaunt_ps1=$PS1
    [ -n "$PS2" ] && __jaunt_ps2=$PS2
    PS1=$__jaunt_warp_ps1 PS2=''
    __jaunt_blanked=1
  elif [ -n "$__jaunt_blanked" ]; then
    PS1=$__jaunt_ps1 PS2=$__jaunt_ps2
    __jaunt_blanked=
  fi
  # Armed last, so the user's PROMPT_COMMAND parts do not count as a command.
  __jaunt_armed=1
}
# Percent-encodes a path for OSC 7 (into $__jaunt_url), byte by byte.
__jaunt_urlpath() {
  local LC_ALL=C s=$1 out= c i
  for (( i = 0; i < ${#s}; i++ )); do
    c=${s:i:1}
    case $c in
      [a-zA-Z0-9/._~-]) out+=$c ;;
      *) printf -v c '%%%02X' "'$c"; out+=$c ;;
    esac
  done
  __jaunt_url=$out
}
# A DEBUG trap the user's startup files set keeps running (bash allows one).
__jaunt_user_debug=
__jaunt_capture_trap() { __jaunt_user_debug=$1; }
__jaunt_prev_trap=$(trap -p DEBUG)
[ -n "$__jaunt_prev_trap" ] && eval "__jaunt_capture_trap ${__jaunt_prev_trap#trap -- }"
unset __jaunt_prev_trap
__jaunt_debug() {
  local ret=$? user=0
  if [ -n "$__jaunt_user_debug" ]; then
    # The user's trap sees the real $? and its result is kept (extdebug).
    (exit $ret)
    eval "$__jaunt_user_debug"
    user=$?
  fi
  [ -n "$__jaunt_armed" ] || return $user
  case "$BASH_COMMAND" in __jaunt_*) return 0 ;; esac
  __jaunt_armed=
  __jaunt_ran=1
  printf '\e[0m\e]133;C\a'
  return $user
}
trap '__jaunt_debug' DEBUG
PROMPT_COMMAND="__jaunt_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}; __jaunt_blank"
"#;

const FISH_CONF: &str = r#"# jaunt shell integration for fish
if status is-interactive
  function __jaunt_prompt --on-event fish_prompt
    if set -q __jaunt_ran
      printf '\e]133;D;%s\a' $__jaunt_status
      set -e __jaunt_ran
    end
    printf '\e]7;file://%s%s\a' (hostname) (string escape --style=url -- $PWD)
    printf '\e]133;A\a'
    # Wrap the user's prompt once, so Warp mode can blank it (T7).
    if not functions -q __jaunt_user_fish_prompt
      functions -q fish_prompt; and functions -c fish_prompt __jaunt_user_fish_prompt
      functions -q fish_right_prompt; and functions -c fish_right_prompt __jaunt_user_fish_right_prompt
      functions -q fish_mode_prompt; and functions -c fish_mode_prompt __jaunt_user_fish_mode_prompt
      # Each wrapper hands the user's prompt the last command's $status.
      function fish_prompt
        set -l s $status
        if not __jaunt_classic
          # One empty row, where the app draws the block header (T8).
          printf '\n'
        else if functions -q __jaunt_user_fish_prompt
          __jaunt_status $s; __jaunt_user_fish_prompt
        end
      end
      function fish_right_prompt
        set -l s $status
        if __jaunt_classic; and functions -q __jaunt_user_fish_right_prompt
          __jaunt_status $s; __jaunt_user_fish_right_prompt
        end
      end
      function fish_mode_prompt
        set -l s $status
        if __jaunt_classic; and functions -q __jaunt_user_fish_mode_prompt
          __jaunt_status $s; __jaunt_user_fish_mode_prompt
        end
      end
    end
  end
  function __jaunt_status
    return $argv[1]
  end
  function __jaunt_classic
    test -z "$JAUNT_CLASSIC_FILE"; or test -e "$JAUNT_CLASSIC_FILE"
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

    /// Output until `needle` shows up (or a timeout).
    async fn read_until(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<Frame>,
        needle: &str,
    ) -> String {
        let mut out = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !out.contains(needle) {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(Frame::Output { data, .. })) => {
                    out.push_str(&String::from_utf8_lossy(&data))
                }
                _ => break,
            }
        }
        out
    }

    /// Warp mode hides the user's prompt; the classic marker brings it back.
    async fn blanks_and_restores(shell: &str, rc: &str, rc_body: &str) {
        if !Path::new(shell).exists() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join(rc), rc_body).unwrap();
        let root = home.path().join("shell");
        let marker = home.path().join("classic");
        let mut env: BTreeMap<String, String> = BTreeMap::from([
            ("HOME".into(), home.path().display().to_string()),
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("SHELL".into(), shell.into()),
            ("JAUNT_CLASSIC_FILE".into(), marker.display().to_string()),
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
        mgr.write(info.id, b"echo hi\n".to_vec()).unwrap();
        let warp = read_until(&mut rx, "133;D;0").await;
        let warp = warp + &read_until(&mut rx, "133;A").await;
        assert!(warp.contains("hi"), "{shell}: {warp:?}");
        assert!(!warp.contains("USERPROMPT"), "{shell} blanked: {warp:?}");

        std::fs::write(&marker, b"").unwrap();
        mgr.write(info.id, b"\n".to_vec()).unwrap();
        let classic = read_until(&mut rx, "USERPROMPT").await;
        let _ = mgr.kill(info.id, true);
        assert!(classic.contains("USERPROMPT"), "{shell} classic: {classic:?}");
    }

    #[tokio::test]
    async fn zsh_warp_mode_blanks_the_prompt() {
        blanks_and_restores("/bin/zsh", ".zshrc", "PROMPT='USERPROMPT> '\n").await;
    }

    #[tokio::test]
    async fn bash_warp_mode_blanks_the_prompt() {
        blanks_and_restores("/bin/bash", ".bash_profile", "PS1='USERPROMPT> '\n").await;
    }

    /// Warp mode (T8): each command gets an empty header row above it, and
    /// the command line is bold while its output is not.
    async fn warp_screen(shell: &str) -> Option<crate::term::TermState> {
        if !Path::new(shell).exists() {
            return None;
        }
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("shell");
        let mut env: BTreeMap<String, String> = BTreeMap::from([
            ("HOME".into(), home.path().display().to_string()),
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("SHELL".into(), shell.into()),
            ("JAUNT_CLASSIC_FILE".into(), home.path().join("classic").display().to_string()),
        ]);
        let args = apply(&root, shell, vec!["-l".into()], &mut env);
        let mgr = TerminalManager::new(home.path().join("s.sock"), env);
        let mut command = vec![shell.to_string()];
        command.extend(args);
        let info = mgr
            .create(TerminalCreate {
                cwd: home.path().display().to_string(),
                command,
                cols: 80,
                rows: 24,
                ..Default::default()
            })
            .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        mgr.attach(info.id, 1, tx, None).unwrap();
        let mut out = read_until(&mut rx, "133;A").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        mgr.write(info.id, b"echo one\n".to_vec()).unwrap();
        out += &read_until(&mut rx, "133;D;0").await;
        out += &read_until(&mut rx, "133;A").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        mgr.write(info.id, b"echo two\n".to_vec()).unwrap();
        out += &read_until(&mut rx, "133;D;0").await;
        out += &read_until(&mut rx, "133;A").await;
        let _ = mgr.kill(info.id, true);
        let mut term = crate::term::TermState::new(24, 80);
        term.process(out.as_bytes());
        Some(term)
    }

    fn assert_warp_blocks(shell: &str, term: &crate::term::TermState) {
        let text = term.contents();
        assert!(text.contains("echo one\none\n\necho two\ntwo"), "{shell} header rows: {text:?}");
        let screen = term.screen();
        let row = |needle: &str| {
            (0..24u16)
                .find(|&r| screen.contents_between(r, 0, r, 80).trim_end() == needle)
                .unwrap_or_else(|| panic!("{shell}: no row {needle:?} in {text:?}"))
        };
        assert!(screen.cell(row("echo two"), 0).unwrap().bold(), "{shell}: command is bold");
        assert!(!screen.cell(row("two"), 0).unwrap().bold(), "{shell}: output is not bold");
    }

    #[tokio::test]
    async fn zsh_warp_mode_gives_each_command_a_header_row_and_bold_command() {
        if let Some(term) = warp_screen("/bin/zsh").await {
            assert_warp_blocks("zsh", &term);
        }
    }

    #[tokio::test]
    async fn bash_warp_mode_gives_each_command_a_header_row_and_bold_command() {
        if let Some(term) = warp_screen("/bin/bash").await {
            assert_warp_blocks("bash", &term);
        }
    }

    /// Runs `commands` in an integrated shell whose rc file holds `rc_body`.
    async fn session_output(shell: &str, rc: &str, rc_body: &str, commands: &str, until: &str) -> Option<String> {
        if !Path::new(shell).exists() {
            return None;
        }
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join(rc), rc_body).unwrap();
        std::fs::create_dir_all(home.path().join("a%b c")).unwrap();
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
            .create(TerminalCreate { cwd: home.path().display().to_string(), command, ..Default::default() })
            .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        mgr.attach(info.id, 1, tx, None).unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;
        mgr.write(info.id, commands.as_bytes().to_vec()).unwrap();
        let out = read_until(&mut rx, until).await;
        let _ = mgr.kill(info.id, true);
        Some(out)
    }

    #[tokio::test]
    async fn cwd_reports_are_fully_percent_encoded() {
        for (shell, rc) in [("/bin/zsh", ".zshrc"), ("/bin/bash", ".bash_profile")] {
            let Some(out) = session_output(shell, rc, "", "cd 'a%b c'\n", "a%25b%20c").await else {
                continue;
            };
            assert!(out.contains("a%25b%20c"), "{shell}: {out:?}");
        }
    }

    #[tokio::test]
    async fn bash_keeps_the_users_debug_trap() {
        let Some(out) = session_output(
            "/bin/bash",
            ".bash_profile",
            "trap 'printf USERTRAP' DEBUG\n",
            "true\n",
            "133;D;0",
        )
        .await
        else {
            return;
        };
        assert!(out.contains("USERTRAP"), "{out:?}");
        assert!(out.contains("133;C"), "jaunt's own mark still works: {out:?}");
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
