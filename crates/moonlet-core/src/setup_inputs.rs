//! What a copy's project setup reads (X60, X62): the files whose change
//! runs the setup again in a copy before the next command, while the setup
//! command itself is the one approved.

use std::collections::BTreeMap;

/// The files a setup's inputs are, by path, with their git blob ids.
pub type Inputs = BTreeMap<String, String>;

/// What a setup reads when the project names nothing else: the lockfiles
/// and manifests of common package managers, by file name in any folder.
/// A project with a `setup_inputs` list in `.moonlet/config.toml` reads
/// that list instead; an empty one never runs the setup again by itself.
pub const DEFAULT: &[&str] = &[
    // JavaScript
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "yarn.lock",
    ".yarnrc.yml",
    "bun.lock",
    "bun.lockb",
    ".npmrc",
    ".nvmrc",
    ".node-version",
    "deno.json",
    "deno.lock",
    "patches/**",
    // Rust
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain",
    "rust-toolchain.toml",
    // Go
    "go.mod",
    "go.sum",
    "go.work",
    // Python
    "pyproject.toml",
    "poetry.lock",
    "uv.lock",
    "Pipfile",
    "Pipfile.lock",
    "requirements*.txt",
    "requirements/*.txt",
    ".python-version",
    // Ruby, PHP, Elixir, Dart, Swift, CocoaPods
    "Gemfile",
    "Gemfile.lock",
    "composer.json",
    "composer.lock",
    "mix.exs",
    "mix.lock",
    "pubspec.yaml",
    "pubspec.lock",
    "Package.swift",
    "Package.resolved",
    "Podfile",
    "Podfile.lock",
    // .NET
    "*.csproj",
    "*.fsproj",
    "packages.lock.json",
    "Directory.Packages.props",
    "global.json",
    // JVM
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "gradle.lockfile",
    // Nix, asdf and mise
    "flake.nix",
    "flake.lock",
    ".tool-versions",
    "mise.toml",
];

/// The paths whose blob differs between the inputs the setup last ran on
/// and those of the files the command is about to see: changed, added or
/// gone, sorted.
pub fn changed(last: &Inputs, now: &Inputs) -> Vec<String> {
    let mut paths: Vec<String> = last
        .iter()
        .filter(|(p, id)| now.get(*p) != Some(*id))
        .map(|(p, _)| p.clone())
        .chain(now.keys().filter(|p| !last.contains_key(*p)).cloned())
        .collect();
    paths.sort();
    paths
}

/// The files of a tree, `(path, blob id)`, that `patterns` name: a
/// setup's inputs. A pattern without `/` names a file by its name in any
/// folder; one with `/` a path from the top of the repository. `*` stands
/// for any run of characters but `/`, `**` for any run at all.
pub fn select<'a>(
    files: impl IntoIterator<Item = (&'a str, &'a str)>,
    patterns: &[String],
) -> Inputs {
    files
        .into_iter()
        .filter(|(path, _)| patterns.iter().any(|p| names(p, path)))
        .map(|(path, id)| (path.to_string(), id.to_string()))
        .collect()
}

/// Whether `pattern` names `path`, as [`select`] reads it.
fn names(pattern: &str, path: &str) -> bool {
    let pattern = pattern.trim().trim_start_matches('/');
    if pattern.is_empty() {
        return false;
    }
    if pattern.contains('/') {
        glob(pattern.as_bytes(), path.as_bytes())
    } else {
        glob(
            pattern.as_bytes(),
            path.rsplit('/').next().unwrap_or(path).as_bytes(),
        )
    }
}

/// `**` matches any run of bytes, `*` any run without `/`; everything else
/// matches itself.
fn glob(pattern: &[u8], text: &[u8]) -> bool {
    match pattern {
        [] => text.is_empty(),
        [b'*', b'*', rest @ ..] => (0..=text.len()).any(|i| glob(rest, &text[i..])),
        [b'*', rest @ ..] => (0..=text.len())
            .take_while(|&i| i == 0 || text[i - 1] != b'/')
            .any(|i| glob(rest, &text[i..])),
        [c, rest @ ..] => text.first() == Some(c) && glob(rest, &text[1..]),
    }
}

