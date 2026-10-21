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

Test citations: Rust tests by function name, Vitest by `describe › it`, e2e by spec file and `it`. A criterion marked *manual* has no automated test; the Test plan says how to check it.

### Tabs

- [x] The dialog shows a two-way switch under its intro: "Local folder" (a folder icon) and "Clone from GitHub" (a globe icon). "Local folder" is picked when the dialog opens. That tab is the dialog as before X59. (add-project-clone.e2e.ts › "clones a repository picked from the user's list and opens the composer for it")
- [x] In the Local folder tab, a Folder value that reads as a GitHub repository (see *Repository input*) shows a row "That's a GitHub repository, not a folder." with a button "Clone <owner/repo>". The button switches to Clone from GitHub with the same text in Repository. Add project stays disabled while the row shows. (add-project-clone.e2e.ts › "sends a URL typed as a folder to the clone tab, which sees the folder is taken")

### Repository input

- [x] These read as the repository `acme/storefront`: `https://github.com/acme/storefront`, `https://github.com/acme/storefront.git`, `https://github.com/acme/storefront/tree/main/src`, `github.com/acme/storefront`, `git@github.com:acme/storefront.git`, `ssh://git@github.com/acme/storefront.git` and `acme/storefront`. Surrounding spaces are ignored. The two SSH forms are marked as SSH. These do not read as a repository: `storefront`, `https://gitlab.com/acme/storefront`, `~/code/storefront`, `/Users/alex/code`, `./acme/storefront` and `acme/store front`. (addProject.test.ts › repoRef › "reads GitHub URLs and owner/repo as the repository", "keeps an SSH address, in the form the daemon accepts", "reads folders, other forges and plain words as no repository")
- [x] Except while the list shows, the hint under Repository reads "A GitHub URL, owner/repo, or an SSH address." (add-project-clone.e2e.ts › "clones a repository picked from the user's list and opens the composer for it")
- [x] Owner and repository names may hold only letters, digits, `.`, `-` and `_`, and cannot start with `-`. The daemon refuses any other name with "not a GitHub repository: <text>" before it runs `gh` or `git`, and an SSH address that is not `git@github.com:<owner/repo>` with "not an SSH address of <owner/repo>: <text>". (`accepts_only_plain_owner_and_name`, `accepts_only_the_github_ssh_address_of_the_repository`, `a_clone_from_github_becomes_a_project_and_reports_its_progress`)

### Looking a repository up

