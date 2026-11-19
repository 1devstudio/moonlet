# X62 — Routed commands: heavy commands run on a free worker

- **Status:** implemented (untried between real machines)
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0009](../adr/0009-central-host-workers-live-copies.md) (routing, fences), [0011](../adr/0011-machines-connect-over-the-tailnet.md) (transport), [0012](../adr/0012-cloud-workers.md) (cloud workers)
- **Depends on:** [X41](X41-worker-link-and-project-identity.md) (the worker link, `worker.list`, project identity), [X61](X61-remote-hosts-for-heavy-commands.md) (remote hosts as workers) and [X60](X60-keep-in-sync.md) (snapshots, packs, offer and update rounds, setup approval).
- **Changed by:** [Picking a worker](#picking-a-worker) (2026-11-19: a free slot is room, whatever the load; the session's host first; a line of commands that wait up to a minute), [Lines moonlet routes](#lines-moonlet-routes) (2026-11-16: `cd`, variables, `timeout`, redirections and filters around a heavy command), [X90](X90-heavy-commands-in-practice.md) (the main checkout's list, background calls, the output file), [X89](X89-every-host-runs-heavy-commands.md) (every member routes and runs heavy commands, approval and worker settings in the account state)

## Summary

An agent on the central host, such as the Mac mini `studio-mini`, runs `pnpm test`. When the project lists `pnpm test` as a **heavy command** and the user has approved it, moonlet runs it where there is a free slot: on the session's own host while it has one, else on a linked Mac or remote host (X41, X61) or a cloud machine ([X63](X63-cloud-workers.md)) with one. With every slot taken, the command waits in line for the first free slot, up to a minute, then runs on the session's host anyway. The worker runs it in a **routing copy** of the session's files. Before the command starts, a **fence** makes the copy hold exactly the session's files. Output streams back as it comes. After the command ends, every change it made is back in the session before the agent sees the exit status. If the worker goes away mid-run, the command may have run in part there, so moonlet does not run it again unless the project marked it safe to; the agent hears so and decides.

Every routed command is a **job** of its session. The session's **Jobs** tab lists its jobs, and each one opens to show its phases, its output, what came back and where it ran, the way X42's Agents tab shows subagents.

The screens are in [`design/x62-x63/`](design/x62-x63/), from the design review of PR #339.

This is ADR 0009's routing slice. It adds two things the ADR did not decide: an approval step, so that routing never skips a permission prompt the user would have seen, and routing copies kept apart from the copies a user keeps in sync.

## User journey

1. Project `shop` on `studio-mini` has, in `.moonlet/config.toml`:

   ```toml
   [heavy]
   commands = ["pnpm test", "pnpm build"]
   outputs = ["coverage"]
   rerun = ["pnpm test"]
   ```

2. In Settings › Projects › shop (studio-mini), the **Heavy commands** section lists `pnpm test` and `pnpm build`, each marked **Not approved**, with a banner: "Approving the list lets agents run it without asking, on studio-mini, this Mac and devbox." The user clicks **Approve**. A toast reads "Approved pnpm test and pnpm build for shop on studio-mini, this Mac and devbox".
3. On the MacBook, Settings › Machines › Hosts › This Mac has **Use this Mac for heavy commands** on (X41). The user approved from this Mac, so this Mac may run them too.
4. In session `fix-cart`, the agent runs `pnpm test`. The Bash row in the chat shows a chip, **on Alex's MacBook Pro**. This Mac has no routing copy of `fix-cart` yet, so moonlet makes one and asks once: "Run shop's setup in the copy on this Mac? `pnpm install`". The user clicks **Run setup**.
5. 457 tests pass. A snapshot file that a test updated is in the session on `studio-mini` before the agent reads the result, and so is `coverage/`.
6. The agent runs `pnpm test` again, and the user closes the lid mid-run. `pnpm test` is listed under `rerun`, so it is safe to run again: the output gets the line "moonlet: Alex's MacBook Pro went away. Running again on studio-mini.", the suite runs on `studio-mini`, and the agent gets that run's exit status. Had it been `pnpm build`, which is not listed, the agent would get exit status 125 and "moonlet: Alex's MacBook Pro went away during the run. The command may have run in part there; it was not run again."
7. The session's **Jobs** tab lists both runs. The second reads "Ran again on studio-mini · exit 0". Opening it shows the timeline: started on Alex's MacBook Pro, which went away ("It missed 3 pings. That run's changes were dropped."), then ran again on studio-mini from the same files and exited 0. **↗** opens the job as a session tab with its full output.
8. Settings › Machines › Workers, on `studio-mini`, lists each worker: load, slots in use, round trip, and the commands running there.

## Behaviour and acceptance criteria

### Which commands are routed

- [x] A project lists its heavy commands as `[heavy] commands` in `.moonlet/config.toml`. Each entry is a command prefix of one or more words. Optional keys:
  - `os`: `"any"` (the default), `"macos"` or `"linux"`;
  - `env`: names of environment variables passed through to the worker;
  - `outputs`: ignored paths brought back after a run.
- [x] A Bash command is routed when it splits into words, by POSIX shell rules, that begin with an approved entry's words, and when it has no part a shell would expand or chain. Worked examples (entries `pnpm test` and `cargo test`):

  | Bash command | Routed |
  |---|---|
  | `pnpm test` | yes |
  | `pnpm test src/cart.test.ts --run` | yes |
  | `pnpm  test` (two spaces) | yes |
  | `"pnpm" test` | yes |
  | `pnpm testing` | no: the words differ |
  | `pnpm test && git status` | no: a second command |
  | `pnpm test 2>&1 \| tail -50` | yes, as a line (below): `2>&1 \| tail -50` runs in the agent's shell |
  | `cd web && pnpm test` | yes, as a line: it runs in `web` |
  | `NODE_ENV=test pnpm test` | as a line when `NODE_ENV` is in `[heavy] env`; otherwise no |
  | `pnpm test $(cat files.txt)` | no: substitution |
  | `pnpm test "$FILE"` | no: expansion inside double quotes |
  | `cargo test 'a b'` | yes, with the argument `a b` |
  | `pnpm test src/*.ts` | no: a glob |
  | `pnpm test # all` | no: a comment |

  The command alone is routed when it has, outside quotes, none of `;` `&` `|` `<` `>` `(` `)` `$` `` ` `` `*` `?` `[` `{` `~` `#` and no newline, nor `$` or `` ` `` inside double quotes, and when it does not start with an assignment. Anything around it is read as a line, below. Nor is one whose first word is a Bash keyword (`time`, `!`, `if`…) or a builtin with no program of its own (`cd`, `export`, `source`…), approved or not: Bash runs those itself, and a worker runs a command without a shell.

### Lines moonlet routes

Agents rarely run a test or a build alone: they `cd` into a package, set a variable, put a `timeout` on it, merge stderr and keep the end of the output. moonlet routes these lines too. Only the heavy command runs through `moonlet exec`, on whichever machine is free, with the line's variables given to it alone; what is around it stays in the agent's own shell, around `moonlet exec`, so it means what it meant before.

- [x] moonlet reads the line by shell rules, into the parts below, and routes it only when it is exactly these parts. Anything else stays where it is, as before. The grammar:

  ```text
  line     = [ "cd" DIR "&&" ] command { "|" filter }
  command  = { NAME=VALUE } [ "env" NAME=VALUE { NAME=VALUE } ]
             [ "timeout" DURATION ] WORD { WORD | redirect }
  filter   = ( "tail" | "head" ) [ "-N" | "-n" N | "-nN" ] { redirect }      tail also -n +N
           | "grep" { option } PATTERN { redirect }
  redirect = [ "1" | "2" ] ( ">" | ">>" ) PATH  |  [ "1" | "2" ] ">&" ( "1" | "2" )
  ```

  - `WORD`s must start with an approved entry's words, as for the command alone.
  - `DIR` is one folder, not an option, with no `..` in it (the shell reads `..` by the path as written, through links), inside the session's worktree once followed.
  - `NAME` must be one of the project's `[heavy] env` names: on the worker, no other variable reaches the command.
  - `DURATION` is a number with an optional fraction and `s`, `m`, `h` or `d`.
  - `env` and `timeout` in any other form (`env -i …`, `timeout -s KILL …`) are the command itself, routed only when approved as such.
  - `grep`'s options are `-i -v -E -F -G -n -w -x -o -c -q -s` (alone or together), `-e PATTERN`, `-A`, `-B`, `-C` and `-m` with a number, and their long forms; it takes one pattern (or only `-e` ones) and no file.
  - `PATH` is `/dev/null` or a file in the session's worktree, not a folder, not a link that leads out, and not in `.git`, `.moonlet` or `.claude`, as written or once followed. A line that writes a file other than `/dev/null` stays here (`claude_rule`) when the Claude Code settings that apply have any `deny` or `ask` rule for `Edit`, `Write`, `MultiEdit` or `NotebookEdit`: Claude Code would have asked before the write.
  - Quotes and `\` work as in the shell; `$` and `` ` `` are refused in double quotes too, and a word that only looks like an assignment (`"CI"=1`) is refused.
- [x] Worked examples (entry `pnpm test`, `CI` in `[heavy] env`). What runs is the line Claude Code runs instead, `M` standing for the quoted `moonlet` path, `exec` and `--tool-use <id>`:

  | Line | Runs |
  |---|---|
  | `cd web && pnpm test` | `cd ./web && M -- pnpm test` |
  | `CI=1 pnpm test`, `env CI=1 pnpm test` | `M --env CI=1 -- pnpm test` |
  | `timeout 600 pnpm test` | `timeout 600 M -- pnpm test` |
  | `pnpm test 2>&1 \| tail -n 50` | `M -- pnpm test 2>&1 \| tail -n 50` |
  | `pnpm test 2>&1 \| grep -E "FAIL\|Error" \| head -20` | `M -- pnpm test 2>&1 \| grep -E 'FAIL\|Error' \| head -20` |
  | `pnpm test > out.txt 2>&1` | `M -- pnpm test > out.txt 2>&1` |
  | `pnpm test "a;b"` | `M -- pnpm test 'a;b'` |

  | Line | Stays here, because |
  |---|---|
  | `pnpm test; git status`, `cd web && pnpm test && git push`, `pnpm test \|\| true` | it runs a second command |
  | `pnpm test $(cat files.txt)` | it has `$`, which the shell expands |
  | `pnpm test src/*.ts` | it has `*`, which the shell expands |
  | `(pnpm test)` | it has a subshell |
  | `pnpm test \| sh` | `sh` is not a filter moonlet runs after a command: use tail, head or grep |
  | `pnpm test \| tail -f` | `tail -f` is not a filter moonlet runs after a command: use tail -n N, head -n N or grep |
  | `cd .. && pnpm test` | `cd` takes a folder without `..` |
  | `cd tmp && pnpm test`, `tmp` a link to `/tmp` | `cd tmp` leaves the session's worktree |
  | `pnpm test > /tmp/out.txt` | `/tmp/out.txt` is outside the session's worktree |
  | `pnpm test > .git/hooks/pre-commit` | `.git/hooks/pre-commit` is git's, moonlet's or Claude Code's own |
  | `NODE_OPTIONS=--inspect pnpm test` | `NODE_OPTIONS` is not one of the project's [heavy] env names |
- [x] Every word the line runs is the one moonlet read, quoted for the shell (`sh`, `bash` or `zsh`). A relative `cd` folder starts with `./`, so `CDPATH` never takes it elsewhere.
- [x] **Where each part runs.** The command runs on the worker, from the folder `cd` went to (relative to the worktree, as for any call), with the line's variables, which are approved `[heavy] env` names. They go to `moonlet exec --env NAME=value`, which adds them to what it sends, so they reach the command alone, never `timeout` or `moonlet exec` on the session's host; when `moonlet exec` runs the command here instead, it runs it with them. `cd`, `timeout`, the redirections and the filters run in the agent's shell on the session's host, on `moonlet exec`'s output, which is the command's output as it streams. So:
  - `cd` leaves the agent's shell in that folder, as it would have;
  - `timeout` stops `moonlet exec` with SIGTERM, which stops the run (as Cancelling below), and exits 124;
  - with `2>&1`, moonlet's own lines (`moonlet: running on …`, `moonlet: full output in …`) are in the filtered output too;
  - the exit status the agent sees is the shell's: the last filter's, or with `pipefail` the last command that failed, the command's own status coming from `moonlet exec` as before;
  - when a filter stops reading, as `head` does, `moonlet exec` stops the run and exits 141, as a command dies of SIGPIPE here.
- [x] **Older hosts.** Nothing new crosses machines: the worker gets the command's words, its folder and the approved variables, as for a command alone run from that folder. A hook that sends `exec.route` without `lines: true` (one from before) is never routed a line, since it would put the whole text after `moonlet exec --`; such a line stays here with reason `form`. A newer hook asking an older daemon gets `not_heavy` for a line and routes the command alone as before.
- [x] **The agent is told.** When a line with an approved heavy command in it stays here because of its form (a listed one that is not approved stays here as `not_approved`, and nothing is said), the hook's answer carries, the first time in the session for that reason, `hookSpecificOutput.additionalContext`:

  ```json
  {
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "additionalContext": "moonlet: this line runs here, not on a worker: it runs a second command. moonlet sends a heavy command to a worker when the line is the command alone, or with `cd <folder> &&`, `NAME=value` (names in [heavy] env) or `timeout <n>` before it, and `2>&1`, `> file` in the worktree, `| tail`, `| head` or `| grep` after it."
    }
  }
  ```

  It has no `permissionDecision`, so the call goes through Claude Code's own checks and runs where it is, as without moonlet. Claude Code reads it to the agent next to the call's result; a Claude Code that does not know the field still runs the call (an output it cannot read never blocks one). The rewrite for a routed call carries no new field.
- [x] **The user sees it.** The session's Jobs tab lists, under its jobs, each line with a heavy command that stayed on the session's host, whatever the reason (its form, not approved, a deny or ask rule), with why: "Ran on the session's host, not on a worker: it runs a second command". The daemon keeps the last 20 per session while it runs.
- [x] Only Bash calls of Claude Code agents in sessions on the central host are routed (since [X89](X89-every-host-runs-heavy-commands.md), in sessions on any member): calls with `MOONLET_SESSION` set, whose working directory is inside the session's worktree. A call whose input has any field but `command`, `timeout`, `description` and (since [X90](X90-heavy-commands-in-practice.md)) `run_in_background` is not routed: one that asks to leave Claude Code's sandbox goes through Claude Code's own checks. Nothing is routed while the agent is in plan mode (`permission_mode` `plan`), so the hook's `allow` never gets round it. Codex is not routed yet.
- [x] A command is routed only when its entry is approved for the project on this central host. Approval holds for the exact list of entries and the exact list of `env` names. An entry that is added or changed is not routed until it is approved, and the project page shows it as not approved. A name added to `env` stops routing for the project until the list is approved again, because approving is the user's consent to send those variables to every worker, cloud machines included. Removing an entry or a name needs no approval.
- [x] Only the Mac's app and paired desktops approve. `heavy.approve` from the `moonlet` CLI or a phone is refused with `forbidden`, so an agent cannot approve the commands it adds.
- [x] Each linked worker keeps its own approval, for the machine it runs on. **Approve** on the project page approves the list on the central host and on every linked worker the app reaches: this Mac, and remote hosts through their tailnet connection (X61). A worker linked later, or one the app could not reach, shows "not approved for shop" on the Workers screen, with **Approve**. `heavy.approve` on a worker follows X61's rule for `link.set`: the worker's own app or a paired Mac, never a phone or the CLI.
- [x] A command is not routed when the Claude Code settings that apply to the session (managed, user or the X33 profile's, project and local) have a `deny` or `ask` rule for `Bash` that matches it. Prefix rules (`Bash(pnpm build:*)`, `Bash(pnpm build)`) are matched as prefixes. A rule that moonlet cannot read as a prefix stops routing for every command that starts with the rule's first word. A rule that starts with a wildcard, and a settings file that exists but is not valid JSON, stop routing for every command. Prefixes are matched as text, so `Bash(pnpm build:*)` also keeps `pnpm builder` where it is.

### The hook

- [x] moonlet's `PreToolUse` hook (A2) asks the daemon `exec.route {session, command, cwd, tool_use_id, lines: true}` for Bash calls, with the session from `MOONLET_SESSION`. With `route: false` and no `note`, an error, or no answer within 2 s, it prints nothing and the call runs as it would without moonlet. With a `note`, it prints only `additionalContext` (Lines moonlet routes).
- [x] With `route: true`, it prints:

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

  `updatedInput` repeats every field of the call's `tool_input` and changes only `command`: the original command text, unchanged, after the `moonlet` binary's own path in single quotes, `exec`, the tool call's id as `--tool-use <id>` (so the job is found from the chat's row) and `--`. Agents do not have `moonlet` on their `PATH`, so the path is spelled out. Claude Code still applies the user's deny and ask rules to the rewritten command. For a routed line, the answer's `line {before, args, command, after}` goes around it instead: `before`, the path, `exec`, `--tool-use <id>`, `args` (the variables as `--env NAME=value`), `--`, `command`, `after`.
- [x] `moonlet exec` started anywhere without a central host's routing (no daemon, or `MOONLET_SESSION` not set) runs the command where it is, so a rewritten command always runs. A command it cannot start exits with 127 and "moonlet: cannot run <command>: <reason>", as a shell would.

### Picking a worker

Until 2026-11-19 a machine was **busy** when its 1-minute load average was at least 0.7 × its cores, and a busy machine took nothing. On the user's Macs the load average sits at 25 to 45 with agent sessions running (190 with several building at once), so every machine looked busy, nothing was routed, and every heavy command ran on its session's host with no limit on how many ran at once. The user approved deciding by slots instead, with a short line (2026-11-19).

- [x] The candidates are:
  - the session's own host (here, the central host);
  - linked workers: Macs with **Use this Mac for heavy commands** on (X41) and remote hosts with **Use for heavy commands** on (X61), each of which approved the project's list;
  - the project's cloud machines that are ready (X63).

  A candidate must have the project's `os` when one is set. (`a_worker_on_another_os_is_skipped`)
- [x] Each machine has **slots**: how many routed commands it runs at once, from 1 to 64. The default is 2, for a machine that never set it: a heavy command (a test suite, a build) already uses every core it can, so two at once overlap one's single-threaded and I/O stretches with the other's work without splitting the cores further, and more at once only makes each slower and adds their memory. Every machine keeps its own in its `link.json` (`link.set {worker: {slots}}`), the central host included, and a linked worker sends them when it registers, and again when they change. The worker's own This Mac page sets them. (`slots_default_to_two_and_link_set_changes_them`)
- [x] A machine **has room** when it has a free slot: its slots minus the heavy commands it runs or has been given and is preparing, its own sessions' and other hosts'. The load average is not a reason to skip a machine: a machine at a load of 38 on 10 cores with a free slot takes the command. The worker still sends its load in each `worker.ping` answer, and the job and the Workers page show it. (`a_host_at_a_high_load_average_with_a_free_slot_takes_the_command`, in core and in `tests/exec.rs`)
- [x] No other machine-wide signal refuses work. On a 10-core, 32 GB Mac, sampled 120 times over 30 minutes on 2026-11-19 while this change's tests built and ran alongside other sessions, the 1-minute load average went from 2.6 to 27.6. In 46 samples it was at 7 or more (busy by the old rule), and in 22 of those the CPU was more than half idle. At the same load the CPU went from 75.5 % idle to 0.5 % idle 15 s later (load 14.0, then 13.9). macOS's memory pressure level (`kern.memorystatus_vm_pressure_level`) was 1, normal, in all 120. So the load average says little about the next minute, a CPU-idle gate would take and refuse work at random from one second to the next, and memory pressure never moved while agents and builds ran. Slots bound what moonlet itself adds.
- [x] Order:
  1. ready cloud machines, when the session asked for the cloud (X63);
  2. the session's own host;
  3. other hosts, by the lowest share of their slots in use, then lowest round trip, then worker id;
  4. ready cloud machines, by the lowest share of their slots in use.

  The session's own host comes first: a command there needs no routing copy, fence or bringing back, and a host with a free slot is not overloaded by heavy commands. An idle session's host keeps its commands; only a session that asked for the cloud sends one away from a host with room. Another host's share of its slots (1 of 4 before 1 of 2) stands where its load per core stood before. Worked examples, for a session on studio-mini (load / cores, slots used of 2):

  | Machines | Runs on |
  |---|---|
  | studio-mini 0.5/10 (0), MacBook 1.0/10 (0) | studio-mini (the session's host has room) |
  | studio-mini 31.0/10 (1), MacBook 0.4/10 (0) | studio-mini (a free slot, whatever the load) |
  | studio-mini 4.3/10 (2), MacBook 7.2/10 (0) | MacBook |
  | studio-mini 0.1/10 (2), MacBook A 0.2/10 (1), MacBook B 6.0/8 (0) | B (0 of 2 before 1 of 2) |
  | studio-mini 9.0/10 (2), MacBook 1.0/10 (2), a ready cloud machine (0) | the cloud machine |
  | studio-mini 9.0/10 (2), MacBook 1.0/10 (2), no cloud machine | waits for a slot |

  (`picks_as_in_the_order_table`; in the daemon, `an_idle_session_host_keeps_its_command` here and in X89's `tests/mesh.rs`)
- [x] **A short line.** When no candidate has room, the command waits for the first free slot on any machine it could run on, in this host's **line**. Commands in the line are served in the order they came, whichever session they are from: a slot that frees goes to the command that has waited longest among those that could run there, and a command that comes later goes behind them, even when it sees the free slot first. One session cannot starve the others. (`commands_waiting_ahead_take_the_free_slots_first`, `commands_waiting_from_two_sessions_are_served_in_the_order_they_came`)
- [x] A command waits at most **one minute**, then runs on the session's host anyway, so nothing waits for ever. A minute lets a typical heavy command elsewhere (a type check, a unit suite) end and free its slot, and leaves most of a Bash call's default two-minute timeout for the run itself. It is not a setting. A command whose tries on other machines (refusals, a copy made) took the minute already runs on the session's host at once. (`a_command_waits_a_minute_for_a_slot_then_runs_anyway`, `with_every_slot_taken_a_command_waits_and_starts_when_one_frees`, `a_command_waits_a_bounded_time_then_runs_on_its_own_host`)
- [x] A command no candidate could run at all, such as a Linux project's on a Mac with no Linux machine, runs on the session's host at once, as before, without waiting. (`a_command_no_machine_could_run_runs_on_its_own_host_without_waiting`)
- [x] A waiting job's state is `waiting {for: "a free slot", slot: true}`, and `running` from the moment a machine takes it. **Stop** ends it with exit 143 and it never runs; **Run on studio-mini now** (`job.run_here`) starts it on the session's host at once. (`a_waiting_command_can_run_here_now_or_be_stopped`)
- [x] With no room anywhere, the session's host included, a project that allows cloud overflow gets a machine (X63), once per command. A machine that is ready while the command still waits takes it. (`overflow_starts_a_machine_once_every_slot_is_taken_whatever_the_load`, in X63's `tests/cloud.rs`)
- [x] Each decision uses the slot counts as they are when it is made: this host's own from its runs, under the same lock its `exec.start` for other hosts takes; a linked worker's from its last ping (every 10 s) or the commands this host gave it since, whichever is more; and, for a member, what the central host answers to `worker.status` and `worker.peers`, asked again every second while the command waits. A machine checks its slots again when the start comes, and refuses with `busy` if another host took the last one meanwhile.
- [x] A worker may refuse a command:
  - `busy`: "no free slot (2 of 2 in use)", or, from a worker before 2026-11-19, a load at 0.7 × its cores or more, which it also calls "no free slot";
  - `missing_tool`: the command's first word is not on the copy's `PATH`;
  - `setup_pending`;
  - `not_approved`;
  - `not_fenced`.

  The session's host then decides again at once, with what it just learned: a machine that refused `busy` is left out of that command's picks for 10 s, as it may have a slot again soon; any other refusal leaves it out for that command. The refusal goes on the job's timeline ("Alex's MacBook Pro refused it: missing pnpm") and on the Workers screen, as "missing pnpm" or "waiting for setup approval". (`a_missing_tool_sends_the_command_to_the_next_worker`, `a_worker_waiting_for_setup_approval_is_skipped`, `a_copy_that_cannot_match_in_time_refuses_not_fenced`, X89's `a_host_with_no_free_slot_refuses_busy_and_the_next_one_runs_it`)
- [x] **What the agent hears.** `moonlet exec`'s stderr says when a command waits and for what: "moonlet: every host is full (studio-mini 2 of 2, Alex's MacBook Pro 2 of 2). Waiting for a free slot, up to 1:00 (0:00)", then "moonlet: waiting for a free slot (0:10)" every 10 s, then "moonlet: waited 0:40 for a slot on studio-mini" or "moonlet: every host was still full after 1:00. Running on studio-mini anyway.", then the usual "moonlet: running on …". (`with_every_slot_taken_a_command_waits_and_starts_when_one_frees`, `a_command_waits_a_bounded_time_then_runs_on_its_own_host`)
- [x] **Older hosts.** No protocol change: `exec.start`, `worker.ping`, `worker.status` and `worker.peers` keep their fields, and the job state's `slot` is optional.
  - A session's host from before 2026-11-19 with a newer runner: it still skips a machine by its load and never waits; the runner no longer refuses for load, only for slots.
  - A newer session's host with a runner from before: the runner refuses `busy` at a high load, which the session's host treats as a full machine (left out 10 s, then tried again), so with every other machine full the command waits its minute and runs on the session's host. A runner from before X89 sends no `used`, and counts only what this host gave it.
  - An app from before 2026-11-19 shows a job waiting for a slot as "Waiting for a free slot" in the row and as waiting for a cloud machine in its detail.

### Routing copies

- [x] A worker runs routed commands in a **routing copy** of the session, at `$MOONLET_HOME/runs/<host>/<project>/<session>/`. It is made with X60's `sync.open` and `sync.fetch`, in a repository of its own under `runs/repos/`, filled only with what the central host sends: the user's own repositories, branches and credentials are never used, so a routing copy and a live copy of the same session never stand in each other's way. A copy the user keeps in sync (X60) is never used for routing, and a routing copy never shows in `sync.list`, its events or the sidebar.
- [x] A routing copy syncs only at fences. After each run, once the central host has its changes, it returns to that run's fence, so between runs it holds exactly what the last fence left.
- [x] Setup in a routing copy on a Mac follows X60: the user approves the exact command once per project and central host, and the approval is shared with live copies. Until setup has finished, the Mac refuses with `setup_pending`, and the app shows X60's setup modal. Cloud machines run setup without asking (X63).
- [x] Paths in output are the session's paths. The worker replaces the routing copy's absolute path with the session's path in every output byte stream, including across chunk boundaries. Example: `/Users/alex/.moonlet/runs/studio-mini/shop/fix-cart/src/cart.ts:12` reads `/Users/alex/.moonlet/worktrees/shop/fix-cart/src/cart.ts:12`.
- [x] A routing copy is removed:
  - when the session is archived;
  - when the worker turns off heavy commands;
  - when the worker's central host changes;
  - after 7 days unused. A copy a run has prepared counts as in use until that run ends, for at most 10 minutes.

  Nothing is saved first: a routing copy holds nothing the user made.

### Fences

- [x] **Before:** the central host snapshots the session (X60's private index) and sends the routing copy an update to that tree and `HEAD`. The command starts only when the copy's snapshot equals the session's tree and its `HEAD` equals the session's. A copy that cannot reach that state within 60 s refuses with `not_fenced`.
- [x] **During:** the routing copy takes no updates, and edits on the central host during the run stay.
- [x] **After:** when the command exits, the worker snapshots the copy and offers it against the fence's tree, with the objects of any commit the run made. The central host applies it. `moonlet exec` returns the exit status only after the central host has applied it. A test: a command that writes `out.txt` and exits 0, then `cat out.txt` in the next Bash call on the central host, prints its contents.
- [x] A file that both the run and the central host changed during the run keeps the central host's version. The run's version is saved to `$MOONLET_HOME/sync-leftovers/<session>-run-<YYYYMMDD-HHMMSS>/` on the central host. The last output line reads "moonlet: src/cart.ts changed on studio-mini during the run; the run's version is in ~/.moonlet/sync-leftovers/fix-cart-run-20261022-104200".
- [x] The `outputs` that count are the ones checked when the run started: a run that edits the config cannot widen them. Ignored files a run makes stay on the worker, as git's rules decide (X60), except the paths in `[heavy] outputs`. Those replace the same paths on the central host after the run. Each `outputs` path must be a non-empty relative path below the worktree root. The root itself (`.`, `./` or an empty string), a path outside the worktree, one with `..`, and one through a `.git` or `.moonlet` folder are refused when the config is read. Symbolic links are never followed:
  - an `outputs` path that is itself a symbolic link is skipped with "moonlet: coverage is a symbolic link; not brought back";
  - a link inside an `outputs` path comes back as a link, with its target text unchanged, and is never resolved on either side;
  - on the central host, a path is replaced only when none of its parent folders inside the worktree is a symbolic link. Otherwise it is skipped with the same kind of line.

  More than 1 GiB of outputs is not brought back, and the last output line reads "moonlet: outputs are 1.4 GiB, over the 1 GiB limit; not brought back".

### Output, exit status, cancelling

- [x] The first stderr line is "moonlet: running on Alex's MacBook Pro", also when the command printed before the worker answered its start: the worker starts it before it answers, so the central host says where the command runs with whichever comes first: the worker's answer, the command's first output, or its end (2026-11-18; until then that output could come first, on a loaded machine; `running_on_comes_before_what_the_command_printed_before_its_start_was_answered`, with `MOONLET_TEST_EXEC_START_REPLY_MS` delaying the worker's answer). The command's stdout and stderr then stream to `moonlet exec`'s stdout and stderr, each in order, with no TTY, as Claude Code's Bash tool runs commands.
- [x] The exit status is the command's own. A command ended by signal N gives 128 + N.
- [x] stdin is `/dev/null`.
- [x] The command runs with the worker's login environment, plus `MOONLET_ROUTED=1`, `MOONLET_SESSION` and the variables named in `[heavy] env`, taken from `moonlet exec`'s environment. No other variable crosses machines.
- [x] The worker runs the words as an argument list (no shell), from the call's working directory relative to the worktree.
- [x] `exec.run` checks the words again as the hook would have, because an agent can call `moonlet exec` itself: a command the hook would not route is refused with `not_routable` and its reason, and `moonlet exec` then runs it where it is, as without moonlet.
- [x] When `moonlet exec` gets SIGINT or SIGTERM (the Bash tool's timeout, or the user stopping the turn), the worker sends SIGTERM to the command's process group, then SIGKILL after 5 s. The run's changes still come back, and `moonlet exec` exits with 130 or 143.

### When a worker goes away

- [x] A run whose worker disconnects, or misses 3 pings (X41), after the worker took its `exec.start` is abandoned. It may have run in part there, or still be stopping, so by default it is not run again: `moonlet exec` exits with 125, and the output gets "moonlet: Alex's MacBook Pro went away during the run. The command may have run in part there; it was not run again." The job's timeline says the same, and it ends `done` with exit 125. (`a_worker_lost_after_its_run_started_is_not_run_again_and_the_agent_hears_so`; X89's `a_runner_lost_after_its_run_started_is_not_run_again_by_default`)
- [x] A command the project lists under `[heavy] rerun`, which says it is safe to run twice, runs again on the central host from the same fence instead, and the output gets "moonlet: Alex's MacBook Pro went away. Running again on studio-mini." The exit status is the second run's. A run stopped from the Jobs panel or by `moonlet exec`'s signal is never run again. (`a_command_marked_safe_to_run_again_runs_again_on_the_central_host`, `a_stopped_job_whose_worker_goes_away_does_not_run_again`, `a_lost_run_runs_again_only_when_rerun_lists_it`)
- [x] A command runs on another machine, or on the central host, after a failed `exec.start` only when it is known not to have started: the worker refused the start, or a start lost on the way (timed out or cut off) was followed by an `exec.cancel`, on the connection the start went on, that the worker answered `false`, which also keeps a late start from running. A worker answers `true` for a run going on, which it stops, and for one that already ended, so a run that started and ended quickly never counts as never started. Otherwise it counts as gone mid-run, as above. (`a_failed_start_counts_as_never_started_only_when_the_runner_says_so`, `a_cancel_answers_whether_the_run_started_here`)
- [x] A worker that comes back to a run its central host gave up on stops the command and its process group (SIGTERM, then SIGKILL after 5 s), and sends nothing back. It counts the run as given up once its link drops, once the link connects again however quickly, since the central host counts a run on a replaced connection as lost and nothing picks it up again, or once it heard nothing from the central host for 25 s, which pings every worker every 10 s: so a run whose central host cannot tell it anything still ends in a bounded time. The central host drops a worker only after 3 missed pings, 30 s or more after the last ping the worker heard, so a worker cut off silently has stopped its command, grace included, before a command marked `rerun` runs again. (`a_worker_that_comes_back_stops_a_run_its_central_host_gave_up_on`, `a_worker_whose_central_host_is_gone_stops_the_command_in_a_bounded_time`, `a_runner_gives_a_run_up_once_its_link_drops_connects_again_or_goes_silent`)
- [x] A Mac does not go to sleep when idle while a heavy command runs on it, its own or another host's: it holds a `PreventUserIdleSystemSleep` power assertion from the first run's start to the last one's end. A closed lid still sleeps. A daemon a test started never takes one. (`the_mac_is_held_awake_from_the_first_heavy_run_to_the_last_ones_end`, `a_mac_running_another_hosts_command_is_kept_awake_until_it_ends`)
- [x] The changes of an abandoned run never reach the session. When the worker links again, its routing copy goes back to the central host's tree before it runs anything.
- [x] When the central host's daemon stops during a run, `moonlet exec` exits with 125 and "moonlet: lost studio-mini's daemon during the run". The worker stops the command.

### Workers screen

- [x] Settings › Machines › Workers on the central host lists each worker: name, OS, cores, load, slots in use of total, round trip, and its running commands (session, command, running for). It follows `workers.changed` and `job.changed`.
- [x] **Approve** on a worker's line first shows the project's exact commands and variable names in the confirm modal (X23), as its page has them now, so nothing is approved unseen.
- [x] A worker's line says why the project's commands skip it: "Not approved for shop" (with **Approve**), "skipped for shop: missing pnpm", or, for the central host when every one of its slots is in use, "busy, takes commands no one else can" (whatever its load, since 2026-11-19).
- [x] The summary line reads "5 commands running · 5 of 13 slots in use": the jobs running now, and used slots of all slots of every linked worker, the central host and ready cloud machines.

### Jobs

- [x] Every routed command is a **job** of its session. So is every command `exec.route` routed that ran on the central host because no worker was free. The central host keeps each session's last 50 jobs, with their output, until the session is archived, and through daemon restarts.
- [x] A job's state is one of:
  - `waiting {for, slot?}`: for setup approval, for a cloud machine (X63), or, with `slot: true`, for a free slot (`for` is "a free slot");
  - `running {worker}`;
  - `bringing_back`;
  - `done {exit}`;
  - `stopped`;
  - `lost` (the central daemon stopped, exit 125).
- [x] A job records its **phases** with their durations: "Copy matched the session", "Ran on <worker>", "Brought back", "Exit status to Claude". It also records its **timeline**:
  - where it went and why, before it started: "<worker> refused it: <its reason>" for each refusal; "Waiting for a free slot", with the full machines ("Every host is full: studio-mini 2 of 2, Alex's MacBook Pro 2 of 2."); then "Waited 40 s for a slot on studio-mini", "Ran on studio-mini: every host was full" (with "It waited 1:00 for a slot, the longest a command waits."), or "Ran on studio-mini now, as asked from the Jobs panel". The job's detail lists these above its phases, refusals and running anyway in the attention colour, and a job still waiting shows "Waiting for a free slot" with the full machines and how long so far (Vitest "says it waits for a free slot, not for a cloud machine", "lists where it ran and why above its phases");
  - started on <worker>;
  - <worker> went away, with why ("It missed 3 pings.", "Its link closed." or "It went away as the command started."), "The command may have run in part there; it was not run again." when it was not, and "That run's changes were dropped.";
  - ran again on <host>, from the same files, for a command listed under `rerun`;
  - exited N, and the status went to the agent.
- [x] A job records what came back: each changed file with its added and removed line counts, each `outputs` path with its size, and each leftover from the fence (a file that changed on the central host during the run). It also records the worker as it was at the start: load, the slot it took ("1 of 2"), round trip and the routing copy's path. Of the environment, it records only the names passed to the worker, never the values.
- [x] A job's output is kept as it streamed, stdout and stderr apart, up to 10 MiB per job. Past that, the middle is dropped and replaced by one line, "moonlet: 3.2 MB of output dropped here". After a rerun, the output of each run stays, with a separator line "──── run 2 · studio-mini ────" between them.
- [x] **Output summary.** When a job ends, the central host reads its output (ANSI escapes removed, the last run only after a rerun) and keeps one summary line. The first rule that matches wins:
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
- [x] Jobs hold commands' output, so only the app and paired devices list, read and stop them. An agent's `moonlet` CLI and a worker are refused with `forbidden`, as the CLI is for another terminal's output without the user's approval (X31).
- [x] **Stop** on a running or waiting job cancels it as `exec.cancel` does (SIGTERM, then SIGKILL after 5 s). The agent gets exit 143 and the line "moonlet: stopped from the Jobs panel". Changes the job made so far still come back. **Stop all** stops every running and waiting job of the session.
- [x] **Run on studio-mini now**, on a job waiting for a cloud machine or a free slot, runs it on the session's host at once, with the line "moonlet: running on studio-mini instead, as asked from the Jobs panel". The machine keeps starting, and takes the next command.
- [x] The Jobs tab's count is the number of the session's jobs in the history, whatever their state.
- [x] The Jobs tab's summary reads "1 waiting · 3 done · 4m 38s on workers": counts by state, and the total running time of the session's jobs. Worked examples:

  | Jobs | Summary |
  |---|---|
  | none | (no summary; the empty text) |
  | 1 running 0:42 | 1 running · 42s on workers |
  | 1 waiting, 3 done (38 s, 1m 12s, 2m 03s), 1:10 waiting | 1 waiting · 3 done · 3m 53s on workers |
  | 2 done (59 s, 1 s) | 2 done · 1m 00s on workers |

  Waiting time does not count as time on workers.
- [x] A job row's second line, worked examples:

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
  - **Commands:** one editable row per entry, with a state pill (**Approved**, or **Not approved** in the attention colour) and **×** to remove it, plus **Add command**. The help text is "A Bash call that starts with one of these runs where there is a free slot: its session's host first, then another host. Chained, piped or redirected calls run where the agent is.";
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
- **Workers page** ([workers-page.png](design/x62-x63/workers-page.png)): the title with a "studio-mini · Central host" badge; "Machines that run heavy commands for studio-mini's sessions. A command runs on studio-mini while it has a free slot, else on a worker with one, and waits up to a minute when every slot is taken."; the summary line; then:
  - a **Macs and hosts** table, with columns Worker, Load (a bar and "1.2 / 10"), Slots ("1 of 2") and Round trip. Badges are "This Mac" and "Central host", and the skip reasons sit under the name, in the attention colour. The page reads `worker.list` and `exec.status` from the central host every two seconds while it is open, and on `workers.changed` and `job.changed`. Each running job sits under its worker: spinner, session, command, elapsed time. A busy load bar uses the attention colour;
  - **Cloud machines** (X63).
- **Workers, empty** ([workers-empty.png](design/x62-x63/workers-empty.png)): "Only studio-mini runs heavy commands", "No machine runs heavy commands for studio-mini yet. Turn on Use this Mac for heavy commands, or Use for heavy commands on a remote host." and **Open Hosts**. **Set up cloud workers** comes with X63.
- **Chat (X6)** ([chat-routed-rows.png](design/x62-x63/chat-routed-rows.png)):
  - a routed Bash row shows the agent's command, never `moonlet exec -- `;
  - a chip shows where it ran, "on Alex's MacBook Pro", with a laptop icon for a Mac, a server icon for a host and a cloud icon for a cloud machine;
  - after a rerun, the chip reads "ran again on studio-mini", in the attention colour;
  - `moonlet:` lines in the output use the accent colour, and a went-away line uses the attention colour.

  The chip comes from the job, matched by the tool call's id, and falls back to the result's first `moonlet:` line when the row's command is the hook's rewrite, so a command moonlet did not route never gets one.
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

- `exec.route {session, command, cwd, tool_use_id, lines}` returns `{route: bool, reason, line?, note?}`. `reason` says why a call stays where it is: `no_session` (unknown or archived), `outside_worktree`, `invalid_config`, `not_heavy`, `form` (a heavy command in a line moonlet does not route as written), `not_approved`, `env_not_approved` or `claude_rule`. `lines` (default false) says the hook puts `line {before, args, command, after}` around `moonlet exec`; it comes only for a routed line that is more than its command. `note` is what to tell the agent, the first time in the session for each reason, only with `lines`. The decision reads `[heavy]` from the session's own worktree, so an agent's edit there counts, and fails closed when it cannot be read or checked.
- `exec.run {session, argv, cwd, env}` returns `{run, host}`, then:
  - frames of kind 5, `Output`, with payload `[u32 BE run][u8 stream: 1 stdout, 2 stderr][bytes]`;
  - the event `exec.exited {run, status, worker, rerun, leftovers}`.
- `exec.cancel {run}`.
- `exec.status` → `{host: {name, os, cores, load, slots, used}` (`used`: its slots in use, its own sessions' and other hosts' since 2026-11-19; `exec_status_lists_what_a_host_runs_for_other_hosts`), running: [{job, session, command, worker, started_at}], skips: [{worker, project, reason, detail}], routed}`: this machine, the routed commands going on wherever they run, why workers were skipped in the last hour, and how many commands this machine runs for its own central host. The Workers page and the Hosts page's `· 1 running` read it.
- `exec.setups` → `[{copy, host, project, command}]` on a Mac: its routing copies whose setup waits for the user's approval, and the event `exec.setup {copy, host, project, command}` when one starts to wait. The app asks with X60's setup modal, and a paired phone with a Needs you card (X40); either answers with `sync.run_setup` or `sync.skip_setup`. A paired phone hears `exec.setup` too; a paired Mac, a worker and the `moonlet` CLI do not. (`a_paired_phone_hears_and_runs_a_routing_copys_setup_and_a_paired_mac_does_not`)
- `job.list {session}` returns the session's jobs, newest first, with state, phases, timeline, worker, what came back, env names and `summary`.
- `job.output {job, from}` → `{chunks: [{stream, text}], next, more}`: the stored output from byte `from` of its file, up to 1 MiB at a time. A running job's new output also comes as the event `job.output {job, session, chunks}`, so the app needs no frames to follow it.
- `job.stop {job}` → `true`/`false`, `job.stop_all {session}` → how many it stopped, and `job.run_here {job}` (a job waiting for a cloud machine; until X63, every job answers `not_waiting`).
- The event `job.changed {job}`.
- `job.stayed {session}` → `[{session, at, command, why}]`, newest first: the lines with a heavy command that stayed on the session's host, and the event `job.stayed {session, at, command, why}`. Like `job.list`, for the app and paired devices only; a daemon from before answers with an error, read as none.
- `exec.route` and `exec.run` take the tool call's id (`tool_use_id` from the hook payload), so the chat can match its row to the job.
- `heavy.get {project}` returns `{config, approved, error}`: the `[heavy]` table of the project's folder, the approved `{commands, env}` or `null`, and why the table cannot be used, if it cannot. The app works out each entry's state and the machines that approved it from these and the workers' answers.
- `heavy.set {project, commands, os, env, outputs}` writes `[heavy]` in `.moonlet/config.toml` as X8 writes the other keys. It never approves.
- `heavy.approve {project, commands, env}` approves exactly those commands and `env` names, together as one record. It fails with `changed` when either list differs from the config as it is now, so the user never approves a list they did not see. It needs the app or a paired desktop.

**Central host to worker:**

- `exec.prepare {session}` returns `{copy, state, reason}`, `state` being `ready`, `making`, `setup_pending` or `failed`. The worker makes the routing copy, through X60's `sync.open {kind: "run"}` and `sync.fetch`, if it has none. A worker with heavy commands off answers `not_approved`.
- `exec.start {run, copy, argv, cwd, env, tree, head, session_path, outputs}` returns `true`, or a refusal: `not_approved` (this machine's own approval), `busy` (no free slot; before 2026-11-19 also a load at 0.7 × its cores), `not_fenced`, `missing_tool` or `invalid_params` (a folder or `outputs` path outside the copy).
- `exec.cancel {run}`.

**Worker to central host:**

- `Output` frames with the run's id;
- `exec.done {run, copy, status, tree, head, pack, outputs}` → `{leftovers, folder, notes}`, only from the worker that runs `run` in `copy`. `outputs` is a tree of the run's `outputs` in the same pack.

**Changed:**

- The `worker.ping` answer gains `load` (1-minute load average).
- `worker.register` gains `slots`.
- `PROTOCOL_VERSION` goes from 5 to 6.
- `docs/protocol.md` gets the frame kind and the methods.
- Not running a lost run again, and a worker stopping a run it was given up on, add nothing to the protocol. A newer session's host against an older worker: the lost run is not run again by default, but an older worker that connects again within moments may still finish the run unobserved, and its `exec.done` on the new connection is ignored. An older session's host against a newer worker: the older host runs the command again, as before, and the newer worker stops its own run once its link drops, connects again or goes silent for 25 s; the two can overlap until then. A newer worker answers `exec.cancel` `true` for a run that already ended, where an older one answered `false`; older session's hosts ignore the answer. An older daemon reads a `[heavy]` table with `rerun` and ignores the key.

## Data and config

- **`.moonlet/config.toml`:** a `[heavy]` table with `commands`, `os`, `env` and `outputs`. It is read by `ProjectConfig` and edited by X8's dialog. `rerun`, the command prefixes safe to run again when their worker goes away mid-run, is read from the project's main checkout as the rest of the table (X90). The app does not edit it: `heavy.set` keeps it as it is, as it keeps X63's `machine_setup`. It is not part of the approval: it only ever runs an approved command again on the session's own host, which the agent could do itself, and sends nothing to another machine. Its default is empty, so a lost run is never run again unless the project says it is safe.
- **Central host, `$MOONLET_HOME/heavy.json`:** the approval per project identity: the exact commands and the exact `env` names, saved together. Example: `{"github.com/acme/shop 4171b03…": {"commands": ["pnpm build", "pnpm test"], "env": ["CI", "NPM_TOKEN"]}}`. A routed command needs both lists to match the config. Since [X89](X89-every-host-runs-heavy-commands.md) the approval is the account state's (`heavy_approval`), once for every member; `heavy.json` only seeds it, and serves a host that shares no account.
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
- **Lines.** The hook's `allow` covers the whole rewritten line, so a line routes only when everything in it besides the approved command is one of a few fixed parts that run nothing else: a `cd` into the worktree, approved variable names, `timeout`, writes to `/dev/null` or to files in the worktree outside `.git`, `.moonlet` and `.claude`, and `tail`, `head` or `grep` reading the command's output, with options that read no file. moonlet parses the line rather than matching its text, and the line Claude Code runs is the one moonlet built from what it parsed, every word quoted, so a word cannot mean something else to the shell. Each part is checked against the user's deny and ask rules too. The worker still gets an argument list only, and checks it against its own approval.
- **Files.** A routing copy gets what a live copy gets (X60). An ignored `.env` stays where it is, so a command that needs it on the worker needs it there already.
- **A lost run is not run again by itself.** Heavy commands are whatever the user approved: a test run is safe to repeat, a deploy, a migration or a publish is not, and two copies at once can fight over ports or a database. A worker can miss 3 pings under load while its command runs fine, so moonlet cannot know that a lost run did nothing. Only commands listed under `rerun` run again, and the worker stops a run it was given up on as soon as it can tell.

## Out of scope

- Picking a run up again after its worker's link connects again, with its output and exit status still delivered. A reconnect counts as the run being lost on both sides, so they always agree; see X89.
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
- **Vitest:** `apps/desktop/src/lib/heavyCommands.test.ts`, `heavyApproval.test.ts`, `workers.test.ts`, `jobs.test.ts`, `layout.test.ts`, `toolOutput.test.ts`, `jobsStore.test.ts` and `syncStore.test.ts`.
- **e2e:** `apps/desktop/e2e/specs/routing.e2e.ts` and `jobs.e2e.ts`.

| Criterion | Tests |
|---|---|
| `[heavy]` keys | `heavy_table_reads_commands_os_env_and_outputs` |
| Which commands are routed (worked examples) | `routes_exactly_the_worked_examples`, `shell_keywords_and_builtins_are_never_routed` |
| Only Claude Code Bash calls in a session's worktree (background ones too since X90) | `a_background_bash_call_is_routed_and_stays_in_the_background`, `a_terminal_outside_a_session_is_not_routed`, `a_call_outside_the_sessions_worktree_is_not_routed` |
| Approval of the exact entries and `env` names | `an_unapproved_entry_is_not_routed`, `a_changed_entry_needs_approving_again`, `a_new_env_name_stops_routing_until_approved`, `removing_an_entry_needs_no_approval`, `approving_records_the_commands_and_env_names_together`, `approving_a_list_that_changed_meanwhile_fails` |
| Who approves | `only_the_app_or_a_paired_mac_approves_heavy_commands` |
| Each linked worker's own approval | `a_worker_that_has_not_approved_refuses_and_the_next_one_runs_it`; Vitest "the approval toast names every machine it covers", "a worker that was not reachable is named in the toast" |
| The user's Claude Code deny and ask rules | `deny_and_ask_rules_stop_routing_in_each_form`, `a_rule_moonlet_cannot_read_stops_routing_for_its_first_word`, `a_deny_rule_in_the_worktree_keeps_the_command_here`, `a_managed_deny_rule_keeps_the_command_here` |
| The hook stays silent | `the_hook_prints_nothing_when_the_daemon_says_no`, `the_hook_prints_nothing_when_the_daemon_is_gone` |
| The hook's rewrite | `the_hook_rewrites_a_captured_bash_call_to_moonlet_exec` |
| Lines moonlet routes: the grammar and worked examples | `wrapped_lines_parse_into_the_command_and_what_runs_around_it`, `lines_beyond_the_routed_forms_are_refused_with_why`, `a_wrapped_line_routes_with_what_runs_around_its_command`, `a_wrapped_line_that_leaves_the_worktree_or_passes_other_variables_stays_here` |
| Lines: where each part runs, exit status | `a_wrapped_line_runs_its_command_through_moonlet_and_gives_what_it_gives_here`, `a_routed_command_whose_reader_has_gone_ends_as_it_would_here`, `a_line_that_starts_with_cd_runs_its_command_in_that_folder_on_another_host` (in X89's `tests/mesh.rs`) |
| Lines: the hook's answer | `the_hook_puts_a_routed_lines_parts_around_moonlet_exec`; Vitest "a routed line shows what ran around moonlet exec, without it" |
| Lines: older hosts | `a_hook_that_rewrites_only_bare_commands_never_gets_a_wrapped_line` |
| Lines: writes and Claude Code's edit rules | `a_line_that_writes_a_file_stays_here_when_claude_code_guards_edits` |
| Lines: nothing said for a command not approved | `a_line_whose_heavy_command_is_not_approved_tells_the_agent_nothing` |
| Lines: the agent is told once | `the_hook_tells_the_agent_why_a_line_stays_here`, `a_heavy_command_anywhere_in_a_line_is_found_for_the_note`, `the_agent_is_told_once_and_the_jobs_tab_lists_each_line_that_stayed_here`, `the_hook_tells_the_agent_once_why_a_line_with_a_heavy_command_stays_here` |
| Lines: the user sees it | `the_agent_is_told_once_and_the_jobs_tab_lists_each_line_that_stayed_here`; Vitest "a line that stayed on the session's host says why", "lists the lines that stayed on the session's host, newest first, as they come", "keeps a line that stayed while the list was read, once", "lists none from a host whose daemon has no such list"; e2e "lists a line with a heavy command that stayed on the session's host, and why" |
| `moonlet exec` without routing | `moonlet_exec_without_routing_runs_the_command_here` |
| `moonlet exec` in a session, and `exec.run`'s own check | `moonlet_exec_in_a_session_runs_through_its_daemon`, `an_unapproved_moonlet_exec_is_refused` |
| Candidates and `os` | `a_worker_on_another_os_is_skipped` |
| Slots | `slots_default_to_two_and_link_set_changes_them`, `a_worker_with_no_free_slot_is_skipped`; Vitest "says how many commands run here, and keeps slots from 1 to 64" |
| Room is a free slot, whatever the load | `a_host_at_a_high_load_average_with_a_free_slot_takes_the_command` (core and `tests/exec.rs`), `a_worker_reports_its_load_with_each_ping`; Vitest "skip reasons for a project" (a loaded central host with a free slot is not busy) |
| Order (worked examples) | `picks_as_in_the_order_table`, `an_idle_session_host_keeps_its_command` |
| The line and its minute | `commands_waiting_ahead_take_the_free_slots_first`, `a_command_waits_a_minute_for_a_slot_then_runs_anyway`, `with_every_slot_taken_a_command_waits_and_starts_when_one_frees`, `a_command_waits_a_bounded_time_then_runs_on_its_own_host`, `commands_waiting_from_two_sessions_are_served_in_the_order_they_came`, `a_waiting_command_can_run_here_now_or_be_stopped` |
| Waiting in the Jobs tab | Vitest "says it waits for a free slot, not for a cloud machine", "lists where it ran and why above its phases"; mobile Vitest "runs a job waiting for a free slot on the session's host now, or stops it" |
| Overflow on the same room | `overflow_starts_a_machine_once_every_slot_is_taken_whatever_the_load` (X63's `tests/cloud.rs`) |
| Refusals | `a_missing_tool_sends_the_command_to_the_next_worker`, `a_worker_waiting_for_setup_approval_is_skipped`, `a_copy_that_cannot_match_in_time_refuses_not_fenced` |
| Routing copies, apart from live copies | `a_routing_copy_lives_under_runs_and_not_in_sync_list` |
| Syncs only at fences | `a_command_starts_only_once_the_copy_matches_the_session` (an edit on the central host between runs waits for the next run) |
| Setup in a routing copy on a Mac | `a_routing_copy_on_a_mac_waits_for_setup_approval`, `a_worker_waiting_for_setup_approval_is_skipped`; Vitest "asks about a routing copy's setup (X62), and Skip skips it", "asks about a routing copy's setup that waited before the app started (X62)" |
| Session paths in output | `replaces_the_copys_path_split_across_two_chunks`, `the_copys_path_reads_as_the_sessions_in_output` |
| Removing routing copies | `archiving_the_session_removes_its_routing_copies`, `turning_heavy_commands_off_removes_the_routing_copies`, `a_routing_copy_unused_for_seven_days_is_removed` |
| Fence before | `a_command_starts_only_once_the_copy_matches_the_session` |
| Fence during | `a_file_changed_on_both_sides_during_a_run_keeps_the_central_version_and_saves_the_runs` |
| Fence after | `a_file_written_by_the_run_is_on_the_central_host_before_the_exit_status`, `a_commit_made_by_the_run_moves_the_sessions_branch` |
| Leftovers | `a_file_changed_on_both_sides_during_a_run_keeps_the_central_version_and_saves_the_runs` |
| `outputs` | `outputs_bring_back_an_ignored_coverage_folder`, `an_outputs_path_outside_the_worktree_is_refused`, `the_worktree_root_is_refused_as_an_outputs_path`, `git_and_moonlet_folders_are_refused_as_outputs_paths`, `a_symbolic_link_in_outputs_is_never_followed`, `an_outputs_path_that_is_a_symbolic_link_is_skipped`, `outputs_over_one_gib_stay_on_the_worker_and_say_so`, `a_tree_of_outputs_never_writes_through_its_own_links` |
| First line and output streams | `a_routed_commands_output_and_exit_status_come_back` |
| Exit status and signals | `a_routed_commands_output_and_exit_status_come_back`, `a_command_killed_by_a_signal_exits_with_128_plus_it` |
| stdin | `a_routed_command_reads_an_empty_stdin` |
| Environment | `only_approved_env_names_reach_the_worker` |
| No shell, same folder | `a_routed_command_runs_without_a_shell_from_the_same_folder` |
| Cancelling | `cancelling_stops_the_command_and_brings_its_changes_back`, `moonlet_exec_stops_the_command_when_it_is_stopped` |
| A worker goes away: not run again by default | `a_worker_lost_after_its_run_started_is_not_run_again_and_the_agent_hears_so`, `a_failed_start_counts_as_never_started_only_when_the_runner_says_so`, `a_cancel_answers_whether_the_run_started_here` |
| A worker goes away: `rerun` runs it again | `a_command_marked_safe_to_run_again_runs_again_on_the_central_host`, `a_lost_run_runs_again_only_when_rerun_lists_it`, `heavy_set_keeps_the_commands_marked_safe_to_run_again` |
| A worker stops a run given up on | `a_worker_that_comes_back_stops_a_run_its_central_host_gave_up_on`, `a_worker_whose_central_host_is_gone_stops_the_command_in_a_bounded_time`, `a_runner_gives_a_run_up_once_its_link_drops_connects_again_or_goes_silent` |
| A Mac running heavy commands stays awake | `the_mac_is_held_awake_from_the_first_heavy_run_to_the_last_ones_end`, `a_mac_running_another_hosts_command_is_kept_awake_until_it_ends` |
| The Jobs tab after a lost run | Vitest "a job whose worker went away and that was not run again", "the rerun timeline" |
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
| Stored output | `output_over_ten_mib_keeps_its_start_and_end`, `a_jobs_phases_and_timeline_after_a_rerun` (the separator line) |
| Output summary | `summarises_as_in_the_worked_examples`, `summarises_captured_runs_of_each_tool` (captured vitest, jest, `cargo test` over two crates, pytest, `tsc` plain and `--pretty`, `cargo build` with a type error) |
| Stop and Stop all | `stopping_a_job_gives_exit_143_and_brings_its_changes_back`, `stop_all_stops_every_running_and_waiting_job`; e2e "Stop ends a running job" |
| Run on the central host now | `job_run_here_needs_a_waiting_job`, `run_here_runs_a_job_waiting_for_a_cloud_machine_on_the_central_host` (in X63's `tests/cloud.rs`) |
| Jobs tab count | Vitest "the tab counts every job" |
| Jobs summary (worked examples) | Vitest "the summary line, as in the worked examples" |
| Row second line (worked examples) | Vitest "a row's second line, as in the worked examples" |
| Chat chip (UI) | Vitest "the chip from a job", "the chip from a result's first line", "the chip comes from the row's job, and falls back to the result's first line", "a rewritten command shows without moonlet exec", "colours moonlet's own lines, and a worker going away in the attention colour" |
| `heavy.set` writes `[heavy]` and never approves | `heavy_set_writes_the_heavy_table_and_keeps_the_rest`, `heavy_set_writes_the_projects_config_and_never_approves` |
| Project page (UI) | Vitest "a new entry, a changed entry, all approved", "the secret-looking env warning", "turns the table into a form and back, trimming and dropping blank entries"; e2e "approving heavy commands saves them" |
| Jobs tab (UI) | e2e "the Jobs tab lists the job and opens its output"; Vitest "the panel's worker card line, as in job-running.png" |
| Job tab (UI) | Vitest "opens a job as a new active tab, and switches to it when open", "keeps job tabs when the terminals are synced, and reads them back", "closes a job tab and activates its neighbour", "lays the phases out at their lengths, as in job-tab.png", "ends with the run going on while a job runs", "adds when it ran, and who ran it, as in job-tab.png", "reads chunks as numbered lines, stdout and stderr apart, without colours", "filters by stream and by what was typed in Find, keeping line numbers", "the job tab's Worker facts, as in job-tab.png" |

## Open questions


- **Slots counted across hosts while a copy is prepared.** A session's host counts the commands it gave a worker from the moment it picks it, but the worker counts another host's command only from its `exec.start`. Two hosts can both prepare a copy on the last slot; the second start is refused `busy` and that host decides again. A slot held from `exec.prepare` would need the worker to expire prepares nobody starts.
- **Who is ahead takes slots in the newcomer's order.** A command ahead in the line is counted as taking the first free slot it could use in the order of the command deciding, which differs from its own when only one of them asked for the cloud or holds a host back after a refusal. It can let a later command take a slot the earlier one would not have used, never the other way round.
- **The line is per session's host.** Commands waiting on two hosts for the same third machine are served in the order their starts reach it, not the order they began waiting.
- **The wait is not a setting.** One minute for every project. A project setting (`[heavy] wait`) is cheap to add if a project's commands are much longer or shorter.
- **`updatedInput` without `permissionDecision`.** Claude Code's docs don't say what that does. This spec always sends `allow`, so the question doesn't arise as long as approval stays required.
- **Codex** has no equivalent of `updatedInput` in its hooks today. Its routing waits for one.

Decided by the user on 2026-10-23:

- **The Jobs tab counts all the session's jobs**, not only the running and waiting ones.
- **Output summaries ship with this spec**, for the runners and compilers listed under Jobs. Others, such as `go test`, mocha or `swift build`, get no summary until they are added.

Decided while writing this spec, on 2026-10-22:

- **Approval before routing.** ADR 0009's hook rewrites commands, and Claude Code applies permission rules to the rewritten command. Without an approval, an `allow` rule for `pnpm test` would stop matching, and the user would be prompted. With a silent `allow` instead, an agent could route anything it wrote into the config. Approval in moonlet's UI is the explicit allow.
- **Routing copies are separate from live copies.** A run in the user's own copy would mix its changes with the user's edits, and an abandoned run's changes could not be thrown away.
- **Never wait for a slot** (replaced on 2026-11-19 by a line of at most a minute: never waiting meant piling every command on the session's host once load said every machine was busy).
