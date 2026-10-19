# Glossary — reference

Summary: Plain definitions for the words the Vinaya docs use in a specific sense. Each entry stands on its own.
Parent: Reference

## Terms

**Architect** — The role that turns product work into a Goal: it declares a GitHub Milestone and names the tranches that serve it. See [Goals and milestones](/docs/process/thinking/goals-and-milestones).

**Archivist** — The role that closes a task after its pull request merges, recording what shipped and why. See [Task close](/docs/process/retrospecting/task-close).

**Backlog Issue** — A stand-alone fix with no sibling to plan against: a short body, every fact about code as a checked fact, one or two objectives. Planned by a Planner, without a tranche. See [Issue kinds](/docs/process/thinking/issue-kinds).

**Brief** — The complete work order for one task, written before anyone codes it: objectives, checked facts, Surface, required sources, parent branch and test plan. Despite the name, it is not short.

**Change** — The exact proposed code revision: base, head and patch. One of the six elements every process defines. See [Process contract](/docs/dev-process/process-contract).

**Checked fact** — A statement about code written as an excerpt the parent branch must contain, so the harness can check it. A sentence about code that is not a checked fact is rejected when the Issue is written.

**Decision** — The controller's outcome for a round: revise, pause, fail, cancel, exhaust, or ready for merge.

**Dev Process** — The contract any development process fulfils to run on the harness and get the Log. It runs across the features; it is not one. The Vinaya process is its default implementation. See [Dev Process](/docs/dev-process/overview).

**Dispatch** — Handing a work order to whoever will execute it, an agent or a person, so the work starts. A task is dispatchable once its prerequisites hold.

**Evidence** — Checks run on an exact Change and their results: tests, CI, mechanical gates, source-delivery receipts.

**Execution** — Work performed by an actor against an Intent: a Developer turn, a review, a planning pass.

**Forge** — The Git hosting platform (GitHub, here), treated as the source of truth for a task's state. No status is written anywhere else.

**Frozen brief** — The brief as it was when the task was dispatched, its facts re-checked and pinned. It is never edited; a change becomes a new Intent version with a reason.

**Gate** — A check that refuses an action until a condition holds. It never relies on someone remembering a rule. See [Gates](/docs/process/gates).

**Generic gate** — One of the twelve questions every process must answer, such as "is the evidence current?". Seventeen of Vinaya's checks implement them. See [Process contract](/docs/dev-process/process-contract).

**Goal** — A product outcome and the tranches that serve it. It lives as a GitHub Milestone, and it is optional.

**Hot Issue** — An Issue for a change that must land now, written by the Principal at entry with a light body. Worked on in hot mode. See [Hot mode](/docs/process/executing/hot-mode).

**Improver** — The harness agent that reads the Log across runs and proposes changes to the process. It is not a process role. See [Self-improvement](/docs/features/self-improvement).

**Integration branch** — A branch that is the parent of several Issues, used to test their work together before it merges into its own parent.

**Intent** — What is to be achieved, with its constraints, scope and acceptance conditions. In Vinaya, the frozen brief plus its objective and ruling versions.

**Log** — The record of every governed act, one typed event each, delivered live to a folder or server and never to GitHub. See [Log](/docs/features/log).

**Operator** — The role that runs work: it starts, watches, resumes and cancels tasks, and repairs the environment. It never plans, codes, rules, approves or merges. See [The Operator](/docs/process/executing/the-operator).

**Parent branch** — The branch an Issue's work forks from and merges back into. Every Issue has one; the default is `main`.

**Pause** — A run stopping and naming who must act: the controller itself for a transient wait, the Operator for infrastructure, the Planner for a missing source, the Principal for a decision. See [Pauses and rulings](/docs/process/executing/pauses-and-rulings).

**Planner** — The role that reads the code first, cuts work into tasks, and writes each as an Issue with its facts, scope and relations.

**Principal** — The person accountable for what merges. Approves the plan, rules on pauses, enters hot mode and merges.

**Provenance** — A durable record, left on a merged pull request, that the work was reviewed and closed out, not just merged.

**Review** — An assessment of an exact Change against an exact Intent and the review policy. Vinaya runs two, Code and Security, each fresh.

**Ring** — Where and when a gate runs: Ring 0 on your machine, Ring 1 on the pull request, Ring 2 after merge.

**Round** — One pass of the loop: the Developer works, the gates run, the reviewers judge, the controller decides.

**Ruling** — The Principal's answer to a pause. It becomes a new Intent version, so earlier evidence and reviews go stale.

**Run** — One task driven from its frozen brief to an outcome, under a pinned process and policy version.

**Surface** — The files and paths a task declares it may change. Paths beyond it are recorded and judged by the reviewers; protected paths are refused.

**Task** — One GitHub Issue: one frozen brief, one branch, at most one pull request, one parent branch.

**Telemetry** — The feature that counts the Log's record: cost, time, review strictness, which checks catch most. `vinaya sync` reads stored events into a local cache that its questions read. See [Telemetry](/docs/features/telemetry).

**Tranche** — A named set of related tasks with declared dependencies and conflicts, planned and tracked together. Finished when every task in it has merged.

**Tranche Archivist** — The role that closes a tranche when its last task is done.

**Worktree** — A separate, isolated copy of the repository's files on its own branch, so one task's edits never collide with another's.

## Derived statuses

A task's status is never stored. It is read from the forge each time: the Issue, its branch, its pull request, the review decision and the blocked label.

| Status | Means |
| --- | --- |
| `backlog` | Deliberately left out of every tranche (`vinaya/backlog` label); never derived inside a tranche |
| `todo` | Issue open, no task branch yet |
| `in-flight` | Its task branch exists; no pull request yet |
| `in-review` | A pull request is open |
| `changes-requested` | The pull request's review decision is changes requested |
| `merged` | The pull request merged; the only way a task is done |
| `blocked` | Carries the `vinaya/blocked` label; wins over every other status |
| `dropped` | Closed as not planned, with no merge |
| `incoherent` | Closed as completed with no merged pull request; needs a person to look |
