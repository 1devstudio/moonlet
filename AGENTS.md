# Agent instructions for jaunt

## Tests

Every change that adds or changes behaviour ships with a test that fails without the change. A bug fix starts with a test that goes red on the bug. Refactors, docs and styling-only changes rely on the existing suite.

- **Rust:** unit tests go in the file's `#[cfg(test)] mod tests`. Daemon and CLI end-to-end tests go in `crates/<crate>/tests/`.
- **Desktop:** Vitest files sit beside the logic as `apps/desktop/src/lib/*.test.ts`. React components have no tests, so move decision logic into `lib/` and test it there.
- **Code that calls `git`, `gh` or the network:** split the parsing and decision logic into a pure function, and test it with real captured output.
- **Specs:** each acceptance criterion in `docs/specs/` maps to at least one test.

The work is done when `pnpm test` passes and your report names the new tests and quotes the pass line.
