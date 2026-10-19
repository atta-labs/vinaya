import { describe, expect, it } from 'bun:test'
import type { AgentVendor } from '../../../src/lib/agent-vendors.js'
import { BODY_CHECKS_WORKFLOW_PATH, buildInitOps, CHECKS_WORKFLOW_PATH } from '../../../src/lib/artifacts.js'
import type { VendoredVinaya } from '../../../src/lib/self-host.js'

// Task-files-v1 6, O2: no workflow uploads a log artifact or runs a
// collector — telemetry reaches its configured destination live instead
// (`apps/cli/specs/log.md` § The destination; § CI events reach the
// destination only through a configured server).
describe('generated vinaya-checks.yml: no log artifact, no collector', () => {
  function opsFor(selfHost: VendoredVinaya | null): ReturnType<typeof buildInitOps> {
    return buildInitOps({
      owner: 'acme',
      repo: 'widget',
      hookDir: '.husky',
      selfHost,
      ciSetup: null,
      agents: new Set<AgentVendor>()
    })
  }

  function contentOf(ops: ReturnType<typeof buildInitOps>, path: string): string {
    const op = ops.find((o) => o.kind === 'create-file' && o.path === path)
    if (op?.kind !== 'create-file') throw new Error(`expected create-file op for ${path}`)
    return op.content
  }

  it('vinaya-checks.yml carries no export/upload-artifact steps', () => {
    const checks = contentOf(opsFor(null), CHECKS_WORKFLOW_PATH)
    expect(checks).not.toContain('Export task-log artifact')
    expect(checks).not.toContain('Upload task-log artifact')
    expect(checks).not.toContain('log export-artifact')
    expect(checks).not.toContain('actions/upload-artifact')
  })

  it('the generated workflow set carries no collector workflow', () => {
    const ops = opsFor(null)
    expect(ops.find((o) => o.kind === 'create-file' && o.path.includes('task-log-collector'))).toBeUndefined()
  })

  function stepOf(workflow: string, name: string): string {
    const start = workflow.indexOf(`      - name: ${name}\n`)
    if (start === -1) throw new Error(`expected a step named ${name}`)
    const next = workflow.indexOf('\n      - ', start + 1)
    return next === -1 ? workflow.slice(start) : workflow.slice(start, next + 1)
  }

  it('a Resolve the diff base step runs after the forge snapshot and before Run checks', () => {
    const checks = contentOf(opsFor(null), CHECKS_WORKFLOW_PATH)
    const snapshot = checks.indexOf('      - name: Write the forge snapshot\n')
    const resolve = checks.indexOf('      - name: Resolve the diff base\n')
    const run = checks.indexOf('      - name: Run checks\n')
    expect(snapshot).toBeGreaterThan(-1)
    expect(resolve).toBeGreaterThan(snapshot)
    expect(run).toBeGreaterThan(resolve)
  })

  it('the resolving step takes the merge commit first parent, falls back to the event base, validates and exports BASE_SHA', () => {
    const step = stepOf(contentOf(opsFor(null), CHECKS_WORKFLOW_PATH), 'Resolve the diff base')
    expect(step).toContain('EVENT_BASE_SHA: ${{ github.event.pull_request.base.sha }}')
    expect(step).toContain('git rev-parse --verify -q HEAD^2')
    expect(step).toContain('git rev-parse HEAD^1')
    expect(step).toContain('BASE="$EVENT_BASE_SHA"')
    expect(step).toContain('=~ ^[0-9a-f]{40}$ ]]')
    expect(step).toContain('::error::')
    expect(step).toContain('echo "Diff base: $BASE, from $SOURCE."')
    expect(step).toContain('echo "BASE_SHA=$BASE" >> "$GITHUB_ENV"')
    // The validation runs before the value reaches $GITHUB_ENV.
    expect(step.indexOf('=~ ^[0-9a-f]{40}$')).toBeLessThan(step.indexOf('>> "$GITHUB_ENV"'))
  })

  it('the Run checks step sets no BASE_SHA of its own, so the resolved job value reaches the checks', () => {
    const checks = contentOf(opsFor(null), CHECKS_WORKFLOW_PATH)
    expect(stepOf(checks, 'Run checks')).not.toMatch(/^\s+BASE_SHA:/m)
    // The event's base commit appears only as the resolving step's fallback.
    const uses = checks.split('\n').filter((l) => l.includes('github.event.pull_request.base.sha'))
    expect(uses).toEqual(['          EVENT_BASE_SHA: ${{ github.event.pull_request.base.sha }}'])
  })

  it('vinaya-checks.yml still holds no forge-write credential', () => {
    const checks = contentOf(opsFor(null), CHECKS_WORKFLOW_PATH)
    const permissionsBlock = checks.slice(checks.indexOf('permissions:'), checks.indexOf('steps:'))
    expect(permissionsBlock).not.toContain('issues: write')
    expect(permissionsBlock).not.toContain('pull-requests: write')
  })
})

// O2: `principal-test-plan-wait` is reported by its own job in
// `vinaya-body-checks.yml`, so a PR body edit (ticking a `[principal]` box)
// re-evaluates it — proven here by the job's own presence and by the
// workflow's shared trigger list, the same file `body-bare-digits`'s own job
// already lives in.
describe('vinaya-body-checks.yml: principal-test-plan-wait has its own job', () => {
  function bodyChecks(selfHost: VendoredVinaya | null): string {
    const ops = buildInitOps({
      owner: 'acme',
      repo: 'widget',
      hookDir: '.husky',
      selfHost,
      ciSetup: null,
      agents: new Set<AgentVendor>()
    })
    const op = ops.find((o) => o.kind === 'create-file' && o.path === BODY_CHECKS_WORKFLOW_PATH)
    if (op?.kind !== 'create-file') throw new Error(`expected create-file op for ${BODY_CHECKS_WORKFLOW_PATH}`)
    return op.content
  }

  it('the workflow trigger list re-runs on a PR body edit — opened, reopened, AND edited', () => {
    const content = bodyChecks(null)
    expect(content).toContain('pull_request_target:')
    expect(content).toContain('types: [opened, reopened, edited]')
  })

  it('principal-test-plan-wait is its own job, separate from vinaya-body-checks', () => {
    const content = bodyChecks(null)
    expect(content).toContain('vinaya-principal-test-plan-wait:')
    expect(content).toContain('name: vinaya check principal-test-plan-wait')
    expect(content).toContain('check principal-test-plan-wait')
  })

  it('carries no write permission — read-only, same as the body-bare-digits job', () => {
    const content = bodyChecks(null)
    const jobStart = content.indexOf('vinaya-principal-test-plan-wait:')
    const job = content.slice(jobStart, content.indexOf('steps:', jobStart))
    expect(job).toContain('contents: read')
    expect(job).toContain('pull-requests: read')
    expect(job).not.toContain('write')
  })
})
