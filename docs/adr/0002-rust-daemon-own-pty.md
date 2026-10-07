# ADR 0002: Rust daemon with its own PTY layer

- **Status:** accepted (2026-10-02)

## Decision

`moonletd` is written in Rust from the start; Herdr is not used as an interim backend. The same binary runs on macOS and, built for musl, on remote Linux hosts.

PTYs are opened with `openpty(3)` through `nix` (`crates/moonlet-core/src/pty.rs`) rather than `portable-pty`.

## Why

- A live daemon upgrade (S3) passes PTY master fds to a new process with `SCM_RIGHTS`. That needs direct ownership of the fd and the ability to adopt a process that is not our child. `portable-pty` hides both.
- moonlet targets Unix only (macOS, Linux), so cross-platform PTY support buys nothing.
- Master fds are non-blocking and driven by tokio's `AsyncFd`, so there is no reader thread per session.

## Consequences

The daemon detects exit of adopted processes by EOF/EIO on the master plus `kill(pid, 0)`. Their exit code is unknown and is reported as `null`.
