//! Shell integration (T3): zsh, bash and fish sessions emit OSC 133 prompt
//! marks and OSC 7 working-directory updates, after the user's own startup
//! files have run unchanged.
//!
//! Blocks mode (T7): when `$MOONLET_CLASSIC_FILE` is set and that file does not
//! exist, the shell draws an empty prompt because the app's editor is the
//! input. The user's prompt is kept and comes back in classic mode.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::Result;

const ZSH_HOOKS: &str = r#"
__moonlet_precmd() {
  local ret=$?
  if [[ -n $__moonlet_ran ]]; then printf '\e]133;D;%s\a' "$ret"; fi
  unset __moonlet_ran
  __moonlet_urlpath "$PWD"
  printf '\e]7;file://%s%s\a' "${HOST}" "$REPLY"
  # Where `node` is, for the editor's chips (T8), only when that changes.
  # Never run it: PATH may point into an untrusted checkout. The daemon
  # reads the version from the install. A relative entry is skipped.
  # The shell's PATH, for the commands the editor colours as known (T8).
  if [[ $PATH != ${__moonlet_path-} ]]; then
    __moonlet_path=$PATH
    printf '\e]1337;MoonletPath=%s\a' "$PATH"
  fi
  local node=${commands[node]-}
  [[ $node == /* ]] || node=
  if [[ $node != ${__moonlet_node-} ]]; then
    __moonlet_node=$node
    printf '\e]1337;MoonletNodePath=%s\a' "$node"
  fi
  printf '\e]133;A\a'
}
# The command line, for an agent reading the terminal (X31), then the mark.
__moonlet_preexec() {
  __moonlet_urlpath "$1"
  printf '\e]1337;MoonletCommand=%s\a\e]133;C\a' "$REPLY"
  __moonlet_ran=1
}
# Percent-encodes a path for OSC 7 (into $REPLY), byte by byte.
__moonlet_urlpath() {
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
# Blocks mode's prompt is two empty rows, where the app draws the block's
# separator and header (T8); the command line is drawn bold.
__moonlet_blocks_ps1=$'\n\n'
__moonlet_blank() {
  if [[ -n $MOONLET_CLASSIC_FILE && ! -e $MOONLET_CLASSIC_FILE ]]; then
    [[ $PROMPT != "$__moonlet_blocks_ps1" ]] && __moonlet_ps1=$PROMPT
    [[ -n $RPROMPT ]] && __moonlet_rps1=$RPROMPT
    [[ -n $PS2 ]] && __moonlet_ps2=$PS2
    [[ -z $__moonlet_blanked ]] && __moonlet_zlehl=("${zle_highlight[@]}")
    PROMPT=$__moonlet_blocks_ps1 RPROMPT='' PS2=''
    zle_highlight=("${(@)__moonlet_zlehl:#default:*}" default:bold)
    __moonlet_blanked=1
  elif [[ -n $__moonlet_blanked ]]; then
    PROMPT=$__moonlet_ps1 RPROMPT=$__moonlet_rps1 PS2=$__moonlet_ps2
    zle_highlight=("${__moonlet_zlehl[@]}")
    unset __moonlet_blanked
  fi
  # Stay last, after hooks that themes add later.
  precmd_functions=(${precmd_functions:#__moonlet_blank} __moonlet_blank)
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __moonlet_precmd
add-zsh-hook preexec __moonlet_preexec
add-zsh-hook precmd __moonlet_blank
"#;

/// One zsh startup file: run the user's version with their ZDOTDIR, then
/// point ZDOTDIR back at us so the next startup file is ours too.
fn zsh_file(name: &str, last_for_login: bool, add_hooks: bool) -> String {
    let mut s = format!(
        "# moonlet shell integration; runs the user's {name} unchanged.\n\
         MOONLET_ZDOTDIR=\"$ZDOTDIR\"\n\
         ZDOTDIR=\"${{MOONLET_USER_ZDOTDIR:-$HOME}}\"\n\
         [[ -f \"$ZDOTDIR/{name}\" ]] && source \"$ZDOTDIR/{name}\"\n\
         MOONLET_USER_ZDOTDIR=\"$ZDOTDIR\"\n\
         ZDOTDIR=\"$MOONLET_ZDOTDIR\"\n"
    );
    if add_hooks {
        s.push_str("if [[ -o interactive && -z $__moonlet_hooked ]]; then\n  __moonlet_hooked=1\n");
        s.push_str(ZSH_HOOKS);
        s.push_str("fi\n");
        // Non-login shells read nothing after .zshrc: hand ZDOTDIR back now.
        s.push_str("[[ -o login ]] || ZDOTDIR=\"$MOONLET_USER_ZDOTDIR\"\n");
    }
    if last_for_login {
        s.push_str("ZDOTDIR=\"$MOONLET_USER_ZDOTDIR\"\n");
    }
    s
}

const BASH_RC: &str = r#"# moonlet shell integration for bash: login semantics, then hooks.
[ -f /etc/profile ] && . /etc/profile
if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
elif [ -f "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
elif [ -f "$HOME/.profile" ]; then . "$HOME/.profile"
fi
case "$-" in *i*) [ -z "$__moonlet_bashrc_done" ] && [ -f "$HOME/.bashrc" ] && ! grep -q bashrc "$HOME/.bash_profile" 2>/dev/null && . "$HOME/.bashrc" ;; esac
__moonlet_prompt() {
  local ret=$?
  # Bold left on by an empty command line in Blocks mode.
  printf '\e[0m'
  if [ -n "$__moonlet_ran" ]; then printf '\e]133;D;%s\a' "$ret"; fi
  __moonlet_ran=
  __moonlet_urlpath "$PWD"
  printf '\e]7;file://%s%s\a' "$HOSTNAME" "$__moonlet_url"
  # Where `node` is, for the editor's chips (T8), only when that changes.
  # Never run it: PATH may point into an untrusted checkout. The daemon
  # reads the version from the install. A relative entry is skipped.
  # The shell's PATH, for the commands the editor colours as known (T8).
  if [ "$PATH" != "${__moonlet_path-}" ]; then
    __moonlet_path=$PATH
    printf '\e]1337;MoonletPath=%s\a' "$PATH"
  fi
  local node
  node=$(type -P node 2>/dev/null)
  case $node in /*) ;; *) node= ;; esac
  if [ "$node" != "${__moonlet_node-}" ]; then
    __moonlet_node=$node
    printf '\e]1337;MoonletNodePath=%s\a' "$node"
  fi
  printf '\e]133;A\a'
}
# Blocks mode's prompt is two empty rows, where the app draws the block's
# separator and header (T8), and leaves bold on for the command line; the
# DEBUG trap resets it before the command's output.
__moonlet_blocks_ps1='\n\n\[\e[1m\]'
__moonlet_blank() {
  if [ -n "$MOONLET_CLASSIC_FILE" ] && [ ! -e "$MOONLET_CLASSIC_FILE" ]; then
    [ "$PS1" != "$__moonlet_blocks_ps1" ] && __moonlet_ps1=$PS1
    [ -n "$PS2" ] && __moonlet_ps2=$PS2
    PS1=$__moonlet_blocks_ps1 PS2=''
    __moonlet_blanked=1
  elif [ -n "$__moonlet_blanked" ]; then
    PS1=$__moonlet_ps1 PS2=$__moonlet_ps2
    __moonlet_blanked=
  fi
  # Armed last, so the user's PROMPT_COMMAND parts do not count as a command.
  __moonlet_armed=1
}
# Percent-encodes a path for OSC 7 (into $__moonlet_url), byte by byte.
__moonlet_urlpath() {
  local LC_ALL=C s=$1 out= c i
  for (( i = 0; i < ${#s}; i++ )); do
    c=${s:i:1}
    case $c in
      [a-zA-Z0-9/._~-]) out+=$c ;;
      *) printf -v c '%%%02X' "'$c"; out+=$c ;;
    esac
  done
  __moonlet_url=$out
}
# A DEBUG trap the user's startup files set keeps running (bash allows one).
__moonlet_user_debug=
__moonlet_capture_trap() { __moonlet_user_debug=$1; }
__moonlet_prev_trap=$(trap -p DEBUG)
[ -n "$__moonlet_prev_trap" ] && eval "__moonlet_capture_trap ${__moonlet_prev_trap#trap -- }"
unset __moonlet_prev_trap
__moonlet_debug() {
  local ret=$? user=0
  if [ -n "$__moonlet_user_debug" ]; then
    # The user's trap sees the real $? and its result is kept (extdebug).
    (exit $ret)
    eval "$__moonlet_user_debug"
    user=$?
  fi
  [ -n "$__moonlet_armed" ] || return $user
  case "$BASH_COMMAND" in __moonlet_*) return 0 ;; esac
  __moonlet_armed=
  __moonlet_ran=1
  # The command (first of a pipeline) for an agent reading the terminal (X31).
  __moonlet_urlpath "$BASH_COMMAND"
  printf '\e[0m\e]1337;MoonletCommand=%s\a\e]133;C\a' "$__moonlet_url"
  return $user
}
trap '__moonlet_debug' DEBUG
PROMPT_COMMAND="__moonlet_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}; __moonlet_blank"
"#;

const FISH_CONF: &str = r#"# moonlet shell integration for fish
if status is-interactive
  function __moonlet_prompt --on-event fish_prompt
    if set -q __moonlet_ran
      printf '\e]133;D;%s\a' $__moonlet_status
      set -e __moonlet_ran
    end
    printf '\e]7;file://%s%s\a' (hostname) (string escape --style=url -- $PWD)
    # Where `node` is, for the editor's chips (T8), only when that changes.
    # Never run it: PATH may point into an untrusted checkout. The daemon
    # reads the version from the install. A relative entry is skipped.
    # The shell's PATH, for the commands the editor colours as known (T8).
    set -l path (string join : $PATH)
    if test "$path" != "$__moonlet_path"
      set -g __moonlet_path $path
      printf '\e]1337;MoonletPath=%s\a' "$path"
    end
    set -l node (command -s node)
    string match -q '/*' -- "$node"; or set node ''
    if test "$node" != "$__moonlet_node"
      set -g __moonlet_node $node
      printf '\e]1337;MoonletNodePath=%s\a' "$node"
    end
    printf '\e]133;A\a'
    # Wrap the user's prompt once, so Blocks mode can blank it (T7).
    if not functions -q __moonlet_user_fish_prompt
      functions -q fish_prompt; and functions -c fish_prompt __moonlet_user_fish_prompt
      functions -q fish_right_prompt; and functions -c fish_right_prompt __moonlet_user_fish_right_prompt
      functions -q fish_mode_prompt; and functions -c fish_mode_prompt __moonlet_user_fish_mode_prompt
      # Each wrapper hands the user's prompt the last command's $status.
      function fish_prompt
        set -l s $status
        if not __moonlet_classic
          # Two empty rows, for the block's separator and header (T8).
          printf '\n\n'
        else if functions -q __moonlet_user_fish_prompt
          __moonlet_status $s; __moonlet_user_fish_prompt
        end
      end
      function fish_right_prompt
        set -l s $status
        if __moonlet_classic; and functions -q __moonlet_user_fish_right_prompt
          __moonlet_status $s; __moonlet_user_fish_right_prompt
        end
      end
      function fish_mode_prompt
        set -l s $status
        if __moonlet_classic; and functions -q __moonlet_user_fish_mode_prompt
          __moonlet_status $s; __moonlet_user_fish_mode_prompt
        end
      end
    end
  end
  function __moonlet_status
    return $argv[1]
  end
  function __moonlet_classic
    test -z "$MOONLET_CLASSIC_FILE"; or test -e "$MOONLET_CLASSIC_FILE"
  end
  function __moonlet_preexec --on-event fish_preexec
    # The command line, for an agent reading the terminal (X31).
    printf '\e]1337;MoonletCommand=%s\a' (string escape --style=url -- $argv[1])
    printf '\e]133;C\a'
    set -g __moonlet_ran 1
  end
  function __moonlet_postexec --on-event fish_postexec
    set -g __moonlet_status $status
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
    let fish = root.join("data").join("fish").join("vendor_conf.d");
    write_if_changed(&fish.join("moonlet.fish"), FISH_CONF)?;
    // jaunt's copy, moved here with ~/.jaunt (X27): fish would load both.
    match std::fs::remove_file(fish.join("jaunt.fish")) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
        _ => {}
    }
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
    if env.get("MOONLET_SHELL_INTEGRATION").map(String::as_str) == Some("0") || install(root).is_err()
    {
        return args;
    }
    let name = program.rsplit('/').next().unwrap_or(program);
    match name {
        "zsh" => {
            if let Some(user) = env.get("ZDOTDIR").cloned() {
                env.insert("MOONLET_USER_ZDOTDIR".into(), user);
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
    use moonlet_proto::Frame;
    use moonlet_proto::methods::TerminalCreate;
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

    /// X31: the command line is reported before its output, percent-encoded.
    #[tokio::test]
    async fn shells_report_the_command_line_before_its_output() {
        for shell in ["/bin/zsh", "/bin/bash", "/opt/homebrew/bin/fish"] {
            let Some(out) = run_shell(shell).await else {
                continue;
            };
            assert!(
                out.contains("\x1b]1337;MoonletCommand=false\x07\x1b]133;C\x07")
                    || out.contains("\x1b]1337;MoonletCommand=false\x07\x1b[0m\x1b]133;C\x07"),
                "{shell}: {out:?}"
            );
        }
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

    /// Blocks mode hides the user's prompt; the classic marker brings it back.
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
            ("MOONLET_CLASSIC_FILE".into(), marker.display().to_string()),
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
        let blocks = read_until(&mut rx, "133;D;0").await;
        let blocks = blocks + &read_until(&mut rx, "133;A").await;
        assert!(blocks.contains("hi"), "{shell}: {blocks:?}");
        assert!(!blocks.contains("USERPROMPT"), "{shell} blanked: {blocks:?}");

        std::fs::write(&marker, b"").unwrap();
        mgr.write(info.id, b"\n".to_vec()).unwrap();
        let classic = read_until(&mut rx, "USERPROMPT").await;
        let _ = mgr.kill(info.id, true);
        assert!(classic.contains("USERPROMPT"), "{shell} classic: {classic:?}");
    }

    #[tokio::test]
    async fn zsh_blocks_mode_blanks_the_prompt() {
        blanks_and_restores("/bin/zsh", ".zshrc", "PROMPT='USERPROMPT> '\n").await;
    }

    #[tokio::test]
    async fn bash_blocks_mode_blanks_the_prompt() {
        blanks_and_restores("/bin/bash", ".bash_profile", "PS1='USERPROMPT> '\n").await;
    }

    /// Blocks mode (T8): each command gets two empty rows above it (separator
    /// and header), and the command line is bold while its output is not.
    /// Also returns the snapshot a second client gets on attach (S2).
    async fn blocks_screen(shell: &str) -> Option<(crate::term::TermState, String)> {
        if !Path::new(shell).exists() {
            return None;
        }
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("shell");
        let mut env: BTreeMap<String, String> = BTreeMap::from([
            ("HOME".into(), home.path().display().to_string()),
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("SHELL".into(), shell.into()),
            ("MOONLET_CLASSIC_FILE".into(), home.path().join("classic").display().to_string()),
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
        let (tx2, _rx2) = tokio::sync::mpsc::unbounded_channel();
        let (_, snapshot) = mgr.attach(info.id, 2, tx2, None).unwrap();
        let _ = mgr.kill(info.id, true);
        let mut term = crate::term::TermState::new(24, 80);
        term.process(out.as_bytes());
        Some((term, String::from_utf8_lossy(&snapshot).into_owned()))
    }

    /// The text of the line a snapshot writes right after each OSC 133 `C`
    /// mark, without escape sequences: each command's first output row.
    fn rows_after_c(snapshot: &str) -> Vec<String> {
        snapshot
            .split("\x1b]133;C;")
            .skip(1)
            .map(|rest| {
                let line = &rest[rest.find('\x07').unwrap() + 1..];
                let line = &line[..line.find("\r\n").unwrap_or(line.len())];
                let mut text = String::new();
                let mut chars = line.chars();
                while let Some(c) = chars.next() {
                    if c == '\x1b' {
                        // CSI: up to its final byte.
                        chars.by_ref().find(|c| c.is_ascii_alphabetic());
                    } else {
                        text.push(c);
                    }
                }
                text.trim_end().to_string()
            })
            .collect()
    }

    fn assert_blocks(shell: &str, term: &crate::term::TermState) {
        let text = term.contents();
        // A spacer row (the separator) and a header row above each command.
        assert!(text.contains("echo one\none\n\n\necho two\ntwo"), "{shell} header rows: {text:?}");
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
    async fn zsh_blocks_mode_gives_each_command_a_header_row_and_bold_command() {
        if let Some((term, _)) = blocks_screen("/bin/zsh").await {
            assert_blocks("zsh", &term);
        }
    }

    #[tokio::test]
    async fn bash_blocks_mode_gives_each_command_a_header_row_and_bold_command() {
        if let Some((term, _)) = blocks_screen("/bin/bash").await {
            assert_blocks("bash", &term);
        }
    }

    /// S2: a client attaching later gets each block's `C` mark right before
    /// the command's output, so it rebuilds the blocks.
    #[tokio::test]
    async fn zsh_snapshot_puts_each_output_after_its_mark() {
        if let Some((_, snapshot)) = blocks_screen("/bin/zsh").await {
            assert_eq!(rows_after_c(&snapshot), vec!["one", "two"], "{snapshot:?}");
        }
    }

    #[tokio::test]
    async fn bash_snapshot_puts_each_output_after_its_mark() {
        if let Some((_, snapshot)) = blocks_screen("/bin/bash").await {
            assert_eq!(rows_after_c(&snapshot), vec!["one", "two"], "{snapshot:?}");
        }
    }

    /// The prompt hook reports where `node` is (T8 chips) when that changes,
    /// not on every prompt, and never runs it; the daemon reads the version
    /// from the install and keeps it on the terminal's info.
    async fn reports_node_version(shell: &str) {
        if !Path::new(shell).exists() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let ran = home.path().join("ran");
        for (dir, minor) in [("n1", 1), ("n2", 2)] {
            let bin = home.path().join(dir).join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            let node = bin.join("node");
            std::fs::write(&node, format!("#!/bin/sh\ntouch {}\necho v6.6.6\n", ran.display())).unwrap();
            std::fs::set_permissions(&node, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
            let include = home.path().join(dir).join("include").join("node");
            std::fs::create_dir_all(&include).unwrap();
            std::fs::write(
                include.join("node_version.h"),
                format!("#define NODE_MAJOR_VERSION {minor}\n#define NODE_MINOR_VERSION 0\n#define NODE_PATCH_VERSION 0\n"),
            )
            .unwrap();
        }
        let root = home.path().join("shell");
        let n1 = home.path().join("n1").join("bin").display().to_string();
        let n2 = home.path().join("n2").join("bin").display().to_string();
        let mut env: BTreeMap<String, String> = BTreeMap::from([
            ("HOME".into(), home.path().display().to_string()),
            ("PATH".into(), format!("{n1}:/usr/bin:/bin")),
            ("SHELL".into(), shell.into()),
        ]);
        let args = apply(&root, shell, vec![], &mut env);
        let mgr = TerminalManager::new(home.path().join("s.sock"), env);
        let mut command = vec![shell.to_string()];
        command.extend(args);
        let info = mgr
            .create(TerminalCreate { cwd: home.path().display().to_string(), command, ..Default::default() })
            .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        mgr.attach(info.id, 1, tx, None).unwrap();
        // The first prompt reports the first `node` on PATH. A login bash
        // runs the system profile, whose path_helper can put a machine's own
        // node (Homebrew's, on CI) ahead of n1, so only its presence is fixed.
        let first = read_until(&mut rx, "133;A").await;
        assert!(first.contains("\x1b]1337;MoonletNodePath=/"), "{shell} first prompt: {first:?}");
        tokio::time::sleep(Duration::from_millis(300)).await;
        mgr.write(info.id, b"true\n".to_vec()).unwrap();
        let same = read_until(&mut rx, "133;A").await;
        assert!(!same.contains("MoonletNode"), "{shell} reported again without a change: {same:?}");
        tokio::time::sleep(Duration::from_millis(300)).await;
        mgr.write(info.id, format!("PATH={n2}:$PATH\n").into_bytes()).unwrap();
        let changed = read_until(&mut rx, &format!("MoonletNodePath={n2}/node")).await;
        assert!(changed.contains(&format!("\x1b]1337;MoonletNodePath={n2}/node\x07")), "{shell} after PATH change: {changed:?}");
        tokio::time::sleep(Duration::from_millis(200)).await;
        let version = mgr.get(info.id).map(|t| t.info().node_version);
        let _ = mgr.kill(info.id, true);
        assert_eq!(version, Some(Some("v2.0.0".to_string())), "{shell}");
        assert!(!ran.exists(), "{shell} ran node");
    }

    /// A `node` reached through a relative PATH entry belongs to whatever
    /// directory the shell is in (an untrusted checkout's
    /// `node_modules/.bin`), so the prompt hook must never run it.
    async fn ignores_relative_node(shell: &str) {
        if !Path::new(shell).exists() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join("node_modules").join(".bin");
        std::fs::create_dir_all(&bin).unwrap();
        let ran = home.path().join("ran");
        std::fs::write(bin.join("node"), format!("#!/bin/sh\ntouch {}\necho v6.6.6\n", ran.display())).unwrap();
        std::fs::set_permissions(bin.join("node"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let root = home.path().join("shell");
        let mut env: BTreeMap<String, String> = BTreeMap::from([
            ("HOME".into(), home.path().display().to_string()),
            ("PATH".into(), "node_modules/.bin:/usr/bin:/bin".into()),
            ("SHELL".into(), shell.into()),
        ]);
        let args = apply(&root, shell, vec![], &mut env);
        let mgr = TerminalManager::new(home.path().join("s.sock"), env);
        let mut command = vec![shell.to_string()];
        command.extend(args);
        let info = mgr
            .create(TerminalCreate { cwd: home.path().display().to_string(), command, ..Default::default() })
            .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        mgr.attach(info.id, 1, tx, None).unwrap();
        let out = read_until(&mut rx, "133;A").await;
        let _ = mgr.kill(info.id, true);
        assert!(!out.contains("v6.6.6"), "{shell}: {out:?}");
        assert!(!ran.exists(), "{shell} ran a relative node");
    }

    #[tokio::test]
    async fn zsh_never_runs_a_node_found_through_a_relative_path() {
        ignores_relative_node("/bin/zsh").await;
    }

    #[tokio::test]
    async fn bash_never_runs_a_node_found_through_a_relative_path() {
        ignores_relative_node("/bin/bash").await;
    }

    /// The prompt hook reports the shell's PATH when it changes (T8), so the
    /// input editor colours the commands this shell can run, including ones
    /// its rc files or a later `PATH=` added.
    async fn reports_path(shell: &str) {
        if !Path::new(shell).exists() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let extra = home.path().join("tools");
        let root = home.path().join("shell");
        let mut env: BTreeMap<String, String> = BTreeMap::from([
            ("HOME".into(), home.path().display().to_string()),
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("SHELL".into(), shell.into()),
        ]);
        let args = apply(&root, shell, vec![], &mut env);
        let mgr = TerminalManager::new(home.path().join("s.sock"), env);
        let mut command = vec![shell.to_string()];
        command.extend(args);
        let info = mgr
            .create(TerminalCreate { cwd: home.path().display().to_string(), command, ..Default::default() })
            .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        mgr.attach(info.id, 1, tx, None).unwrap();
        let first = read_until(&mut rx, "133;A").await;
        // bash's login startup runs macOS's path_helper, so only the presence is fixed here.
        assert!(first.contains("\x1b]1337;MoonletPath=/"), "{shell} first prompt: {first:?}");
        tokio::time::sleep(Duration::from_millis(300)).await;
        mgr.write(info.id, format!("PATH={}:$PATH\n", extra.display()).into_bytes()).unwrap();
        read_until(&mut rx, "MoonletPath=").await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        let path = mgr.shell_path(info.id);
        let _ = mgr.kill(info.id, true);
        let path = path.unwrap_or_default();
        assert!(path.starts_with(&format!("{}:", extra.display())), "{shell}: {path}");
        assert!(path.contains("/usr/bin"), "{shell}: {path}");
    }

    #[tokio::test]
    async fn zsh_reports_its_path() {
        reports_path("/bin/zsh").await;
    }

    #[tokio::test]
    async fn bash_reports_its_path() {
        reports_path("/bin/bash").await;
    }

    #[tokio::test]
    async fn zsh_reports_the_node_version_when_it_changes() {
        reports_node_version("/bin/zsh").await;
    }

    #[tokio::test]
    async fn bash_reports_the_node_version_when_it_changes() {
        reports_node_version("/bin/bash").await;
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
        assert!(out.contains("133;C"), "moonlet's own mark still works: {out:?}");
    }

    #[test]
    fn opt_out_and_unknown_shells() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = BTreeMap::from([("MOONLET_SHELL_INTEGRATION".to_string(), "0".to_string())]);
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
        assert_eq!(env["MOONLET_USER_ZDOTDIR"], "/u/z");
        assert!(dir.path().join("zsh/.zshrc").exists());
        assert!(
            dir.path()
                .join("data/fish/vendor_conf.d/moonlet.fish")
                .exists()
        );
    }

    /// X27: fish would load jaunt's copy of the integration as well.
    #[test]
    fn install_removes_the_jaunt_fish_file() {
        let dir = tempfile::tempdir().unwrap();
        let conf = dir.path().join("data/fish/vendor_conf.d");
        std::fs::create_dir_all(&conf).unwrap();
        std::fs::write(conf.join("jaunt.fish"), "# jaunt shell integration for fish\n").unwrap();
        std::fs::write(conf.join("mine.fish"), "set -g x 1\n").unwrap();
        install(dir.path()).unwrap();
        let mut names: Vec<_> = std::fs::read_dir(&conf)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["mine.fish", "moonlet.fish"]);
    }
}