/// Why the setup runs again, for the job's timeline: "pnpm-lock.yaml
/// changed", "package.json and pnpm-lock.yaml changed", or the first two
/// and how many more.
pub fn why(changed: &[String]) -> String {
    match changed {
        [] => "nothing changed".into(),
        [one] => format!("{one} changed"),
        [a, b] => format!("{a} and {b} changed"),
        [a, b, rest @ ..] => format!("{a}, {b} and {} more changed", rest.len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(files: &[(&str, &str)]) -> Inputs {
        files
            .iter()
            .map(|(p, id)| (p.to_string(), id.to_string()))
            .collect()
    }

    #[test]
    fn a_lockfile_with_another_blob_changed() {
        let last = inputs(&[
            ("package.json", "9a3f6c1e2b4d5f60718293a4b5c6d7e8f9012345"),
            ("pnpm-lock.yaml", "1b2c3d4e5f60718293a4b5c6d7e8f90123456789"),
        ]);
        let now = inputs(&[
            ("package.json", "9a3f6c1e2b4d5f60718293a4b5c6d7e8f9012345"),
            ("pnpm-lock.yaml", "77e1f0a2b3c4d5e6f708192a3b4c5d6e7f809102"),
        ]);
        assert_eq!(changed(&last, &now), vec!["pnpm-lock.yaml".to_string()]);
    }

    fn defaults() -> Vec<String> {
        DEFAULT.iter().map(|p| p.to_string()).collect()
    }

    #[test]
    fn the_default_list_names_lockfiles_and_manifests_in_any_folder_and_nothing_else() {
        let tree = [
            ("README.md", "0c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5"),
            ("package.json", "9a3f6c1e2b4d5f60718293a4b5c6d7e8f9012345"),
            ("pnpm-lock.yaml", "1b2c3d4e5f60718293a4b5c6d7e8f90123456789"),
            (
                "apps/web/package.json",
                "2f3e4d5c6b7a8091a2b3c4d5e6f708192a3b4c5d",
            ),
            (
                "apps/web/src/cart.ts",
                "3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d",
            ),
            (
                "crates/api/Cargo.toml",
                "4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e",
            ),
            ("Cargo.lock", "5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f"),
            (
                "docs/package.json.md",
                "6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
            ),
        ];
        assert_eq!(
            select(tree, &defaults()),
            inputs(&[
                ("Cargo.lock", "5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f"),
                (
                    "apps/web/package.json",
                    "2f3e4d5c6b7a8091a2b3c4d5e6f708192a3b4c5d"
                ),
                (
                    "crates/api/Cargo.toml",
                    "4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e"
                ),
                ("package.json", "9a3f6c1e2b4d5f60718293a4b5c6d7e8f9012345"),
                ("pnpm-lock.yaml", "1b2c3d4e5f60718293a4b5c6d7e8f90123456789"),
            ])
        );
    }

    #[test]
    fn a_projects_own_list_names_paths_from_the_top_with_stars() {
        let tree = [
            ("pnpm-lock.yaml", "1b2c3d4e5f60718293a4b5c6d7e8f90123456789"),
            (
                "patches/left-pad@1.3.0.patch",
                "7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1",
            ),
            (
                "patches/old/right-pad.patch",
                "8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2",
            ),
            (
                "vendor/patches/x.patch",
                "90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3",
            ),
            (
                "scripts/deps.sh",
                "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4",
            ),
            (
                "scripts/other.sh",
                "b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5",
            ),
        ];
        let own = ["patches/*.patch", "scripts/deps.sh", "pnpm-lock.yaml"].map(String::from);
        assert_eq!(
            select(tree, &own),
            inputs(&[
                (
                    "patches/left-pad@1.3.0.patch",
                    "7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1"
                ),
                ("pnpm-lock.yaml", "1b2c3d4e5f60718293a4b5c6d7e8f90123456789"),
                (
                    "scripts/deps.sh",
                    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4"
                ),
            ])
        );
        let deep = ["patches/**".to_string()];
        assert_eq!(
            select(tree, &deep).into_keys().collect::<Vec<_>>(),
            [
                "patches/left-pad@1.3.0.patch",
                "patches/old/right-pad.patch"
            ]
        );
    }

    #[test]
    fn an_empty_list_names_nothing() {
        let tree = [("pnpm-lock.yaml", "1b2c3d4e5f60718293a4b5c6d7e8f90123456789")];
        assert_eq!(select(tree, &[]), Inputs::new());
    }

    #[test]
    fn an_input_added_or_gone_changed_too() {
        let last = inputs(&[
            ("package.json", "9a3f6c1e2b4d5f60718293a4b5c6d7e8f9012345"),
            ("yarn.lock", "c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6"),
        ]);
        let now = inputs(&[
            ("package.json", "9a3f6c1e2b4d5f60718293a4b5c6d7e8f9012345"),
            ("pnpm-lock.yaml", "1b2c3d4e5f60718293a4b5c6d7e8f90123456789"),
        ]);
        assert_eq!(changed(&last, &now), ["pnpm-lock.yaml", "yarn.lock"]);
        assert_eq!(changed(&now, &now), Vec::<String>::new());
    }

    #[test]
    fn why_names_the_first_two_changed_files() {
        let paths = |p: &[&str]| p.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(why(&paths(&["pnpm-lock.yaml"])), "pnpm-lock.yaml changed");
        assert_eq!(
            why(&paths(&["package.json", "pnpm-lock.yaml"])),
            "package.json and pnpm-lock.yaml changed"
        );
        assert_eq!(
            why(&paths(&[
                "apps/web/package.json",
                "package.json",
                "pnpm-lock.yaml",
                "yarn.lock"
            ])),
            "apps/web/package.json, package.json and 2 more changed"
        );
    }
}
