# 0012. Harness and processes sit at the repository root

**Status:** Accepted

**Date:** 2026-10-21

## Context

The developer-review loop is moving onto Atta Engine. What runs it splits into two kinds of code: generic machinery that any process needs (a process contract and loader, tools, adapters for agents, the code host, the tracker and the log destination, gates, isolation, effects, the log, telemetry, the studio, configuration, evaluations and a command line), and the content that makes one process what it is (its roles, its Flows, its gates, its extensions and its evaluations). Vinaya is the first process; others are meant to follow on the same harness.

Today's code lives in `apps/` and `packages/`, where the two kinds are mixed. A process that imports harness internals and a harness that imports a process look the same to a reader, so the dependency direction cannot be seen or checked from the folder tree.

## Decision

We will put the generic machinery in one `harness/` package and give each process one folder under `processes/`, both at the repository root with no wrapper folder around them. `harness/` never imports from `processes/`, by relative path or by package scope; an architecture test in the harness package enforces it. The existing `apps/` and `packages/` stay untouched until each piece is retired, so nothing moves before its replacement runs.

## Considered options

- Keep everything in `apps/` and `packages/`. Nothing moves, but the harness and the process stay entangled and the rule that the harness knows no process has no place to live.
- Nest both under one wrapper folder. This groups them, but adds a level every path carries and says nothing the two folder names do not.
- Move the existing code into the new folders first. This reaches the final shape sooner, but every move breaks consumers before the replacement is demonstrated.
- Create the empty final-shape tree now and fill it piece by piece. This is the chosen option: the direction of dependency is checked from the first day, and each piece moves only when it is ready.

## Consequences

A reader sees from the folder tree which code is generic and which belongs to a process, and a test refuses the one import that would blur it. For a time the repository holds two homes for the same kind of code, the old one and the new one, and each piece must be retired from the old home on purpose. Every new process adds one folder and one package, not a change to the harness.

## Where it is applied

`harness/` is the package `@attalabs/harness` and `processes/vinaya/` is the package `@attalabs/process-vinaya`; both are private and listed in the root `package.json` workspaces. `harness/tests/architecture.test.ts` fails when a file under `harness/` imports from `processes/`. The root `README.md` layout tree shows both folders.
