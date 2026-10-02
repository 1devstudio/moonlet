# ADR 0001: Fold phase 0 spikes into the build

- **Status:** accepted (2026-10-02)

## Context

The plan called for five throwaway spikes before any product code. Several of them (rendering latency, notification click behaviour) need someone at the GUI to measure, which the implementing agent cannot do unattended.

## Decision

Each spike question is answered inside the real code:
- by an automated test where the behaviour is observable from code (terminal replay fidelity, hook latency, daemon persistence), or
- by a recorded design decision plus a manual check in `docs/manual-checks.md` where it needs a human (keystroke latency, WebGL throughput, notification clicks).

## Consequences

There is no throwaway code. Numbers that need a GUI are collected by the user from the manual checklist, and any regression leads to a new ADR.
