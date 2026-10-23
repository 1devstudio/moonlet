# X62 — Routed commands: heavy commands run on a free worker

- **Status:** draft
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0009](../adr/0009-central-host-workers-live-copies.md) (routing, fences), [0011](../adr/0011-machines-connect-over-the-tailnet.md) (transport), [0012](../adr/0012-cloud-workers.md) (cloud workers)
- **Depends on:** [X41](X41-worker-link-and-project-identity.md) (the worker link, `worker.list`, project identity), [X61](X61-remote-hosts-for-heavy-commands.md) (remote hosts as workers) and [X60](X60-keep-in-sync.md) (snapshots, packs, offer and update rounds, setup approval).

## Summary

An agent on the central host, such as the Mac mini `studio-mini`, runs `pnpm test`. When the project lists `pnpm test` as a **heavy command** and the user has approved it, moonlet runs it on the free worker with the lowest load: a linked Mac or remote host (X41, X61), the central host itself, or a cloud machine ([X63](X63-cloud-workers.md)). The worker runs it in a **routing copy** of the session's files. Before the command starts, a **fence** makes the copy hold exactly the session's files. Output streams back as it comes. After the command ends, every change it made is back in the session before the agent sees the exit status. If the worker goes away mid-run, the command runs again on the central host.

Every routed command is a **job** of its session. The session's **Jobs** tab lists its jobs, and each one opens to show its phases, its output, what came back and where it ran, the way X42's Agents tab shows subagents.

The screens are in [`design/x62-x63/`](design/x62-x63/), from the design review of PR #339.

This is ADR 0009's routing slice. It adds two things the ADR did not decide: an approval step, so that routing never skips a permission prompt the user would have seen, and routing copies kept apart from the copies a user keeps in sync.

## User journey

1. Project `shop` on `studio-mini` has, in `.moonlet/config.toml`:

   ```toml
   [heavy]
   commands = ["pnpm test", "pnpm build"]
   outputs = ["coverage"]
   ```

