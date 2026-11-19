# @attalabs/test-selection

Which tests a change between two committed revisions requires — read from the
revisions alone, through the TypeScript compiler's own module graph, a
validated inventory of every test and every non-import input, and, when the
caller has one, a record of what each test actually read.

The package knows no hook, CI job, forge or process. Its library touches git,
the file system or the network only through the reader its caller passes. The
exceptions are the installed commands, which find the repository they are started
in through `git`, and the read recorder, which runs and traces its tests. The
exported search `findReadRecord`, and the `test-selection` command given
`--fetch-record`, start `gh` and so reach GitHub; nothing else in the library
does.

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

The one entry point. Given the same input it returns the same plan, and the
library itself reads nothing but what `input.repo` serves for `input.base` and
`input.head`. The one exception is a callback the caller passes: when
`history.branchSide` is given, `selectTests` may call its `base()` to get the
comparison commit for the branch's own changes, and that callback does
whatever work the caller wrote into it (this repository's builds a commit in
git). Pass no `branchSide` and nothing outside the reader runs.

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

plannedTests(plan) // every test to run: required, fallback scopes, obligations and whole-suite runs, less the branch-side tests left to the default branch and what an earlier pass covers
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

<!-- VINAYA:CLAIM: packages/test-selection/src/lockfile-identity.ts contains:return bunLockIdentity(JSON.parse(json + text.slice(start))) -->
<!-- VINAYA:CLAIM: packages/test-selection/src/lockfile-identity.ts contains:throw new Error('bun.lock is not an object') -->
[`readBunLockIdentity(text)`](src/lockfile-identity.ts) reads the text of a `bun.lock` in Node or Bun and
returns its dependency identity with local paths normalized. It accepts
trailing commas and throws on malformed text or a non-object value.

### Inventory and record types

- `InventoryView` — one revision's validated inventory: its suites, tests,
  declared input edges, unknown scopes and policies. `validateInventory` and
  `validateInventoryView` check one; `inventoryViewOf(revision, files,
  declarations)` builds a simple one from a file map.
- `ReadRecord` / `RecordedTest` — what each test read when it ran on one
  commit (`isReadRecord` checks one); `SelectionRecords` hands a record and its
  platform to `selectTests`. A `RecordedTest` holds `reads` (the files and
  folders its process tree opened or probed), `listed` (every folder listed,
  by the test's code or by the module resolver alike) and, in a record taken
  with a listing probe, `scanned`: the folders the test's own code listed, an
  entry ending in `/` listed recursively (`./` for the root). `isReadRecord`
  accepts `schemaVersion` 1 and 2 and refuses any other. A version-2 entry may
  also hold `opens` (per read, how many times the test's own process, its
  threads included, opened it successfully; a read absent from it was never
  opened by that process, only probed or opened by a child), `childOpens` (the
  reads a child process opened) and, for a Bun run, `coverage`: per
  repository-relative source file Bun's coverage listed, `instrumented` (every
  line it instrumented) and `executed` (the instrumented lines the test ran),
  each as inclusive `[first, last]` ranges (`FileCoverage`, `LineSpan`). An
  `executed` range may span uninstrumented lines, so a line ran when it is in
  both. A file listed with no executed line was loaded but not run; `{}` is a
  run that covered no source file; no `coverage` (a Vitest run, a version-1
  record) means unknown. Opens are counted per file: a read that stands for
  many files (`bun.lock#zod`, a package's source folder for a read under its
  `dist/`) carries the count of its most-opened file. The loader opens a module
  once per process, so an `opens` count above 1 means one file was read as
  data. A version-1 record, and a version-2 entry lacking any of these facts,
  selects as it always did.

