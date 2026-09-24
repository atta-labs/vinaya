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
