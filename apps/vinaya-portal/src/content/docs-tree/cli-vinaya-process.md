# Vinaya process commands — reference

Summary: The three agent commands the Vinaya process adds, which you run inside Claude Code or Codex.
Parent: CLI
Badges: Reference · Principal · Slash commands

## About these commands

The Vinaya process adds a few commands on top of the [harness commands](/docs/start/cli). These are the ones you, the Principal, run. The Operator and the agents call others as they work; those are not listed.

## In your agent

Three commands start the agent roles. Run them inside Claude Code or Codex.

| Command | What it starts |
| --- | --- |
| `/vinaya architect` | The Architect: turns product work into one milestone. You decide the parts together. |
| `/vinaya planner` | The Planner: writes every task as an Issue an agent can run. You approve the plan. |
| `/vinaya operator` | The Operator: dispatches the agents, runs the gates, and stops when it needs you. |

See [Working with it](/docs/process/working-with-it) for when to run each.

`vinaya studio` and `vinaya pr rule` are harness commands; see [Harness commands](/docs/start/cli).

## What's next

```cards
- [Working with it](/docs/process/working-with-it) How you use these day to day
- [Pauses and rulings](/docs/process/executing/pauses-and-rulings) When `vinaya pr rule` is needed
- [Studio](/docs/features/studio) What `vinaya studio` shows
```
