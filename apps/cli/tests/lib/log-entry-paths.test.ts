import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { parse } from 'yaml'
import { coreCheckRegistry } from '../../src/checks/registry.js'

type Route = { producer: 'operation' | 'gate'; commandToken: string }
type InventoryRow = { id: string; route?: Route; noProducer?: string }
type Workflow = { jobs?: Record<string, { steps?: Array<{ name?: string; run?: unknown }> }> }

const ROOT = join(import.meta.dir, '..', '..', '..', '..')
const NO_PRODUCER_REASON = 'setup, build, test, or workflow bookkeeping only; it performs no governed act'

const workflowRoutes: Record<string, Route> = {
  'workflow:ci.yml:build:vinaya doctor — managed files match their generator': {
    producer: 'operation',
    commandToken: 'doctor'
  },
  'workflow:vinaya-archivist.yml:post-merge:Run vinaya archive': {
    producer: 'operation',
    commandToken: 'archive'
  },
  'workflow:vinaya-archivist.yml:post-merge:Self-archive the tranche once its last task merges (O4)': {
    producer: 'operation',
    commandToken: 'archive tranche'
  },
  'workflow:vinaya-archivist.yml:issue-closed:Self-archive the tranche this Issue belongs to': {
    producer: 'operation',
    commandToken: 'archive tranche'
  },
  'workflow:vinaya-archivist.yml:daily-drift:Run vinaya audit --only=dead-branches': {
    producer: 'operation',
    commandToken: 'audit --only=dead-branches'
  },
  'workflow:vinaya-archivist.yml:daily-drift:Archive every finished tranche not yet archived': {
    producer: 'operation',
    commandToken: 'archive tranches'
  },
  'workflow:vinaya-archivist.yml:direct-main-push-detection:Run vinaya audit --only=direct-push': {
    producer: 'operation',
    commandToken: 'audit --only=direct-push'
  },
  'workflow:vinaya-body-checks.yml:vinaya-body-checks:Body checks': {
    producer: 'gate',
    commandToken: 'check body-bare-digits'
  },
  'workflow:vinaya-body-checks.yml:vinaya-principal-test-plan-wait:Principal Test Plan wait': {
    producer: 'gate',
    commandToken: 'check principal-test-plan-wait'
  },
  'workflow:vinaya-checks.yml:vinaya-checks:Run checks': {
    producer: 'gate',
    commandToken: 'check --all --diff-only'
  },
  'workflow:vinaya-review-verdict.yml:evaluate:Review gate (verdict evaluation)': {
    producer: 'gate',
    commandToken: 'check review-gate'
  },
  'workflow:vinaya-review.yml:vinaya-review:Review gate': {
    producer: 'gate',
    commandToken: 'check review-gate'
  }
}

