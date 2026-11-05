---
title: Feature specs
description: How moonlet documents its features, and how to tell what has shipped.
group: Reference
order: 4
---

## One spec per feature

Every feature of moonlet has its own spec in [docs/specs](https://github.com/1devstudio/moonlet/blob/main/docs/specs/README.md). The spec is written before the feature is built, and updated whenever the code changes, so it describes what shipped.

A spec's file name is its id and a slug, such as `X53-drag-tasks-between-columns.md`. Newer features take the next free `X<n>` id. The [index](https://github.com/1devstudio/moonlet/blob/main/docs/specs/README.md) lists every spec with its priority, phase and status.

## What a spec holds

Each spec starts from the same [template](https://github.com/1devstudio/moonlet/blob/main/docs/specs/_template.md), with these sections:

| Section | What it says |
|---|---|
| Summary | What the feature is and why it exists |
| User journey | The flow, step by step, from your side of the screen |
| Behaviour and acceptance criteria | Testable statements, one per behaviour |
| UI | Layout, empty, loading and error states, keyboard shortcuts |
| Protocol and RPCs | Daemon methods, frames or CLI commands added or changed |
| Data and config | Files and config keys, such as `.moonlet/config.toml` |
| Security considerations | Inputs that cross a trust boundary, permissions, sanitising |
| Out of scope | What the spec deliberately leaves out |
| Test plan | Unit, integration and manual checks |
| Open questions | What is not settled yet |

Each acceptance criterion maps to at least one test. Most criteria name their tests in brackets after the statement, so you can see what checks it.

## How to read the status

A spec's header has a **Status** line:

- `draft`: being written or built.
- `approved`: agreed, ready to build.
- `implemented`: built and shipped.
- `superseded`: replaced by a later spec, which it names.

A status often adds a note in brackets, such as "implemented (untried between two real Macs)". The note says what has not been checked in real use yet. Read it before you rely on that part.

Inside a spec, the acceptance criteria are checkboxes. A ticked box (`[x]`) is built and tested. An open box (`[ ]`) may still be to come. Some specs also note "Superseded in part by" another spec, for the parts a later feature changed.

## Architecture decision records

Lasting technical decisions, such as a library choice or a protocol change, are recorded as [architecture decision records](https://github.com/1devstudio/moonlet/tree/main/docs/adr) in `docs/adr`. Each one has a Context, a Decision and its Consequences, and many list the options considered. Its status is `proposed`, `accepted` or `superseded`, and specs link the ADRs they build on.

## The plan

[docs/plan.md](https://github.com/1devstudio/moonlet/blob/main/docs/plan.md) holds the technology choices and the implementation status: which requirements are open, and where the build departed from the original plan.

The words specs use, such as workspace, session and board, are defined in the [Glossary](/docs/glossary).

## Propose a change

[CONTRIBUTING.md](https://github.com/1devstudio/moonlet/blob/main/CONTRIBUTING.md) covers how to report a bug, suggest a feature and send a pull request. In short:

- A new feature starts with a spec written from the template and added to the index.
- A change to existing behaviour updates its spec in the same pull request.
- Every change that adds or changes behaviour ships with a test that fails without it.

For anything larger than a small fix, open an issue first, so the approach can be agreed before you write code.
