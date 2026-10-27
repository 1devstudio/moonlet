# X70 — Get a project this host does not have: clone it from its origin, or locate a copy

- **Status:** implemented (2026-10-27; daemon and Vitest tests, the dialog seen in the e2e app; a real private repository and a remote host untried)
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
6. `scratch`, a repository with no remote, is missing too. Its dialog says "scratch has no remote, so This Mac can't clone it. Push it to a remote from the host that has it, or locate a copy here." Only Locate a copy is offered.

## Behaviour and acceptance criteria

Test citations: Rust tests by function name, Vitest by `describe › it`, e2e by spec file and `it`. A criterion marked *manual* has no automated test; the Test plan says how to check it.

### Opening the dialog

- [x] Clicking a project group marked "not on <host>" opens **Get <name> on <host>** for that project and section, in place of X68's toast. <host> is the shown host's label, or "This Mac". <name> is the label the sidebar shows for the group. (sidebar.test.ts › arrangeShared › "shows each project once with every member's sessions, newest first, and says where the rest are"; getProject.test.ts › getProjectTitle › "names the project and the host it is got on"; the click *manual*)
- [x] The dialog acts on the shown host: the lookup, the clone and the located folder are all on that host, as X59's dialog does for its chosen host. For a remote host, Browse… is absent and the hint reads "A path on <host>. No Browse… for remote hosts." (*manual*)
- [x] When the shown host's daemon predates X70, the dialog shows only "<host>'s moonletd is too old to get this project. Update moonlet there." and a Close button. Such a daemon answers the lookup with "missing field `repo`". For a project without an origin, which needs no lookup, the dialog looks up an empty origin to tell: an X70 daemon refuses it as no project origin. (getProject.test.ts › isTooOld › "reads a daemon that wants a repository as one from before X70")

### Which address to clone from

- [x] The daemon accepts an origin only as `host[:port]/path`. The host is letters, digits, `.`, `-` and `_` (an ssh host alias), or an IPv6 address in brackets, with an optional port of digits. The path is one or more segments of letters, digits, `.`, `_`, `~` and `-`, separated by `/`; no segment is empty, `.` or `..`, or starts with `-`. Anything else is refused with "not a project origin: <text>" before `git` runs. A root must be 40 or 64 lowercase hex digits, as git prints it, else "not a root commit: <text>"; `repo.clone_target` and `repo.clone` both check it. (`accepts_only_an_origin_as_a_project_identity_holds_it`, `accepts_only_a_commit_id_as_a_root`, `an_origin_clones_only_from_its_own_addresses`)
  - Accepted: `github.com/acme/shop`, `gitlab.com/group/sub/shop`, `git.example.com:2222/acme/shop`, `gh_work/acme/shop`, `[fe80::1]:2222/acme/shop`.
  - Refused: `-oProxyCommand=x/a`, `github.com/../etc`, `github.com/acme/-shop`, `github.com//shop`, `example.com/a b`, `github.com`.
- [x] For an origin `github.com/<owner>/<name>`, the lookup asks `gh repo view` when gh is signed in on the host, and the clone then runs `gh repo clone`, as in X59. When gh is not signed in or cannot see it, git tries `https://github.com/<owner>/<name>.git`, then `git@github.com:<owner>/<name>.git`. (`tries_ssh_then_https_and_https_first_on_github`, `a_github_origin_of_owner_and_name_can_go_through_gh`, `clones_an_origin_only_from_one_of_its_addresses`)
- [x] For any other origin, the daemon tries these addresses in order, and uses the first one that `git ls-remote --symref <address> HEAD` reaches:
  - `git@gitlab.com:acme/ledger.git` for `gitlab.com/acme/ledger`, or `ssh://git@git.example.com:2222/acme/shop.git` for `git.example.com:2222/acme/shop` (and `ssh://git@[fe80::1]/…` for an IPv6 host);
  - `https://gitlab.com/acme/ledger.git`, or `https://git.example.com:2222/acme/shop.git`;
  - for an origin with a port, also `https://git.example.com/acme/shop.git`: the log does not keep the scheme, so the port may have been SSH's.
  - An address that fails, or does not answer within the lookup's 60 s, is noted and the next one is tried.
  (`tries_ssh_then_https_and_https_first_on_github`, `a_project_from_another_member_is_cloned_from_its_origin_into_its_section`)