<!-- VINAYA:CLAIM: packages/test-selection/src/selector.ts contains:const lockParser = policyLockParser ?? (basename(change.path) === 'bun.lock' ? readBunLockIdentity : undefined) -->
<!-- VINAYA:CLAIM: packages/test-selection/src/selector.ts contains:names === null ? [anyDependencyRead(change.path)] -->
With a read record, [`selectTests`](src/selector.ts) compares a modified `bun.lock` package by
package by default. It selects the recorded readers of changed packages and
of the lockfile itself. A `bun-lock` parser in `SelectionPolicy.parsers`
replaces the built-in reader. Adding or deleting a lockfile, unreadable
text, a missing or invalid `packages` object, or changes to fields outside
`packages` and `workspaces` select every recorded package reader. Without
a caller parser, changes to `bun.lockb`, `package-lock.json`,
`pnpm-lock.yaml` or `yarn.lock` also select every recorded package reader.

On the record path a test whose reads include a changed file is left out, with
a reason in the plan, in two independent ways; neither applies to the test file
itself, to an added, deleted or renamed path, or to a file read only through a
folder.

- *Unreached names* — only the exported names the test's imports never reach
  changed (`unreached-names`).
- *Unentered bodies* (`unentered-bodies`) — the safe rule. Every changed file
  the test opened must pass every condition, and any fact the record lacks
  keeps the test. The file: it is a modified, non-test `.ts` file, both texts
  parse, and `classifyHunks` calls every hunk body-only or an inert addition
  (type-only imports, no exported additions), the code outside function bodies
  being otherwise byte-identical. The test: its coverage holds the file (it
  loaded it); its own process opened it exactly once and no child process
  opened it; and for every changed function, whose own body lines are those
  between the line that opens the body (the binding line, run at load) and the
  one that closes it, less the lines of nested functions, at least one is
  instrumented and none was executed, nor the closing line. A function with no
  own line counts as entered. Reach is decided by coverage and opens only,
  never by matching changed names, and the rule applies only when the caller's
  platform is the record's, because coverage is control flow and may differ by
  platform.

`SelectionPolicy.fileLevel` (`realSandbox`, `outsideCall`) lists tests the
second rule never leaves out: a listed test, or a test whose record read a
listed helper, always runs when a file it read changes. Both lists are part of
the policy's identity hash.

On the record path a changed path reaches a recorded test through its reads
(`recordReach`). An added or deleted path also reaches it through a listed
folder: in a record without `scanned`, any listed folder holding the path. With
`scanned`, the rule applies at the nearest listed folder above the path — its
own folder, or the nearest listed one above and the first name below it — and
keeps the test only when that folder (or a folder above it listed recursively)
is among `scanned`, when the test read a name there sharing a dot-delimited stem
with the path's name (`mod.tsx` or `mod/` beside a read `mod.ts`, since the
resolver decides from its cached listing), or when the name is one the loader
reads by convention (`package.json`, `tsconfig.json`, `jsconfig.json`,
`bunfig.toml`, a `.env` name). The reason names which. Past an unlisted folder
the walk also needs a folder that changed: the selection gives each added or
deleted path, between the base and the head and between the record's commit
and the base alike, the shallowest folder on it absent from the other side
(the earlier revision for an added path, the later one for a deleted one),
read once from the two revisions' file lists. The walk goes on as above only
when there is such a folder: below the listed folder it reached, that folder
itself, or one above it, so deleting the whole tree a test listed still
reaches the test. A file added inside folders that exist on both sides, such
as a new `.changeset/` entry, leaves that listing as it was and reaches no test
through it; a new top-level folder still reaches a test that listed the root.
A path change without that fact walks as before. `passKeys` keeps
covering every listed folder: `scanned` narrows the selection, never pass reuse.
- `PassEntry` / `SelectionHistory` — earlier complete passes, each under the
  key that proves it still holds, and the tests that failed; `selectTests`
  leaves a test that a matching pass covers out of `plannedTests`.
- `SelectionPolicy` — the caller's rules as data: the graph depth, scanner and
  spawned-program declarations, obligations, the suites whose whole change
  runs the whole suite, and the `fileLevel` lists of tests the safe rule keeps.

### `workspaceInventory(repo, revision): WorkspaceInventory`

One commit's inventory view, built from the repository's own manifests, for a
repository with no inventory program of its own. Run from the top folder of a
git repository with at least one commit, as an ES module (`node inventory.mjs`):

