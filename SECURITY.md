# Security policy

## Supported versions

moonlet is in early development. Security fixes are made on `main` and shipped in the next release. Only the latest release is supported; installed apps update themselves from **Settings › Updates**.

## Reporting a vulnerability

**Do not report security vulnerabilities in public issues, discussions or pull requests.**

Report them privately through GitHub: open the repository's **Security** tab and click **Report a vulnerability**, or go directly to <https://github.com/1devstudio/moonlet/security/advisories/new>.

Please include:

- the affected version (Settings › Updates) and macOS version;
- a description of the issue and its impact;
- steps to reproduce, or a proof of concept;
- any suggested fix or mitigation.

## What to expect

- We acknowledge a report within **5 business days**.
- We keep you informed while we investigate and fix it, and agree with you on a disclosure date.
- Once a fix is released, we publish a GitHub security advisory and credit you, unless you prefer to stay anonymous.

## Scope

Areas where security matters most:

- the `moonletd` daemon and its Unix socket API, which can start processes and read terminals;
- agent hooks and the `moonlet` CLI;
- installing and running the remote helper on SSH hosts;
- the in-app updater and release signing;
- rendering untrusted content (agent output, Markdown, diffs) in the desktop app.

Vulnerabilities in third-party dependencies are in scope when moonlet's use of them makes the issue exploitable.
