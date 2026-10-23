//! The one-line summary of a routed command's output (X62): test results
//! from vitest, jest, `cargo test` and pytest, or the first compiler error
//! of `tsc` or rustc.

use std::sync::LazyLock;

use regex::Regex;

static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").unwrap());
static VITEST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*Tests\s+(.*?)\((\d+)\)\s*$").unwrap());
static JEST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^Tests:\s+(.*?)(\d+) total").unwrap());
static CARGO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;").unwrap()
});
static PYTEST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^=+ (.*?) in [\d.]+s(?: \([^)]*\))? =+\s*$").unwrap());
static FAILED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+) failed").unwrap());
static PASSED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+) passed").unwrap());
static TSC_PLAIN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^(.+?)\((\d+),\d+\): error TS\d+:").unwrap());
static TSC_PRETTY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^(.+?):(\d+):\d+ - error TS\d+:").unwrap());
static RUST_ERROR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^error(?:\[E\d+\])?: (.+)$").unwrap());
static RUST_AT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\s*--> (.+?):(\d+):\d+").unwrap());

/// The summary of `output`, a run's stdout and stderr together: its test
/// results, or else its first compiler error, or nothing. Paths under
/// `root`, the session's worktree, read relative to it.
pub fn summarise(output: &str, root: Option<&str>) -> Option<String> {
    let text = ANSI.replace_all(output, "");
    tests(&text).or_else(|| compiler_error(&text, root))
}

fn count(re: &Regex, text: &str) -> u64 {
    re.captures(text)
        .and_then(|c| c[1].parse().ok())
        .unwrap_or(0)
}

fn tests(text: &str) -> Option<String> {
    let (failed, total) = if let Some(c) = VITEST.captures_iter(text).last() {
        (count(&FAILED, &c[1]), c[2].parse().ok()?)
    } else if let Some(c) = JEST.captures_iter(text).last() {
        (count(&FAILED, &c[1]), c[2].parse().ok()?)
    } else if CARGO.is_match(text) {
        let (mut passed, mut failed) = (0u64, 0u64);
        for c in CARGO.captures_iter(text) {
            passed += c[1].parse::<u64>().ok()?;
            failed += c[2].parse::<u64>().ok()?;
        }
        (failed, passed + failed)
    } else if let Some(c) = PYTEST
        .captures_iter(text)
        .filter(|c| PASSED.is_match(&c[1]) || FAILED.is_match(&c[1]))
        .last()
    {
        let failed = count(&FAILED, &c[1]);
        (failed, failed + count(&PASSED, &c[1]))
    } else {
        return None;
    };
    let noun = if total == 1 { "test" } else { "tests" };
    Some(if failed > 0 {
        format!("{failed} of {total} {noun} failed")
    } else {
        format!("{total} {noun} passed")
    })
}

fn compiler_error(text: &str, root: Option<&str>) -> Option<String> {
    let relative = |p: &str| -> String {
        let p = p.trim();
        root.and_then(|r| p.strip_prefix(r.trim_end_matches('/')))
            .and_then(|rest| rest.strip_prefix('/'))
            .unwrap_or(p)
            .to_string()
    };
    let tsc = [&*TSC_PLAIN, &*TSC_PRETTY]
        .into_iter()
        .filter_map(|re| re.captures(text))
        .min_by_key(|c| c.get(0).map_or(usize::MAX, |m| m.start()));
    let rust = RUST_ERROR.captures(text).and_then(|e| {
        let start = e.get(0)?.end();
        let at = RUST_AT.captures(&text[start..])?;
        Some((
            e.get(0)?.start(),
            e[1].to_string(),
            at[1].to_string(),
            at[2].to_string(),
        ))
    });
    match (tsc, rust) {
        (Some(t), r) if r.as_ref().is_none_or(|r| t.get(0).unwrap().start() < r.0) => {
            Some(format!("Type error in {}:{}", relative(&t[1]), &t[2]))
        }
        (_, Some((_, message, path, line))) => {
            let message: String = message.trim().chars().take(60).collect();
            Some(format!("{message} in {}:{line}", relative(&path)))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// X62's worked examples.
    #[test]
    fn summarises_as_in_the_worked_examples() {
        let rows: [(&str, Option<&str>); 10] = [
            ("      Tests  457 passed (457)", Some("457 tests passed")),
            (
                "      Tests  2 failed | 455 passed (457)",
                Some("2 of 457 tests failed"),
            ),
            (
                "Tests:       2 failed, 455 passed, 457 total",
                Some("2 of 457 tests failed"),
            ),
            (
                "test result: ok. 38 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.52s\ntest result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s",
                Some("50 tests passed"),
            ),
            (
                "test result: FAILED. 36 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.52s",
                Some("2 of 38 tests failed"),
            ),
            ("==== 457 passed in 3.21s ====", Some("457 tests passed")),
            (
                "src/cart.ts(41,7): error TS2322: Type 'string' is not assignable to type 'number'.",
                Some("Type error in src/cart.ts:41"),
            ),
            (
                "src/cart.ts:41:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
                Some("Type error in src/cart.ts:41"),
            ),
            (
                "error[E0308]: mismatched types\n  --> src/lib.rs:41:5",
                Some("mismatched types in src/lib.rs:41"),
            ),
            ("Done in 2.1s", None),
        ];
        for (output, want) in rows {
            assert_eq!(summarise(output, None).as_deref(), want, "{output}");
        }
    }

    /// Whole outputs captured from real runs, with their paths made up.
    #[test]
    fn summarises_captured_runs_of_each_tool() {
        let cases: [(&str, &str); 11] = [
            (
                include_str!("fixtures/job_summary/vitest-pass.txt"),
                "3 tests passed",
            ),
            (
                include_str!("fixtures/job_summary/vitest-fail.txt"),
                "2 of 4 tests failed",
            ),
            (
                include_str!("fixtures/job_summary/jest-pass.txt"),
                "2 tests passed",
            ),
            (
                include_str!("fixtures/job_summary/jest-fail.txt"),
                "1 of 3 tests failed",
            ),
            (
                include_str!("fixtures/job_summary/cargo-test-pass.txt"),
                "3 tests passed",
            ),
            (
                include_str!("fixtures/job_summary/cargo-test-fail.txt"),
                "1 of 3 tests failed",
            ),
            (
                include_str!("fixtures/job_summary/pytest-pass.txt"),
                "2 tests passed",
            ),
            (
                include_str!("fixtures/job_summary/pytest-fail.txt"),
                "1 of 3 tests failed",
            ),
            (
                include_str!("fixtures/job_summary/tsc-plain.txt"),
                "Type error in src/cart.ts:4",
            ),
            (
                include_str!("fixtures/job_summary/tsc-pretty.txt"),
                "Type error in src/cart.ts:4",
            ),
            (
                include_str!("fixtures/job_summary/cargo-build-fail.txt"),
                "mismatched types in tax/src/lib.rs:1",
            ),
        ];
        for (output, want) in cases {
            assert_eq!(summarise(output, None).as_deref(), Some(want), "{output}");
        }
        // Paths under the worktree read relative to it.
        assert_eq!(
            summarise(
                "/Users/alex/.moonlet/worktrees/shop/fix-cart/src/cart.ts(4,14): error TS2322: x",
                Some("/Users/alex/.moonlet/worktrees/shop/fix-cart")
            )
            .as_deref(),
            Some("Type error in src/cart.ts:4")
        );
    }
}