```js
import { execFileSync } from 'node:child_process'
import { gitRepository, workspaceInventory } from '@attalabs/test-selection'

const root = process.cwd()
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const { view, leftOut } = workspaceInventory(gitRepository(root), commit)
console.log(view.suites.map((suite) => suite.id), leftOut)
```

It reads every file through `repo`, for exactly `revision`, and nothing else.
It reads the root manifest's `workspaces` field (an array, or the `packages`
array of the object form), followed by entries from the root
`pnpm-workspace.yaml` that the manifest did not list. The YAML file's top-level
`packages` list can use block entries (indented or flush left) or a bracketed
list on the same line. Entries can be plain, single-quoted, or double-quoted.
A doubled single quote inside a single-quoted entry represents one quote.
Escape sequences, anchors, aliases, tags, and flow mappings are outside the
supported subset. Blank lines and comments can appear within a block list,
and a hash within a quoted entry is part of that entry. The block list ends
at the first line outside that subset, including a block scalar indicator
(`|` or `>`), mapping item, or nested sequence.
A segment `*` matches one folder name, a `!` prefix removes matching folders,
and a `**` segment expands to no folders. Members need a named manifest.

- A suite for each member whose `test` script starts `bun test` or Vitest,
  with that runner, and one for the root package on the same rule from its
  own `test` script. A repository with no workspace members gives the
  root suite alone. A suite's id is its package's `name` (`root` for an
  unnamed root).
- Every test-named file (`*.test.*` or `*.spec.*`) is a test of the suite
  whose folder is the deepest one that holds it. A left-out package's tests
  therefore belong to the root suite when there is one.
- `leftOut.packages` lists each package with no suite, with its folder, its
  `name`, its `test` script and the reason: `no-test-script` or
  `other-runner`.
- `leftOut.tests` lists each test-named file under no suite's folder.

The view's `schemaIdentity` is `workspace-inventory@1`
(`WORKSPACE_INVENTORY_SCHEMA`). It declares no input edge, unknown scope or
policy, so only imports link a test to a file.

### `classifyHunks(input): FileHunkClasses`

Classifies each hunk of a change to one TypeScript file by its structure. It
reads only its input, decides no selection, and changes nothing `selectTests`
does: a caller combines its answer with what each test ran.

```ts
import { classifyHunks, loadTypeScript } from '@attalabs/test-selection'

const result = classifyHunks({
  path: 'src/total.ts',
  status: 'modified', // 'modified' | 'added' | 'deleted' | 'renamed'
  before, // the file's text before the change, or null
  after, // its text after, or null
  ts: loadTypeScript(root) // the TypeScript API, or null
})
result.classified // true only when every hunk is body-only or an inert addition
result.hunks // one class per hunk of lineDiffRanges(before, after), in order
```

Each hunk carries its line range on both sides (`lineDiffRanges`' shape) and
one of three classes:

- `body-only` — the hunk lies strictly inside one function's block body on
  both sides (never on the line of its signature, its opening brace or its
  closing brace), and that function's signature text (parameters, defaults,
  return type, modifiers, decorators) and every enclosing class, namespace,
  function and declaration header are unchanged. It names the innermost such
  function (`Store.path`, `<anonymous>` for an unnamed one) and gives, on each
  side, its whole span, its body span and the spans of the functions written
  directly in it, so a caller can map line coverage onto the function's own
  lines.
- `inert-addition` — the hunk replaces only blank lines with whole top-level
  statements (and their leading comments and blank lines), each of them inert:
  not exported, and either an `import type`, a type alias or interface, a
  function declaration, a class with no heritage clause, computed member key,
  static member, static block or decorator, or a `const` whose initializers are
  function or arrow expressions or primitive literals (a plain string, a
  number, a boolean, `null`). No added name may appear as an identifier
  anywhere in the old text, since it would redeclare a name or shadow one the
  unchanged code reads. It lists the added `names` and each added type-only
  import's specifier (`importSpecifiers`). A hunk that only adds or removes
  blank lines between tokens is an inert addition binding no names.
