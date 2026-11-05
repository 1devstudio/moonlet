---
title: Heavy commands
description: Send test suites and builds that agents run to the least busy machine, and follow each run as a job.
group: Mesh
order: 3
tags: [macOS or Linux, Claude Code]
---

## What a heavy command is

A heavy command, such as a test suite, is one you would rather run on a free machine. When an agent on the central host runs an approved heavy command, moonlet runs it on the free worker with the lowest load. The output streams back, and the run's changes are back in the session before the agent sees the exit status.

> **Note:** Heavy commands are new and not yet tried widely between real machines. Expect rough edges.

## List them in the project config

A project lists its heavy commands in `.moonlet/config.toml`:

```toml
[heavy]
commands = ["pnpm test", "pnpm build"]
os = "any"
env = ["CI"]
outputs = ["coverage"]
```

| Key | Meaning |
|---|---|
| `commands` | Command prefixes of one or more words. |
| `os` | `"any"` (the default), `"macos"` or `"linux"`. Workers on another system are skipped. |
| `env` | Names of environment variables passed to the worker. No other variable crosses machines. |
| `outputs` | Ignored paths, such as `coverage`, brought back after a run. Up to 1 GiB. |

The **Heavy commands** section of **Settings › Projects › shop (studio-mini)** edits the same keys. See [Project config](/docs/project-config) for the rest of the file.

## Approve the list

Nothing is routed until you approve it. In the **Heavy commands** section, each entry shows **Approved** or **Not approved**, and **Approve** approves the whole list.

- Approval covers the exact commands and `env` names. A changed entry or a new name needs approving again; removing one does not.
- Only the moonlet app and paired Macs approve, never an agent or a phone.
- **Approve** covers the central host and every linked worker the app reaches. A worker it missed shows "Not approved for shop" on the Workers page, with **Approve**.
- Your Claude Code `deny` and `ask` rules for `Bash` still apply.

An approved prefix allows any arguments, and a test run can execute code the agent wrote.

## Which Bash calls are routed

Only Bash calls of Claude Code agents in sessions on the central host are routed, from inside the session's worktree. Background calls, calls made in plan mode and Codex agents are not routed.

A call is routed when its words begin with an approved entry's words, and when it has nothing a shell would expand or chain. With the entries `pnpm test` and `cargo test`:

| Bash command | Routed |
|---|---|
| `pnpm test` | yes |
| `pnpm test src/cart.test.ts --run` | yes |
| `pnpm  test` (two spaces) | yes |
| `"pnpm" test` | yes |
| `pnpm testing` | no: the words differ |
| `pnpm test && git status` | no: chaining |
| `pnpm test 2>&1 \| tail -50` | no: redirection and a pipe |
| `cd web && pnpm test` | no: chaining |
| `NODE_ENV=test pnpm test` | no: an assignment |
| `pnpm test $(cat files.txt)` | no: substitution |
| `pnpm test "$FILE"` | no: expansion inside double quotes |
| `cargo test 'a b'` | yes, with the argument `a b` |
| `pnpm test src/*.ts` | no: a glob |
| `pnpm test # all` | no: a comment |

A call that is not routed runs where the agent is, as it would without moonlet.

## Workers and load

The candidates are:

- Macs with **Use this Mac for heavy commands** on, in **Settings › Machines › Hosts › This Mac**;
- tailnet hosts with **Use for heavy commands** on, under each remote host on the same page;
- the central host itself;
- cloud machines that are ready, see [Cloud workers](/docs/cloud-workers).

The first time you turn on **Use for heavy commands** for a host such as build-box, a dialog asks for a pairing code from the central host. Get one with **Let another Mac connect** in moonlet on studio-mini, or `moonletd pair` there.

Each worker has slots: how many routed commands it runs side by side. The **Run at most** row on the Hosts page sets them, from 1 to 64, and the default is 2. One slot suits a laptop on battery. A worker is busy when its 1-minute load average is at least 0.7 times its cores. moonlet picks linked workers first, by lowest load per core, then the central host, then cloud machines. A command never waits for a slot: when no worker is free, it runs on the central host.

A worker runs each command in its own routing copy of the session, brought to exactly the session's files first. On a Mac, the first run asks once to run the project's setup there, with **Run setup**. A file that changed on the central host during the run keeps the central host's version, and the run's goes to `~/.moonlet/sync-leftovers/`.

**Settings › Machines › Workers** on the central host lists each worker with its load, slots in use, round trip and running commands.

## The Jobs tab

Every routed command is a job of its session. In the chat, a routed Bash row shows a chip saying where it ran, such as **on macbook**. The output starts with the line `moonlet: running on macbook`.

The session's **Jobs** tab, after **Agents**, lists its jobs newest first. Each job shows its phases, its worker, what came back and its output, with a summary such as "457 tests passed" for common test runners. **Stop** ends a job and **Stop all** ends every one; changes made so far still come back. **↗** opens a job as a tab. The central host keeps each session's last 50 jobs.

## When a worker goes away

If a worker disconnects or misses 3 pings during a run, the run is dropped and runs again on the central host from the same files. The output says "moonlet: macbook went away. Running again on studio-mini.", and the agent gets the second run's exit status. The dropped run's changes never reach the session.

If the central host's daemon stops during a run, the command exits with status 125.
