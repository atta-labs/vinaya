# Deploy medium work — guide

Summary: Ship one feature or a medium project as a single tranche: several tasks in parallel, no milestone above them.
Parent: Guides
Badges: Medium work · Planner · Operator

## Before you start

- Vinaya is installed in the repository. See [Get started](/docs/start/get-started).
- The work is one feature or engineering need, small enough to plan in one go.

## The flow

```flow-diagram
medium
```

## Steps

```steps
### Plan the tranche
In your agent, run `/vinaya planner` and describe the feature. The Planner reads the code, cuts the work into tasks, and writes each as a GitHub Issue carrying the tranche label, with dependencies and conflicts declared. You approve before anything is written.

### Choose where it lands
Every Issue has a parent branch. By default it is `main`. To test the whole feature together first, use an integration branch as the parent of every task in the tranche. See [Parent and integration branches](/docs/process/executing/parent-and-integration-branches).

### Run the tasks
Run `/vinaya operator`. Each task runs through the same loop, in parallel where the plan allows. To run one task yourself, use `vinaya task run <tranche> <n>`.

### Rule and merge
Answer any pause that is yours with `vinaya pr rule`. Merge each pull request when it is ready.
```

## What you get

- One reviewed pull request per task.
- Each task closed on merge, and the tranche closed when its last task lands. There is no milestone to close.

## What's next

```cards
- [Deploy backlog issues](/docs/process/guides/from-one-issue) A single fix, no tranche
- [Tranches and tasks](/docs/process/thinking/tranches-and-tasks) How a tranche is shaped
```

## The whole process

Every flow on one diagram, from product work to merge and back.

```whole-diagram
```
