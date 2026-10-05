//! Command names the shell input editor colours as known (T8): executables
//! on PATH plus the shell's builtins and reserved words.

use std::os::unix::fs::PermissionsExt;

/// Builtins and reserved words shared by zsh and bash.
const POSIX: &[&str] = &[
    ".", ":", "[", "[[", "alias", "bg", "break", "builtin", "case", "cd", "command", "continue", "declare", "dirs", "do",
    "done", "echo", "elif", "else", "esac", "eval", "exec", "exit", "export", "false", "fc", "fg", "fi", "for", "function",
    "getopts", "hash", "history", "if", "in", "jobs", "kill", "let", "local", "logout", "popd", "printf", "pushd", "pwd",
    "read", "readonly", "return", "select", "set", "shift", "source", "test", "then", "time", "times", "trap", "true",
    "type", "typeset", "ulimit", "umask", "unalias", "unset", "until", "wait", "while",
];
const ZSH: &[&str] = &[
    "autoload", "bindkey", "compdef", "emulate", "noglob", "nocorrect", "rehash", "repeat", "setopt", "unsetopt", "where",
    "whence", "which", "zle", "zmodload", "zstyle",
];
const BASH: &[&str] = &["bind", "caller", "complete", "compgen", "compopt", "coproc", "disown", "enable", "help", "mapfile", "shopt", "suspend"];
const FISH: &[&str] = &[
    "abbr", "and", "argparse", "begin", "bg", "bind", "break", "builtin", "case", "cd", "command", "commandline", "complete",
    "contains", "continue", "count", "echo", "else", "emit", "end", "eval", "exec", "exit", "false", "fg", "for", "function",
    "functions", "history", "if", "jobs", "math", "not", "or", "printf", "pwd", "random", "read", "realpath", "return", "set",
    "set_color", "source", "status", "string", "switch", "test", "true", "type", "while",
];

/// Executable file names in the absolute directories of `path`, plus the
/// builtins of `shell` (`zsh`, `bash` or `fish`), sorted and de-duplicated.
/// Relative PATH entries are skipped: they depend on the shell's directory.
pub fn list(path: &str, shell: &str) -> Vec<String> {
    let mut names: Vec<String> = match shell {
        "fish" => FISH.iter().map(|s| s.to_string()).collect(),
        "bash" => POSIX.iter().chain(BASH).map(|s| s.to_string()).collect(),
        _ => POSIX.iter().chain(ZSH).map(|s| s.to_string()).collect(),
    };
    for dir in path.split(':').filter(|d| d.starts_with('/')) {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            // Follows symlinks, as Homebrew's bin directories are full of them.
            let Ok(meta) = std::fs::metadata(entry.path()) else { continue };
            if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    names.sort();
    names.dedup();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_executables_on_path_and_builtins() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let tool = a.path().join("mytool");
        std::fs::write(&tool, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(a.path().join("notes.txt"), "").unwrap();
        std::fs::create_dir(a.path().join("subdir")).unwrap();
        let other = b.path().join("other");
        std::fs::write(&other, "").unwrap();
        std::fs::set_permissions(&other, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = format!("{}:relative/bin:{}:/does/not/exist", a.path().display(), b.path().display());

        let names = list(&path, "zsh");
        assert!(names.contains(&"mytool".to_string()));
        assert!(names.contains(&"other".to_string()));
        assert!(!names.contains(&"notes.txt".to_string()), "not executable");
        assert!(!names.contains(&"subdir".to_string()), "a directory");
        for builtin in ["cd", "export", "source", "if", "setopt"] {
            assert!(names.contains(&builtin.to_string()), "{builtin}");
        }
        let mut sorted = names.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(names, sorted, "sorted, no duplicates");
    }

    #[test]
    fn fish_has_its_own_builtins() {
        let names = list("", "fish");
        assert!(names.contains(&"abbr".to_string()));
        assert!(!names.contains(&"setopt".to_string()));
    }
}
