import { describe, expect, it } from 'bun:test'
import type { AgentVendor } from '../../../src/lib/agent-vendors.js'
import { buildInitOps, CHECKS_WORKFLOW_PATH, TASK_LOG_COLLECTOR_WORKFLOW_PATH } from '../../../src/lib/artifacts.js'
import type { VendoredVinaya } from '../../../src/lib/self-host.js'

// CI task evidence outlives job logs
// without exposing publication credentials. The generated-workflow half of
// the story: the export step vinaya-checks.yml carries (no write
// credential), and the trusted collector workflow's own trust boundary
// (workflow_run on the default branch, fork PRs excluded structurally,
// artifacts downloaded by API-verified run id).
describe('task-log artifact export + collector: generated workflow content', () => {
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

  it('vinaya-checks.yml exports whatever outbox exists even on failure or cancellation — never gated on the check suite passing', () => {
    const checks = contentOf(opsFor(null), CHECKS_WORKFLOW_PATH)
    expect(checks).toContain('Export task-log artifact')
    expect(checks).toContain('Upload task-log artifact')
    // Both steps must run regardless of an earlier step's outcome (O2:
    // "cancellation preserve[s] available evidence") — `if: always()`, not
    // `!cancelled()` (which the summary step above uses deliberately, but a
    // cancelled run's PARTIAL outbox is still real evidence worth exporting,
    // unlike its half-captured check-output log).
    const exportStep = checks.slice(checks.indexOf('Export task-log artifact'))
    const uploadStep = checks.slice(checks.indexOf('Upload task-log artifact'))
    expect(exportStep.slice(0, 80)).toContain('always()')
    expect(uploadStep.slice(0, 200)).toContain('always()')
    expect(checks).toContain('log export-artifact')
    expect(checks).toContain('actions/upload-artifact@v4')
    expect(checks).toContain('if-no-files-found: ignore')
    // Keyed to this specific run — the collector downloads by this exact
    // run id, an API-level binding never re-derived from the artifact bytes.
    const sigil = '$'
    expect(checks).toContain(`vinaya-task-log-${sigil}{{ github.run_id }}`)
  })

  it('vinaya-checks.yml holds no forge-write credential — the export step cannot publish anything itself', () => {
    const checks = contentOf(opsFor(null), CHECKS_WORKFLOW_PATH)
    const permissionsBlock = checks.slice(checks.indexOf('permissions:'), checks.indexOf('steps:'))
    expect(permissionsBlock).not.toContain('issues: write')
    expect(permissionsBlock).not.toContain('pull-requests: write')
  })

  it('the collector is registered in the init manifest, alongside the other CI workflows', () => {
    const ops = opsFor(null)
    const op = ops.find((o) => o.kind === 'create-file' && o.path === TASK_LOG_COLLECTOR_WORKFLOW_PATH)
    expect(op?.kind).toBe('create-file')
    if (op?.kind === 'create-file') expect(op.group).toBe('CI workflows')
  })

  it('the collector triggers on workflow_run, never a PR-controllable event — the same default-branch boundary vinaya-review.yml uses', () => {
    const collector = contentOf(opsFor(null), TASK_LOG_COLLECTOR_WORKFLOW_PATH)
    expect(collector).toContain('workflow_run:')
    expect(collector).toContain('workflows: [Vinaya Checks]')
    expect(collector).toContain('types: [completed]')
    expect(collector).not.toContain('\n  pull_request:\n')
    expect(collector).not.toContain('pull_request_target:')
    const sigil = '$'
    expect(collector).toContain(`ref: ${sigil}{{ github.event.repository.default_branch }}`)
    expect(collector).not.toContain('refs/pull/')
  })

  it('a fork-originated PR has no pull_requests entry on its workflow_run event — the collector job refuses to run rather than guess a PR', () => {
    const collector = contentOf(opsFor(null), TASK_LOG_COLLECTOR_WORKFLOW_PATH)
    const sigil = '$'
    expect(collector).toContain(`if: ${sigil}{{ github.event.workflow_run.pull_requests[0] != null }}`)
  })

  it('downloads the artifact scoped to the exact run id the trusted workflow_run event names — never trusts the artifact to self-identify', () => {
    const collector = contentOf(opsFor(null), TASK_LOG_COLLECTOR_WORKFLOW_PATH)
    const sigil = '$'
    expect(collector).toContain('actions/download-artifact@v4')
    expect(collector).toContain(`run-id: ${sigil}{{ github.event.workflow_run.id }}`)
    expect(collector).toContain(`name: vinaya-task-log-${sigil}{{ github.event.workflow_run.id }}`)
  })

  it('runs on every conclusion, not only success — a cancelled or failed run still gets its partial evidence collected', () => {
    const collector = contentOf(opsFor(null), TASK_LOG_COLLECTOR_WORKFLOW_PATH)
    expect(collector).not.toContain("conclusion == 'success'")
  })

  it('validates before publishing (vinaya log collect-artifact), keyed to the resolved PR and repo, never trusting the download alone', () => {
    const collector = contentOf(opsFor(null), TASK_LOG_COLLECTOR_WORKFLOW_PATH)
    expect(collector).toContain('log collect-artifact')
    expect(collector).toContain('--pr')
    expect(collector).toContain('--repo')
  })

  it('the collector holds the write credential the task-path job never gets — its own permissions block, not the checks job', () => {
    const collector = contentOf(opsFor(null), TASK_LOG_COLLECTOR_WORKFLOW_PATH)
    const permissionsBlock = collector.slice(collector.indexOf('permissions:'), collector.indexOf('steps:'))
    expect(permissionsBlock).toContain('issues: write')
    expect(permissionsBlock).toContain('pull-requests: write')
  })

  it('vendored shape builds its own trusted copy (never downloads the shared build) — same O2 boundary reviewWorkflow already enforces', () => {
    const VENDORED: VendoredVinaya = { dir: 'apps/cli', bin: 'apps/cli/dist/index.js' }
    const collector = contentOf(opsFor(VENDORED), TASK_LOG_COLLECTOR_WORKFLOW_PATH)
    expect(collector).toContain('Build the trusted Vinaya CLI')
    expect(collector).not.toContain('Find the shared CLI build for this commit')
  })
})
