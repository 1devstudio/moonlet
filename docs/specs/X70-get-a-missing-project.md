# X70 — Get a project this host does not have: clone it from its origin, or locate a copy

- **Status:** draft
- **Priority / phase:** P1 · phase 4 (sessions across machines)
- **PRD refs:** none (new scope)
- **Related ADRs:** [0014](../adr/0014-one-account-across-hosts.md) (one account across hosts)
- **Depends on:** [X68](X68-account-state.md) (the account's sections and their `missing` identities), [X59](X59-add-project-from-github.md) (cloning on a host with live progress), [X41](X41-worker-link-and-project-identity.md) (project identity)

## Summary

Since X68, every member of an account shows the same sections. A project that no connected member has shows a dashed square and "not on This Mac", and clicking it only says that moonlet will clone it in a later version. This spec makes that row actionable. Clicking it opens **Get <name> on <host>**, which clones the project from its origin into a folder on the shown host, with X59's progress, or adds a copy that is already on the host. Origins on any forge work, not only GitHub, because a project's identity holds its normalized origin (`host[:port]/path`) and its root commit. The clone is checked against the root commit, so a remote that now holds another repository is not added in its place. A project without an origin cannot be cloned; it can still be located.

## User journey

1. On the MacBook, section "Acme" lists `ledger` with a dashed square and "not on This Mac". The user clicks it.
2. A dialog **Get ledger on This Mac** opens. Its card shows `ledger`, the origin `gitlab.com/acme/ledger` in mono, and "Looking up…" with a spinner, then "Found · main" in green with `git@gitlab.com:acme/ledger.git` under it in small mono.
3. **Clone into** shows `~/moonlet` / `ledger`, the parent last used for a clone on This Mac. They press **Clone and add**.
4. The progress card from X59 shows counting, receiving and resolving. When it finishes, a toast says "Added ledger". The dialog becomes the new session composer for `ledger`. In the sidebar, the row has the project's own mark and no "not on This Mac", in the same place in the section.
5. Another time, `blog` is missing, but the user already has a clone in `~/work/blog` that was never added. In the dialog they click **Locate a copy**, pick `~/work/blog` with Browse…, and press **Add this folder**. moonlet checks the folder holds the same repository and adds it to the section.
6. `scratch`, a repository with no remote, is missing too. Its dialog says "scratch has no remote, so This Mac can't clone it. Push it to a remote from the Mac that has it, or locate a copy here." Only Locate a copy is offered.

## Behaviour and acceptance criteria

Test citations: Rust tests by function name, Vitest by `describe › it`, e2e by spec file and `it`. A criterion marked *manual* has no automated test; the Test plan says how to check it.

### Opening the dialog

- [ ] Clicking a project group marked "not on <host>" opens **Get <name> on <host>** for that project and section, in place of X68's toast. <host> is the shown host's label, or "This Mac". <name> is the label the sidebar shows for the group.
- [ ] The dialog acts on the shown host: the lookup, the clone and the located folder are all on that host, as X59's dialog does for its chosen host. For a remote host, Browse… is absent and the hint reads "A path on <host>. No Browse… for remote hosts."
- [ ] When the shown host's daemon predates X70, the dialog shows only "<host>'s moonletd is too old to get this project. Update moonlet there." and a Close button.

### Which address to clone from

- [ ] The daemon accepts an origin only as `host[:port]/path`. The host is letters, digits, `.` and `-`, with an optional port of digits. The path is one or more segments of letters, digits, `.`, `_`, `~` and `-`, separated by `/`; no segment is empty, `.` or `..`, or starts with `-`. Anything else is refused with "not a project origin: <text>" before `git` runs. A root must be 40 or 64 hex digits.
  - Accepted: `github.com/acme/shop`, `gitlab.com/group/sub/shop`, `git.example.com:2222/acme/shop`.
  - Refused: `-oProxyCommand=x/a`, `github.com/../etc`, `github.com/acme/-shop`, `github.com//shop`, `example.com/a b`, `github.com`.
- [ ] For an origin on `github.com`, the dialog works as X59 does for `owner/repo`: the lookup and the clone use `gh` when it is signed in on the host, else git over HTTPS. When neither reaches it, git over SSH (`git@github.com:owner/repo.git`) is tried as well.
- [ ] For any other origin, the daemon tries these addresses in order, and uses the first one that `git ls-remote --symref <address> HEAD` reaches:
  - `git@gitlab.com:acme/ledger.git` for `gitlab.com/acme/ledger`, or `ssh://git@git.example.com:2222/acme/shop.git` for `git.example.com:2222/acme/shop`;
  - `https://gitlab.com/acme/ledger.git`, or `https://git.example.com:2222/acme/shop.git`.
- [ ] Git never prompts: the lookup and the clone run with `GIT_TERMINAL_PROMPT=0` and `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`.
- [ ] When the lookup finds the repository, the card shows "Found · <default branch>" in green and the address it reached, in small mono.
- [ ] When no address answers, the card shows "<host> can't reach <origin>" in red. Under it is "This Mac tried <SSH address> and <HTTPS address>. Check that this Mac can read the repository, with an SSH key or a signed-in credential helper, then retry." Each address's failure follows in git's words (X59's last `fatal:` line). **Retry** looks it up again. Locate a copy stays available.

### Cloning

- [ ] **Clone into** works as in X59: a parent folder and a folder name, the parent starting at the last one used for a clone on that host (`moonlet.cloneParents`, shared with X59), else `~/moonlet`. The name starts as the origin's last path segment.
- [ ] The target is checked as in X59. A folder that already exists and holds the same project (same identity) offers **Add existing folder** and "Use <name>-2". Any other existing folder offers only "Use <name>-2". **Clone and add** is disabled until the lookup has found the repository and the target is free.
- [ ] **Clone and add** starts the clone on the host with the address the lookup reached. It shows X59's progress card and footer, and **Cancel clone** works as in X59: git stops and the folder the clone created is removed.
- [ ] When git is done, the daemon reads the clone's identity. When its root commit differs from the project's, the daemon removes the folder, and the dialog says "<address> holds another repository: its first commit is not the one ledger starts with on the other Macs." Nothing is added.
- [ ] When the root matches, the folder is added as a project in the section the dialog was opened from. The section keeps the project in the place it had, and the project is no longer in the section's `missing`, on this member and on the others once they sync. A toast says "Added <name>". If the dialog is still showing, it becomes the new session composer for the project.
- [ ] A clone left to run after the dialog closes ends as in X59: a toast, and nothing opens.

### Locating a copy

- [ ] **Locate a copy** shows a Folder field, with Browse… on This Mac, and **Add this folder**. When the folder is typed or picked, the dialog reads its identity on the host (`project.identity`). It says "This is a clone of <origin>." in green when the identities are the same project (X41's `same_project`: equal known roots and equal origins). Otherwise it shows the reason in red, and Add this folder is disabled:
  - "<folder> is not a git repository."
  - "<folder> holds another repository." (another root)
  - "<folder> has the same history but its origin is <its origin>, not <origin>." (same root, another origin; "no origin" when it has none)
- [ ] **Add this folder** adds the folder to the section (`section.add_project` with the expected identity). The daemon checks the identity again and refuses a folder that is not the same project with the same reason, so a folder changed after the check is not added. On success the dialog closes with a toast "Added <name>", and the project keeps its place in the section.

### A project without an origin

- [ ] For an identity whose origin is `null`, the dialog shows no lookup and no Clone into. It says "<name> has no remote, so <host> can't clone it. Push it to a remote from the Mac that has it, or locate a copy here." Locate a copy is open from the start.

## UI

The dialog is 560px wide, like Add project, and reuses its parts:

- Header: **Get <name> on <host>**, with a dashed square as the project mark.
- Project card: the name in bold, the origin in mono, the lookup state on the right ("Looking up…", "Found · main", or the red failure box under the card), and the address reached in small mono under the origin.
- **Clone into**: X59's two fields, its hints and its amber "already exists" box.
- Below, a divider and a link-style button **Locate a copy**. It opens the Folder field with Browse… and its green or red line under the field.
- Footer: **Cancel** and **Clone and add**, or **Add this folder** while Locate a copy is open. While cloning, X59's footer: "Closing keeps the clone running in the background.", **Cancel clone** and a disabled "Cloning…".

States: looking up, found, not reachable, no origin, target taken, cloning, failed clone (the red box under the form, as in X59), wrong root, located folder matching or not.

## Protocol and RPCs

Changed methods. `repo` and `origin` are alternatives: a call carries one of them.

| Method | Params | Result |
|---|---|---|
| `repo.lookup` | `{ origin: "host/path" }` | X59's `RepoInfo`, plus `url`, the address it reached |
| `repo.clone_target` | `{ origin, root, parent, name }` | X59's `CloneTarget`; `same_repo` is true when the folder is the same project by identity |
| `repo.clone` | `{ id, origin, root, url, parent, name, section_id }` | `{ id, repo, path }` at once; `repo` is the origin. Progress and the end come as X59's `repo.clone_progress` and `repo.clone_done` events. |
| `section.add_project` | gains `identity?: ProjectIdentity` | refuses a folder that is not that project, with the reasons above |

- `repo.clone` with an `origin` accepts only a `url` that is one of the origin's addresses above (for `github.com`, also the `gh` route, given as `url: null`). So the app cannot make the daemon clone an address of its own choosing.
- A failed lookup's error carries each address tried and git's reason for it.

## Data and config

- Nothing new in the daemon's state. The cloned or located folder becomes a project like any added folder, and its identity takes the section's existing project field, so the account log gets no new field for it.
- The app keeps using `moonlet.cloneParents` from X59.

## Security considerations

- An origin comes from the account log, written by another member. The daemon treats it as untrusted text. It accepts only the shape above, so no origin can become a git option, a `file://` or `ext::` address, or a local path. It builds every address itself, with a fixed `ssh://`, `git@…:` or `https://` form.
- The root check means a remote that has been replaced, or an origin another member made up, is never added as the project.
- Git never prompts, and SSH runs in batch mode, so an unreachable or unknown host fails at once instead of waiting for a password or a host-key answer.
- No credentials are read, stored or sent. The clone uses the host's own SSH keys, credential helper or `gh` sign-in.

## Out of scope

- Copying a project that has no origin from the member that has it, over the link (a `git bundle` from that member). That needs the member to be connected, and comes later.
- Offering this dialog for a project that another connected member has (rows marked "on studio-mini").
- Cloning every missing project of a section at once.
- Picking SSH or HTTPS by hand, or a custom address.
- Shallow clones and submodules beyond `git clone`'s defaults, as in X59.

## Test plan

- **Rust unit (`moonlet-core/src/repo_clone.rs`):** origin checks against the accepted and refused literals above; the addresses tried for `gitlab.com/acme/ledger`, `git.example.com:2222/acme/shop` and `github.com/acme/shop`, as literals; a lookup failure message from captured `git ls-remote` stderr for SSH (`Permission denied (publickey)`) and HTTPS (`could not read Username`).
- **Rust unit (`moonlet-core/src/session/account.rs`):** a section with a missing project, then that project added with an identity: it is no longer missing, and the project order the other member sees is unchanged; a folder with another root or another origin is refused with the reasons above.
- **Daemon (`moonletd/tests/daemon.rs`):** a scratch home whose `.gitconfig` maps `ssh://git@example.test/acme/shop.git` to a local bare repository with `url.<bare>.insteadOf`. `repo.lookup {origin}` reports that address; `repo.clone` sends progress and done, and `section.list` no longer lists the identity in `missing`. A bare repository with another root is cloned, removed, and reported as another repository. `repo.clone` with a `url` that is not one of the origin's addresses is refused.
- **Vitest (`apps/desktop/src/lib/`):** what clicking a missing project opens; the dialog's states and messages (found, not reachable with both addresses, no origin, located folder matching or not, too old a daemon); the folder name from an origin.
- **e2e (`apps/desktop/e2e/specs/get-missing-project.e2e.ts`):** with the app's daemon given a section that lists a missing project through the account log, click the row, clone it from the `insteadOf` bare repository, and land in the new session composer with the row no longer marked "not on This Mac". Locate a copy of a second missing project from a folder.
- **Manual:** clone a private GitLab repository over SSH on This Mac; clone on a remote host into a path on that host.

## Open questions

- Should "on studio-mini" rows also offer **Get it on This Mac**? It is the same dialog, but the click on those rows toggles the group today.
