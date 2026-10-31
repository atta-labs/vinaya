# Test selection

Which tests a change between two committed revisions requires — read from the
revisions alone, through the TypeScript compiler's own module graph and a
validated inventory of every test and every non-import input.

This directory is self-contained: copy it anywhere, install its dependencies,
and import `index.ts`. Nothing outside it is imported, at runtime or for types.

## Usage

```ts
import { gitRepository, plannedTests, selectTests } from './verification/index.ts'

const plan = selectTests({
  repo: gitRepository('/path/to/repo'),
  base: '3f2c…', // immutable commit ids, never a branch name
  head: '9a1b…',
  inventory: { head: headView, base: baseView }, // validated views, one per revision
  policy: { depth: 'transitive', scanners, spawnPrograms, obligations }
})

plannedTests(plan) // every test to run: required, fallback scopes and obligations
plan.identity // equal for equal inputs
```

`selectTests` reads every file through the repository reader, for exactly the
two revisions it was given. It never reads a checkout, an index, a branch or a
remote, runs no test and writes nothing. The plan states:

- `changes` — every changed path and what accounted for it (`graph`,
  `input:<edge>`, `scanner:<test>`, `test`, or a `fallback:<scope>`);
- `required` — the tests the change requires, each with its reasons and the
  revision whose graph found them (the base graph keeps an edge the head
  removed);
- `fallbacks` — named scopes over every test, for paths nothing models, inputs
  the inventory marks unknown, unreadable paths, or a base with no valid
  inventory;
- `obligations` — what the caller's policy adds on top, never mixed into
  `required`;
- `policies` — mandatory and security duties the changed inputs engage;
- `removedTests`, `renamedTests`, `configurations` and the `context` that
  reproduces the plan. `profile` holds timings and is not part of `identity`.

The inventory is the caller's: `validateInventory` checks the shape every
selection relies on, and `selectTests` refuses views built for other
revisions. A repository's own declarations — its folder-scanning tests, the
programs its tests start, its always-run lists — reach the library only as
policy.

## Running what a plan names

```ts
import { groupNativeTests, validateExecutedIdentities } from './verification/index.ts'

const { groups, problems } = groupNativeTests({
  tests: required, // explicit TestIdentity values, each with an optional configuration name
  wholeSuites: [{ suite: 'core', reason: 'its tests read the whole tree', identities: coreTests }],
  universe: view.tests // finds a sibling a Vitest file argument would also match
})
// … start each group's runner in its cwd with group.args, leaving out group.exclude …
const check = validateExecutedIdentities(groups, executions, { roots: [repoRoot, realRepoRoot] })
```

`groupNativeTests` groups an explicit set of test identities by suite and
configuration — the unit one runner start serves — and states each group's
runner, working directory, preload, environment and file arguments (Bun's
`./`-prefixed, so a path is never a substring filter). Every identity it is
given stays in a group, repository-owned ones included; a repeat under the same
configuration, a member whose runner facts differ from its group's, or a path
outside the repository or its suite's working directory is a problem. The same
file under two configurations is two groups. A whole-suite request expands to
the identities it lists, and its group runs with no file filter. An empty set
yields no group.

`validateExecutedIdentities` takes, per group, the files the runner's own
report says executed — parsed by the caller — and fails on a missing, extra or
repeated file, a report for an unscheduled group, a group with no report or two,
an interrupted run or an unreadable report. Platform aliases of the repository
root are the caller's to list; a path outside all of them is refused.

Neither selects, places or launches anything, and neither knows a job, a branch
or a record of a past run.

## Files

| File | Holds |
|---|---|
| `index.ts` | the public entrypoint |
| `types.ts` | the public types |
| `inventory.ts` | inventory validation, and which readers a changed input reaches |
| `selector.ts` | trees, repository readers, the graph walk and `selectTests` |
| `native.ts` | native test groups, and the check of what each runner executed |
| `compiler-graph.ts` | the compiler-resolved import graph and its read-only source seam |
| `changed-names.ts` | changed-name attribution and the line diff |
| `scanner-inputs.ts` | tests that read the tree, and their declared triggers |
| `spawn-inputs.ts` | tests that start a program |
| `path-pattern.ts` | the two glob grammars |
| `tests/` | the standalone tests and their committed fixture repositories |

## Dependencies

Runtime and type dependencies outside this directory, and nothing else:

- Node.js standard library: `node:child_process`, `node:crypto`, `node:fs`, `node:module`, `node:path`
- `typescript` — loaded at runtime through `createRequire`, imported only as types; without it the selection falls back to its text-scan graph
- `git` — the executable, only for `gitRepository`

The standalone tests also use:

- `bun:test` — the test runner (`bun test tests/`)

No preload, global, configuration file or environment variable is read.

The grouping and the execution check need no runner installed: they read the
data the caller passes. The fixtures that start real Bun and Vitest runs
against them are this repository's own (`scripts/test-suites/schedule.test.ts`),
not part of the copyable directory, and need `bun` and an installed `vitest`.

## License

`LICENSE` beside this file is the license this directory is distributed
under, the same as the package it ships in.