- [x] Git never prompts: the lookup and the clone run with `GIT_TERMINAL_PROMPT=0`, and with `GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10"` unless the user has an ssh command of their own (`GIT_SSH_COMMAND`, `GIT_SSH`, or `core.sshCommand` in any git config), which git would otherwise lose. (*manual*)
- [x] When the lookup finds the repository, the card shows "Found · <default branch>" in green and the address it reached, in small mono. (getProject.test.ts › foundLine › "says found, with the default branch when git gave one"; `a_project_from_another_member_is_cloned_from_its_origin_into_its_section`)
- [x] When no address answers, a red box under the card reads "<host> can't reach <origin>". Under it is "<host> tried <first address> and <second address>." (or "<a>, <b> and <c>" for three) Check that this Mac can read the repository, with an SSH key or a signed-in credential helper, then retry." Each address follows in mono with why it failed: the line ssh or git printed before git's first `fatal:`, else that `fatal:` line. **Retry** looks it up again. Locate a copy stays available. (getProject.test.ts › cantReach › "names both addresses tried and why each failed", "lists three addresses for an origin with a port", "says what the daemon said when it tried no address"; `says_why_an_address_could_not_be_reached`)

### Cloning

- [x] **Clone into** works as in X59: a parent folder and a folder name, the parent starting at the last one used for a clone on that host (`moonlet.cloneParents`, shared with X59), else `~/moonlet`. The name starts as the origin's last path segment. (addProject.test.ts › cloneParent › "starts at ~/moonlet, then remembers the last parent of each host"; getProject.test.ts › originName › "starts the folder name as the origin's last path segment")
- [x] The target is checked as in X59. A folder that already exists and holds the same project (same identity) offers **Add existing folder** and "Use <name>-2". Any other existing folder offers only "Use <name>-2". **Clone and add** is disabled until the lookup has found the repository and the target checked for the folder typed now is free. (`a_folder_is_the_same_project_by_its_identity`; getProject.test.ts › canCloneInto › "clones once the repository is found and the folder typed now is free", "waits for the check of a folder typed since", "does not clone into a folder that exists, before the lookup, or twice")
- [x] **Clone and add** starts the clone on the host with the address the lookup reached. The daemon clones only from one of the origin's own addresses, or through gh for github.com: any other is refused with "<address> is not an address of <origin>". It shows X59's progress card and footer, and **Cancel clone** works as in X59: git stops and the folder the clone created is removed. A failed clone's red box goes once the form is edited, as in X59. (`clones_an_origin_only_from_one_of_its_addresses`, `an_origin_clones_only_from_its_own_addresses`; progress and cancel run the same code as X59's, tested by `a_clone_from_github_becomes_a_project_and_reports_its_progress` and `a_cancelled_clone_stops_and_leaves_no_folder`)
- [x] When git is done, the daemon reads the clone's root commit. When it differs from the project's, the daemon removes the folder, and the dialog says "<address> holds another repository: its first commit is not the one ledger starts with on the account's other hosts." Nothing is added. (`a_clone_whose_address_holds_another_repository_is_not_added`)
- [x] When the root matches, the folder is added as a project in the section the dialog was opened from. The section keeps the project in the place it had, and the project is no longer in the section's `missing`, on this member and on the others once they sync. A toast says "Added <name>". If the dialog is still showing, it becomes the new session composer for the project. (`a_project_from_another_member_is_cloned_from_its_origin_into_its_section`, `a_clone_of_a_missing_project_keeps_its_place_in_the_section`, `a_clone_added_here_is_no_longer_missing`; the toast and the composer as X59's addProject.test.ts › clone runs)
- [x] A clone left to run after the dialog closes ends as in X59: a toast, and nothing opens. (addProject.test.ts › clone runs › "adds the project: a toast, the parent remembered, the composer when the dialog watched")

### Locating a copy

