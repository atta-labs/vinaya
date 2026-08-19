## Task Issue — Planner rationale

**Boundary** — Restyle the shared `packages/ui/Button.tsx` component used by every consuming app.

**Sizing** — One task; a component edit plus its test.

**Project(s) + blast radius** — vinaya; touches `packages/ui/Button.tsx`.

**Dependency rationale** — Depends-on: none.

**Traps** — None known.

**Suggested agent-class** — Sonnet, low judgment (style-only change).

**Stop-and-escalate** — Halt if the component is consumed outside this repo's own apps.

**Docs to keep coherent** — §7: `apps/cli/README.md`'s command reference row.
