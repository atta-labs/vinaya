#!/usr/bin/env bun
/**
 * This repository's adapter to the selection library: one immutable plan of
 * the tests a change between two commits requires, for a local push and for
 * CI alike.
 *
 * The library (`apps/cli/src/lib/verification/index.ts`, its public
 * entrypoint and the only module of it this file imports) holds no fact of
 * this repository's. This adapter supplies them, each read from the head
 * commit's own committed files — never from the checkout this runs in:
 *
 * - the inventory views, built by `inventory-check.ts` for each commit from
 *   that commit's declarations;
 * - the folder-scanning tests' declarations, read from the syntax of the
 *   module the inventory names as their provider;
 * - the program the CLI tests start (`bun apps/cli/src/index.ts`);
 * - the obligations each consumer adds on top of what the change requires.
 *
 * The two consumers share every input that decides the dependency-required
 * set — the comparison, the inventory and the policy — so for the same
 * commits and depth they require the same tests. Their obligations are
 * stated additions: a local push adds the inventory's always-run policies
 * (the `prePush.alwaysRun` list); CI adds the inventory gate's repository
 * suite. The Linux sandbox conformance suite is no obligation: it runs when
 * the change reaches it — through its imports or the paths its
 * `SUITE_INPUTS` provider names — like any other test.
 *
 * The CI workflow consumes this adapter through its own plan
 * (`scripts/ci/impact-plan.ts`), which also keeps the always-run list as a
 * CI obligation until its inputs are modeled. The pre-push hook consumes it
 * through the native local-run adapter (`local-run.ts`), which hands it the
 * base the push chose and keeps the push's failed-test obligations outside it.
 *
 *   bun scripts/test-suites/repository-selection.ts --base <rev> --head <rev> [--consumer local|ci] [--depth one|transitive]
 */
import { execFileSync } from 'node:child_process'
import { CLI_SPAWN_BINARY } from '../../apps/cli/src/lib/cli-spawn-tests.js'
import { DEFAULT_CLI_ENTRYPOINT } from '../../apps/cli/src/lib/test-selector.js'
import {
  gitRepository,
  type ScannerDeclaration,
  type ScannerTrigger,
  type SelectionObligation,
  type SelectionPlan,
  type SelectionPolicy,
  type SelectTestsInput,
  selectTests
} from '../../apps/cli/src/lib/verification/index.js'
import {
  INVENTORY_PATH,
  type InventoryDeclarations,
  type InventoryView,
  readExportedScannerDeclarations,
  readTestInventory,
  revisionReader
} from './inventory-check.js'

export type SelectionConsumer = 'local' | 'ci'

export type RepositorySelectionOptions = {
  base: string
  head: string
  consumer: SelectionConsumer
  /** The local push walks depth one and CI the transitive closure, unless a caller names one. */
  depth?: SelectionPolicy['depth']
}

/** The repository suite the inventory gate runs on every pull request. */
const INVENTORY_GATE = { policy: 'inventory-gate', suite: 'repository' }
const SCANNER_TRIGGERS: ReadonlySet<string> = new Set(['tree-shape', 'process-start', 'listed-files', 'content'])

