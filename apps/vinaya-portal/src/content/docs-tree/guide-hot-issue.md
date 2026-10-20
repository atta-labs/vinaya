# Deploy hot issue now — guide

Summary: For a fix that must land now, or when the loop itself is broken: you and one agent edit the branch live, with every gate still running.
Parent: Guides
Badges: Hot issue · Principal

## Before you start

- You are the Principal. Hot mode is yours to enter.
- The change is urgent and small: one objective, a few files.

## The flow

```flow-diagram
hot
```

## Steps

```steps
### Open a hot Issue
Write a light Issue marked hot: one objective, the files, and the facts you read. You do the readiness check yourself, and it is recorded in the Issue. No Planner.

### Work with one agent, live
Pair with one agent in any chat surface. There is no loop and no rounds: you drive, the agent edits.

### Commit and push
Commit and push as usual. Ring 0 runs on your machine; the pull request runs Ring 1. The gates are the same as for any task.

### Ask for review when you want it
Review runs once, on demand: the same two reviewers judge the pull request against the hot Issue's objective. A push after that voids their verdicts and review runs again.

### Merge
Merge when the gates are green. The Issue closes on merge, with the record kept beside the work.
```

```callout-warning
Hot mode is planned. The commands `vinaya hot start --issue <n>` and `vinaya hot review --issue <n>` are part of its design.
```

## What you get

- One pull request, merged by you, through the same gates as everything else.
- The same Log: every gate run and review is recorded.

## What's next

```cards
- [Hot mode](/docs/process/executing/hot-mode) The full definition
- [Gates](/docs/process/gates) What runs on every commit and pull request
```

## The whole process

Every flow on one diagram, from product work to merge and back.

```whole-diagram
```
