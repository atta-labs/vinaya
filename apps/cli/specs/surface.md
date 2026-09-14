# Surface — the public function index

Status: draft

One command is one function, published and tested. `apps/cli/tests/surface-index.test.ts` enforces the layering rule directly against the real source tree — the real router, the real command entry functions, the real call graph — with no hand-maintained table as its input. `apps/cli/tests/surface-spec-exports.test.ts` enforces that a command's declared exemption target, once it names a real `apps/cli/src/lib/**` export, still names a function. Neither test reads a row-level index from this file. This file states the rule and the mechanism; the tests are the source of truth for whether any given command complies.

## The rule

A command is a function with argument parsing in front. Commands never call commands. One capability is one function.

A change that adds or removes no exported function/const/class (a new field on an already-exported type, a new CLI flag on an already-listed command, a behavioral change inside an already-exported function) needs no documentation update anywhere — this file included — under this rule.

Three layers:

- **Policy** — `@attalabs/aeg-core`. Pure functions: no filesystem, no network, no process. Unrestricted for a command to call.
- **Effects** — `apps/cli/src/lib`. The chokepoints that touch the world: git, the filesystem, the forge, a child process. A future consolidated set (`log`, `flushLog`, `forgeWrite`, `forgeRead`, `runChecks`, `collectTokens`, `dispatchRole`, `devReviewLoop`, `runTask` — Tech Spec "A Task Finishes Itself" §2–§3) does not fully exist yet; today's `apps/cli/src/lib` is a wider micro-library commands compose directly.
- **Commands** — `apps/cli/src/commands`. One file per command (or per closely-related command family sharing a file, e.g. `milestone.ts`). Each command's entry function, reached from `apps/cli/src/index.ts`'s router, should call exactly one effects-layer function. `apps/cli/src/index.ts` itself is the router, not a command, and is exempt by construction.

**Predicate the test enforces (per Principal ruling on Issue #418):** for a command's entry function, collect every call expression (transitively through same-file helpers) whose callee resolves to an export of `apps/cli/src/lib/**` or of another `apps/cli/src/commands/*.ts` file. A call into `apps/cli/src/lib` beyond the one named function is a violation. A call into another `commands/*.ts` file is refused outright — commands never call commands — with zero allowance beyond the same dated-exemption mechanism (no separate carve-out). `printJson`, `promptYesNo`/`closeStdin`, and `packageRoot` count toward the cap like any other call — no allowlist (see Open note below). Calls into `@attalabs/aeg-core` are unrestricted (policy is meant to be composed freely).

**Open note (Principal ruling, 2026-09-05):** `printJson`, `promptYesNo`/`closeStdin`, and `packageRoot` are called by most commands purely for output/prompt/path-resolution plumbing, not business effect. They are not allowlisted out of the cap — they count like any other call — but the shape that will retire most of today's exemptions for install/scaffolding commands (`doctor`, `doctrine`, `eject`, `init`, `init product`, `quickstart`, `upgrade`, `demo break`, `waiver`) is a **shared command shell** consolidating this plumbing, not one of the named chokepoints above. That shell is a later task, named `sharedCommandShell` in the exemption markers below until it exists.

## Exemptions live in source, not here

A command whose entry function does not yet call exactly one lib chokepoint declares that in its own file — never in a shared spec every unrelated task also has to edit:

```ts
import type { SurfaceExemption } from '../lib/surface-exemption'

export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  'milestone create': { date: '2026-09-05', callsToday: 8, retiresVia: 'forgeWrite' }
}
```

`apps/cli/src/lib/surface-exemption.ts` defines the shape. `callsToday` is a ratchet: `surface-index.test.ts` recomputes the command's real in-scope call count from source on every run and fails if it no longer matches the marker — so a call silently added without updating the marker in the same file is refused, without anyone maintaining a central count. `retiresVia` names the chokepoint (existing or, per the Open note above, still aspirational) that retires the row once the command is rewritten to call it alone. No command is rewritten by declaring or reading this marker — it only records what is already true of the command's source today.

A non-command file colocated under `apps/cli/src/commands/` that isn't wired into the router (e.g. logic a future task moves into `apps/cli/src/lib/`) carries the same marker, keyed by its own filename instead of a command name.

## Why this file carries no export or command listing

`apps/cli/src/commands/**` and `apps/cli/src/lib/**` are the two busiest directories in the CLI. A markdown table listing every export or every command's compliance status made every task touching either directory rewrite the same lines — two branches each adding one unrelated export collided on this file even though neither touched the other's code. The table also drifted: entries here could disagree with each other and with the real source, since nothing but eyeballing kept them aligned. Removing the table doesn't relax the rule — `surface-index.test.ts` and `surface-spec-exports.test.ts` still refuse a command that calls another command, still refuse an uncounted lib call, and still catch a mistyped exemption target — it only moves the input from a document to the source itself, so an ordinary export or command addition touches only the file it's actually about.
