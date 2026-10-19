import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  },
  'workflow:vinaya-body-checks.yml:vinaya-forge-read:Write the forge snapshot': {
    producer: 'operation',
    commandToken: 'pr snapshot'
  },
  'workflow:vinaya-checks.yml:vinaya-checks:Write the forge snapshot': {
    producer: 'operation',
    commandToken: 'pr snapshot'
  },
  'workflow:vinaya-review-verdict.yml:evaluate:Write the forge snapshot': {
    producer: 'operation',
    commandToken: 'pr snapshot'
  },
  'workflow:vinaya-review.yml:vinaya-review:Write the forge snapshot': {
    producer: 'operation',
    commandToken: 'pr snapshot'
  },
  'workflow:vinaya-review.yml:vinaya-evidence-fresh:Write the forge snapshot': {
    producer: 'operation',
    commandToken: 'pr snapshot'
  },
  'workflow:vinaya-review.yml:vinaya-evidence-fresh:Evidence freshness': {
    producer: 'gate',
    commandToken: 'check evidence-fresh'
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
  'workflow:ci.yml:sandbox-conformance-macos:Install dependencies',
  "workflow:ci.yml:sandbox-conformance-macos:Install the checks' own tool",
  'workflow:ci.yml:sandbox-conformance-macos:Run the suite under both sandboxes',
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
  'workflow:vinaya-body-checks.yml:vinaya-principal-test-plan-wait:Build the trusted Vinaya CLI',
  'workflow:vinaya-checks.yml:vinaya-checks:Build the vendored Vinaya CLI',
  'workflow:vinaya-checks.yml:vinaya-checks:Adopter CI setup',
  'workflow:vinaya-checks.yml:vinaya-checks:Per-check summary',
  'workflow:vinaya-checks.yml:vinaya-checks:Resolve the diff base',
  'workflow:vinaya-review-verdict.yml:evaluate:Resolve PR head',
  'workflow:vinaya-review-verdict.yml:evaluate:Build the trusted Vinaya CLI',
  'workflow:vinaya-review-verdict.yml:retrigger:Re-run the required review gate for this branch',
  'workflow:vinaya-review.yml:vinaya-review:Require a verdict or waiver before building',
  'workflow:vinaya-review.yml:vinaya-review:Build the trusted Vinaya CLI',
  "workflow:ci.yml:build:Report this job's GitHub token budget",
  "workflow:ci.yml:test-shared-packages:Report this job's GitHub token budget",
  "workflow:ci.yml:test-cli:Report this job's GitHub token budget",
  "workflow:ci.yml:test-cli-config-anchor:Report this job's GitHub token budget",
  "workflow:ci.yml:sandbox-conformance:Report this job's GitHub token budget",
  "workflow:ci.yml:sandbox-conformance-macos:Report this job's GitHub token budget",
  "workflow:ci.yml:aggregate:Report this job's GitHub token budget",
  "workflow:ci.yml:build:Print the limits of this job's GitHub reads",
  "workflow:ci.yml:sandbox-conformance:Print the limits of this job's GitHub reads",
  "workflow:ci.yml:sandbox-conformance-macos:Print the limits of this job's GitHub reads",
  "workflow:vinaya-archivist.yml:post-merge:Report this job's GitHub token budget",
  "workflow:vinaya-archivist.yml:issue-closed:Report this job's GitHub token budget",
  "workflow:vinaya-archivist.yml:daily-drift:Report this job's GitHub token budget",
  "workflow:vinaya-archivist.yml:direct-main-push-detection:Report this job's GitHub token budget",
  "workflow:vinaya-body-checks.yml:vinaya-body-checks:Report this job's GitHub token budget",
  "workflow:vinaya-body-checks.yml:vinaya-principal-test-plan-wait:Report this job's GitHub token budget",
  "workflow:vinaya-checks.yml:vinaya-checks:Report this job's GitHub token budget",
  "workflow:vinaya-review-verdict.yml:evaluate:Report this job's GitHub token budget",
  "workflow:vinaya-review-verdict.yml:retrigger:Report this job's GitHub token budget",
  "workflow:vinaya-review.yml:vinaya-review:Report this job's GitHub token budget",
  'workflow:vinaya-archivist.yml:post-merge:Record the GraphQL budget at job start',
  'workflow:vinaya-archivist.yml:post-merge:Record the GraphQL budget at job end',
  'workflow:vinaya-archivist.yml:issue-closed:Record the GraphQL budget at job start',
  'workflow:vinaya-archivist.yml:issue-closed:Record the GraphQL budget at job end',
  'workflow:vinaya-archivist.yml:daily-drift:Record the GraphQL budget at job start',
  'workflow:vinaya-archivist.yml:daily-drift:Record the GraphQL budget at job end',
  'workflow:vinaya-archivist.yml:direct-main-push-detection:Record the GraphQL budget at job start',
  'workflow:vinaya-archivist.yml:direct-main-push-detection:Record the GraphQL budget at job end',
  'workflow:vinaya-body-checks.yml:vinaya-forge-read:Record the GraphQL budget at job start',
  'workflow:vinaya-body-checks.yml:vinaya-forge-read:Build the trusted Vinaya CLI',
  'workflow:vinaya-body-checks.yml:vinaya-forge-read:Read the pull request over REST',
  'workflow:vinaya-body-checks.yml:vinaya-forge-read:Record the GraphQL budget at job end',
  "workflow:vinaya-body-checks.yml:vinaya-forge-read:Report this job's GitHub token budget",
  'workflow:vinaya-body-checks.yml:vinaya-body-checks:Require the pull request read',
  'workflow:vinaya-body-checks.yml:vinaya-body-checks:Record the GraphQL budget at job start',
  'workflow:vinaya-body-checks.yml:vinaya-body-checks:Export the pull request body',
  'workflow:vinaya-body-checks.yml:vinaya-body-checks:Record the GraphQL budget at job end',
  'workflow:vinaya-body-checks.yml:vinaya-principal-test-plan-wait:Require the pull request read',
  'workflow:vinaya-body-checks.yml:vinaya-principal-test-plan-wait:Record the GraphQL budget at job start',
  'workflow:vinaya-body-checks.yml:vinaya-principal-test-plan-wait:Export the pull request body',
  'workflow:vinaya-body-checks.yml:vinaya-principal-test-plan-wait:Record the GraphQL budget at job end',
  'workflow:vinaya-checks.yml:vinaya-checks:Record the GraphQL budget at job start',
  'workflow:vinaya-checks.yml:vinaya-checks:Read the pull request over REST',
  'workflow:vinaya-checks.yml:vinaya-checks:Record the GraphQL budget at job end',
  'workflow:vinaya-review-verdict.yml:evaluate:Record the GraphQL budget at job start',
  'workflow:vinaya-review-verdict.yml:evaluate:Read the pull request over REST',
  'workflow:vinaya-review-verdict.yml:evaluate:Record the GraphQL budget at job end',
  'workflow:vinaya-review-verdict.yml:retrigger:Record the GraphQL budget at job start',
  'workflow:vinaya-review-verdict.yml:retrigger:Record the GraphQL budget at job end',
  'workflow:vinaya-review.yml:vinaya-review:Record the GraphQL budget at job start',
  'workflow:vinaya-review.yml:vinaya-review:Read the pull request over REST',
  'workflow:vinaya-review.yml:vinaya-review:Record the GraphQL budget at job end',
  'workflow:vinaya-review.yml:vinaya-evidence-fresh:Record the GraphQL budget at job start',
  'workflow:vinaya-review.yml:vinaya-evidence-fresh:Build the trusted Vinaya CLI',
  'workflow:vinaya-review.yml:vinaya-evidence-fresh:Read the pull request over REST',
  'workflow:vinaya-review.yml:vinaya-evidence-fresh:Fetch the pull request head as git objects',
  'workflow:vinaya-review.yml:vinaya-evidence-fresh:Record the GraphQL budget at job end',
  "workflow:vinaya-review.yml:vinaya-evidence-fresh:Report this job's GitHub token budget"
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
  'doc-claims',
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
  'issue-milestone-attach',
  'atta-labs/secret-scan'
] as const

