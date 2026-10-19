# Vinaya Development Harness — overview

Summary: The enforcement plane for agent-run software delivery. You hand it a planned task. It runs a coding agent, has other agents review the result, and refuses at the merge anything that breaks a rule. A person merges.
Parent: Vinaya Development Harness
Badges: Five features · Dev Process · One CLI · The Vinaya process

## What Vinaya is

Vinaya is two things in one product.

- **The features** are what every team gets and configures, whatever way it works: the Log, Telemetry, Studio, self-improvement and the configuration file.
- **Dev Process** runs across them: the contract any development process fulfils to run on the harness and get the Log.

**The Vinaya process** is the default implementation of that contract, installed by default: how work is thought through, executed and closed with agents, and the gates it runs.

## How it works

```steps
### Install it
One command, `vinaya init`, puts the harness into your repository: its git hooks, its CI workflow and a starter `vinaya.config.json`.

### Plan the work
The Vinaya process turns product work into tasks, each with a frozen brief that says exactly what to build.

### Agents build and review
A coding agent builds each task; fresh agents review it; every gate runs on the exact change.

### A person merges
Nothing merges until the gates pass and the Principal merges it. Every governed act lands in the Log.
```

## The two docs

```cards
- [The Vinaya harness](/docs/start) What Vinaya is, how to install it, the five features, the Dev Process contract and every command you run
- [The Vinaya process](/docs/process) Integration, Thinking, Executing, Retrospecting, Gates, Roles and Guides
```

## The features

```cards
- [Log](/docs/features/log) Every governed act, delivered live
- [Telemetry](/docs/features/telemetry) The record, counted
- [Studio](/docs/features/studio) Mission Control and the dashboard
- [Self-improvement](/docs/features/self-improvement) The Improver proposes; the Principal approves
- [Configuration](/docs/features/configuration) One file sets it all up
```

The [Dev Process](/docs/dev-process/overview) is not a feature: it is the contract that runs across them.

## What's next

```cards
- [Get started](/docs/start/get-started) Install, upgrade, check, remove
- [CLI](/docs/start/cli) Every command you run
- [Quick start](/start/quick) From an empty repository to your first gated pull request
```
