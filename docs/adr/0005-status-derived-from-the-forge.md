# 0005. Status derived from the forge

**Status:** Accepted

**Date:** 2026-08-14

## Context

Several agents and humans work on the same plan at once, and each needs to know which tasks are active, blocked or done. The forge already records the facts that answer this: whether an Issue exists, whether its branch exists, whether a pull request is open, and whether it merged.

A status written down separately, in a file, an Issue field or a label, has to be updated by whoever changes the underlying state. An earlier approach kept a session-start protocol and a pinned, hand-maintained state Issue for each project; its queries named labels that did not exist, and the one live instance drifted stale and was closed.

## Decision

We will derive all live execution status from the forge's Issue, branch, pull-request, review and merge state, and never store it. A task is a forge Issue. There is no status field and no status label; labels carry only tier, blocked and input-needed markers. No file in the repository records progress.

Anything that cannot be derived, such as a pending manual operation, is an ordinary open Issue that is closed when resolved.

## Considered options

- A status file in the repository. It is easy to read, but every change of state needs a commit, and the file drifts from the forge whenever someone forgets.
- A pinned state Issue per project, edited by hand. This is the option that was tried and retired: its queries drifted from the labels that existed, and it went stale.
- Status labels on each task Issue. Labels are queryable, but they still have to be set by hand and can contradict the pull request they describe.
- Status derived from forge state. This is the chosen option. It cannot drift, because there is nothing separate to update.

## Consequences

Every role answers "what is the state" with the same forge queries and gets the same answer. A status that looks wrong points to a real forge state that is wrong, never to a stale copy.

Reading status needs forge access and costs forge queries, which a sandboxed agent cannot always make itself. Commands that report status have to compute it each time rather than read a stored value, and roles must refuse to write a status anywhere even when it would be convenient.

## Where it is applied

`aeg-root/skills/aeg/SKILL.md` states the rule and lists the session-start forge queries. `vinaya check` derives task status from the forge, and `vinaya task status` (`apps/cli/src/commands/task-status.ts`) reports a task's state from its Issue, branch and pull request. `AGENTS.md` tells every adopter that live task status is never written into a file.
