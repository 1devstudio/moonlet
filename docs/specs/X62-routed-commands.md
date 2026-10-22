# X62 — Routed commands: heavy commands run on a free worker

- **Status:** draft
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0009](../adr/0009-central-host-workers-live-copies.md) (routing, fences), [0011](../adr/0011-machines-connect-over-the-tailnet.md) (transport), [0012](../adr/0012-cloud-workers.md) (cloud workers)
- **Depends on:** [X41](X41-worker-link-and-project-identity.md) (the worker link, `worker.list`, project identity), [X61](X61-remote-hosts-for-heavy-commands.md) (remote hosts as workers) and [X60](X60-keep-in-sync.md) (snapshots, packs, offer and update rounds, setup approval).

## Summary

An agent on the central host, such as the Mac mini `studio-mini`, runs `pnpm test`. When the project lists `pnpm test` as a **heavy command** and the user has approved it, moonlet runs it on the free worker with the lowest load: a linked Mac or remote host (X41, X61), the central host itself, or a cloud machine ([X63](X63-cloud-workers.md)). The worker runs it in a **routing copy** of the session's files. Before the command starts, a **fence** makes the copy hold exactly the session's files. Output streams back as it comes. After the command ends, every change it made is back in the session before the agent sees the exit status. If the worker goes away mid-run, the command runs again on the central host.

This is ADR 0009's routing slice. It adds two things the ADR did not decide: an approval step, so that routing never skips a permission prompt the user would have seen, and routing copies kept apart from the copies a user keeps in sync.

## User journey

1. Project `shop` on `studio-mini` has, in `.moonlet/config.toml`:

   ```toml
   [heavy]
   commands = ["pnpm test", "pnpm build"]
   outputs = ["coverage"]
   ```

2. In Settings › Projects › shop (studio-mini), a **Heavy commands** section reads "pnpm test, pnpm build: not approved". It says: "Approved commands run without asking, on whichever machine is free." The user clicks **Approve**.
3. On the MacBook, Settings › Machines › Hosts › This Mac has **Use this Mac for heavy commands** on (X41). The user approved from this Mac, so this Mac may run them too.
4. In session `fix-cart`, the agent runs `pnpm test`. The Bash row in the chat shows a chip, **on Alex's MacBook Pro**. This Mac has no routing copy of `fix-cart` yet, so moonlet makes one and asks once: "Run shop's setup in the copy on this Mac? `pnpm install`". The user clicks **Run setup**.
5. 457 tests pass. A snapshot file that a test updated is in the session on `studio-mini` before the agent reads the result, and so is `coverage/`.
6. The agent runs `pnpm test` again, and the user closes the lid mid-run. The output gets the line "moonlet: Alex's MacBook Pro went away. Running again on studio-mini.", the suite runs on `studio-mini`, and the agent gets that run's exit status.
7. Settings › Machines › Workers, on `studio-mini`, lists each worker: load, slots in use, round trip, and the commands running there.

## Behaviour and acceptance criteria

### Which commands are routed

- [ ] A project lists its heavy commands as `[heavy] commands` in `.moonlet/config.toml`. Each entry is a command prefix of one or more words. Optional keys:
  - `os`: `"any"` (the default), `"macos"` or `"linux"`;
  - `env`: names of environment variables passed through to the worker;
  - `outputs`: ignored paths brought back after a run.