const workflowWithoutProducers = [
  'workflow:ci.yml:build:Detect docs-only diff',
  'workflow:ci.yml:build:Install dependencies',
  'workflow:ci.yml:build:Build the Vinaya CLI',
  "workflow:ci.yml:build:Arm this checkout's git hooks routing",
  'workflow:ci.yml:build:Lint and format',
  'workflow:ci.yml:build:Typecheck',
  'workflow:ci.yml:build:Docs-only skip report',
  'workflow:ci.yml:test-shared-packages:Install dependencies',
  'workflow:ci.yml:test-shared-packages:Test',
  'workflow:ci.yml:test-cli:Install dependencies',
  'workflow:ci.yml:test-cli:Test shard $' + '{{ matrix.shard }}',
  'workflow:ci.yml:test-cli-config-anchor:Install dependencies',
  'workflow:ci.yml:test-cli-config-anchor:Test shard $' + "{{ matrix.shard }} with the PR's config as the trust anchor",
  'workflow:ci.yml:sandbox-conformance:Install dependencies',
  'workflow:ci.yml:sandbox-conformance:Install the Linux sandbox tools',
  "workflow:ci.yml:sandbox-conformance:Install the checks' own tools",
  'workflow:ci.yml:sandbox-conformance:Run the suite under both sandboxes',
  'workflow:ci.yml:aggregate:Every upstream job succeeded or was correctly skipped (docs-only)',
  'workflow:published-lifecycle.yml:verify-published-lifecycle:Check published version',
  'workflow:published-lifecycle.yml:verify-published-lifecycle:Install dependencies',
  'workflow:published-lifecycle.yml:verify-published-lifecycle:Verify published lifecycle',
  'workflow:release.yml:version:Install dependencies',
  'workflow:vinaya-archivist.yml:post-merge:Build the vendored Vinaya CLI',
  'workflow:vinaya-archivist.yml:issue-closed:Build the vendored Vinaya CLI',
  'workflow:vinaya-archivist.yml:daily-drift:Build the vendored Vinaya CLI',
  'workflow:vinaya-archivist.yml:direct-main-push-detection:Build the vendored Vinaya CLI',
  'workflow:vinaya-body-checks.yml:vinaya-body-checks:Build the trusted Vinaya CLI',
  'workflow:vinaya-body-checks.yml:vinaya-body-checks:Fetch PR body',
  'workflow:vinaya-body-checks.yml:vinaya-principal-test-plan-wait:Build the trusted Vinaya CLI',
  'workflow:vinaya-body-checks.yml:vinaya-principal-test-plan-wait:Fetch PR body',
  'workflow:vinaya-checks.yml:vinaya-checks:Install dependencies (dist is downloaded below, never built here)',
  'workflow:vinaya-checks.yml:vinaya-checks:Find the shared CLI build for this commit',
  'workflow:vinaya-checks.yml:vinaya-checks:Restore executable bits lost in the artifact round-trip',
  'workflow:vinaya-checks.yml:vinaya-checks:Adopter CI setup',
  'workflow:vinaya-checks.yml:vinaya-checks:Fetch PR body',
  'workflow:vinaya-checks.yml:vinaya-checks:Per-check summary',
  'workflow:vinaya-review-verdict.yml:evaluate:Resolve PR head',
  'workflow:vinaya-review-verdict.yml:evaluate:Build the trusted Vinaya CLI',
  'workflow:vinaya-review-verdict.yml:retrigger:Re-run the required review gate for this branch',
  'workflow:vinaya-review.yml:vinaya-review:Require a verdict or waiver before building',
  'workflow:vinaya-review.yml:vinaya-review:Build the trusted Vinaya CLI'
] as const

const checkNames = [
  'brief-shape',
  'pr-report-density',
  'doc-coverage',
  'coherence',
  'pr-premise-reassert',
  'dispatch-readiness',
  'closes-n',
  'single-plan-pr',
  'surface-scope',
  'test-plan',
  'principal-test-plan-wait',
  'body-bare-digits',
  'no-disk-state',
  'registry-gates',
  'review-gate',
  'branch-topology',
  'dead-branch-push',
  'first-push-dispatch',
  'doc-coverage-push',
  'issue-assignment',
  'evidence-fresh',
  'reader-resolvable-prose',
  'retired-vocabulary',
  'doctrine-portability',
  'doctrine-no-procedures',
  'exec-bits',
  'ci-shard-coverage',
  'workspace-escape',
  'changeset-coverage',
  'quoted-command',
  'main-branch-refusal',
  'token-collection-wired',
  'issue-title-grammar',
  'issue-objectives-numbering',
  'issue-parts-coverage',
  'issue-surface-globs',
  'issue-tranche-label',
  'issue-milestone-attach',
  'atta-labs/secret-scan'
] as const

function workflowEntries(): Map<string, string> {
  const entries = new Map<string, string>()
  const directory = join(ROOT, '.github', 'workflows')
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.yml'))
    .sort()) {
    const workflow = parse(readFileSync(join(directory, file), 'utf8')) as Workflow
    for (const [job, value] of Object.entries(workflow.jobs ?? {})) {
      for (const [index, step] of (value.steps ?? []).entries()) {
        if (typeof step.run !== 'string') continue
        expect(step.name, `${file}:${job}: command-running step ${index} needs a stable name`).toBeTruthy()
        entries.set(`workflow:${file}:${job}:${step.name}`, step.run)
      }
    }
  }
  return entries
}

function gitHookEntries(): Map<string, string> {
  const directory = join(ROOT, '.vinaya', 'hooks')
  return new Map(
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [`git-hook:.vinaya/hooks/${entry.name}`, readFileSync(join(directory, entry.name), 'utf8')])
  )
}

