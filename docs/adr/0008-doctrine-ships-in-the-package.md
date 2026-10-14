# 0008. Doctrine ships in the package

**Status:** Accepted

**Date:** 2026-07-26

## Context

Every role reads its doctrine before it works: the front door, the role documents, the contracts, the state machine and the ring gates. Adopting repositories need that doctrine on every machine that runs a role. A copy committed into each adopting repository is easy to find, but it is a second copy of text whose source lives elsewhere, and it starts to differ from the installed version the moment either one changes.

A committed file is also shared by every clone, while the place a package is installed is a property of one machine, so the committed file cannot name that place directly.

## Decision

We will ship the full, canonical doctrine inside the installed `@attalabs/vinaya` package, with no copy inside an adopting repository. A committed entry point names the package, never a filesystem path, and `vinaya doctrine` prints the absolute path of the front door, or of a role's doctrine, on the current machine.

## Considered options

- Copy the doctrine into each adopting repository on install. Readers find it without a command, but the copy drifts from the version the checks were built against, and every upgrade has to rewrite it.
- Publish the doctrine on a website only. There is one copy, but an agent working offline or inside a sandbox cannot reach it, and the published version need not match the installed checks.
- Ship it inside the installed package and resolve its path with a command. This is the chosen option: the doctrine and the checks that enforce it always come from the same version.

## Consequences

Upgrading the package upgrades the doctrine and the checks together, and there is nothing in the adopting repository to keep in sync. Reading the doctrine needs one command to find it, and an agent must run that command rather than open a known path. Changes to the doctrine reach adopters only through a release.

## Where it is applied

`AGENTS.md` names the package and the command that resolves the front door, `aeg-root/skills/aeg/SKILL.md`. `vinaya doctrine` (`apps/cli/src/commands/doctrine.ts`) prints the doctrine's path on the current machine. Keeping a copy out of adopting repositories is upheld by review: no check refuses one.
