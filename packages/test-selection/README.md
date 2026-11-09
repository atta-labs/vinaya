# @attalabs/test-selection

Which tests a change between two committed revisions requires — read from the
revisions alone, through the TypeScript compiler's own module graph, a
validated inventory of every test and every non-import input, and, when the
caller has one, a record of what each test actually read.

The package knows no hook, CI job, forge or process. It touches git, the file
system or the network only through the reader its caller passes.

## Install

```sh
npm install @attalabs/test-selection
# optional: the compiler-resolved graph; without it the text-scan graph is used
npm install --save-dev typescript
```

Bun loads the TypeScript source (`src/`); Node and every other runtime load the
built `dist/`, with its declarations.

## Example

This runs as it is, as an ES module (`node example.mjs`):

```js
import { inventoryViewOf, memoryRepository, plannedTests, selectTests } from '@attalabs/test-selection'

const base = {
  'package.json': '{ "name": "example" }\n',
  'src/greet.ts': 'export const greet = () => "hi"\n',
  'src/other.ts': 'export const other = 1\n',
  'tests/greet.test.ts': "import { greet } from '../src/greet'\n",
  'tests/other.test.ts': "import { other } from '../src/other'\n"
}
const head = { ...base, 'src/greet.ts': 'export const greet = () => "hello"\n' }
const declarations = {
  suites: [{ id: 'root', dir: '.', runner: 'bun', preload: null }],
  edges: [],
  unknowns: [],
  policies: []
}

const plan = selectTests({
  repo: memoryRepository({ base, head }),
  base: 'base',
  head: 'head',
  inventory: {
    base: inventoryViewOf('base', base, declarations),
    head: inventoryViewOf('head', head, declarations)
  },
  policy: { depth: 'transitive' }
})

console.log(JSON.stringify(plannedTests(plan))) // ["tests/greet.test.ts"]
```

## Public API

### `selectTests(input): SelectionPlan`

The one entry point. Pure: given the same input it returns the same plan, and
it reads nothing but what `input.repo` serves for `input.base` and
`input.head`.

```ts
const plan = selectTests({
  repo, // a RepositoryReader
  base: '3f2c…', // immutable commit ids, never a branch name
  head: '9a1b…',
  inventory: { head: headView, base: baseView }, // validated views, one per revision
  policy: { depth: 'one', scanners, spawnPrograms, obligations, wholeSuites },
  records: { record, platform: 'linux' }, // optional: what each test read on an earlier commit
  history: { context, passes, failures }, // optional: earlier complete passes and failed tests of this branch
  branchSide: { paths, base } // optional: after a default-branch merge, the branch's own changes
})

plannedTests(plan) // every test to run: required, fallback scopes and obligations, less what an earlier pass covers
plan.identity // equal for equal inputs
```

### Readers

`selectTests` reads only through a `RepositoryReader`:

```ts
type RepositoryReader = {
  list(revision: string): readonly string[] // every file path the revision holds
  read(revision: string, path: string): string | null // a file at a revision, or null
  identity?(revision: string, path: string): string | null // a content id, when known without reading
}
```

Two are provided, each built by the caller and passed in:
`gitRepository(root)` reads committed revisions through the `git` executable,
and `memoryRepository({ [revision]: files })` serves in-memory trees. A caller
with its own storage implements the type itself.

### Inventory and record types

- `InventoryView` — one revision's validated inventory: its suites, tests,
  declared input edges, unknown scopes and policies. `validateInventory` and
  `validateInventoryView` check one; `inventoryViewOf(revision, files,
  declarations)` builds a simple one from a file map.
- `ReadRecord` / `RecordedTest` — what each test read when it ran on one
  commit (`isReadRecord` checks one); `SelectionRecords` hands a record and its
  platform to `selectTests`.
- `PassEntry` / `SelectionHistory` — earlier complete passes, each under the
  key that proves it still holds, and the tests that failed; `selectTests`
  leaves a test that a matching pass covers out of `plannedTests`.
- `SelectionPolicy` — the caller's rules as data: the graph depth, scanner and
  spawned-program declarations, obligations, and the suites whose whole change
  runs the whole suite.

## The plan

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

A test that resolves an import through another package is also required when
a non-source file of that package changes — its `package.json`, its
`tsconfig.json`, an asset it ships — since no such file is a graph node. A
non-source file under the package's own `tests`, `test`, `__tests__`, `specs`
or `fixtures` folder does not count: it is the package's test data, required
only by the tests that import it or that the inventory declares as reading it.
Nor does a file named exactly `README.md`, `CHANGELOG.md` or `LICENSE`,
anywhere in the package: it is prose about the package, required only by the
tests that declare it as an input or scan its folder. Every other non-source
file still counts, whatever its extension.

The inventory is the caller's: `validateInventory` checks the shape every
selection relies on, and `selectTests` refuses views built for other
revisions. A repository's own declarations — its folder-scanning tests, the
programs its tests start, its always-run lists — reach the library only as
policy.

## Running what a plan names

```ts
import { groupNativeTests, validateExecutedIdentities } from '@attalabs/test-selection'

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
yields no group. With the optional `maxFilesPerGroup` (a positive integer), a
group over that many files — a whole suite included — is split, after its
problems are decided, into ordered chunks of consecutive sorted files, each
its own runner start with id `<suite>@<configuration>#<k>of<n>`, its own
file arguments and exclusions, and, for a whole suite, its reason; a group at
or under the limit is unchanged.

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
| `src/index.ts` | the public entrypoint |
| `src/types.ts` | the public types |
| `src/inventory.ts` | inventory validation, and which readers a changed input reaches |
| `src/memory-inventory.ts` | an inventory view built from a file map and a small declaration |
| `src/lockfile-identity.ts` | a parsed `bun.lock`'s dependency identity, its path text replaced |
| `src/selector.ts` | trees, repository readers, the graph walk and `selectTests` |
| `src/recorded-reads.ts` | read records, and what a record decides for a change |
| `src/pass-entries.ts` | earlier complete passes, their keys, and which planned tests they cover |
| `src/native.ts` | native test groups, and the check of what each runner executed |
| `src/compiler-graph.ts` | the compiler-resolved import graph and its read-only source seam |
| `src/changed-names.ts` | changed-name attribution and the line diff |
| `src/scanner-inputs.ts` | tests that read the tree, and their declared triggers |
| `src/spawn-inputs.ts` | tests that start a program, and the scripts a test starts with `<binary> <script>` |
| `src/path-pattern.ts` | the two glob grammars |
| `tests/` | the package's tests and their committed fixture repositories |

## Dependencies

- Node.js standard library: `node:child_process`, `node:crypto`, `node:fs`, `node:module`, `node:path`
- `typescript` — an optional peer, loaded at runtime through `createRequire` and imported only as types; without it the selection falls back to its text-scan graph
- `git` — the executable, only for `gitRepository`

The tests also use `bun:test` (`bun test`). No preload, global, configuration
file or environment variable is read.

`tests/isolation.test.ts` fails if anything in the package imports from outside
its folder or names a module `package.json` does not declare, and if anything
outside it imports past the package name. `tests/consumer.test.ts` packs the
package, installs the tarball into a fresh repository and runs a selection
there — this README's example included.

## License

`LICENSE` beside this file is the license the package is distributed under.