- [x] **Locate a copy** shows a Folder field, with Browse… on This Mac, and **Add this folder**; for a project with an origin, "Clone it instead" goes back. When the folder is typed or picked, the dialog reads its identity on the host (`project.identity`). It says "This is a clone of <origin>." in green when the identities are the same project (X41's `same_project`: equal known roots and equal origins), or "This is a copy of <name>." for a project without an origin. Otherwise it shows the reason in red, and Add this folder is disabled:
  - "<folder> has no history to match: it is not a git repository, or a shallow clone, or has no commits."
  - "<folder> holds another repository." (another root)
  - "<folder> has the same history but its origin is <its origin>, not <origin>." (same root, another origin)
  - "<folder> has the same history but no origin; the project's is <origin>." and "<folder> has the same history but its origin is <its origin>; the project has none."
  (getProject.test.ts › copyCheck › "accepts a folder of the same project, in green", "says why any other folder is not a copy"; `says_why_a_folder_is_not_a_copy_of_the_project`)
- [x] **Add this folder** adds the folder to the section (`section.add_project` with the expected identity). The daemon checks the identity again, on the repository it adds and in the same step, and refuses a folder that is not the same project with the same reason, so a folder changed after the check is not added. A folder inside a copy adds that copy's top folder, as any added folder does. On success the dialog closes with a toast "Added <name>", and the project keeps its place in the section. A late answer, after the dialog closed or another opened, leaves the dialogs alone. (`a_located_folder_joins_a_section_only_as_a_copy_of_the_project`, `a_clone_of_a_missing_project_keeps_its_place_in_the_section`)

### A project without an origin

- [x] For an identity whose origin is `null`, the dialog shows no lookup and no Clone into. It says "<name> has no remote, so <host> can't clone it. Push it to a remote from the host that has it, or locate a copy here." Locate a copy is open from the start. (getProject.test.ts › noOrigin › "says a project without a remote can only be located")

## UI

The dialog is 560px wide, like Add project, and reuses its parts:

- Header: **Get <name> on <host>**.
- Project card: a dashed square as the project mark, the name in bold, the origin in mono (or "no remote"), the lookup state on the right ("Looking up…", "Found · main", or the red failure box under the card), and the address reached in small mono under the origin.
- **Clone into**: X59's two fields, its hints and its amber "already exists" box.
- Below, a divider and a link-style button **Locate a copy**. It opens the Folder field with Browse… and its green or red line under the field, and "Clone it instead" under them.
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

- **Rust unit (`moonlet-core/src/repo_clone.rs`):** origin and root checks against the accepted and refused literals above; the addresses tried for `gitlab.com/acme/ledger`, `git.example.com:2222/acme/shop` and `github.com/acme/shop`, as literals; the clone command only from an origin's own addresses; why an address failed, from captured `git ls-remote` stderr for SSH without a key, an unknown SSH host and HTTPS without credentials; a folder that is the same project by its identity.
- **Rust unit (`moonlet-core/src/identity.rs`):** why a folder is not a copy of the project.
- **Rust unit (`moonlet-core/src/session/account.rs`):** a section with a missing project, then a clone of it added on this member: it keeps its place, the member sends no change for the section, and the other member keeps the order.
- **Daemon (`moonletd/tests/daemon.rs`):** a scratch home whose `.gitconfig` maps `git@example.test:acme/ledger.git` to a local bare repository with `url.<bare>.insteadOf`. `repo.lookup {origin}` reports that address; `repo.clone` adds the project to the section with the origin's root, and its remote keeps the address. A clone whose root is not the project's is removed and reported. `repo.clone` with an address that is not the origin's, or an origin of another shape, is refused. `section.add_project` with an identity refuses a folder of another repository.
- **Vitest (`apps/desktop/src/lib/getProject.test.ts`, `sidebar.test.ts`):** the title, the folder name from an origin, the found line, the unreachable box, the no-remote text, the located folder's check, a daemon from before X70; a missing project's group carries its identity.
- **No e2e spec:** getting a missing project is not one of AGENTS.md's crucial features, and a missing project needs a second member of the account. The dialog was checked in the e2e app with a throwaway snap spec, the section's `missing` given through a `sections.changed` event and the origin mapped to a local bare repository.
- **Manual:** clone a private GitLab repository over SSH on This Mac; clone on a remote host into a path on that host; the user's own `core.sshCommand` is kept.

## Open questions

- Should "on studio-mini" rows also offer **Get it on This Mac**? It is the same dialog, but the click on those rows toggles the group today.