- `unclassified` — anything else, with a `reason`. A caller treats it as
  reaching every reader of the file.

One unclassified hunk makes the whole file unclassified, and every other hunk
is then reported `unclassified` too (`other-hunk-unclassified`). The whole
file is unclassified when its status is not `modified`, its path does not end
in `.ts` (a `.tsx`, `.mts` or `.d.ts` file included), it is a test file
(`*.test.ts`, `*.spec.ts`), `ts` is `null`, or either text has a syntax error
or one of the load-time errors the compiler's checks see on the file alone (a
grammar error such as an `await` outside an async function, a redeclared
name, a name used before its declaration). Equal texts give no hunks and a
classified file.

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
- `records.leftOut` — every test a record left out although it read a changed
  file, with one entry per such file naming its `rule` and why, so a reviewer
  sees why it did not run;
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

## The `test-selection` command

The package installs one command. It selects the tests a change between two
commits requires and prints the plan as one JSON document on standard output:

```sh
npm install --save-dev @attalabs/test-selection
npx test-selection --base origin/main --head HEAD
```

Started in any folder of a git repository, it selects for that whole
repository. It resolves both arguments to commit ids first, builds each
commit's view with `workspaceInventory`, and calls `selectTests`. It then
groups the planned tests with `groupNativeTests`. It starts no test. It writes
no file, except that with `--fetch-record` it keeps record files under the git
directory (below). It reads no file but the two its optional flags name, and no
environment variable of its own; git's own settings still apply.

```sh
npx test-selection --base <commit> --head <commit> [--record <file> | --fetch-record] [--config <file>]
npx test-selection --help
```

- `--record <file>` — a read record (`ReadRecord`, checked with
  `isReadRecord`), passed to `selectTests` as its `records` with
  `process.platform` as the platform. A test with a valid record is decided by
  what it read; every other test, and every test when the record's commit
  cannot be compared with the base, by static selection.
- `--fetch-record` — finds a read record itself and passes it as `--record`
  would. Given together with `--record` it is refused (exit 2). It needs the
  GitHub CLI `gh` on the `PATH`, a login or a `GH_TOKEN`, and, inside a
  workflow, the `actions: read` permission. It walks the base commit and the
  nine before it on its first-parent line, nearest first, and stops at the first
  that gives a record. A commit whose record is kept is served without
  starting `gh`; otherwise `gh` (started in the repository root, without any
  `GIT_` variable, with a limit of 20 seconds a call) names the default branch,
  once a run, then lists the runs of `test-selection-record.yml` that a push
  to the default branch started for the commit, and downloads from the first
  that holds it the artifact `read-record-<commit>`. A record is used only when
  `isReadRecord` accepts it and it names that very commit. A fetched record
  that is used is kept as `<commit>.json` in `test-selection/read-records`
  under the repository's common git directory, which every worktree shares; a
  later run uses it with no call. Nothing is written in the working tree. The
  search reads no environment variable by name; it hands its own environment,
  less the `GIT_` variables, to `gh`, which reads its login from it.
  One line goes to standard error: `test-selection: record: <commit> kept` or
  `fetched`, or `test-selection: no record: <reason>`. The plan on standard
  output is the same either way.
  The search never fails the command: with no record it selects as it does
  with no record flag and exits 0. The cases that end with no record are: no
  `gh` (it cannot be started); a `gh` that fails when asked for the default
  branch or a commit's runs (no login, no `actions: read`, no network) — after
  which `gh` is started no more and only kept records are used; a commit with
  no run; a run with no such artifact (expired, never uploaded, or a download
  that fails or runs out of time); and a file that is not a read record of
  that commit.
- `--config <file>` — a consumer config: a JSON document stating the rest of
  what a selection takes.

With neither flag it calls `selectTests` with `policy: { depth: 'transitive' }`
and declares nothing: no input edge, no folder-scanning test, no spawned
program and no policy. A test that reads a file it does not import is then
required only through a fallback scope or its own imports.