2. In Settings › Projects › shop (studio-mini), the **Heavy commands** section lists `pnpm test` and `pnpm build`, each marked **Not approved**, with a banner: "Approving the list lets agents run it without asking, on studio-mini, this Mac and devbox." The user clicks **Approve**. A toast reads "Approved pnpm test and pnpm build for shop on studio-mini, this Mac and devbox".
3. On the MacBook, Settings › Machines › Hosts › This Mac has **Use this Mac for heavy commands** on (X41). The user approved from this Mac, so this Mac may run them too.
4. In session `fix-cart`, the agent runs `pnpm test`. The Bash row in the chat shows a chip, **on Alex's MacBook Pro**. This Mac has no routing copy of `fix-cart` yet, so moonlet makes one and asks once: "Run shop's setup in the copy on this Mac? `pnpm install`". The user clicks **Run setup**.
5. 457 tests pass. A snapshot file that a test updated is in the session on `studio-mini` before the agent reads the result, and so is `coverage/`.
6. The agent runs `pnpm test` again, and the user closes the lid mid-run. The output gets the line "moonlet: Alex's MacBook Pro went away. Running again on studio-mini.", the suite runs on `studio-mini`, and the agent gets that run's exit status.
7. The session's **Jobs** tab lists both runs. The second reads "Ran again on studio-mini · exit 0". Opening it shows the timeline: started on Alex's MacBook Pro, which went away ("It missed 3 pings. That run's changes were dropped."), then ran again on studio-mini from the same files and exited 0. **↗** opens the job as a session tab with its full output.
8. Settings › Machines › Workers, on `studio-mini`, lists each worker: load, slots in use, round trip, and the commands running there.

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

  A command is not routed when it has, outside single quotes, any of `;` `&` `|` `<` `>` `(` `)` `$` `` ` `` `*` `?` `[` `{` `~` `#`, or a newline, or when it starts with an assignment. Nor is one whose first word is a Bash keyword (`time`, `!`, `if`…) or a builtin with no program of its own (`cd`, `export`, `source`…), approved or not: Bash runs those itself, and a worker runs a command without a shell.
- [ ] Only Bash calls of Claude Code agents in sessions on the central host are routed: calls with `MOONLET_SESSION` set, whose working directory is inside the session's worktree. A call whose input has any field but `command`, `timeout` and `description` is not routed: `run_in_background`, or one that asks to leave Claude Code's sandbox, goes through Claude Code's own checks. Nothing is routed while the agent is in plan mode (`permission_mode` `plan`), so the hook's `allow` never gets round it. Codex is not routed yet.
- [ ] A command is routed only when its entry is approved for the project on this central host. Approval holds for the exact list of entries and the exact list of `env` names. An entry that is added or changed is not routed until it is approved, and the project page shows it as not approved. A name added to `env` stops routing for the project until the list is approved again, because approving is the user's consent to send those variables to every worker, cloud machines included. Removing an entry or a name needs no approval.
- [ ] Only the Mac's app and paired desktops approve. `heavy.approve` from the `moonlet` CLI or a phone is refused with `forbidden`, so an agent cannot approve the commands it adds.
- [ ] Each linked worker keeps its own approval, for the machine it runs on. **Approve** on the project page approves the list on the central host and on every linked worker the app reaches: this Mac, and remote hosts through their tailnet connection (X61). A worker linked later, or one the app could not reach, shows "not approved for shop" on the Workers screen, with **Approve**. `heavy.approve` on a worker follows X61's rule for `link.set`: the worker's own app or a paired Mac, never a phone or the CLI.
- [ ] A command is not routed when the Claude Code settings that apply to the session (managed, user or the X33 profile's, project and local) have a `deny` or `ask` rule for `Bash` that matches it. Prefix rules (`Bash(pnpm build:*)`, `Bash(pnpm build)`) are matched as prefixes. A rule that moonlet cannot read as a prefix stops routing for every command that starts with the rule's first word. A rule that starts with a wildcard, and a settings file that exists but is not valid JSON, stop routing for every command. Prefixes are matched as text, so `Bash(pnpm build:*)` also keeps `pnpm builder` where it is.

### The hook

- [ ] moonlet's `PreToolUse` hook (A2) asks the daemon `exec.route {session, command, cwd, tool_use_id}` for Bash calls, with the session from `MOONLET_SESSION`. With `route: false`, an error, or no answer within 2 s, it prints nothing and the call runs as it would without moonlet.
- [ ] With `route: true`, it prints:

  ```json
  {
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "allow",
      "permissionDecisionReason": "moonlet: an approved heavy command; it runs on whichever machine is free",
      "updatedInput": {
        "command": "'/Applications/moonlet.app/Contents/MacOS/moonlet' exec --tool-use toolu_012ftuDv3XBoqpcogRjeHhqb -- pnpm test",
        "description": "Run the tests",
        "timeout": 600000
      }
    }
  }
  ```

  `updatedInput` repeats every field of the call's `tool_input` and changes only `command`: the original command text, unchanged, after the `moonlet` binary's own path in single quotes, `exec`, the tool call's id as `--tool-use <id>` (so the job is found from the chat's row) and `--`. Agents do not have `moonlet` on their `PATH`, so the path is spelled out. Claude Code still applies the user's deny and ask rules to the rewritten command.
- [ ] `moonlet exec` started anywhere without a central host's routing (no daemon, or `MOONLET_SESSION` not set) runs the command where it is, so a rewritten command always runs. A command it cannot start exits with 127 and "moonlet: cannot run <command>: <reason>", as a shell would.

### Picking a worker

- [ ] The candidates are:
  - linked workers: Macs with **Use this Mac for heavy commands** on (X41) and remote hosts with **Use for heavy commands** on (X61), each of which approved the project's list;
  - the central host;
  - the project's cloud machines that are ready (X63).

  A candidate must have the project's `os` when one is set, a free slot, and a load below busy.
- [ ] Each worker has **slots**: how many routed commands it runs at once, from 1 to 64. The default is 2. Every machine keeps its own in its `link.json` (`link.set {worker: {slots}}`), the central host included, and a linked worker sends them when it registers, and again when they change. The worker's own This Mac page sets them.
- [ ] A worker is **busy** when its 1-minute load average (`getloadavg`) is at least 0.7 × its cores. The worker sends its load in each `worker.ping` answer, and `worker.list` shows it. The central host reads its own load the same way.
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

- [ ] A worker runs routed commands in a **routing copy** of the session, at `$MOONLET_HOME/runs/<host>/<project>/<session>/`. It is made with X60's `sync.open` and `sync.fetch`, in a repository of its own under `runs/repos/`, filled only with what the central host sends: the user's own repositories, branches and credentials are never used, so a routing copy and a live copy of the same session never stand in each other's way. A copy the user keeps in sync (X60) is never used for routing, and a routing copy never shows in `sync.list`, its events or the sidebar.
- [ ] A routing copy syncs only at fences. After each run, once the central host has its changes, it returns to that run's fence, so between runs it holds exactly what the last fence left.
- [ ] Setup in a routing copy on a Mac follows X60: the user approves the exact command once per project and central host, and the approval is shared with live copies. Until setup has finished, the Mac refuses with `setup_pending`, and the app shows X60's setup modal. Cloud machines run setup without asking (X63).
- [ ] Paths in output are the session's paths. The worker replaces the routing copy's absolute path with the session's path in every output byte stream, including across chunk boundaries. Example: `/Users/alex/.moonlet/runs/studio-mini/shop/fix-cart/src/cart.ts:12` reads `/Users/alex/.moonlet/worktrees/shop/fix-cart/src/cart.ts:12`.
- [ ] A routing copy is removed:
  - when the session is archived;
  - when the worker turns off heavy commands;
  - when the worker's central host changes;
  - after 7 days unused. A copy a run has prepared counts as in use until that run ends, for at most 10 minutes.

  Nothing is saved first: a routing copy holds nothing the user made.

### Fences

- [ ] **Before:** the central host snapshots the session (X60's private index) and sends the routing copy an update to that tree and `HEAD`. The command starts only when the copy's snapshot equals the session's tree and its `HEAD` equals the session's. A copy that cannot reach that state within 60 s refuses with `not_fenced`.
- [ ] **During:** the routing copy takes no updates, and edits on the central host during the run stay.
- [ ] **After:** when the command exits, the worker snapshots the copy and offers it against the fence's tree, with the objects of any commit the run made. The central host applies it. `moonlet exec` returns the exit status only after the central host has applied it. A test: a command that writes `out.txt` and exits 0, then `cat out.txt` in the next Bash call on the central host, prints its contents.
- [ ] A file that both the run and the central host changed during the run keeps the central host's version. The run's version is saved to `$MOONLET_HOME/sync-leftovers/<session>-run-<YYYYMMDD-HHMMSS>/` on the central host. The last output line reads "moonlet: src/cart.ts changed on studio-mini during the run; the run's version is in ~/.moonlet/sync-leftovers/fix-cart-run-20261022-104200".
- [ ] The `outputs` that count are the ones checked when the run started: a run that edits the config cannot widen them. Ignored files a run makes stay on the worker, as git's rules decide (X60), except the paths in `[heavy] outputs`. Those replace the same paths on the central host after the run. Each `outputs` path must be a non-empty relative path below the worktree root. The root itself (`.`, `./` or an empty string), a path outside the worktree, one with `..`, and one through a `.git` or `.moonlet` folder are refused when the config is read. Symbolic links are never followed:
  - an `outputs` path that is itself a symbolic link is skipped with "moonlet: coverage is a symbolic link; not brought back";
  - a link inside an `outputs` path comes back as a link, with its target text unchanged, and is never resolved on either side;
  - on the central host, a path is replaced only when none of its parent folders inside the worktree is a symbolic link. Otherwise it is skipped with the same kind of line.

  More than 1 GiB of outputs is not brought back, and the last output line reads "moonlet: outputs are 1.4 GiB, over the 1 GiB limit; not brought back".

### Output, exit status, cancelling

- [ ] The first stderr line is "moonlet: running on Alex's MacBook Pro". The command's stdout and stderr then stream to `moonlet exec`'s stdout and stderr, each in order, with no TTY, as Claude Code's Bash tool runs commands.
- [ ] The exit status is the command's own. A command ended by signal N gives 128 + N.
- [ ] stdin is `/dev/null`.
- [ ] The command runs with the worker's login environment, plus `MOONLET_ROUTED=1`, `MOONLET_SESSION` and the variables named in `[heavy] env`, taken from `moonlet exec`'s environment. No other variable crosses machines.
- [ ] The worker runs the words as an argument list (no shell), from the call's working directory relative to the worktree.
- [ ] `exec.run` checks the words again as the hook would have, because an agent can call `moonlet exec` itself: a command the hook would not route is refused with `not_routable` and its reason, and `moonlet exec` then runs it where it is, as without moonlet.
- [ ] When `moonlet exec` gets SIGINT or SIGTERM (the Bash tool's timeout, or the user stopping the turn), the worker sends SIGTERM to the command's process group, then SIGKILL after 5 s. The run's changes still come back, and `moonlet exec` exits with 130 or 143.

### When a worker goes away

- [ ] A run whose worker disconnects, or misses 3 pings (X41), is abandoned. It runs again on the central host from the same fence, and the output gets "moonlet: Alex's MacBook Pro went away. Running again on studio-mini." The exit status is the second run's.
- [ ] The changes of an abandoned run never reach the session. When the worker links again, its routing copy goes back to the central host's tree before it runs anything.
- [ ] When the central host's daemon stops during a run, `moonlet exec` exits with 125 and "moonlet: lost studio-mini's daemon during the run". The worker stops the command.

### Workers screen

- [ ] Settings › Machines › Workers on the central host lists each worker: name, OS, cores, load, slots in use of total, round trip, and its running commands (session, command, running for). It follows `workers.changed` and `job.changed`.
- [ ] **Approve** on a worker's line first shows the project's exact commands and variable names in the confirm modal (X23), as its page has them now, so nothing is approved unseen.
- [ ] A worker's line says why the project's commands skip it: "Not approved for shop" (with **Approve**), "skipped for shop: missing pnpm", or, for the central host when no other worker is free, "busy, takes commands no one else can".
- [ ] The summary line reads "5 commands running · 5 of 13 slots in use": the jobs running now, and used slots of all slots of every linked worker, the central host and ready cloud machines.

### Jobs

- [ ] Every routed command is a **job** of its session. So is every command `exec.route` routed that ran on the central host because no worker was free. The central host keeps each session's last 50 jobs, with their output, until the session is archived, and through daemon restarts.
- [ ] A job's state is one of:
  - `waiting {for}`: for setup approval, or for a cloud machine (X63). A command never waits for a slot;
  - `running {worker}`;
  - `bringing_back`;
  - `done {exit}`;
  - `stopped`;
  - `lost` (the central daemon stopped, exit 125).
- [ ] A job records its **phases** with their durations: "Copy matched the session", "Ran on <worker>", "Brought back", "Exit status to Claude". It also records its **timeline**:
  - started on <worker>;
  - <worker> went away, with why ("It missed 3 pings." or "Its link closed.") and "That run's changes were dropped.";
  - ran again on <host>, from the same files;
  - exited N, and the status went to the agent.
- [ ] A job records what came back: each changed file with its added and removed line counts, each `outputs` path with its size, and each leftover from the fence (a file that changed on the central host during the run). It also records the worker as it was at the start: load, the slot it took ("1 of 2"), round trip and the routing copy's path. Of the environment, it records only the names passed to the worker, never the values.
- [ ] A job's output is kept as it streamed, stdout and stderr apart, up to 10 MiB per job. Past that, the middle is dropped and replaced by one line, "moonlet: 3.2 MB of output dropped here". After a rerun, the output of each run stays, with a separator line "──── run 2 · studio-mini ────" between them.
- [ ] **Output summary.** When a job ends, the central host reads its output (ANSI escapes removed, the last run only after a rerun) and keeps one summary line. The first rule that matches wins:
  1. **Test results.** Formats read:
     - vitest's `Tests  … (N)` line;
     - jest's `Tests: …, N total`;
     - `cargo test`'s `test result:` lines, summed over every crate and binary;
     - pytest's closing `== … in …s ==` line.

     All passed gives "457 tests passed". Some failed gives "2 of 457 tests failed".
  2. **The first compiler error.** Formats read:
     - TypeScript (`tsc`, in both its plain and `--pretty` forms) gives "Type error in src/cart.ts:41";
     - rustc and cargo (`error[E…]: <message>` followed by ` --> <file>:<line>:<col>`) give "<message> in src/lib.rs:41", the message cut to 60 characters.
  3. Otherwise, no summary.

  Paths are relative to the worktree. Worked examples:

  | Output (the lines that matter) | Exit | Summary |
  |---|---|---|
  | `      Tests  457 passed (457)` | 0 | 457 tests passed |
  | `      Tests  2 failed \| 455 passed (457)` | 1 | 2 of 457 tests failed |
  | `Tests:       2 failed, 455 passed, 457 total` | 1 | 2 of 457 tests failed |
  | `test result: ok. 38 passed; 0 failed; …` and `test result: ok. 12 passed; 0 failed; …` | 0 | 50 tests passed |
  | `test result: FAILED. 36 passed; 2 failed; …` | 101 | 2 of 38 tests failed |
  | `==== 457 passed in 3.21s ====` | 0 | 457 tests passed |
  | `src/cart.ts(41,7): error TS2322: Type 'string' is not assignable to type 'number'.` | 2 | Type error in src/cart.ts:41 |
  | `src/cart.ts:41:7 - error TS2322: …` | 2 | Type error in src/cart.ts:41 |
  | `error[E0308]: mismatched types` then `  --> src/lib.rs:41:5` | 101 | mismatched types in src/lib.rs:41 |
  | `Done in 2.1s` | 0 | (none) |

  The summary ends the job tab's state line ("… · run by Claude in fix-cart · 457 tests passed"). A row's second line adds it only for a job that did not exit 0 ("studio-mini · exit 1 · Type error in src/cart.ts:41").
- [ ] Jobs hold commands' output, so only the app and paired devices list, read and stop them. An agent's `moonlet` CLI and a worker are refused with `forbidden`, as the CLI is for another terminal's output without the user's approval (X31).
- [ ] **Stop** on a running or waiting job cancels it as `exec.cancel` does (SIGTERM, then SIGKILL after 5 s). The agent gets exit 143 and the line "moonlet: stopped from the Jobs panel". Changes the job made so far still come back. **Stop all** stops every running and waiting job of the session.
- [ ] **Run on studio-mini now**, on a job waiting for a cloud machine, runs it on the central host at once, with the line "moonlet: running on studio-mini instead, as asked from the Jobs panel". The machine keeps starting, and takes the next command.
- [ ] The Jobs tab's count is the number of the session's jobs in the history, whatever their state.
- [ ] The Jobs tab's summary reads "1 waiting · 3 done · 4m 38s on workers": counts by state, and the total running time of the session's jobs. Worked examples:

  | Jobs | Summary |
  |---|---|
  | none | (no summary; the empty text) |
  | 1 running 0:42 | 1 running · 42s on workers |
  | 1 waiting, 3 done (38 s, 1m 12s, 2m 03s), 1:10 waiting | 1 waiting · 3 done · 3m 53s on workers |
  | 2 done (59 s, 1 s) | 2 done · 1m 00s on workers |

  Waiting time does not count as time on workers.
- [ ] A job row's second line, worked examples:

  | Job | Second line |
  |---|---|
  | done on a Mac, exit 0, 1 leftover | Alex's MacBook Pro · exit 0 · 1 leftover |
  | done after a rerun, exit 0 | Ran again on studio-mini · exit 0 |
  | done on the central host, exit 1, no summary | studio-mini · exit 1 |
  | done on the central host, exit 1, a type error | studio-mini · exit 1 · Type error in src/cart.ts:41 |
  | waiting for a cloud machine at setup step 4 of 6 | Waiting for moonlet-shop-m3x9 · setup 4 of 6 |
  | running on a cloud machine | Running on moonlet-shop-7k2q · 0:31 |
  | stopped | Stopped · Alex's MacBook Pro |

## UI

The screens are in [`design/x62-x63/`](design/x62-x63/). Where this section and a screen differ, this section wins and the difference is listed under Open questions.

- **Settings nav (X43), Machines group** ([settings-nav.png](design/x62-x63/settings-nav.png)): **Hosts**, then **Workers**, then **Cloud workers** (X63), then **Phones**. Workers and Cloud workers carry the central host's name, as project rows carry their host's.
- **Project page, Heavy commands** ([project-page.png](design/x62-x63/project-page.png)):
  - under the heading, "Approved commands run without asking, on whichever machine is free.";
  - **Commands:** one editable row per entry, with a state pill (**Approved**, or **Not approved** in the attention colour) and **×** to remove it, plus **Add command**. The help text is "A Bash call that starts with one of these goes to the free worker with the lowest load. Chained, piped or redirected calls run where the agent is.";
  - **Runs on:** a segmented control, **Any**, **macOS** or **Linux** (`os`), with "Workers on another system are skipped.";
  - **Bring back after a run:** `outputs`, with "Ignored paths that replace the same paths on studio-mini when a run ends. Up to 1 GiB.";
  - **Pass to the worker:** `env`. A name that looks like a secret gets the warning "NPM_TOKEN looks like a secret. It reaches every machine that runs these commands, cloud machines too." Approving the list approves these names too;
  - while the list differs from the approved one, a banner names what changed ("pnpm build was added since you approved the list"), the machines the approval covers, and the code-execution warning, with **Approve**;
  - the footnote "Changing an entry needs approving again. Removing one doesn't. Only this app and paired desktops can approve, never an agent or a phone."

  The page edits `[heavy]` in `.moonlet/config.toml` on the project's host, as X8 edits the other keys. Editing never approves.
- **Hosts page** ([hosts-slots.png](design/x62-x63/hosts-slots.png)):
  - under **Use this Mac for heavy commands**, the status line adds the running count: "Linked to studio-mini since 09:02 · 1 running";
  - a **Run at most [− 2 +] at once** row, with "Routed commands side by side. 1 suits a laptop on battery.";
  - the same row under each remote host's **Use for heavy commands** switch, with "Saved on devbox.";
  - the footnote "studio-mini's own slots are on its This Mac page. See what each worker runs in Workers.";
  - the help text "Commands are not routed yet" from X41 and X61 goes away.
- **Workers page** ([workers-page.png](design/x62-x63/workers-page.png)): the title with a "studio-mini · Central host" badge; "Machines that run heavy commands for studio-mini's sessions. A command goes to the free worker with the lowest load, and runs on studio-mini when none is free."; the summary line; then:
  - a **Macs and hosts** table, with columns Worker, Load (a bar and "1.2 / 10"), Slots ("1 of 2") and Round trip. Badges are "This Mac" and "Central host", and the skip reasons sit under the name, in the attention colour. The page reads `worker.list` and `exec.status` from the central host every two seconds while it is open, and on `workers.changed` and `job.changed`. Each running job sits under its worker: spinner, session, command, elapsed time. A busy load bar uses the attention colour;
  - **Cloud machines** (X63).
- **Workers, empty** ([workers-empty.png](design/x62-x63/workers-empty.png)): "Only studio-mini runs heavy commands", "No machine runs heavy commands for studio-mini yet. Turn on Use this Mac for heavy commands, or Use for heavy commands on a remote host." and **Open Hosts**. **Set up cloud workers** comes with X63.
- **Chat (X6)** ([chat-routed-rows.png](design/x62-x63/chat-routed-rows.png)):
  - a routed Bash row shows the agent's command, never `moonlet exec -- `;
  - a chip shows where it ran, "on Alex's MacBook Pro", with a laptop icon for a Mac, a server icon for a host and a cloud icon for a cloud machine;
  - after a rerun, the chip reads "ran again on studio-mini", in the attention colour;
  - `moonlet:` lines in the output use the accent colour, and a went-away line uses the attention colour.

  The chip comes from the job, matched by the tool call's id, and falls back to the result's first `moonlet:` line.
- **Session right panel, Jobs tab** ([jobs-list.png](design/x62-x63/jobs-list.png), [session-jobs-panel.png](design/x62-x63/session-jobs-panel.png)): a tab after **Agents** with a count of the session's jobs. It shows the summary line with **Stop all**, then one row per job, newest first:
  - a state dot: accent dots for waiting or running, green for exit 0, red for any other exit;
  - the command, the elapsed or total time, and the second line;
  - under the list, "Heavy commands this session's agents ran through moonlet. Click one for its output."

  The tab shows once the session has a job.
- **Job detail in the panel** ([job-running.png](design/x62-x63/job-running.png), [job-waiting-for-cloud.png](design/x62-x63/job-waiting-for-cloud.png), [job-done-after-rerun.png](design/x62-x63/job-done-after-rerun.png)): **‹ Jobs**, the command, the state line ("Running · 0:42 · Claude in fix-cart"), and **↗** to open it as a tab. Then:
  - the phases as a checklist with durations, or the timeline after a rerun;
  - the worker card ("load 1.2 / 10 · slot 1 of 2 · 6 ms");
  - for a cloud wait, X63's startup checklist;
  - **Output** with its line count, **Follow** and copy;
  - a footer with **Stop** ("Changes made so far still come back.") or **Run on studio-mini now**.
- **Job tab** ([job-tab.png](design/x62-x63/job-tab.png)): a session tab (T2) with the worker's icon and the job's state. Its header has the command, the worker chip, and a state line ("Done · exit 0 · 1m 12s · 10:40:46 – 10:41:58 · run by Claude in fix-cart"). Under it, a bar with the phases at their real lengths, labelled with durations, then **Copy output** and a **⋯** menu. Then:
  - the output, with **All / stdout / stderr** (stderr with a count), **Find in output**, the line count, **Follow**, line numbers, and stderr lines in the attention colour;
  - a side column with **Worker** (load at start, slot, round trip, copy path), **Brought back** (files with +/− counts, `outputs` with sizes), a leftover card with **Compare** (the session's version against the run's) and, when the central host is this Mac, **Reveal**, and **Passed to the worker** (names only, "Values are never shown here.").

  The tab closes when the job is dropped from the history.
- **Toasts** ([toasts.png](design/x62-x63/toasts.png)): after **Approve**, "Approved pnpm test and pnpm build for shop on studio-mini, this Mac and devbox". When a worker could not be reached to approve: "Approved for shop on studio-mini and this Mac. devbox was not reachable; approve it from Workers."

## Protocol and RPCs

**Daemon, local and on the central host:**

- `exec.route {session, command, cwd, tool_use_id}` returns `{route: bool, reason}`. `reason` says why a call stays where it is: `no_session` (unknown or archived), `outside_worktree`, `invalid_config`, `not_heavy`, `not_approved`, `env_not_approved` or `claude_rule`. The decision reads `[heavy]` from the session's own worktree, so an agent's edit there counts, and fails closed when it cannot be read or checked.
- `exec.run {session, argv, cwd, env}` returns `{run, host}`, then:
  - frames of kind 5, `Output`, with payload `[u32 BE run][u8 stream: 1 stdout, 2 stderr][bytes]`;
  - the event `exec.exited {run, status, worker, rerun, leftovers}`.
- `exec.cancel {run}`.
- `exec.status` → `{host: {name, os, cores, load, slots, used}, running: [{job, session, command, worker, started_at}], skips: [{worker, project, reason, detail}], routed}`: this machine, the routed commands going on wherever they run, why workers were skipped in the last hour, and how many commands this machine runs for its own central host. The Workers page and the Hosts page's `· 1 running` read it.
- `job.list {session}` returns the session's jobs, newest first, with state, phases, timeline, worker, what came back, env names and `summary`.
- `job.output {job, from}` → `{chunks: [{stream, text}], next, more}`: the stored output from byte `from` of its file, up to 1 MiB at a time. A running job's new output also comes as the event `job.output {job, session, chunks}`, so the app needs no frames to follow it.
- `job.stop {job}` → `true`/`false`, `job.stop_all {session}` → how many it stopped, and `job.run_here {job}` (a job waiting for a cloud machine; until X63, every job answers `not_waiting`).
- The event `job.changed {job}`.
- `exec.route` and `exec.run` take the tool call's id (`tool_use_id` from the hook payload), so the chat can match its row to the job.
- `heavy.get {project}` returns `{config, approved, error}`: the `[heavy]` table of the project's folder, the approved `{commands, env}` or `null`, and why the table cannot be used, if it cannot. The app works out each entry's state and the machines that approved it from these and the workers' answers.
- `heavy.set {project, commands, os, env, outputs}` writes `[heavy]` in `.moonlet/config.toml` as X8 writes the other keys. It never approves.
- `heavy.approve {project, commands, env}` approves exactly those commands and `env` names, together as one record. It fails with `changed` when either list differs from the config as it is now, so the user never approves a list they did not see. It needs the app or a paired desktop.

**Central host to worker:**

- `exec.prepare {session}` returns `{copy, state, reason}`, `state` being `ready`, `making`, `setup_pending` or `failed`. The worker makes the routing copy, through X60's `sync.open {kind: "run"}` and `sync.fetch`, if it has none. A worker with heavy commands off answers `not_approved`.
- `exec.start {run, copy, argv, cwd, env, tree, head, session_path, outputs}` returns `true`, or a refusal: `not_approved` (this machine's own approval), `busy` (slots or load), `not_fenced`, `missing_tool` or `invalid_params` (a folder or `outputs` path outside the copy).
- `exec.cancel {run}`.

**Worker to central host:**

- `Output` frames with the run's id;
- `exec.done {run, copy, status, tree, head, pack, outputs}` → `{leftovers, folder, notes}`, only from the worker that runs `run` in `copy`. `outputs` is a tree of the run's `outputs` in the same pack.

**Changed:**

- The `worker.ping` answer gains `load` (1-minute load average).
- `worker.register` gains `slots`.
- `PROTOCOL_VERSION` goes from 5 to 6.
- `docs/protocol.md` gets the frame kind and the methods.

## Data and config

- **`.moonlet/config.toml`:** a `[heavy]` table with `commands`, `os`, `env` and `outputs`. It is read by `ProjectConfig` and edited by X8's dialog.
- **Central host, `$MOONLET_HOME/heavy.json`:** the approval per project identity: the exact commands and the exact `env` names, saved together. Example: `{"github.com/acme/shop 4171b03…": {"commands": ["pnpm build", "pnpm test"], "env": ["CI", "NPM_TOKEN"]}}`. A routed command needs both lists to match the config.
- **Each linked worker, `$MOONLET_HOME/sync/projects.json`:** each project gains `approved_heavy {commands, env}`, the lists approved for that worker, under X60's `<host> <origin> <root>` key.
- **`link.json`:** `worker` gains `slots`, on every machine, the central host included.
- **Routing copies:** `$MOONLET_HOME/runs/`, listed in `sync/copies.json` with `kind: "run"`.
- **Jobs, on the central host:** `$MOONLET_HOME/jobs/<session>/jobs.json` (the last 50 jobs) and `<job>.out`, the output as tagged stdout and stderr chunks. They are removed with the session.

## Security considerations

- **Routing never skips a prompt the user would have seen.** The hook answers `allow` only for entries the user approved in moonlet's UI, which says that they run without asking. A prompt-injected agent can add `rm -rf ~` to `[heavy] commands`, but it is not approved, so it is not routed and not allowed. Deny and ask rules in the user's Claude Code settings still apply. Claude Code checks the rewritten command, and moonlet does not route commands that match the user's rules for the original.
- **An approved prefix allows any arguments.** `pnpm test --config evil.js` runs code the agent chose, as `pnpm test` already runs scripts the agent can edit. On a Mac, that code runs as the user. ADR 0009 accepts this for one user's own machines. The approval text names it: "Approved commands can run code from the project, including code the agent wrote, on this Mac."
- **Who approves.** On this Mac's Unix socket, the app and an agent's `moonlet` CLI are told apart by the name each gives, as for phone access (X39) and the link (X41, X61). A process running as the user that lies about its name could also edit `~/.moonlet/heavy.json` itself, so the check guards against an agent's ordinary use of the CLI, not against such a process.
- **The worker checks again.** It runs a command only when the command matches its own approved list for that project and central host. It runs an argument list, never `sh -c`, and only with a working directory inside the routing copy. Paths and folder names from the central host follow X60's rules.
- **Environment.** Only `[heavy] env` crosses machines, and only once the user has approved its exact names, so an agent cannot add a name and have its value sent. The approval banner names secret-looking ones (`*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD`) and says they reach every machine, cloud machines included.
- **Outputs.** Bringing back `outputs` never follows a symbolic link on either machine, so a run cannot make the central host read or write outside the worktree through one.
- **Files.** A routing copy gets what a live copy gets (X60). An ignored `.env` stays where it is, so a command that needs it on the worker needs it there already.

## Out of scope

- Cloud machines: [X63](X63-cloud-workers.md).
- Codex, background Bash calls, chained or piped commands, and commands typed into terminals by the user.
- Takeover when the central host is unreachable (ADR 0009's last slice).
- Windows workers.

## Test plan

Every acceptance criterion maps to at least one test below. The names are the ones the implementing pull requests use, word for word. A pull request that renames a test updates this table. Expected values are literals from this spec or from captured real output.

Where the tests live:

- **Rust unit tests:** `crates/moonlet-core/src/heavy.rs` (matching, Claude Code rules, picking, paths), `crates/moonlet-core/src/job_summary.rs` and `crates/moonlet-cli/src/hook.rs`, each in its `#[cfg(test)] mod tests`.
- **Daemon end-to-end:** `crates/moonletd/tests/exec.rs`. It runs a central host and one or two worker `TestDaemon`s, linked as in `tests/link.rs`, with a test-only setting for load and size limits. Slots and load over the link are in `crates/moonletd/tests/link.rs`.
- **CLI end-to-end:** `crates/moonlet-cli/tests/exec.rs`.
- **Vitest:** `apps/desktop/src/lib/heavyCommands.test.ts`, `workers.test.ts`, `jobs.test.ts`, `layout.test.ts` and `toolOutput.test.ts`.
- **e2e:** `apps/desktop/e2e/specs/routing.e2e.ts` and `jobs.e2e.ts`.

| Criterion | Tests |
|---|---|
| `[heavy]` keys | `heavy_table_reads_commands_os_env_and_outputs` |
| Which commands are routed (worked examples) | `routes_exactly_the_worked_examples`, `shell_keywords_and_builtins_are_never_routed` |
| Only Claude Code Bash calls in a session's worktree, not background | `a_background_bash_call_is_not_routed`, `a_terminal_outside_a_session_is_not_routed`, `a_call_outside_the_sessions_worktree_is_not_routed` |
| Approval of the exact entries and `env` names | `an_unapproved_entry_is_not_routed`, `a_changed_entry_needs_approving_again`, `a_new_env_name_stops_routing_until_approved`, `removing_an_entry_needs_no_approval`, `approving_records_the_commands_and_env_names_together`, `approving_a_list_that_changed_meanwhile_fails` |
| Who approves | `only_the_app_or_a_paired_mac_approves_heavy_commands` |
| Each linked worker's own approval | `a_worker_that_has_not_approved_refuses_and_the_next_one_runs_it`; Vitest "the approval toast names every machine it covers", "a worker that was not reachable is named in the toast" |
| The user's Claude Code deny and ask rules | `deny_and_ask_rules_stop_routing_in_each_form`, `a_rule_moonlet_cannot_read_stops_routing_for_its_first_word`, `a_deny_rule_in_the_worktree_keeps_the_command_here`, `a_managed_deny_rule_keeps_the_command_here` |
| The hook stays silent | `the_hook_prints_nothing_when_the_daemon_says_no`, `the_hook_prints_nothing_when_the_daemon_is_gone` |
| The hook's rewrite | `the_hook_rewrites_a_captured_bash_call_to_moonlet_exec` |
| `moonlet exec` without routing | `moonlet_exec_without_routing_runs_the_command_here` |
| `moonlet exec` in a session, and `exec.run`'s own check | `moonlet_exec_in_a_session_runs_through_its_daemon`, `an_unapproved_moonlet_exec_is_refused` |
| Candidates and `os` | `a_worker_on_another_os_is_skipped` |
| Slots | `slots_default_to_two_and_link_set_changes_them`, `a_worker_with_no_free_slot_is_skipped`; Vitest "says how many commands run here, and keeps slots from 1 to 64" |
| Busy | `a_worker_reports_its_load_with_each_ping`, `a_worker_at_seven_tenths_of_its_cores_is_busy` |
| Order (worked examples) | `picks_as_in_the_order_table` |
| Never waits for a slot | `a_command_with_no_free_worker_runs_on_the_central_host` |
| Refusals | `a_missing_tool_sends_the_command_to_the_next_worker`, `a_worker_waiting_for_setup_approval_is_skipped`, `a_copy_that_cannot_match_in_time_refuses_not_fenced` |
| Routing copies, apart from live copies | `a_routing_copy_lives_under_runs_and_not_in_sync_list` |
| Syncs only at fences | `a_routing_copy_takes_no_update_between_runs` |
| Setup in a routing copy on a Mac | `a_routing_copy_on_a_mac_waits_for_setup_approval` |
| Session paths in output | `replaces_the_copys_path_split_across_two_chunks`, `the_copys_path_reads_as_the_sessions_in_output` |
| Removing routing copies | `archiving_the_session_removes_its_routing_copies`, `turning_heavy_commands_off_removes_the_routing_copies`, `a_routing_copy_unused_for_seven_days_is_removed` |
| Fence before | `a_command_starts_only_once_the_copy_matches_the_session` |
| Fence during | `an_edit_on_the_central_host_during_a_run_stays` |
| Fence after | `a_file_written_by_the_run_is_on_the_central_host_before_the_exit_status`, `a_commit_made_by_the_run_moves_the_sessions_branch` |
| Leftovers | `a_file_changed_on_both_sides_during_a_run_keeps_the_central_version_and_saves_the_runs` |
| `outputs` | `outputs_bring_back_an_ignored_coverage_folder`, `an_outputs_path_outside_the_worktree_is_refused`, `the_worktree_root_is_refused_as_an_outputs_path`, `git_and_moonlet_folders_are_refused_as_outputs_paths`, `a_symbolic_link_in_outputs_is_never_followed`, `an_outputs_path_that_is_a_symbolic_link_is_skipped`, `outputs_over_one_gib_stay_on_the_worker_and_say_so`, `a_tree_of_outputs_never_writes_through_its_own_links` |
| First line and output streams | `a_routed_commands_output_and_exit_status_come_back` |
| Exit status and signals | `a_routed_commands_output_and_exit_status_come_back`, `a_command_killed_by_a_signal_exits_with_128_plus_it` |
| stdin | `a_routed_command_reads_an_empty_stdin` |
| Environment | `only_approved_env_names_reach_the_worker` |
| No shell, same folder | `a_routed_command_runs_without_a_shell_from_the_same_folder` |
| Cancelling | `cancelling_stops_the_command_and_brings_its_changes_back`, `moonlet_exec_stops_the_command_when_it_is_stopped` |
| A worker goes away | `a_worker_that_goes_away_mid_run_makes_the_command_run_again_on_the_central_host` |
| Abandoned changes | `an_abandoned_runs_changes_never_reach_the_session` |
| The central daemon stops | `a_stopped_central_daemon_ends_moonlet_exec_with_125` |
| Workers screen | `exec_status_lists_the_central_host_its_runs_and_why_workers_were_skipped`; Vitest "a worker's row from worker.list and job.list"; e2e "the Workers page says when no other machine runs heavy commands" |
| Skip reasons | Vitest "skip reasons for a project" |
| Approving on a worker | Vitest "shows the exact commands and variable names first" |
| Workers summary line | Vitest "the summary line counts running jobs and slots" |
| Who reads and stops jobs | `an_agents_cli_neither_reads_nor_stops_jobs` |
| Jobs history | `jobs_outlive_a_daemon_restart_and_keep_the_last_fifty`, `archiving_the_session_removes_its_jobs`, `a_job_going_on_when_the_daemon_stops_is_lost`, `a_job_knows_its_tool_call` |
| Job states | Vitest "the state line for each state" |
| Phases and timeline | `a_jobs_phases_and_timeline_after_a_rerun`; Vitest "the phase checklist", "the rerun timeline" |
| What came back | `a_job_lists_what_came_back_and_the_env_names_only` |
| Stored output | `output_over_ten_mib_keeps_its_start_and_end`, `a_rerun_keeps_both_runs_output_with_a_separator` |
| Output summary | `summarises_as_in_the_worked_examples`, `summarises_captured_runs_of_each_tool` (captured vitest, jest, `cargo test` over two crates, pytest, `tsc` plain and `--pretty`, `cargo build` with a type error) |
| Stop and Stop all | `stopping_a_job_gives_exit_143_and_brings_its_changes_back`, `stop_all_stops_every_running_and_waiting_job`; e2e "Stop ends a running job" |
| Run on the central host now | `job_run_here_needs_a_waiting_job`; `run_here_runs_a_job_waiting_for_a_cloud_machine_on_the_central_host` comes with X63, which makes jobs that wait |
| Jobs tab count | Vitest "the tab counts every job" |
| Jobs summary (worked examples) | Vitest "the summary line, as in the worked examples" |
| Row second line (worked examples) | Vitest "a row's second line, as in the worked examples" |
| Chat chip (UI) | Vitest "the chip from a job", "the chip from a result's first line", "the chip comes from the row's job, and falls back to the result's first line", "a rewritten command shows without moonlet exec", "colours moonlet's own lines, and a worker going away in the attention colour" |
| `heavy.set` writes `[heavy]` and never approves | `heavy_set_writes_the_heavy_table_and_keeps_the_rest`, `heavy_set_writes_the_projects_config_and_never_approves` |
| Project page (UI) | Vitest "a new entry, a changed entry, all approved", "the secret-looking env warning", "turns the table into a form and back, trimming and dropping blank entries"; e2e "approving heavy commands saves them" |
| Jobs tab (UI) | e2e "the Jobs tab lists the job and opens its output"; Vitest "the panel's worker card line, as in job-running.png" |
| Job tab (UI) | Vitest "opens a job as a new active tab, and switches to it when open", "keeps job tabs when the terminals are synced, and reads them back", "closes a job tab and activates its neighbour", "lays the phases out at their lengths, as in job-tab.png", "ends with the run going on while a job runs", "adds when it ran, and who ran it, as in job-tab.png", "reads chunks as numbered lines, stdout and stderr apart, without colours", "filters by stream and by what was typed in Find, keeping line numbers", "the job tab's Worker facts, as in job-tab.png" |

## Open questions


- **Default slots:** 2 per worker. The ADR 0009 trial ran one suite per machine, and a laptop may want 1.
- **`updatedInput` without `permissionDecision`.** Claude Code's docs don't say what that does. This spec always sends `allow`, so the question doesn't arise as long as approval stays required.
- **Codex** has no equivalent of `updatedInput` in its hooks today. Its routing waits for one.

Decided by the user on 2026-10-23:

- **The Jobs tab counts all the session's jobs**, not only the running and waiting ones.
- **Output summaries ship with this spec**, for the runners and compilers listed under Jobs. Others, such as `go test`, mocha or `swift build`, get no summary until they are added.

Decided while writing this spec, on 2026-10-22:

- **Approval before routing.** ADR 0009's hook rewrites commands, and Claude Code applies permission rules to the rewritten command. Without an approval, an `allow` rule for `pnpm test` would stop matching, and the user would be prompted. With a silent `allow` instead, an agent could route anything it wrote into the config. Approval in moonlet's UI is the explicit allow.
- **Routing copies are separate from live copies.** A run in the user's own copy would mix its changes with the user's edits, and an abandoned run's changes could not be thrown away.
- **Never wait for a slot.** A queued command holds the agent's turn, and the central host can always run it.
