#!/usr/bin/env bun
/**
 * This repository's adapter to the selection library: one immutable plan of
 * the tests a change between two commits requires, for a local push and for
 * CI alike.
 *
 * The library (`harness/kernel/gates/ring0-hooks/pre-push/verification/index.ts`, its public
 * entrypoint and the only module of it this file imports) holds no fact of
 * this repository's. This adapter supplies them, each read from the head
 * commit's own committed files — never from the checkout this runs in:
 *
 * - the inventory views, built by `inventory-check.ts` for each commit from
 *   that commit's declarations;
 * - the folder-scanning tests' declarations, read from the syntax of the
 *   module the inventory names as their provider;
 * - the program the CLI tests start (`bun apps/cli/src/index.ts`);
 * - the obligations every caller adds on top of what the change requires;
 * - the record of what each test read when it last ran on the default branch
 *   (`read-records.ts`), when the caller reached one.
 *
 * There is one answer per change: a local push and CI call this with the same
 * inputs and get the same selected set. A test with a valid record is decided
 * by its record; every other test by the static selection, which walks the
 * full transitive import closure for every caller. The obligations are stated
 * additions, the same for every caller: the inventory's always-run policies
 * (the `prePush.alwaysRun` list) and the inventory gate's build-gate suites.
 * The Linux sandbox conformance suite is no obligation: it runs when the
 * change reaches it like any other test.
 *
 * The CI workflow consumes this adapter through its own plan
 * (`scripts/ci/impact-plan.ts`). The pre-push hook consumes it through the
 * native local-run adapter (`local-run.ts`), which hands it the base the push
 * chose and keeps the push's failed-test obligations outside it.
 *
 *   bun scripts/test-suites/repository-selection.ts --base <rev> --head <rev> [--record <file>]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { CLI_SPAWN_BINARY } from '../../harness/kernel/gates/ring0-hooks/pre-push/cli-spawn-tests.js'
import { DEFAULT_CLI_ENTRYPOINT } from '../../harness/processes/vinaya-strict/integration/repository-verification.js'
import {
  gitRepository,
  isReadRecord,
  type ReadRecord,
  type ScannerDeclaration,
  type ScannerTrigger,
  type SelectionObligation,
  type SelectionPlan,
  type SelectionPolicy,
  type SelectTestsInput,
  selectTests
} from '../../harness/kernel/gates/ring0-hooks/pre-push/verification/index.js'
import {
  bunLockParser,
  INVENTORY_PATH,
  type InventoryDeclarations,
  type InventoryView,
  readExportedScannerDeclarations,
  readTestInventory,
  revisionReader
} from './inventory-check.js'

export type RepositorySelectionOptions = {
  base: string
  head: string
  /** The record of the comparison's commit, when the caller reached one; absent, static selection decides every test. */
  record?: ReadRecord | null
  /** The platform the caller runs on; defaults to this process's. */
  platform?: string
  /**
   * How far the static selection walks importers: `one` follows only the tests that import a changed file
   * directly, `transitive` (the default) the whole import closure. A local push walks `one`, so a change in a
   * widely imported package does not select nearly every test; CI keeps the transitive closure.
   */
  depth?: SelectionPolicy['depth']
}

/** The root suites the build job runs on every pull request, each under the policy that states the duty. */
const BUILD_GATES = [
  { policy: 'inventory-gate', suite: 'repository' },
  { policy: 'package-compatibility', suite: 'package-compat' }
]
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

/** What every caller adds on top of what the change requires: the always-run policies and the build-gate suites. */
function obligationsOf(repoRoot: string, head: string, view: InventoryView): SelectionObligation[] {
  const gates = BUILD_GATES.flatMap(({ policy: id, suite }) => {
    const gate = view.policies.find((policy) => policy.id === id)
    return gate ? [{ id: gate.id, kind: 'policy' as const, reason: gate.duty, suites: [suite] }] : []
  })
  return [...alwaysRunObligations(repoRoot, head, view), ...gates]
}

/** This repository's selection policy, read from the head commit. */
export function repositoryPolicy(
  repoRoot: string,
  head: string,
  view: InventoryView,
  depth: SelectionPolicy['depth'] = 'transitive'
): SelectionPolicy {
  return {
    depth,
    scanners: scannerDeclarations(repoRoot, head),
    spawnPrograms: [{ binary: CLI_SPAWN_BINARY, entrypoint: DEFAULT_CLI_ENTRYPOINT }],
    obligations: obligationsOf(repoRoot, head, view),
    parsers: { toml: (text) => Bun.TOML.parse(text), 'bun-lock': bunLockParser }
  }
}

/** The selection's whole input: both commits resolved, both inventory views, the policy and the record. */
export function repositorySelectionInput(repoRoot: string, options: RepositorySelectionOptions): SelectTestsInput {
  const base = resolveCommit(repoRoot, options.base)
  const head = resolveCommit(repoRoot, options.head)
  const inventory = readTestInventory(repoRoot, { base, head })
  return {
    repo: gitRepository(repoRoot),
    base,
    head,
    inventory: { head: inventory.head, base: inventory.base },
    policy: repositoryPolicy(repoRoot, head, inventory.head, options.depth ?? 'transitive'),
    records: options.record ? { record: options.record, platform: options.platform ?? process.platform } : null
  }
}

/** The plan of the tests the change from `base` to `head` requires. */
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
  const recordFile = argValue(argv, '--record')
  if (!base) {
    process.stderr.write('usage: repository-selection.ts --base <rev> [--head <rev>] [--record <file>]\n')
    process.exitCode = 2
  } else {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    const parsed = recordFile ? (JSON.parse(readFileSync(recordFile, 'utf8')) as unknown) : null
    const record = isReadRecord(parsed) ? parsed : null
    const plan = repositorySelection(repoRoot, { base, head, record })
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  }
}