- [ ] A Bash command is routed when it splits into words, by POSIX shell rules, that begin with an approved entry's words, and when it has no part a shell would expand or chain. Worked examples (entries `pnpm test` and `cargo test`):

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

  A command is not routed when it has, outside single quotes, any of `;` `&` `|` `<` `>` `(` `)` `$` `` ` `` `*` `?` `[` `{` `~` `#`, or a newline, or when it starts with an assignment.
- [ ] Only Bash calls of Claude Code agents in sessions on the central host are routed: calls with `MOONLET_SESSION` set, whose working directory is inside the session's worktree. A call with `run_in_background` is not routed. Codex is not routed yet.
- [ ] A command is routed only when its entry is approved for the project on this central host. Approval holds for the exact list of entries. An entry that is added or changed is not routed until it is approved, and the project page shows it as not approved. Removing an entry needs no approval.
- [ ] Only the Mac's app and paired desktops approve. `heavy.approve` from the `moonlet` CLI or a phone is refused with `forbidden`, so an agent cannot approve the commands it adds.
- [ ] Each linked worker keeps its own approval, for the machine it runs on. **Approve** on the project page approves the list on the central host and on every linked worker the app reaches: this Mac, and remote hosts through their tailnet connection (X61). A worker linked later, or one the app could not reach, shows "not approved for shop" on the Workers screen, with **Approve**. `heavy.approve` on a worker follows X61's rule for `link.set`: the worker's own app or a paired Mac, never a phone or the CLI.
- [ ] A command is not routed when the user's Claude Code settings that apply to the session (user, project, local and the X33 profile's) have a `deny` or `ask` rule for `Bash` that matches it. Prefix rules (`Bash(pnpm build:*)`, `Bash(pnpm build)`) are matched as prefixes. A rule that moonlet cannot read as a prefix stops routing for every command that starts with the rule's first word.

### The hook

- [ ] moonlet's `PreToolUse` hook (A2) asks the daemon `exec.route {terminal, command, cwd}` for Bash calls. With `route: false`, an error, or no answer within 2 s, it prints nothing and the call runs as it would without moonlet.
- [ ] With `route: true`, it prints:

  ```json
  {
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "allow",
      "permissionDecisionReason": "moonlet: pnpm test is an approved heavy command of shop",
      "updatedInput": {
        "command": "moonlet exec -- pnpm test",
        "description": "Run the tests",
        "timeout": 600000
      }
    }
  }
  ```

  `updatedInput` repeats every field of the call's `tool_input` and changes only `command`: the original command text, unchanged, after `moonlet exec -- `. Claude Code still applies the user's deny and ask rules to the rewritten command.
- [ ] `moonlet exec` started anywhere without a central host's routing (no daemon, or `MOONLET_SESSION` not set) runs the command where it is, so a rewritten command always runs.

### Picking a worker

- [ ] The candidates are:
  - linked workers: Macs with **Use this Mac for heavy commands** on (X41) and remote hosts with **Use for heavy commands** on (X61), each of which approved the project's list;
  - the central host;
  - the project's cloud machines that are ready (X63).

  A candidate must have the project's `os` when one is set, a free slot, and a load below busy.
- [ ] Each worker has **slots**: how many routed commands it runs at once. The default is 2. The worker's own This Mac page sets it, and the central host's page sets the central host's own.
- [ ] A worker is **busy** when its 1-minute load average is at least 0.7 × its cores. The worker sends its load in each `worker.ping` answer. The central host reads its own load the same way.
- [ ] Order:
  1. linked workers, by lowest load per core, then lowest round trip, then worker id;
  2. the central host;
  3. ready cloud machines, by lowest load per core.

  A session that asked for the cloud (X63) tries cloud machines first. Worked examples:

  | Workers (load / cores, slots used of 2) | Runs on |
  |---|---|
  | MacBook 1.0/10 (0), central 0.5/10 (0) | MacBook |
  | MacBook 7.2/10 (0), central 4.3/10 (1) | central host (the MacBook is busy) |
  | MacBook 1.0/10 (2), central 1.0/10 (0) | central host (the MacBook has no free slot) |
  | MacBook A 3.0/10, MacBook B 1.0/8 | B (0.125 < 0.3) |
  | no linked workers, central 9.0/10 (2), a ready cloud machine | the cloud machine |
  | no linked workers, central 9.0/10 (2), no cloud machine | central host anyway |

- [ ] A command never waits for a slot. When no candidate is free, it runs on the central host. If the project allows cloud overflow, a machine is started for the next command (X63).
- [ ] A worker may refuse a command:
  - `busy`;
  - `missing_tool`: the command's first word is not on the copy's `PATH`;
  - `setup_pending`;
  - `not_approved`;
  - `not_fenced`.

  The central host then tries the next candidate. The reason shows on the Workers screen, as "missing pnpm" or "waiting for setup approval".

### Routing copies

- [ ] A worker runs routed commands in a **routing copy** of the session, at `$MOONLET_HOME/runs/<host>/<project>/<session>/`. It is made with X60's `sync.open` and `sync.fetch`. A copy the user keeps in sync (X60) is never used for routing, and a routing copy never shows in `sync.list` or the sidebar.
- [ ] A routing copy syncs only at fences. Between runs it holds what the last fence left.
- [ ] Setup in a routing copy on a Mac follows X60: the user approves the exact command once per project and central host, and the approval is shared with live copies. Until setup has finished, the Mac refuses with `setup_pending`, and the app shows X60's setup modal. Cloud machines run setup without asking (X63).
- [ ] Paths in output are the session's paths. The worker replaces the routing copy's absolute path with the session's path in every output byte stream, including across chunk boundaries. Example: `/Users/alex/.moonlet/runs/studio-mini/shop/fix-cart/src/cart.ts:12` reads `/Users/alex/.moonlet/worktrees/shop/fix-cart/src/cart.ts:12`.
- [ ] A routing copy is removed:
  - when the session is archived;
  - when the worker turns off heavy commands;
  - when the worker's central host changes;
  - after 7 days unused.

  Nothing is saved first: a routing copy holds nothing the user made.

### Fences

- [ ] **Before:** the central host snapshots the session (X60's private index) and sends the routing copy an update to that tree and `HEAD`. The command starts only when the copy's snapshot equals the session's tree and its `HEAD` equals the session's. A copy that cannot reach that state within 60 s refuses with `not_fenced`.
- [ ] **During:** the routing copy takes no updates, and edits on the central host during the run stay.
- [ ] **After:** when the command exits, the worker snapshots the copy and offers it against the fence's tree, with the objects of any commit the run made. The central host applies it. `moonlet exec` returns the exit status only after the central host has applied it. A test: a command that writes `out.txt` and exits 0, then `cat out.txt` in the next Bash call on the central host, prints its contents.
- [ ] A file that both the run and the central host changed during the run keeps the central host's version. The run's version is saved to `$MOONLET_HOME/sync-leftovers/<session>-run-<YYYYMMDD-HHMMSS>/` on the central host. The last output line reads "moonlet: src/cart.ts changed on studio-mini during the run; the run's version is in ~/.moonlet/sync-leftovers/fix-cart-run-20261022-104200".
- [ ] Ignored files a run makes stay on the worker, as git's rules decide (X60), except the paths in `[heavy] outputs`. Those replace the same paths on the central host after the run. A path outside the worktree, or one with `..`, is refused when the config is read. More than 1 GiB of outputs is not brought back, and the output says so.

### Output, exit status, cancelling

- [ ] The first stderr line is "moonlet: running on Alex's MacBook Pro". The command's stdout and stderr then stream to `moonlet exec`'s stdout and stderr, each in order, with no TTY, as Claude Code's Bash tool runs commands.
- [ ] The exit status is the command's own. A command ended by signal N gives 128 + N.
- [ ] stdin is `/dev/null`.
- [ ] The command runs with the worker's login environment, plus `MOONLET_ROUTED=1`, `MOONLET_SESSION` and the variables named in `[heavy] env`, taken from `moonlet exec`'s environment. No other variable crosses machines.
- [ ] The worker runs the words as an argument list (no shell), from the call's working directory relative to the worktree.
- [ ] When `moonlet exec` gets SIGINT or SIGTERM (the Bash tool's timeout, or the user stopping the turn), the worker sends SIGTERM to the command's process group, then SIGKILL after 5 s. The run's changes still come back, and `moonlet exec` exits with 130 or 143.

### When a worker goes away

- [ ] A run whose worker disconnects, or misses 3 pings (X41), is abandoned. It runs again on the central host from the same fence, and the output gets "moonlet: Alex's MacBook Pro went away. Running again on studio-mini." The exit status is the second run's.
- [ ] The changes of an abandoned run never reach the session. When the worker links again, its routing copy goes back to the central host's tree before it runs anything.
- [ ] When the central host's daemon stops during a run, `moonlet exec` exits with 125 and "moonlet: lost studio-mini's daemon during the run". The worker stops the command.

### Workers screen

- [ ] Settings › Machines › Workers on the central host lists each worker: name, OS, cores, load, slots in use of total, round trip, and its running commands (session, command, running for). It follows `workers.changed` and `exec.changed`.

## UI

- **Project page (X43), Heavy commands section:** each entry with its state (approved / not approved), an **Approve** button for the list as it is now, the `os` and `outputs` as read from the config, and the line "Approved commands run without asking, on whichever machine is free." Editing the list happens in `.moonlet/config.toml`; X8's dialog gets the `[heavy]` keys.
- **This Mac page and each remote host's row (X61):** under the heavy-commands switch, "Run at most [2] at once". The help text "Commands are not routed yet" from X41 and X61 goes away.
- **Chat (X6):** a routed Bash row shows a chip "on Alex's MacBook Pro", read from the result's first `moonlet:` line, and "ran again on studio-mini" after a rerun.
- **Workers screen:** as above. With no workers: "No machine runs heavy commands for studio-mini yet. Turn on Use this Mac for heavy commands, or Use for heavy commands on a remote host."

## Protocol and RPCs

**Daemon, local and on the central host:**

- `exec.route {terminal, command, cwd}` returns `{route: bool, reason}`.
- `exec.run {session, argv, cwd, env}` returns `{run}`, then:
  - frames of kind 5, `Output`, with payload `[u32 BE run][u8 stream: 1 stdout, 2 stderr][bytes]`;
  - the event `exec.exited {run, status, worker, rerun, leftovers}`.
- `exec.cancel {run}`.
- `exec.list` returns running runs.
- The event `exec.changed`.
- `heavy.get {project}` returns `{entries: [{command, approved}], os, env, outputs}`.
- `heavy.approve {project, commands}` approves exactly that list. It needs the app or a paired desktop.

**Central host to worker:**

- `exec.prepare {session}` returns `ready`, `setup_pending`, `not_approved` or `making`. The worker makes the routing copy, through X60's `sync.open` and `sync.fetch`, if it has none.
- `exec.start {run, copy, argv, cwd, env, tree, head}` returns `{started: true}` or a refusal.
- `exec.cancel {run}`.

**Worker to central host:**

- `Output` frames with the run's id;
- `exec.done {run, status, base, tree, head, pack, outputs_pack}`.

**Changed:**

- The `worker.ping` answer gains `load` (1-minute load average).
- `worker.register` gains `slots`.
- `PROTOCOL_VERSION` goes from 5 to 6.
- `docs/protocol.md` gets the frame kind and the methods.

## Data and config

- **`.moonlet/config.toml`:** a `[heavy]` table with `commands`, `os`, `env` and `outputs`. It is read by `ProjectConfig` and edited by X8's dialog.
- **Central host, `$MOONLET_HOME/heavy.json`:** approved entries per project identity, as exact strings. Example: `{"github.com/acme/shop 4171b03…": ["pnpm build", "pnpm test"]}`.
- **Each linked worker, `$MOONLET_HOME/sync/projects.json`:** each project gains `approved_heavy`, the list approved for that worker, under X60's `<host> <origin> <root>` key.
- **`link.json`:** `worker` gains `slots`. The central host keeps its own slots in `heavy.json`.
- **Routing copies:** `$MOONLET_HOME/runs/`, listed in `sync/copies.json` with `kind: "run"`.

## Security considerations

- **Routing never skips a prompt the user would have seen.** The hook answers `allow` only for entries the user approved in moonlet's UI, which says that they run without asking. A prompt-injected agent can add `rm -rf ~` to `[heavy] commands`, but it is not approved, so it is not routed and not allowed. Deny and ask rules in the user's Claude Code settings still apply. Claude Code checks the rewritten command, and moonlet does not route commands that match the user's rules for the original.
- **An approved prefix allows any arguments.** `pnpm test --config evil.js` runs code the agent chose, as `pnpm test` already runs scripts the agent can edit. On a Mac, that code runs as the user. ADR 0009 accepts this for one user's own machines. The approval text names it: "Approved commands can run code from the project, including code the agent wrote, on this Mac."
- **The worker checks again.** It runs a command only when the command matches its own approved list for that project and central host. It runs an argument list, never `sh -c`, and only with a working directory inside the routing copy. Paths and folder names from the central host follow X60's rules.
- **Environment.** Only `[heavy] env` crosses machines. A project that names a secret there sends it to the worker, and the project page warns when a name looks like a secret (`*_TOKEN`, `*_KEY`, `*_SECRET`).
- **Files.** A routing copy gets what a live copy gets (X60). An ignored `.env` stays where it is, so a command that needs it on the worker needs it there already.

## Out of scope

- Cloud machines: [X63](X63-cloud-workers.md).
- Codex, background Bash calls, chained or piped commands, and commands typed into terminals by the user.
- Takeover when the central host is unreachable (ADR 0009's last slice).
- Windows workers.

## Test plan

- **Unit, `moonlet-core`:**
  - the matcher, against every row of the worked-example table;
  - the rule check, with captured `settings.json` files that have `deny` and `ask` rules in each form;
  - the picker, against every row of the order table;
  - path replacement, with the copy's path split across two chunks;
  - load parsing from captured `sysctl -n vm.loadavg` (macOS) and `/proc/loadavg` (Linux) output.
- **Unit, `moonlet-cli`:** the hook's output for a captured Claude Code `PreToolUse` payload (Bash with `description` and `timeout`) equals the literal JSON above. An unroutable payload prints nothing.
- **Daemon end-to-end, `crates/moonletd/tests/exec.rs`:** a central host and one or two worker `TestDaemon`s, linked as in `tests/link.rs`:
  - a routed command's output and exit status (3) come back;
  - a file the command writes is on the central host when `exec.exited` arrives;
  - a commit made by the run moves the session's branch;
  - an unapproved entry gets `route: false`;
  - a worker that has not approved the list refuses with `not_approved`, and the command runs on the next candidate;
  - a missing tool gets `missing_tool` and the next candidate;
  - a busy worker (load injected through a test-only setting) is skipped;
  - a worker stopped with SIGSTOP mid-run makes the command run again on the central host, the output has the rerun line, and the abandoned run's file never reaches the session;
  - cancelling sends SIGTERM and the exit is 143;
  - a file edited on the central host during the run keeps its version, and the run's is under `sync-leftovers`;
  - `outputs` brings back an ignored `coverage/`;
  - a stopped central daemon gives exit 125.
- **Vitest, `apps/desktop/src/lib/`:**
  - the chip text from a result's first `moonlet:` line;
  - the heavy-commands section's states (a new entry, a changed entry, all approved);
  - the Workers screen rows;
  - the secret-looking env warning.
- **e2e, `apps/desktop/e2e/specs/routing.e2e.ts`:** a scratch central host and the app's daemon linked as a worker:
  - approving heavy commands on the project page saves them (saving settings is crucial, X12);
  - a session terminal on the central host running `moonlet exec -- <fixture command>` shows "moonlet: running on" with the worker's name;
  - the Workers screen lists the run.

## Open questions

- **Default slots:** 2 per worker. The ADR 0009 trial ran one suite per machine, and a laptop may want 1.
- **`updatedInput` without `permissionDecision`.** Claude Code's docs don't say what that does. This spec always sends `allow`, so the question doesn't arise as long as approval stays required.
- **Codex** has no equivalent of `updatedInput` in its hooks today. Its routing waits for one.

Decided while writing this spec, on 2026-10-22:

- **Approval before routing.** ADR 0009's hook rewrites commands, and Claude Code applies permission rules to the rewritten command. Without an approval, an `allow` rule for `pnpm test` would stop matching, and the user would be prompted. With a silent `allow` instead, an agent could route anything it wrote into the config. Approval in moonlet's UI is the explicit allow.
- **Routing copies are separate from live copies.** A run in the user's own copy would mix its changes with the user's edits, and an abandoned run's changes could not be thrown away.
- **Never wait for a slot.** A queued command holds the agent's turn, and the central host can always run it.