- [x] When Repository reads as a repository, the dialog looks it up on the chosen host (`repo.lookup`, after 300 ms without typing, once gh's status on the host is known). While it waits, a card shows "Looking up acme/storefront…" with a spinner. (*manual*)
- [x] When `gh` is signed in on that host, the lookup runs `gh repo view <owner/repo> --json name,nameWithOwner,description,isPrivate,defaultBranchRef,pushedAt,diskUsage`. The card shows the owner's initial on a tile, `owner/repo`, a lock icon with "Private" when it is private, the description when there is one, and `<default branch> · pushed <age> · <size>` in mono. On the right it shows a check icon with "Found" in green. (`reads_a_repository_from_gh_repo_view`, `looks_repositories_up_and_lists_them_through_gh`; add-project-clone.e2e.ts › "clones a repository picked from the user's list and opens the composer for it")
- [x] Without a signed-in `gh` on that host, the lookup runs `git ls-remote --symref <https URL> HEAD` (or the SSH address when one was typed). If git can read it, the card shows `owner/repo` with the default branch only, and "Found". (`reads_the_default_branch_from_git_ls_remote`)
- [x] When the lookup fails, Repository gets a red border and a red box shows "<host> can't see <owner/repo>". <host> is the host's label, or "This Mac". Under it:
  - With `gh` signed in: "It doesn't exist, or <login> has no access to it."
  - With `gh` installed but not signed in: "gh isn't signed in on <host>, so only public repositories can be cloned there. Sign in once on that host, then try again."
  - Without `gh`: "gh isn't installed on <host>, so only public repositories can be cloned there. Install gh and sign in once on that host, then try again."
  - The last two also show a mono `gh auth login` field with a copy button.
  - The daemon's own words for the failure follow in small mono text, and **Retry** looks the repository up again.
  (addProject.test.ts › dialog messages › "says who cannot see a repository, and asks to sign in when gh is not")
- [x] Ages read "just now" (under a minute), "<n>m ago", "<n>h ago", "yesterday" (24–47 hours), "<n>d ago" (under 14 days), "<n>w ago" (under 8 weeks), else the date as "12 Mar 2026". Sizes come from `diskUsage` in KB: "<1 MB" under 1024 KB, "<n> MB" rounded under 1024 MB, else "<n.n> GB". (addProject.test.ts › pushedAgo › "reads minutes, hours, yesterday, days and weeks, then the date"; diskSize › "reads KB as MB, or GB from 1024 MB")

### Your repositories

- [x] When Repository is empty or holds text that does not read as a repository, and `gh` is signed in on the host, a list headed "Your repositories" shows the user's repositories whose `owner/repo` contains the text (case-insensitive). "from gh · <owners>" on the right of the header names the owners in the list. The list holds up to 6 rows, most recently pushed first. (addProject.test.ts › matchingRepos › "keeps those whose owner/repo holds the text, in any case, up to 6", "names the owners in the list"; cloneTabState › "lists the user's repositories for text that is not a repository, only with gh signed in"; add-project-clone.e2e.ts › "clones a repository picked from the user's list and opens the composer for it")
- [x] The list comes from `gh api "user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100"`. gh's status and the list are fetched once per dialog and host (`repo.gh_status`, `repo.list`). (`lists_the_users_repositories_and_marks_those_already_added`)
- [x] Each row shows the owner's initial on a tile, `owner/` muted with the name in bold, a lock icon when private, the description, and the age on the right (the highlighted row shows ↵ instead). A repository already added as a project on that host is dimmed, reads "Already added" in a pill and cannot be picked. A project is that repository when its `origin` remote points at it. (`lists_the_users_repositories_and_marks_those_already_added`, `reads_the_repository_of_a_github_remote`, `looks_repositories_up_and_lists_them_through_gh`)
- [x] Clicking a row, or Enter on the highlighted row (↑/↓ move it, wrapping around), puts `owner/repo` into Repository. The row is then looked up as above. (addProject.test.ts › moveHighlight › "moves with the arrow keys and wraps around"; add-project-clone.e2e.ts › "clones a repository picked from the user's list and opens the composer for it")
- [x] Under the list: "Not listed? Type owner/repo or paste any URL you can access." (add-project-clone.e2e.ts › "clones a repository picked from the user's list and opens the composer for it")
- [x] With `gh` not signed in, no list shows, and text that does not read as a repository shows only the hint. (addProject.test.ts › cloneTabState › "lists the user's repositories for text that is not a repository, only with gh signed in")

### Where it is cloned

- [x] **Clone into** has two fields: the parent folder, then `/`, then the folder name. The name starts as the repository's name. For This Mac, **Browse…** picks the parent folder. For a remote host, Browse… is absent and the hint reads "A path on <host>. No Browse… for remote hosts." (addProject.test.ts › repository and folder strings › "explains Clone into for This Mac and for a remote host"; add-project-clone.e2e.ts › "clones a repository picked from the user's list and opens the composer for it"; Browse… *manual*)
- [x] The parent folder starts as the last parent used for a clone on that host. The first time on a host it is `~/moonlet`. Under the fields: "The parent folder is remembered for the next clone." (addProject.test.ts › cloneParent › "starts at ~/moonlet, then remembers the last parent of each host"; add-project-clone.e2e.ts › "sends a URL typed as a folder to the clone tab, which sees the folder is taken")
- [x] The dialog checks the target on the host (`repo.clone_target`) when the repository, parent or name changes. A parent that is not a full path, or a name that is empty, `.`, `..` or holds `/`, shows the daemon's reason in red under the fields ("Clone into needs a full path, like ~/moonlet"). When the target exists, the name field gets an amber border and an amber box shows "<parent>/<name> already exists" with a shield icon, in place of the hint.
  - When it is a clone of the same repository: "It's already a clone of <owner/repo>, on <branch>. Add that folder as the project, or pick another name to clone fresh." Two buttons follow: **Add existing folder**, which adds it as a project without cloning, and "Use <name>-2".
  - Otherwise: "It isn't a clone of <owner/repo>. Pick another name to clone fresh." with only "Use <name>-2".
  - "<name>-2" is the first of `<name>-2`, `<name>-3`, … that does not exist (for `storefront-2` it is `storefront-2-2`). **Clone and add** is disabled while the target exists.
  (`refuses_a_folder_that_is_not_one_name_under_a_full_path`, `tells_a_free_folder_a_clone_of_the_repository_and_another_folder_apart`; addProject.test.ts › dialog messages › "offers the existing clone or a free name when the folder is taken"; cloneTabState › "can clone a found repository into a free folder, once"; add-project-clone.e2e.ts › "sends a URL typed as a folder to the clone tab, which sees the folder is taken")
- [x] A missing parent folder is created by the clone. (`a_clone_from_github_becomes_a_project_and_reports_its_progress`)

### Cloning

- [x] **Clone and add** (Enter in Repository or the name) starts the clone on the chosen host (`repo.clone`) under an id the app chooses, so it follows the clone's events even before the daemon answers. It is disabled until the repository is found and the target is free. The daemon answers at once. Then:
  - With `gh` signed in and no SSH address typed, it runs `gh repo clone <owner/repo> <dest> -- --progress`, so private repositories clone with gh's sign-in.
  - With an SSH address, it runs `git clone --progress <ssh address> <dest>`.
  - Otherwise it runs `git clone --progress https://github.com/<owner/repo>.git <dest>`.
  - Git never prompts (`GIT_TERMINAL_PROMPT=0`).
  (`clones_with_gh_when_signed_in_else_with_git`, `a_clone_from_github_becomes_a_project_and_reports_its_progress`)
- [x] While it runs, the daemon sends `repo.clone_progress` events built from git's progress output (separated by `\r` as well as newlines). Each event carries the step (`counting`, `receiving` or `resolving`), its counts, and for receiving the size and speed git prints. `counting` is the remote's "Counting objects"; its enumerating and compressing are not reported. (`reads_the_steps_of_git_clone_progress`, `a_clone_from_github_becomes_a_project_and_reports_its_progress`)
- [x] The progress card shows three steps: "Counting objects <total>", "Receiving objects <done>/<total> · <size> · <speed>" and "Resolving deltas <done>/<total>". Each has a check when done, a spinner while running, and is muted before it starts. A fourth line "Then: open the new session composer" follows them. Numbers use thousands separators. The percentage is 10% of counting, 80% of receiving and 10% of resolving, rounded down. Overall it reads 0% before git reports anything and 100% when done. (addProject.test.ts › clone progress › "reads nothing yet as three waiting steps at 0%", "checks a finished step, spins the running one, with git's counts, size and speed", "counts a step git skipped as done once a later one starts"; add-project-clone.e2e.ts › "shows git's progress while it clones, and Cancel clone leaves no folder")
- [x] While it runs, the repository card and Section are hidden, and Repository and Clone into are dimmed and read-only, as in the design. The footer reads "Closing keeps the clone running in the background." with **Cancel clone** and a disabled "Cloning…" with a spinner. (add-project-clone.e2e.ts › "shows git's progress while it clones, and Cancel clone leaves no folder")
- [x] When the clone succeeds, the daemon adds the folder as a project, in the chosen section when there is one (as `section.add_project`), and sends `repo.clone_done` with the project. The parent folder is remembered for that host. Each app window shows a toast "Added <name>". If the dialog is still showing that clone, it becomes the new session composer for the project, as the Local folder tab does. (`a_clone_from_github_becomes_a_project_and_reports_its_progress`; addProject.test.ts › clone runs › "adds the project: a toast, the parent remembered, the composer when the dialog watched"; add-project-clone.e2e.ts › "clones a repository picked from the user's list and opens the composer for it")
- [x] When the folder cloned but cannot be added as a project, the folder stays and `repo.clone_done` carries "cloned into <dest>, but adding it as a project failed: <reason>". (*manual*)
- [x] When the dialog was closed during the clone, the clone goes on. Its end shows the toast, or an error toast, and nothing opens. (addProject.test.ts › clone runs › "adds the project: a toast, the parent remembered, the composer when the dialog watched", "keeps a failure for the dialog that watches it, else says it in a toast")
- [x] When the clone fails, the daemon removes the folder the clone created and sends `repo.clone_done` with git's last `fatal:` line (or its last line) as the error. The dialog shows it in a red box under the form and turns back to editable; editing the form or closing the dialog forgets it. (`a_failed_clone_says_why_and_leaves_no_folder`, `says_why_a_clone_failed_in_gits_words`; addProject.test.ts › clone runs › "keeps a failure for the dialog that watches it, else says it in a toast")
- [x] **Cancel clone** (`repo.clone_cancel`) stops git and every process it started, removes the folder the clone created, and sends `repo.clone_done` with `cancelled`. Once git is done and the folder is being added, the clone can no longer be cancelled ("the clone <id> is done and is being added"). The dialog turns back to editable, and no toast shows. (`a_cancelled_clone_stops_and_leaves_no_folder`; addProject.test.ts › clone runs › "forgets a cancelled clone quietly"; add-project-clone.e2e.ts › "shows git's progress while it clones, and Cancel clone leaves no folder")
- [x] One host runs any number of clones at once. A second clone into the same target is refused with "<dest> is being cloned already". (`a_cancelled_clone_stops_and_leaves_no_folder`)

### gh status

- [x] The dialog's footer, in the Clone from GitHub tab and while not cloning, shows `gh` on the chosen host (`repo.gh_status`, from `gh auth status --hostname github.com`):
  - "gh signed in on <host>" with a green check.
  - "gh not signed in on <host>" with a grey dot.
  - "gh is not installed on <host>" with a grey dot.
  - "<host>'s moonletd is too old to clone from GitHub. Update moonlet there." when the host's daemon predates X59; nothing is looked up then.
  (`reads_the_signed_in_login_from_gh_auth_status`; addProject.test.ts › dialog messages › "tells whether gh is signed in, signed out or missing on the host"; add-project-clone.e2e.ts › "clones a repository picked from the user's list and opens the composer for it")

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
| `repo.clone` | `{ id, repo, ssh?, parent, name, section_id? }`; `id` is the app's, letters, digits and `-` | `{ id, repo, path }` at once |
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
- e2e `add-project-clone.e2e.ts`: pick a repository from the list with the keyboard, clone it with a fake `gh` and land in the new session composer; paste a URL into Folder and follow the nudge to a taken folder; watch a slow fake clone's progress and cancel it.
- Manual, in the app: the "Looking up…" card shows while a lookup waits; Browse… beside Clone into picks a parent folder; a folder that cannot be added as a project after cloning stays on disk with the error; a remote host clones into a path on that host.

## Open questions

- None.
