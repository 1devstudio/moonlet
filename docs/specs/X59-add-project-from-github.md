# X59 — Add a project from GitHub

- **Status:** implemented (2026-10-21; checked with e2e and screenshots of the e2e app; remote hosts untried)
- **Priority / phase:** P1 · phase 3
- **PRD refs:** X5 (projects, sections), X32 (sections), R1 (remote hosts), X57 (tailnet hosts)
- **Related ADRs:** none
- **Related specs:** X15 (GitHub origin of a project), X36 (streamed `claude update` output), X55 (per-host git settings)

## Summary

The Add project dialog only takes a folder that already holds a git repository. Adding a repository that is only on GitHub means leaving moonlet to clone it first. The dialog gains a second tab, **Clone from GitHub**. It takes a GitHub URL, `owner/repo` or an SSH address, or a pick from the user's own repositories. It shows what it found and clones the repository into a folder on the chosen host, with live progress. Then it adds the folder as a project and opens the new session composer. The clone runs in the host's daemon, so it works the same on a remote host, and it keeps running when the dialog closes.

## User journey

1. The user opens Add project and picks the **Clone from GitHub** tab.
2. In **Repository** they paste `https://github.com/acme/storefront`. A card shows `acme/storefront` with a Private badge, its description, `main · pushed 2h ago · 48 MB` and a green "Found".
3. **Clone into** shows `~/moonlet` / `storefront`. They keep it and press **Clone and add**.
4. The form dims. A progress card reads "Cloning acme/storefront into ~/moonlet/storefront", with a bar, the percentage and the steps git reports: "Counting objects 12,840", "Receiving objects 8,213/12,840 · 21.4 MiB · 6.2 MiB/s", "Resolving deltas", "Then: open the new session composer".
5. When it finishes, a toast says "Added storefront". The dialog becomes the new session composer for the new project.
6. Another time, they type `store` instead of a URL. Their repositories that match are listed under "Your repositories". A repository that is already a project on that host reads "Already added".
7. Pasting a GitHub URL into the **Local folder** tab shows "That's a GitHub repository, not a folder." with a button "Clone acme/storefront →" that switches tabs and keeps the URL.

## Behaviour and acceptance criteria

### Tabs

- [x] The dialog shows a two-way switch under its intro: "Local folder" (a folder icon) and "Clone from GitHub" (a globe icon). "Local folder" is picked when the dialog opens. That tab is the dialog as before X59. (add-project-clone.e2e.ts)
- [x] In the Local folder tab, a Folder value that reads as a GitHub repository (see *Repository input*) shows an amber row "That's a GitHub repository, not a folder." with a button "Clone <owner/repo>". The button switches to Clone from GitHub with the same text in Repository. Add project stays disabled while the row shows. (addProject.test.ts `repoRef`; add-project-clone.e2e.ts)

### Repository input

- [x] These read as the repository `acme/storefront`: `https://github.com/acme/storefront`, `https://github.com/acme/storefront.git`, `https://github.com/acme/storefront/tree/main/src`, `github.com/acme/storefront`, `git@github.com:acme/storefront.git`, `ssh://git@github.com/acme/storefront.git` and `acme/storefront`. Surrounding spaces are ignored. The two SSH forms are marked as SSH. These do not read as a repository: `storefront`, `https://gitlab.com/acme/storefront`, `~/code/storefront`, `/Users/alex/code`, `./acme/storefront` and `acme/store front`. (addProject.test.ts)
- [x] The hint under Repository reads "A GitHub URL, owner/repo, or an SSH address."
- [x] Owner and repository names may hold only letters, digits, `.`, `-` and `_`, and cannot start with `-`. The daemon refuses any other name with "not a GitHub repository: <text>" before it runs `gh` or `git`. (repo_clone.rs)

### Looking a repository up

- [x] When Repository reads as a repository, the dialog looks it up on the chosen host (`repo.lookup`, after 300 ms without typing). While it waits, the card shows "Looking up acme/storefront…".
- [x] When `gh` is signed in on that host, the lookup runs `gh repo view <owner/repo> --json name,nameWithOwner,description,isPrivate,defaultBranchRef,pushedAt,diskUsage`. The card shows the owner's initial on a tile, `owner/repo`, a lock icon with "Private" when it is private, the description when there is one, and `<default branch> · pushed <age> · <size>` in mono. On the right it shows a check icon with "Found" in green. (repo_clone.rs fixture `gh-repo-view.json`; daemon.rs `looks_repositories_up_and_lists_them_through_gh`; add-project-clone.e2e.ts)
- [x] Without a signed-in `gh` on that host, the lookup runs `git ls-remote --symref <https URL> HEAD` (or the SSH address when one was typed). If git can read it, the card shows `owner/repo` with the default branch only, and "Found". (repo_clone.rs)
- [x] When the repository cannot be found or read, Repository gets a red border and a red box shows "<host> can't see <owner/repo>". <host> is the host's label, or "This Mac". Under it:
  - With `gh` signed in: "It doesn't exist, or <login> has no access to it."
  - Without `gh` signed in: "gh isn't signed in on <host>, so only public repositories can be cloned there. Sign in once on that host, then try again." It also shows a mono `gh auth login` field with a copy button, and **Retry**, which looks the repository up again. (addProject.test.ts)
