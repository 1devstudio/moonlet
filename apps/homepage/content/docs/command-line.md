---
title: Command line
description: The moonlet and moonletd commands, for scripts, agents and hosts without the app.
group: Reference
order: 1
---

## Two binaries

The app bundles two binaries:

- `moonletd`, the session daemon. It owns every terminal and runs under launchd on a Mac, or systemd on Linux.
- `moonlet`, the command-line client for scripts and agents. It talks to the daemon over its socket.

Both take `--socket <path>` to pick the daemon's socket. It defaults to `$MOONLET_SOCK`, else `~/.moonlet/run/moonletd.sock`. Run `moonlet --help` or `moonlet <command> --help` for the full options.

## moonlet

### Sessions and projects

```sh
moonlet ls                       # list sessions
moonlet project ls               # list projects: name, base branch and path
moonlet session new storefront "Fix the login form"   # new worktree + agent
moonlet session ls               # live sessions with their agent's status
moonlet session wait <id>        # wait until the agent stops working
moonlet session read <id>        # the agent's last reply and pending approvals
moonlet session send <id> "Run the tests too"
```

`moonlet session new <project> [prompt]` creates a session and starts its agent with the prompt, then prints the session as JSON. The project can be an id, a path or a name. The prompt also names the session. Options:

| Option | What it does |
|---|---|
| `--name` | The session's name, instead of the prompt's first line |
| `--branch` | The new branch's name, with no prefix added and `-2` added if it is taken. Without it, the branch is your branch prefix (Settings › Git, or the project's `branch_prefix`) plus the name as a slug, such as `moonlet/fix-login` |
| `--from` | The start point, instead of the project's base branch |
| `--agent` | The agent to start, or `none` for a shell |
| `--model`, `--effort`, `--mode` | The model, effort and permission mode |

Run inside a moonlet agent, a new session's permission mode is never more permissive than that agent's own.

`moonlet session wait` gives up after 30 minutes by default; `--timeout <seconds>` changes that.

### Agents and hooks

```sh
moonlet hooks install            # install Claude Code and Codex hooks
moonlet hooks status
moonlet hooks uninstall
moonlet notify --state done -m "Tests pass"   # report agent state for this terminal
moonlet agent start --cwd ~/code/storefront "Review the open PR"
```

`hooks install` takes `--no-claude` or `--no-codex` to skip one of them. `notify --state` takes `idle`, `working`, `blocked`, `done` or `error`.

`moonlet hook` is the entry point the installed hooks call. It never fails, so a missing daemon cannot break an agent. You do not run it yourself.

### Terminals and processes

```sh
moonlet term ls                  # terminals of your session you may read
moonlet term read <id> --lines 50   # a terminal's output, once you allow it
moonlet pane run <id> npm test   # type a command into a pane and press Enter
moonlet ps                       # what a session's terminals and agents run
moonlet kill <pid>               # stop processes of a session
moonlet kill --all
```

`term read` prints a terminal's output only once you allow it. It prints the last 200 lines by default, at most 2000.

`ps` lists processes by name, never with their arguments, including what was left running in the worktree. `kill` sends SIGTERM, then SIGKILL after 3 seconds. `--all` stops every process of the session except its tabs' own shells and agents. Both default to the session you run in; `--session <id>` picks another.

### Design systems and designs

```sh
moonlet design system ls
moonlet design system new "Storefront web" --from storefront --cover core
moonlet design system sync --system <slug>
moonlet design system rm <slug>
moonlet design ls
moonlet design new --system <slug> "A settings page with General and Git sections"
moonlet design open <slug>       # show a design in the app
moonlet design rm <slug>         # delete a design and stop its agent
moonlet design check --system <slug>
moonlet design snap <card>
```

`design system new` creates a design system from one or more projects (repeat `--from`) and starts its sync agent. `--cover` is `core` (the default), `all` or `none`.

`design new` creates a design and starts its agent with the brief. `--here` makes a session design in the worktree of the session the agent works in.

`design check` prints every problem as JSON and exits 1 when there is one. With `--render`, the moonlet app also renders each card and judges it. `design snap` saves a screenshot of a card, taken by the moonlet app. `--render` and `snap` need the app open. See [Design mode](/docs/design-mode).

Most design commands take `--workspace <id>` to pick the workspace.

The sync agent also runs `design system progress` and `design system synced` to report its steps. You do not run them yourself.

### Heavy commands and cloud machines

```sh
moonlet exec -- cargo test       # run a heavy command, routed if it can be
moonlet worker up --project storefront   # start a cloud machine
moonlet worker ls
moonlet worker down <name>
```

moonlet's hook rewrites an agent's approved heavy commands to `moonlet exec`. With no central host to route it, the command runs where you are. See [Heavy commands](/docs/heavy-commands) and [Cloud workers](/docs/cloud-workers).

### Call the daemon

```sh
moonlet rpc repo.list
moonlet rpc project.identity '{"path": "~/code/storefront"}'
```

`moonlet rpc <method> [params]` calls any daemon method and prints the JSON result. See [Socket protocol](/docs/socket-protocol).

## moonletd

```sh
moonletd status                  # daemon info as JSON
moonletd start                   # start the daemon in the background if needed
moonletd stop                    # stop the daemon and every session it owns
moonletd daemon                  # run the daemon in the foreground
moonletd upgrade                 # hand live sessions to a newer daemon
moonletd service install         # start the daemon at login
moonletd service status
moonletd service uninstall
moonletd tailnet on              # let paired Macs and phones connect over Tailscale
moonletd tailnet off
moonletd tailnet status
moonletd pair                    # show a one-time pairing code
moonletd proxy                   # bridge stdin and stdout to the daemon socket
```

> **Note:** `moonletd stop` ends every session the daemon owns. To move to a newer daemon without losing sessions, use `moonletd upgrade`.

`moonletd service` installs a launchd LaunchAgent on a Mac, or a systemd user unit on Linux.

`moonletd pair` prints a code that pairs a Mac or a phone with this host. The code works once, for five minutes. `--name` sets the name to type on the other Mac, such as `build-box`. See [Add an always-on host](/docs/add-an-always-on-host).

`moonletd proxy` is what an SSH host runs: the app connects with `ssh <host> ~/.moonlet/bin/moonletd proxy`, which starts the daemon if it is not running.

`moonletd join` pairs a cloud machine with its central host. The machine's first-boot script runs it.
