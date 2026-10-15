# Where a change's spec lives

moonlet tracks work as specs, not issues. Each feature has `docs/specs/<id>-<slug>.md` (`X44-task-trackers.md`), and commits and PR titles name the ids they touch in parentheses: `feat(desktop): … (X44, X46)`.

To find the spec for a range of commits:

1. Collect the ids: `git log <base>..HEAD --format=%s | grep -oE '\b[A-Z][0-9]+\b' | sort -u`.
2. Read each `docs/specs/<id>-*.md`. `git diff <base>...HEAD -- docs/specs` shows the lines this change adds or edits; those are the requirements it claims.
3. A PR number in a subject (`(#188)`) leads to its description: `gh pr view <n>`. Pull request descriptions summarise the change and list its tests; GitHub Issues are not used for planning.

Acceptance lines end with the tests that prove them, in parentheses. A requirement is met when its cited test exists and checks the claim.
