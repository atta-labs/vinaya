# 0006. Resume by re-execution

**Status:** Accepted

**Date:** 2026-09-12

## Context

The review loop is a long-running driver process that runs one task from brief to reviewed pull request. It can pause and wait for a Principal ruling, sometimes for hours. While it waits, fixes to the loop's own code can merge into the default branch. A paused driver that simply resumes keeps running the old code, and would judge the next round against rules the new code has already changed.

The task branch is also published through a governed path that pushes fast-forward only and records the base the branch was built on. Rewriting the branch's history, by rebasing it, resetting it or force-pushing it, would make that publication path refuse it, and would discard the record the reviewers judged.

## Decision

We will resume a paused loop by re-executing it on the current default branch, never by rewriting history. Before a driver resumes for a new ruling, and whenever the default branch has moved over the driver's own code, it pulls the default branch fast-forward only and starts a fresh process of itself that continues the same task, so the new process runs the new code and consumes the ruling once.

When a ruling asks a task branch to take the default branch's changes, it asks the Developer to merge the default branch into the task branch, never to rebase it. The driver never force-pushes.

## Considered options

- Resume in the same process. This is the simplest, but the process keeps running the code it was started with, even after a fix to that code has merged.
- Stop and hand the stale driver to a human. A paused state for staleness alone was used first; it turned an automatic situation into a manual one. It is now kept only for when the re-execution itself fails.
- Rebase or reset the task branch onto the new default branch. This gives a linear history, but the fast-forward-only publication refuses it, and a rewritten branch no longer matches what was reviewed.
- Re-execute on the new default branch and merge, never rewrite. This is the chosen option.

## Consequences

A ruling takes effect with the newest loop code, without anyone restarting the run. A ruling never has to describe a git operation that rewrites history, and the published branch only ever moves forward.

Task branches carry merge commits from the default branch. The driver must hand its lock to the new process before starting it, and must carry its round, active time and repeat-detection state across the process boundary, because the new process starts with nothing in memory.

## Where it is applied

`apps/cli/specs/loop.md` describes the stale-driver re-execution (`checkStaleDriver`), the watching driver's re-execution before it resumes for a ruling (`watchPauseThenResume`), and the publication base that only moves forward. `aeg-root/roles/principal.md` states that a ruling on default-branch drift asks for a merge, never a rebase. `apps/cli/src/lib/dev-review-loop.ts` publishes with a push that never forces.