function agentHookEntries(): Map<string, string> {
  const settingsPath = join(ROOT, '.claude', 'settings.json')
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: unknown }> }>>
  }
  const entries = new Map<string, string>()
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const [groupIndex, group] of groups.entries()) {
      for (const [hookIndex, hook] of (group.hooks ?? []).entries()) {
        if (typeof hook.command === 'string') {
          entries.set(`agent-hook:.claude/settings.json:${event}:${groupIndex}:${hookIndex}`, hook.command)
        }
      }
    }
  }
  return entries
}

function checkEntries(): Map<string, string> {
  const config = JSON.parse(readFileSync(join(ROOT, 'vinaya.config.json'), 'utf8')) as {
    checks?: Record<string, { run: string }>
  }
  return new Map([
    ...coreCheckRegistry().map((check) => [`check:${check.name}`, relative(ROOT, check.run)] as const),
    ...Object.entries(config.checks ?? {}).map(([name, check]) => [`check:${name}`, check.run] as const)
  ])
}

const inventory: InventoryRow[] = [
  { id: 'git-hook:.vinaya/hooks/commit-msg', route: { producer: 'operation', commandToken: 'commit-msg' } },
  { id: 'git-hook:.vinaya/hooks/pre-commit', route: { producer: 'gate', commandToken: 'check --all' } },
  { id: 'git-hook:.vinaya/hooks/pre-push', route: { producer: 'gate', commandToken: 'check --all' } },
  ...Object.entries(workflowRoutes).map(([id, route]) => ({ id, route })),
  ...workflowWithoutProducers.map((id) => ({ id, noProducer: NO_PRODUCER_REASON })),
  {
    id: 'agent-hook:.claude/settings.json:Stop:0:0',
    noProducer: 'records a local transcript pointer only; it performs no governed act'
  },
  ...checkNames.map((name) => ({
    id: `check:${name}`,
    route: { producer: 'gate' as const, commandToken: name === 'atta-labs/secret-scan' ? 'secret-scan' : name }
  }))
]

function validateInventory(rows: InventoryRow[], entries: Map<string, string>): string[] {
  const errors: string[] = []
  const rowIds = new Set(rows.map((row) => row.id))
  for (const id of entries.keys()) if (!rowIds.has(id)) errors.push(`unlisted entry path: ${id}`)
  for (const row of rows) {
    const command = entries.get(row.id)
    if (command === undefined) errors.push(`stale inventory row: ${row.id}`)
    else if (row.route && !command.includes(row.route.commandToken)) {
      errors.push(`route token not present in command: ${row.id} -> ${row.route.commandToken}`)
    }
    if (Boolean(row.route) === Boolean(row.noProducer)) errors.push(`row needs exactly one disposition: ${row.id}`)
  }
  return errors
}

function realEntryPaths(): Map<string, string> {
  return new Map([...gitHookEntries(), ...workflowEntries(), ...agentHookEntries(), ...checkEntries()])
}

describe('log entry-path producer inventory', () => {
  const entries = realEntryPaths()

  it('has one row for every real entry path and no stale rows', () => {
    const errors = validateInventory(inventory, entries)
    if (errors.length > 0) throw new Error(`log entry-path inventory drift:\n${errors.join('\n')}`)
  })

  it('detects each inventory drift class', () => {
    const first = inventory[0]!
    expect(validateInventory(inventory.slice(1), entries)).toContain(`unlisted entry path: ${first.id}`)
    expect(
      validateInventory([...inventory, { id: 'workflow:gone.yml:gone:gone', noProducer: 'gone' }], entries)
    ).toContain('stale inventory row: workflow:gone.yml:gone:gone')
    const badRoute = inventory.map((row) =>
      row.id === first.id
        ? { ...row, route: { producer: 'operation' as const, commandToken: 'not-a-real-command' } }
        : row
    )
    expect(validateInventory(badRoute, entries)).toContain(
      `route token not present in command: ${first.id} -> not-a-real-command`
    )
  })

  it("keeps today's no-producer list explicit and shrinking", () => {
    const noProducer = inventory.filter((row) => row.noProducer)
    expect(noProducer).toHaveLength(42)
    expect(noProducer.every((row) => row.noProducer!.trim().length > 0)).toBe(true)
  })
})
