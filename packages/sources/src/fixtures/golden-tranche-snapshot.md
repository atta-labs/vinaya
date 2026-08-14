# Tranche: golden-snapshot-example — a fixture, not a real tranche

**Lifecycle:** complete

Goal (fixture, not product-why): exercise `parseTranche` against a
real-shaped tranche file — the topology table, per-task rationale blocks, and
a backlog section — without depending on any external repo's history.

## Tasks (topology)

| # | Task | Issue | Project(s) | Depends-on | Conflicts-with |
|---|------|-------|------------|------------|-----------------|
| 1 | Scaffold the fixture package | #1 | example | — | — |
| 2 | Wire the fixture into the golden test | #2 | example | 1 | — |

### Task 1 — Scaffold the fixture package

**Boundary** — create the package skeleton the fixture exercises.

### Task 2 — Wire the fixture into the golden test

**Boundary** — consume task 1's package from the golden comparison test.

## Backlog

- A follow-up fixture covering the `## Backlog` bullet edge cases
