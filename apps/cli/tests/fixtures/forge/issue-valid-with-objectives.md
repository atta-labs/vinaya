## Objectives

O1. The validated forge-write commands ship.

## Task Issue — Planner rationale

**Boundary** — Ship the validated forge-write commands; nothing beyond the CLI surface.

**Sizing** — One task; a shared helper plus two command files and their tests.

**Project(s) + blast radius** — vinaya; touches `@attalabs/vinaya-sources` (registry), re-verified.

**Dependency rationale** — Depends-on: 3 (the check runner + CheckError contract).

**Traps** — Adapt the aeg-core bins' semantics, never import them; do not hardcode the brief template.

**Suggested agent-class** — Opus, high judgment (contract/schema design).

**Stop-and-escalate** — Halt if the adopter-generic config cannot express a required validation.

**Docs to keep coherent** — §7: `apps/cli/README.md`'s command reference row.