### The consumer config

Every key is optional; an unknown key, or a value of the wrong shape, is
refused naming the key:

```json
{
  "depth": "transitive",
  "inputs": [{ "path": "packages/app/data/table.json", "readers": ["packages/app/tests/a.test.ts"] }],
  "scanners": [{ "test": "packages/app/tests/files.test.ts", "roots": ["packages/app/src/"], "trigger": "tree-shape" }],
  "spawnPrograms": [{ "binary": "node", "entrypoint": "scripts/build.mjs" }],
  "dataFolders": ["fixtures", "data"],
  "alwaysRun": [{ "id": "smoke", "reason": "runs on every change", "tests": ["packages/lib/tests/*.test.ts"] }],
  "wholeSuites": [{ "suite": "app", "reason": "its tests read the whole package" }]
}
```

- `depth` — the import walk's depth, `one` or `transitive` (`transitive` when
  absent).
- `inputs` — files a test reads without importing them, each with its
  readers: test paths, repository-relative; a `path` ending in `/` is a folder
  and covers every file beneath it. Each becomes an input edge of kind
  `fixture`, reader kind `raw-bytes` and source `config:<index>` in both
  commits' views, which keep only the readers that commit holds: a change that
  adds a test together with its input, or deletes a test still named, still
  selects.
- `scanners` — folder-scanning tests (`ScannerDeclaration`): the test, the
  roots it reads, and its trigger (`tree-shape`, `process-start`,
  `listed-files` or `content`).
- `spawnPrograms` — programs whose start by a test is followed into the
  entrypoint's imports (`SpawnProgram`).
- `dataFolders` — folder names whose files are data, not code (`fixtures`
  when absent).
- `alwaysRun` — always-run obligations: an `id`, a `reason`, and `tests`
  (globs), `suites`, or both. Each is a `SelectionObligation` of kind
  `policy`.
- `wholeSuites` — suites that run whole when the change touches a path under
  their folder (`WholeSuitePolicy`).

A suite id in `alwaysRun` or `wholeSuites` is one the workspace inventory
gives: the package's `name` (`root` for an unnamed root package), or
`name@dir` when two packages share a name. The plan document keeps its shape,
so an obligation or a whole-suite policy shows as the tests it adds to
`tests`.

To try it, write the example above as `selection.json` (with your own paths)
and run, from a git repository with two commits:

```sh
npx test-selection --base HEAD~1 --head HEAD --config selection.json
```

### In a pull request's CI

The record comes from a recording job on the default branch, documented with
the package's record command (see "The `test-selection-record` command"
below); that job keeps each record as an artifact named for its commit. A
pull-request job passes `--fetch-record`, which downloads the record of the
base commit, or of the nearest earlier one that has one; with no record found
it selects without one. It takes only a run of the recording workflow that a
push to the default branch started, so a record from another branch or event
never narrows the selection:

```yaml
name: tests
on: pull_request
permissions:
  actions: read
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the record's commit must be in history, or every test falls back to static selection
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: Select
        env:
          GH_TOKEN: ${{ github.token }}
          BASE: ${{ github.event.pull_request.base.sha }}
          HEAD: ${{ github.event.pull_request.head.sha }}
        run: npx test-selection --base "$BASE" --head "$HEAD" --fetch-record --config selection.json > plan.json
```

It exits 0 when it prints a plan, including when it prints a warning. After
writing the plan to standard output, it writes one `test-selection: warning:`
line to standard error if the head inventory left out any package with an
unsupported test runner or any test-named file under no suite. The line gives
both counts. Packages without a `test` script do not count toward the warning.
With `--help` or `-h` anywhere in the
arguments, it prints help on standard output and exits 0, even outside a git
repository. A missing argument, a folder outside a git
repository, an argument that names no commit, a `--record` file that is
missing or not a read record, `--fetch-record` together with `--record`, or a
`--config` file that is missing or not a valid consumer config prints one message on standard error and exits 2; any
other failure exits 1.

