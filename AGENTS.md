# Agent instructions for moonlet

## Tests

Every change that adds or changes behaviour ships with a test that fails without the change. A bug fix starts with a test that goes red on the bug. Refactors, docs and styling-only changes rely on the existing suite.

### Where tests go

Both sides of a change get unit tests: the daemon and core in Rust, and the UI's logic in `apps/desktop/src/lib/`.

- **Rust:** unit tests go in the file's `#[cfg(test)] mod tests`. Daemon and CLI end-to-end tests go in `crates/<crate>/tests/`.
- **Desktop:** Vitest files sit beside the logic as `apps/desktop/src/lib/*.test.ts`. React components have no unit tests, so move decision logic into `lib/` and test it there.
- **Code that calls `git`, `gh` or the network:** split the parsing and decision logic into a pure function, and test it with real captured output.
- **Crucial features** also get an e2e spec in `apps/desktop/e2e/specs/` that drives the real app (spec X12). A feature is crucial when a user would notice its breakage within minutes: starting a session, running an agent or script, saving settings, reviewing and committing changes. Run `pnpm e2e:build` once, then `pnpm e2e`. Type with `fill()` from `e2e/fixtures.ts`, not `setValue`.
- **Specs:** each acceptance criterion in `docs/specs/` maps to at least one test.

### How tests are written

Each test asserts **public behaviour** against an **independent literal**, and is written as one **vertical slice** of red-green-refactor.

- **Public behaviour:** go through the public interface: an RPC result, an exported `lib/` function, what the window shows, a file the user reads such as `.jaunt/config.toml`. Renaming or restructuring internals leaves the test green.
- **Independent literal:** the expected value comes from the spec, a worked example or real captured output, written out as a literal.
- **Vertical slice:** write one test, watch it go red, make it green, refactor, then write the next.

Forbidden test anti-patterns, the inverse of the three rules above:

- **Implementation-coupled tests:** asserting on private methods, internal collaborators, call counts or internal state (such as `state.json`) instead of public behaviour. If renaming an internal function breaks the test while the user-facing behaviour is unchanged, the test is invalid.
- **Tautological tests:** recomputing the expected value with the same logic or formula as the implementation, so the test passes by construction.
- **Bulk, horizontally sliced tests:** writing a large batch of tests before any code exists, which commits to an imagined structure instead of stepping through red-green-refactor.

### Done

The work is done when `pnpm test` passes, and `pnpm e2e` too when a crucial feature changed. Your report names the new tests and quotes the pass lines.
