# Contributing to moonlet

Thank you for your interest in moonlet. This guide explains how to report problems, propose changes and get a pull request merged.

## Ways to contribute

- **Report a bug.** Use the [bug report form](https://github.com/1devstudio/moonlet/issues/new?template=bug_report.yml). Include the moonlet and macOS versions, the steps to reproduce, and any relevant lines from `~/.moonlet/logs/moonletd.log`.
- **Suggest a feature.** Use the [feature request form](https://github.com/1devstudio/moonlet/issues/new?template=feature_request.yml). Describe the problem first, then the solution you have in mind.
- **Improve the documentation.** Fixes to the README, specs and guides are welcome as pull requests.
- **Contribute code.** Read the rest of this guide.

Search [existing issues](https://github.com/1devstudio/moonlet/issues) before opening a new one. Report security vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Before you start

For anything larger than a small fix, open an issue (or comment on an existing one) before writing code, so we can agree on the approach. This avoids work on changes that do not fit the project's direction.

## Development setup

Requirements: macOS 14 or later, Rust (stable), Node.js 22 or later with pnpm, and the Xcode Command Line Tools.

```sh
git clone https://github.com/1devstudio/moonlet.git
cd moonlet
pnpm install
MOONLET_HOME=/tmp/moonlet-dev pnpm dev
```

`MOONLET_HOME` keeps development state out of your real `~/.moonlet`. Use a scratch directory whenever you run a development build or the binaries in `target/debug/`.

Read [CONTEXT.md](CONTEXT.md) for the vocabulary (workspace, section, project, session, terminal, block) and [docs/plan.md](docs/plan.md) for the architecture.

## Specs and design decisions

Every feature has a spec in [`docs/specs/`](docs/specs/README.md).

- A new feature starts with a spec written from [`docs/specs/_template.md`](docs/specs/_template.md) and added to the index in `docs/specs/README.md`. New features take the next free `X<n>` ID; check `main` for the latest one right before you open the pull request.
- A change to existing behaviour updates its spec in the same pull request, so specs always describe shipped behaviour.
- Lasting technical decisions (a library choice, a protocol change) are recorded as an [ADR](docs/adr).

## Tests

Every change that adds or changes behaviour ships with a test that fails without the change. A bug fix starts with a test that reproduces the bug. Refactors, documentation and styling-only changes rely on the existing suite.

### Where tests go

- **Rust:** unit tests in the file's `#[cfg(test)] mod tests`; daemon and CLI end-to-end tests in `crates/<crate>/tests/`.
- **Desktop app:** Vitest files beside the logic, as `apps/desktop/src/lib/*.test.ts`. React components have no unit tests, so move decision logic into `lib/` and test it there.
- **Code that calls `git`, `gh` or the network:** split the parsing and decision logic into a pure function, and test it with real captured output.
- **Crucial features** (starting a session, running an agent or script, saving settings, reviewing and committing changes) also get an end-to-end spec in `apps/desktop/e2e/specs/` that drives the real app.
- **Specs:** each acceptance criterion in `docs/specs/` maps to at least one test.

### How tests are written

- Test **public behaviour**: an RPC result, an exported `lib/` function, what the window shows, a file the user reads. Renaming internals must leave the test green.
- Compare against an **independent literal** from the spec, a worked example or real captured output. Do not recompute the expected value with the implementation's logic.
- Work in **vertical slices**: write one test, watch it fail, make it pass, refactor, then write the next.

### Running tests

```sh
pnpm test        # cargo test --workspace, then Vitest
pnpm e2e:build   # once, and after Rust or Tauri changes
pnpm e2e         # end-to-end tests against a scratch daemon and repository
```

If you run the tests from a terminal inside moonlet, unset the `MOONLET_*` session variables first, so the test app cannot reach your real daemon:

```sh
env $(env | grep -E '^MOONLET_' | cut -d= -f1 | sed 's/^/-u /') pnpm e2e
```

## Code style

- Match the surrounding code: its naming, comment density and idioms.
- Do not run `cargo fmt` across the workspace: the code base is not uniformly formatted yet, and a workspace-wide format produces large unrelated diffs. Format only the files you add.
- TypeScript must type-check: `pnpm --filter @moonlet/desktop typecheck`.

## Commits and pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change, with tests, and keep each commit to one logical change.
3. Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org) style, with a scope where it helps:

   ```
   feat(app): show the session's branch in the title bar
   fix(daemon): keep scrollback when a client reattaches
   docs: explain remote host requirements
   ```

   Types in use: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.
4. Make sure `pnpm test` passes (and `pnpm e2e` when a crucial feature changed).
5. Open a pull request against `main` and fill in the template: what changed, the spec it touches, and the tests you added with their pass lines.

Pull requests are reviewed by a maintainer and an automated reviewer. Address the comments with new commits; there is no need to force-push during review. Pull requests are squash-merged, so the title becomes the commit message on `main` and must follow the Conventional Commits style too.

Large features can be split into a stack of dependent pull requests, each one reviewable on its own.

## License

moonlet is dual-licensed under the [MIT](LICENSE-MIT) and [Apache 2.0](LICENSE-APACHE) licenses. Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in moonlet by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.