The document:

```json
{
  "schema": "test-selection-command",
  "schemaVersion": 1,
  "base": "<commit id>",
  "head": "<commit id>",
  "tests": ["packages/app/tests/greet.test.ts"],
  "groups": [
    {
      "id": "app@default",
      "runner": "bun",
      "cwd": "packages/app",
      "args": ["./tests/greet.test.ts"],
      "exclude": [],
      "tests": ["packages/app/tests/greet.test.ts"]
    }
  ],
  "ungrouped": [],
  "problems": [],
  "fallbacks": [],
  "leftOut": { "packages": [], "tests": [] }
}
```

- `tests` — `plannedTests(plan)`, less the plan's `removedTests`;
- `groups` — one runner start each: start `runner` in `cwd` (relative to the
  repository root) with `args`, and tell it to leave out `exclude`;
- `ungrouped` — planned tests the head view has no identity for;
- `problems` — what `groupNativeTests` refused;
- `fallbacks` — the plan's fallback scopes, whose tests are already in
  `tests`;
- `leftOut` — names each package the head commit's inventory left out, with
  its reason, and lists the path of each test-named file under no suite.

## The `test-selection-record` command

The package installs a second command. It records what each test file reads
and writes the read record `selectTests` takes as `records`. It runs on Linux
only, with `strace` installed, since it traces every test at the syscall:

```sh
sudo apt-get install -y strace
npx test-selection-record --out read-record
```

Started in any folder of a git repository, it builds the commit's inventory
with `workspaceInventory`, as the `test-selection` command does, and runs each
test file in its own process under
`strace -f -yy -qq -s 4096 -e trace=%file,getdents64,chdir,fchdir,clone,clone3,fork,vfork`,
child processes included: `bun test <file>` or `vitest run <file>` in its
suite's folder, with the installed Vitest found through each
`node_modules/.bin` from that folder up. Each Bun run also preloads the
listing probe (`src/listing-probe.ts`, copied outside the repository first),
so the record can tell a folder the test's own code listed from one the module
resolver listed, and writes Bun's line coverage
(`--coverage --coverage-reporter=lcov --coverage-dir=<scratch folder>`), which
the record keeps per source file. The trace takes no `status=successful`
filter, which would drop the failed lookups the record keeps; an open counts
as successful when its printed result, on a `<... resumed>` line too, is a
descriptor. Each process keeps its own working folder (`chdir`, `fchdir`),
shared by its threads. A file whose run does not exit 0 gets no record, so its
selection stays static, and the recorder logs the end of what that run printed
right after the file's failure line: it reads the run's standard output and
standard error as they come, keeps only the newest 40 lines, and cuts those to
their newest 4,000 characters. A file that passes logs no output, and the
output is never written into the record. A read under installed dependencies is recorded as the
repository's lockfile joined to the package's name (`bun.lock#zod`), so
selection can match individual package changes in `bun.lock` by default.

Flags:

- `--out <dir>` — the folder the record is written to (required);
- `--commit <rev>` — the commit the record names; default `HEAD`;
- `--concurrency <n>` — test files traced at once; default 3;
- `--shard <i>/<n>` — record only the i-th of n disjoint slices of the sorted
  test list, and write `shard.json` beside the partial record, naming the
  slice and every test it attempted;
- `--merge <dir>` — merge the shard outputs (each a folder holding
  `shard.json` and `read-record.json`) directly under `<dir>` into the record
  an unsharded run would have written; it refuses a missing, doubled or
  overlapping shard, and shards that do not attempt every test of the commit;
- `--only <test,test>` — record only these test files;
- `--expect <test>=<path>` — fail unless the test's record reaches `path`;
- `--summary <file>` — append a Markdown summary, such as
  `$GITHUB_STEP_SUMMARY`;
- `--help` or `-h` — print help on standard output when present anywhere in
  the arguments, on any platform and without requiring git or `strace`.

It writes `<out>/read-record.json`, one JSON document:

