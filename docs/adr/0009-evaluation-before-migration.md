# 0009. Evaluation before migration

**Status:** Superseded by [0013](0013-engine-migration-first-no-baseline-run.md)

**Date:** 2026-10-12

## Context

The developer-review loop is moving from its own driver onto Atta Engine. The loop is made of many parts: ports, nodes, roles, tools, gates, transitions, effects, adapters, isolation boundaries and product guarantees. Each behaves in ways that tests written alongside a change do not fully cover, and agent behaviour varies from run to run. A part that compiles and passes its own tests on the new backend can still behave worse on real tasks.

The Engine's own principle is that implemented means demonstrated against a maintained evaluation corpus.

## Decision

We will move no component to Atta Engine without a named, maintained evaluation. Every component that migrates has a recorded evaluation with its required fields before it moves, both backends run the same suites, and a component moves only when its migration gate's evidence is met. The migration happens module by module, never all at once.

## Considered options

- Migrate everything at once and compare the whole loop afterwards. This is the fastest route, but a regression cannot be traced to the part that caused it, and there is no point at which to stop.
- Migrate module by module, relying on each change's own tests. This isolates each move, but tests written by the author agree with the author's assumptions and say nothing about live behaviour on real tasks.
- Migrate module by module behind a named, maintained evaluation per component. This is the chosen option. It is the slowest and requires keeping suites, graders and floors alive over time.

## Consequences

Every migrated component has evidence that it behaves at least as well on the new backend, and a regression points to one module. Migration is slower, the evaluation corpus is a standing maintenance cost, and floors must be fixed before an authoritative evaluation runs rather than tuned to the result.

## Where it is applied

`apps/cli/specs/dev-review-evaluation-program.md` defines the required evaluation fields for each migrating component and the module-by-module migration gate. The decision is upheld by review today: no check yet refuses a component that moves without its evaluation.