- [x] Ages read "just now" (under a minute), "<n>m ago", "<n>h ago", "yesterday" (24–47 hours), "<n>d ago" (under 14 days), "<n>w ago" (under 8 weeks), else the date as "12 Mar 2026". Sizes come from `diskUsage` in KB: "<1 MB" under 1024 KB, "<n> MB" rounded under 1024 MB, else "<n.n> GB". (addProject.test.ts)

### Your repositories

- [x] When Repository is empty or holds text that does not read as a repository, and `gh` is signed in on the host, a list headed "Your repositories" shows the user's repositories whose `owner/repo` contains the text (case-insensitive). "from gh · <owners>" on the right of the header names the owners in the list. The list holds up to 6 rows, most recently pushed first. (addProject.test.ts; add-project-clone.e2e.ts)
- [x] The list comes from `gh api "user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100"`, fetched once per dialog and host (`repo.list`). (repo_clone.rs fixture `gh-user-repos.json`)
- [x] Each row shows the owner's initial on a tile, `owner/` muted with the name in bold, a lock icon when private, the description, and the age on the right. A repository already added as a project on that host is dimmed, reads "Already added" in a pill and cannot be picked. A project is that repository when its `origin` remote points at it. (repo_clone.rs; daemon.rs `looks_repositories_up_and_lists_them_through_gh`)
- [x] Clicking a row, or Enter on the highlighted row (↑/↓ move it), puts `owner/repo` into Repository. The row is then looked up as above.
- [x] Under the list: "Not listed? Type owner/repo or paste any URL you can access."
- [x] With `gh` not signed in, no list shows. Text that does not read as a repository shows only the hint.

### Where it is cloned

- [x] **Clone into** has two fields: the parent folder, then `/`, then the folder name. The name starts as the repository's name. For This Mac, **Browse…** picks the parent folder. For a remote host, Browse… is absent and the hint reads "A path on <host>. No Browse… for remote hosts."
- [x] The parent folder starts as the last parent used for a clone on that host. The first time on a host it is `~/moonlet`. Under the fields: "The parent folder is remembered for the next clone." (addProject.test.ts)
- [x] The dialog checks the target on the host (`repo.clone_target`) when the repository, parent or name changes. When the target exists, the name field gets an amber border and an amber box shows "<parent>/<name> already exists" with a shield icon.
  - When it is a clone of the same repository: "It's already a clone of <owner/repo>, on <branch>. Add that folder as the project, or pick another name to clone fresh." Two buttons follow: **Add existing folder**, which adds it as a project without cloning, and "Use <name>-2".
  - Otherwise: "It isn't a clone of <owner/repo>. Pick another name to clone fresh." with only "Use <name>-2".
  - "<name>-2" is the first of `<name>-2`, `<name>-3`, … that does not exist (for `storefront-2` it is `storefront-2-2`). **Clone and add** is disabled while the target exists. (repo_clone.rs; add-project-clone.e2e.ts)
- [x] A missing parent folder is created by the clone.

### Cloning

- [x] **Clone and add** (Enter in Repository or the name) starts the clone on the chosen host (`repo.clone`). It is disabled until the repository is found and the target is free. The daemon answers at once with the clone's id. Then:
  - With `gh` signed in and no SSH address typed, it runs `gh repo clone <owner/repo> <dest> -- --progress`, so private repositories clone with gh's sign-in.
  - With an SSH address, it runs `git clone --progress <ssh address> <dest>`.
  - Otherwise it runs `git clone --progress https://github.com/<owner/repo>.git <dest>`.
  - Git never prompts (`GIT_TERMINAL_PROMPT=0`).
  (repo_clone.rs `clones_with_gh_when_signed_in_else_with_git`; daemon.rs `a_clone_from_github_becomes_a_project_and_reports_its_progress`)