```json
{
  "schema": "vinaya.read-record",
  "schemaVersion": 2,
  "commit": "<commit id>",
  "platform": "linux",
  "tests": {
    "packages/app/tests/greet.test.ts": {
      "reads": ["bun.lock#zod", "packages/app/src/greet.ts", "packages/app/tests/greet.test.ts"],
      "listed": ["packages/app/tests"],
      "scanned": [],
      "opens": { "bun.lock#zod": 1, "packages/app/src/greet.ts": 1, "packages/app/tests/greet.test.ts": 1 },
      "childOpens": [],
      "coverage": {
        "packages/app/src/greet.ts": { "instrumented": [[1, 3], [6, 8]], "executed": [[1, 3]] }
      }
    }
  }
}
```

A test entry may also hold `fallback` (`git-read`, with the `gitReaders` that
read repository content under `.git/`, or `truncated-path`) and
`branchesOnPlatform`. A merge refuses shards whose records are of different
versions. It exits 0 when it writes a record or prints help; 2 for a missing
`--out`, a malformed `--shard`, a host that is not Linux or a missing
`strace`, each with one message on standard error; 1 when a merge is refused
or an `--expect` read is missing.

Use [`test-selection-setup`](#the-test-selection-setup-command) to generate
the GitHub Actions workflow that records every push to the default branch.

A selection for a change then downloads the artifact of its base commit and
passes the parsed record to `selectTests`, or the file to the `test-selection`
command with `--record`. The command's `--fetch-record` does the download
itself, and `findReadRecord(repoRoot, base)` is the same search from code. It
finds only a recording workflow whose file is `test-selection-record.yml` in
the `.github/workflows` folder and whose artifact is named
`read-record-<commit>` (`RECORD_WORKFLOW_FILE`, `RECORD_ARTIFACT_PREFIX`),
holding `read-record.json`; a recording job of another file or artifact name
is not found.

From code, `recordReads` records the same way and returns the record; a
caller with its own inventory, runner launch, run-outcome check, time limit or
dependency input passes them (`RecorderSetup`), and `recordCommand` is the
command itself with those injected.

## The `test-selection-setup` command

Run `npx test-selection-setup` from any folder in your git repository. It
writes `.github/workflows/test-selection-record.yml` at the repository root.
Commit the generated workflow so GitHub Actions can run it on pushes to
the chosen branch. Setup uses local git and files and starts no tests.

- `--branch <name>` chooses the branch to record. By default the command
  reads the local `origin/HEAD` ref and asks for the flag if the ref is missing.
- `--package-manager <bun|npm|pnpm|yarn>` chooses how the workflow installs
  dependencies and starts the recorder. By default the command looks for
  `bun.lock` or `bun.lockb`, `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`
  at the repository root. Pass the flag if no lockfile exists or the
  lockfiles belong to more than one package manager.
- `--help` or `-h` prints usage and flags on standard output.

The command exits `0` and prints the repository-relative path when it writes
the file. A byte-for-byte match prints that the file is unchanged and also
exits `0`, as does help. A refusal exits `2` with one message on standard
error. If the file already has different content, setup leaves it intact.
Setup refuses symbolic links at `.github`, `.github/workflows`, or the
workflow file itself.
To take the workflow from a later package version, delete the file and
run setup again.

For Bun and the branch `main`, setup writes:

```yaml
on:
  push:
    branches: ['main']
permissions:
  contents: read
jobs:
  record-reads:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: sudo apt-get install -y strace
      - run: npx test-selection-record --out "$RUNNER_TEMP/read-record" --summary "$GITHUB_STEP_SUMMARY"
      - uses: actions/upload-artifact@v4
        with:
          name: read-record-${{ github.sha }}
          path: ${{ runner.temp }}/read-record/read-record.json
          retention-days: 60
```

| Package manager | Install steps | Recorder invocation |
|---|---|---|
| npm | `npm ci` | `npx test-selection-record` |
| pnpm | `corepack enable`, then `pnpm install --frozen-lockfile` | `pnpm exec test-selection-record` |
| Yarn | `corepack enable`, then `yarn install --immutable` with `.yarnrc.yml` at the repository root or `yarn install --frozen-lockfile` otherwise | `yarn run test-selection-record` |

The npm, pnpm and Yarn variants are verified by their generated text until
a repository runs them in GitHub Actions.

## Files

| File | Holds |
|---|---|
| `src/index.ts` | the public entrypoint |
| `src/types.ts` | the public types |
| `src/inventory.ts` | inventory validation, and which readers a changed input reaches |
| `src/memory-inventory.ts` | an inventory view built from a file map and a small declaration |
| `src/workspace-inventory.ts` | an inventory view built from one commit's package manifests |
| `src/cli.ts` | the `test-selection` command, never imported by the entrypoint |
| `src/consumer-config.ts` | the command's consumer config: its validation, and its declared inputs as edges |
| `src/record-fetch.ts` | the search for a read record: kept copies, and `gh` for a commit's recording run |
| `src/record-command.ts` | the `test-selection-record` command, never imported by the entrypoint |
| `src/setup-command.ts` | the `test-selection-setup` command, never imported by the entrypoint |
| `src/recorder.ts` | the read recorder: traced runs, the record entry each builds, shards and their merge |
| `src/listing-probe.ts` | the listing probe a recorded Bun run preloads, never imported by the entrypoint |
| `src/listing-probe-paths.ts` | the probe's log variable and path helpers |
| `src/lockfile-identity.ts` | the text `bun.lock` reader and dependency identity comparison |
| `src/selector.ts` | trees, repository readers, the graph walk and `selectTests` |
| `src/recorded-reads.ts` | read records, and what a record decides for a change |
| `src/pass-entries.ts` | earlier complete passes, their keys, and which planned tests they cover |
| `src/native.ts` | native test groups, and the check of what each runner executed |
| `src/compiler-graph.ts` | the compiler-resolved import graph and its read-only source seam |
| `src/changed-names.ts` | changed-name attribution and the line diff |
| `src/hunk-classes.ts` | each hunk of a TypeScript file's change classed body-only, inert addition or unclassified |
| `src/scanner-inputs.ts` | tests that read the tree, and their declared triggers |
| `src/spawn-inputs.ts` | tests that start a program, and the scripts a test starts with `<binary> <script>` |
| `src/path-pattern.ts` | the two glob grammars |
| `tests/` | the package's tests and their committed fixture repositories |

## Dependencies

- Node.js standard library: `node:child_process`, `node:crypto`, `node:fs`, `node:module`, `node:os`, `node:path`, `node:readline`, `node:url`, `node:util`, `node:worker_threads`
- Bun, only inside a recorded Bun run: the listing probe wraps `Bun`'s own functions and `bun:ffi` there
- `typescript` — an optional peer, loaded at runtime through `createRequire` and imported only as types; without it the selection falls back to its text-scan graph, and `classifyHunks`, which takes the API as its `ts` input, reports every hunk unclassified
- `git` — the executable, only for `gitRepository` and the two commands
- `gh` — the GitHub CLI, only for `findReadRecord` and the `test-selection` command given `--fetch-record`
- `strace` — the executable, only for the read recorder, on Linux

The tests also use `bun:test` (`bun test`). Outside the recorder's own runs (the probe reads `VINAYA_LISTING_PROBE_LOG`), no preload, global, configuration
file or environment variable is read by name; the record search hands its own environment, less the `GIT_` variables, to `gh`, which reads its login from it.

`tests/isolation.test.ts` fails if anything in the package imports from outside
its folder or names a module `package.json` does not declare, and if anything
outside it imports past the package name. `tests/consumer.test.ts` packs the
package, installs the tarball into a fresh repository and runs a selection
there — this README's example included — and runs the `test-selection`
command under Node in a fresh repository of one Bun package and one Vitest
package, then with a read record and a consumer config in another, and runs
the `test-selection-record` command and a direct `bun --preload` of the
shipped probe.
## License

`LICENSE` beside this file is the license the package is distributed under.