/** The commit a revision names, resolved once, so the plan is pinned to an object id rather than a moving name. */
export function resolveCommit(repoRoot: string, revision: string): string {
  return execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

/** The folder-scanning declarations the head commit's inventory names a provider for, read from that commit's syntax. */
function scannerDeclarations(repoRoot: string, head: string): ScannerDeclaration[] {
  const tree = revisionReader(repoRoot, head)
  const declarations = JSON.parse(tree.read(INVENTORY_PATH) ?? '{}') as Partial<InventoryDeclarations>
  const out: ScannerDeclaration[] = []
  for (const provider of declarations.providers ?? []) {
    if (provider.shape !== 'scanner-declarations') continue
    const text = tree.read(provider.file)
    const read = text === null ? null : readExportedScannerDeclarations(text, provider.file, provider.export)
    for (const entry of read ?? [])
      if (SCANNER_TRIGGERS.has(entry.trigger))
        out.push({ test: entry.test, roots: entry.roots, trigger: entry.trigger as ScannerTrigger })
  }
  return out
}

/** A `path#key.path` list the head commit holds, or none. */
function committedList(repoRoot: string, head: string, entry: string): string[] {
  const [path, keyPath] = entry.split('#') as [string, string | undefined]
  const text = revisionReader(repoRoot, head).read(path)
  if (text === null || !keyPath) return []
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return []
  }
  for (const key of keyPath.split('.')) value = (value as Record<string, unknown> | undefined)?.[key]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** The inventory's always-run policies, each with the tests its list names at the head commit. */
export function alwaysRunObligations(repoRoot: string, head: string, view: InventoryView): SelectionObligation[] {
  return view.policies
    .filter((policy) => policy.kind === 'always-run')
    .map((policy) => ({
      id: policy.id,
      kind: 'policy' as const,
      reason: policy.duty,
      tests: policy.inputs.flatMap((entry) => committedList(repoRoot, head, entry))
    }))
}

/** What each consumer adds on top of what the change requires. */
function obligationsOf(
  repoRoot: string,
  head: string,
  view: InventoryView,
  consumer: SelectionConsumer
): SelectionObligation[] {
  if (consumer === 'local') return alwaysRunObligations(repoRoot, head, view)
  const gate = view.policies.find((policy) => policy.id === INVENTORY_GATE.policy)
  return gate ? [{ id: gate.id, kind: 'policy' as const, reason: gate.duty, suites: [INVENTORY_GATE.suite] }] : []
}

/** This repository's selection policy for one consumer, read from the head commit. */
export function repositoryPolicy(
  repoRoot: string,
  head: string,
  view: InventoryView,
  consumer: SelectionConsumer,
  depth: SelectionPolicy['depth']
): SelectionPolicy {
  return {
    depth,
    scanners: scannerDeclarations(repoRoot, head),
    spawnPrograms: [{ binary: CLI_SPAWN_BINARY, entrypoint: DEFAULT_CLI_ENTRYPOINT }],
    obligations: obligationsOf(repoRoot, head, view, consumer),
    parsers: { toml: (text) => Bun.TOML.parse(text) }
  }
}

/** The selection's whole input for `consumer`: both commits resolved, both inventory views, the policy. */
export function repositorySelectionInput(repoRoot: string, options: RepositorySelectionOptions): SelectTestsInput {
  const base = resolveCommit(repoRoot, options.base)
  const head = resolveCommit(repoRoot, options.head)
  const inventory = readTestInventory(repoRoot, { base, head })
  const depth = options.depth ?? (options.consumer === 'local' ? 'one' : 'transitive')
  return {
    repo: gitRepository(repoRoot),
    base,
    head,
    inventory: { head: inventory.head, base: inventory.base },
    policy: repositoryPolicy(repoRoot, head, inventory.head, options.consumer, depth)
  }
}

/** The plan of the tests the change from `base` to `head` requires, for `consumer`. */
export function repositorySelection(repoRoot: string, options: RepositorySelectionOptions): SelectionPlan {
  return selectTests(repositorySelectionInput(repoRoot, options))
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const base = argValue(argv, '--base')
  const head = argValue(argv, '--head') ?? 'HEAD'
  const consumer = (argValue(argv, '--consumer') ?? 'ci') as SelectionConsumer
  const depth = argValue(argv, '--depth') as SelectionPolicy['depth'] | undefined
  if (!base || (consumer !== 'local' && consumer !== 'ci')) {
    process.stderr.write(
      'usage: repository-selection.ts --base <rev> [--head <rev>] [--consumer local|ci] [--depth one|transitive]\n'
    )
    process.exitCode = 2
  } else {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    const plan = repositorySelection(repoRoot, { base, head, consumer, ...(depth ? { depth } : {}) })
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  }
}