function workflowEntries(directory = join(ROOT, '.github', 'workflows')): Map<string, string> {
  const entries = new Map<string, string>()
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()) {
    const workflow = parse(readFileSync(join(directory, file), 'utf8')) as Workflow
    for (const [job, value] of Object.entries(workflow.jobs ?? {})) {
      for (const [index, step] of (value.steps ?? []).entries()) {
        if (typeof step.run !== 'string') continue
        expect(step.name, `${file}:${job}: command-running step ${index} needs a stable name`).toBeTruthy()
        const id = `workflow:${file}:${job}:${step.name}`
        if (entries.has(id)) throw new Error(`duplicate workflow entry path: ${id}`)
        entries.set(id, step.run)
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

  it('enumerates command-running steps from .yaml workflows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vinaya-log-entry-paths-'))
    try {
      writeFileSync(
        join(directory, 'supported.yaml'),
        'jobs:\n  verify:\n    steps:\n      - name: Run supported workflow\n        run: bun test\n'
      )
      expect(workflowEntries(directory)).toEqual(
        new Map([['workflow:supported.yaml:verify:Run supported workflow', 'bun test']])
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses duplicate workflow step identities instead of collapsing them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vinaya-log-entry-paths-'))
    try {
      writeFileSync(
        join(directory, 'duplicate.yml'),
        'jobs:\n  verify:\n    steps:\n      - name: Repeated\n        run: first\n      - name: Repeated\n        run: second\n'
      )
      expect(() => workflowEntries(directory)).toThrow(
        'duplicate workflow entry path: workflow:duplicate.yml:verify:Repeated'
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("keeps today's no-producer list explicit and shrinking", () => {
    const noProducer = inventory.filter((row) => row.noProducer)
    expect(noProducer).toHaveLength(99)
    expect(noProducer.every((row) => row.noProducer!.trim().length > 0)).toBe(true)
  })
})
