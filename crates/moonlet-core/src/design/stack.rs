//! What a project's UI is built with, for the New design system dialog
//! (X64): "React · Tailwind", "React Native", "Next.js".

use std::path::Path;

/// The frameworks and styling a folder's `package.json` files name: the
/// folder's own, and those of a monorepo's `apps/*` and `packages/*`.
pub fn detect(dir: &Path) -> Vec<String> {
    let mut deps = std::collections::BTreeSet::new();
    let mut files = vec![dir.join("package.json")];
    for group in ["apps", "packages"] {
        if let Ok(entries) = std::fs::read_dir(dir.join(group)) {
            files.extend(entries.flatten().map(|e| e.path().join("package.json")));
        }
    }
    for file in files {
        let Some(json) = std::fs::read_to_string(&file)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        else {
            continue;
        };
        for key in ["dependencies", "devDependencies", "peerDependencies"] {
            if let Some(map) = json[key].as_object() {
                deps.extend(map.keys().cloned());
            }
        }
    }
    let has = |name: &str| deps.contains(name);
    let mut out = Vec::new();
    // The framework that shapes the UI most: Next.js and React Native are React too.
    let framework = if has("next") {
        Some("Next.js")
    } else if has("react-native") {
        Some("React Native")
    } else if has("react") {
        Some("React")
    } else if has("vue") {
        Some("Vue")
    } else if has("svelte") {
        Some("Svelte")
    } else if has("@angular/core") {
        Some("Angular")
    } else {
        None
    };
    out.extend(framework.map(String::from));
    if has("tailwindcss") {
        out.push("Tailwind".into());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (path, text) in files {
            let p = dir.path().join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        dir
    }

    #[test]
    fn a_projects_stack_comes_from_its_package_files() {
        // A monorepo like moonlet: the UI is in apps/desktop.
        let moonlet = folder(&[
            ("package.json", r#"{"name": "moonlet", "private": true}"#),
            (
                "apps/desktop/package.json",
                r#"{"dependencies": {"react": "^19", "react-dom": "^19"}, "devDependencies": {"tailwindcss": "^4", "@tailwindcss/vite": "^4"}}"#,
            ),
            (
                "apps/mobile/package.json",
                r#"{"dependencies": {"react": "^19"}}"#,
            ),
        ]);
        assert_eq!(detect(moonlet.path()), vec!["React", "Tailwind"]);
        let next = folder(&[(
            "package.json",
            r#"{"dependencies": {"next": "16", "react": "19"}}"#,
        )]);
        assert_eq!(detect(next.path()), vec!["Next.js"]);
        let native = folder(&[(
            "package.json",
            r#"{"dependencies": {"react-native": "0.80", "react": "19"}}"#,
        )]);
        assert_eq!(detect(native.path()), vec!["React Native"]);
        let vue = folder(&[(
            "package.json",
            r#"{"dependencies": {"vue": "3"}, "devDependencies": {"tailwindcss": "3"}}"#,
        )]);
        assert_eq!(detect(vue.path()), vec!["Vue", "Tailwind"]);
        let rust = folder(&[("Cargo.toml", "[package]\nname = \"x\"\n")]);
        assert_eq!(detect(rust.path()), Vec::<String>::new());
        let broken = folder(&[("package.json", "{ not json")]);
        assert_eq!(detect(broken.path()), Vec::<String>::new());
    }
}