- [x] While it runs, the daemon sends `repo.clone_progress` events built from git's progress output (separated by `\r` as well as newlines). Each event carries the step (`counting`, `receiving` or `resolving`), its counts, and for receiving the size and speed git prints. `counting` is the remote's "Counting objects"; its enumerating and compressing are not reported. (repo_clone.rs fixture `git-clone-progress.txt`)
- [x] The progress card shows three steps: "Counting objects <total>", "Receiving objects <done>/<total> · <size> · <speed>" and "Resolving deltas <done>/<total>". Each has a check when done, a spinner while running, and is muted before it starts. A fourth line "Then: open the new session composer" follows them. Numbers use thousands separators. The percentage is 10% of counting, 80% of receiving and 10% of resolving, rounded down. Overall it reads 0% before git reports anything and 100% when done. (addProject.test.ts)
- [x] While it runs, the form is dimmed and read-only. The footer reads "Closing keeps the clone running in the background." with **Cancel clone** and a disabled "Cloning…" with a spinner.
- [x] When the clone succeeds, the daemon adds the folder as a project, in the chosen section when there is one (as `section.add_project`), and sends `repo.clone_done` with the project. The parent folder is remembered for that host. The app shows a toast "Added <name>". If the dialog is still showing that clone, it becomes the new session composer for the project, as the Local folder tab does. (daemon.rs `a_clone_from_github_becomes_a_project_and_reports_its_progress`; addProject.test.ts `clone runs`; add-project-clone.e2e.ts)
- [x] When the dialog was closed during the clone, the clone goes on. Its end shows the toast, or an error toast, and nothing opens. (addProject.test.ts `clone runs`)
- [x] When the clone fails, the daemon removes the folder the clone created and sends `repo.clone_done` with git's last `fatal:` line (or its last line) as the error. The dialog shows it in a red box over the form and turns back to editable. (daemon.rs `a_failed_clone_says_why_and_leaves_no_folder`; repo_clone.rs `says_why_a_clone_failed_in_gits_words`; addProject.test.ts `clone runs`)
- [x] **Cancel clone** (`repo.clone_cancel`) stops git, removes the folder the clone created, and sends `repo.clone_done` with `cancelled`. The dialog turns back to editable, and no toast shows. (daemon.rs `a_cancelled_clone_stops_and_leaves_no_folder`; addProject.test.ts `clone runs`)
- [x] One host runs any number of clones at once. A second clone into the same target is refused with "<dest> is being cloned already". (daemon.rs `a_cancelled_clone_stops_and_leaves_no_folder`)

### gh status

- [x] The dialog's footer, in the Clone from GitHub tab and while not cloning, shows `gh` on the chosen host (`repo.gh_status`, from `gh auth status --hostname github.com`):
  - "gh signed in on <host>" with a green check.
  - "gh not signed in on <host>" with a grey dot.
  - "gh is not installed on <host>" with a grey dot.
  (repo_clone.rs fixtures `gh-auth-status.txt` and `gh-auth-status-signed-out.txt`; addProject.test.ts `ghLine`; add-project-clone.e2e.ts)

## UI

The design is the "Add project from GitHub" board: six frames 560px wide. They cover the repository found, the GitHub tab list, a URL pasted into Folder, cloning in progress, a target folder that already exists, and a remote host where gh is not signed in. Section stays the last field of both tabs. Host shows when more than one host is connected, as before. The footer button reads **Clone and add** in the GitHub tab and **Add project** in the folder tab.

## Protocol and RPCs

New methods, all answered by the host's daemon:

| Method | Params | Result |
|---|---|---|
| `repo.gh_status` | — | `{ installed: bool, login: string \| null }` |
| `repo.lookup` | `{ repo: "owner/name", ssh?: string }` | `RepoInfo { repo, private, description, default_branch, pushed_at, disk_kb }` (fields optional when found through git) |
| `repo.list` | — | `RepoSummary[] { repo, description, private, pushed_at, added: bool }` |
| `repo.clone_target` | `{ repo, parent, name }` | `{ path, exists: bool, same_repo: bool, branch: string \| null, free_name: string }` |
| `repo.clone` | `{ repo, ssh?, parent, name, section_id? }` | `{ id, repo, path }` at once |
| `repo.clone_cancel` | `{ id }` | `true` |

New events: `repo.clone_progress { id, repo, path, step, current, total, size?, speed? }` and `repo.clone_done { id, repo, path, project?, error?, cancelled }`.

## Data and config

- The last clone parent per host is kept in the app's local storage as `moonlet.cloneParents` (`{ "<host id>": "~/code" }`).
- Nothing new in the daemon's state: a cloned folder becomes a project like any added folder.

## Security considerations

- Repository text crosses from the UI to `gh` and `git` arguments. The daemon accepts only `owner/name` made of `[A-Za-z0-9._-]` and not starting with `-`. It accepts only SSH addresses of the form `git@github.com:owner/name(.git)`, so no text can become an option.
- The clone runs with `GIT_TERMINAL_PROMPT=0`, so a private repository without access fails instead of waiting for a password.
- No token is read or stored by moonlet. Private repositories clone through the host's own `gh` sign-in.

## Out of scope

- GitHub Enterprise hosts, GitLab and other forges.
- Signing in to `gh` from moonlet (the dialog shows the command), and opening a terminal on a remote host for it.
- Shallow or partial clones, and submodules beyond what `git clone` does by default.
- A list of running clones outside the dialog.

## Test plan

- Rust unit tests in `moonlet-core/src/repo_clone.rs`, run on real captured output: `gh repo view --json`, `gh api user/repos`, `gh auth status` signed in and out, `git ls-remote --symref`, and `gh repo clone … -- --progress` stderr.
- A daemon test in `moonletd/tests/daemon.rs` with a fake `gh` that clones a local bare repository: `repo.clone` sends progress and done, and `project.list` holds the new project. Cancelling removes the folder.
- Vitest in `apps/desktop/src/lib/addProject.test.ts`: repository input, list filtering, ages and sizes, the remembered parent, progress steps and percentage, and the error box text.
- e2e `add-project-clone.e2e.ts`: paste a URL, see the card, clone with a fake `gh`, land in the new session composer with the project.

## Open questions

- None.
