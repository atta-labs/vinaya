# 0013. Engine migration first, no baseline run

**Status:** Accepted

**Date:** 2026-10-21

## Context

An earlier record required a named, maintained evaluation for every component before it moved to Atta Engine, with both backends running the same suites. Satisfying it meant running a baseline of the current developer-review loop first, and building the evaluation program around that baseline. That work delayed the migration itself and tied the new backend's evaluation to measurements of a driver that is being retired.

On 2026-10-21 the Principal decided to change the order.

## Decision

We will migrate the developer-review loop to Atta Engine first, without a baseline run of the current loop. The migrated loop is evaluated on the Engine after migration, against the maintained evaluations written for it there.

## Considered options

- Keep the earlier order: baseline the current loop, then migrate module by module behind evaluations. It gives a before-and-after comparison, but it spends the effort on a backend that is being retired and delays the move.
- Migrate first and evaluate on the Engine afterwards. This is the chosen option: the effort goes to the backend that will remain.
- Migrate with no evaluation at all. It is the fastest route, but there would be no evidence of how the migrated loop behaves on real tasks.

## Consequences

The migration starts sooner and the evaluation effort goes to the backend that stays. There is no measured baseline of the old loop, so a regression from the old behaviour cannot be shown by comparison and is judged against the Engine's own evaluations instead.

## Where it is applied

`apps/cli/specs/dev-review-evaluation-program.md` describes the evaluation program. The decision is upheld by review: no check refuses a migration for lacking a baseline run.
