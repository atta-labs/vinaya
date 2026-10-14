# 0004. Claude and Codex parity

**Status:** Accepted

**Date:** 2026-10-14

## Context

Vinaya dispatches its roles through more than one coding agent. Claude Code and Codex are the two it can run unattended today. Each has its own configuration files, its own hook mechanism, its own sandbox and its own way of reporting results. Enforcement work is usually written while one agent is in front of the author, and the easiest change is the one that wires a rule into that agent's hooks alone.

A rule enforced for one agent and not the other is not enforced: a run can simply be dispatched through the agent that lacks it. The enforcement model also states that nothing in its contracts assumes a particular coding agent.

## Decision

We will hold Claude Code and Codex to the same enforcement. Every enforcement or harness change covers both agents in the same piece of work, and a dispatch of either agent starts only when that agent's own required controls are active.

## Considered options

- Enforce on one primary agent and treat the other as best effort. This halves the wiring work, but a weaker agent becomes the way around every rule the primary one enforces. The repository names no source that weighed this option; it is the obvious alternative this decision excludes.
- Add the second agent's wiring later, in follow-up work. This ships sooner, but the gap stays open between the two changes, and a follow-up is easy to drop.
- Cover both agents in the same change. This is the chosen option. It costs more per change and requires knowing both agents' mechanisms.

## Consequences

The same task can be dispatched through either agent with the same guarantees, so the choice of agent is a question of capability and cost, never of which rules apply. Planning and review must check every enforcement change against both agents. Adding a third agent means building its controls before it can be dispatched unattended.

## Where it is applied

`apps/cli/src/lib/enforcement-controls.ts` declares a required control per agent (`claude-settings-and-hooks` for Claude Code, `codex-hooks` for Codex), and an unattended dispatch starts no agent unless that agent's controls are active. Beyond that check, parity is upheld by review: no check confirms that a given enforcement change covered both agents.
