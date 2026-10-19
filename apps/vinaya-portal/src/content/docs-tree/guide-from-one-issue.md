# Deploy backlog issues — guide

Summary: Turn a single fix you found while working into one backlog Issue, run it through the loop, and merge it.
Parent: Guides
Badges: Simple task · Planner

## Before you start

- Vinaya is installed in the repository.
- You have one small change in mind: a fix, a chore, a small feature, with no sibling task to plan against.

```callout-tip
Try it first in the interactive demo: [Simple task](/vinaya-process/demo/simple).
```

## The flow

```flow-diagram
backlog
```

## Steps

```steps
### Write the backlog Issue
In your agent, run `/vinaya planner` and describe what you found. The Planner reads the code and writes one backlog Issue: the evidence pasted, every fact about code as a checked fact, one or two objectives, the files it may touch and how to prove it. No tranche.

### Run it
Run the Issue through the loop with `vinaya task run --issue <n>`, or let the Operator start it.

### Merge
When the pull request is ready, merge it. The Issue closes on merge.
```

```callout-note
If the fix turns out to need ordering against other work, cut it into a tranche instead. See [Deploy medium work](/docs/process/guides/from-a-tranche).
```

## What you get

- One reviewed pull request, one closed Issue. No tranche, no milestone.

## What's next

```cards
- [Issue kinds](/docs/process/thinking/issue-kinds) Planned, backlog and hot Issues
- [Deploy hot issue now](/docs/process/guides/hot-issue) When it cannot wait for the loop
```

## The whole process

Every flow on one diagram, from product work to merge and back.

```whole-diagram
```
