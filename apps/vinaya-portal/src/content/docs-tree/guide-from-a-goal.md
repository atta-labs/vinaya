# Deploy complex work — guide

Summary: Ship a product outcome that spans several features: one milestone, several tranches, many tasks, built in parallel and merged by you.
Parent: Guides
Badges: Complex work · Architect · Planner · Operator

## Before you start

- Vinaya is installed in the repository. See [Get started](/docs/start/get-started).
- The product work is specified upstream, for example as projects in Linear or epics in Jira.
- You are the Principal: you approve the plan, rule when a run pauses for you, and merge.

```callout-tip
Try it first in the interactive demo: [Complex work](/vinaya-process/demo/complex).
```

## The flow

```flow-diagram
feature
```

## Steps

```steps
### Turn the product work into a milestone
In your agent (Claude Code or Codex), run `/vinaya architect`. Describe the outcome and the projects behind it. The Architect declares one Goal as a GitHub Milestone and names its tranches. You decide the parts together.

### Plan every task
Run `/vinaya planner` and ask it to plan every part of the milestone. The Planner reads the real code first, then writes each task as a GitHub Issue with its objectives, Surface, checked facts and test plan, and declares dependencies and conflicts. You approve the plan before anything is written. Every Issue passes the [Issue checks](/docs/process/gates/ring1-issue-checks) as it is written.

### Run the tasks
Run `/vinaya operator`. The Operator starts each ready task through the loop: a Developer works in a sandbox, the gates run at commit, push and on the pull request, and two fresh reviewers judge the result. Independent tasks run in parallel; dependent ones wait. See [The loop](/docs/process/executing/the-loop).

### Answer when a run pauses for you
A run that needs a decision pauses and says who must act. Infrastructure problems retry by themselves, and the Operator repairs the environment. A policy or scope question is yours: answer it with `vinaya pr rule`. See [Pauses and rulings](/docs/process/executing/pauses-and-rulings).

### Merge
Each pull request ends ready for merge, with every gate green and both reviews current. You merge. Nobody else does.
```

## What you get

- One reviewed pull request per task, each landed on its parent branch.
- Each task closed on merge, each tranche closed when its last task lands, and the milestone closed when its tranches have. See [Retrospecting](/docs/process/retrospecting).
- Every act in the [Log](/docs/features/log), live in [Studio](/docs/features/studio).

## What's next

```cards
- [Deploy medium work](/docs/process/guides/from-a-tranche) One feature, no milestone
- [Thinking](/docs/process/thinking) How work is shaped before execution
- [Executing](/docs/process/executing) The loop, batches and the Operator
- [Roles](/docs/process/roles) Who does what
```

## The whole process

Every flow on one diagram, from product work to merge and back.

```whole-diagram
```
