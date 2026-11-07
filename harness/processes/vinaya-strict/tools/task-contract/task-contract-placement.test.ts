import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../../../../..')
// Every relocation is named explicitly so a deleted source cannot return unnoticed.
const moves = {
  'packages/aeg-core/src/blast-radius-domains.ts':
    'harness/processes/vinaya-strict/tools/task-contract/blast-radius-domains.ts',
  'packages/aeg-core/src/blast-radius-domains.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/blast-radius-domains.test.ts',
  'packages/aeg-core/src/brief-render.ts': 'harness/processes/vinaya-strict/tools/task-contract/brief-render.ts',
  'packages/aeg-core/src/brief-render.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/brief-render.test.ts',
  'packages/aeg-core/src/brief-validation.ts':
    'harness/processes/vinaya-strict/tools/task-contract/brief-validation.ts',
  'packages/aeg-core/src/brief-validation.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/brief-validation.test.ts',
  'packages/aeg-core/src/consumer-enumeration.ts':
    'harness/processes/vinaya-strict/tools/task-contract/consumer-enumeration.ts',
  'packages/aeg-core/src/consumer-enumeration.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/consumer-enumeration.test.ts',
  'packages/aeg-core/src/derive-section7.ts': 'harness/processes/vinaya-strict/tools/task-contract/derive-section7.ts',
  'packages/aeg-core/src/derive-section7.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/derive-section7.test.ts',
  'packages/aeg-core/src/derive-tranche.ts': 'harness/processes/vinaya-strict/tools/task-contract/derive-tranche.ts',
  'packages/aeg-core/src/derive-tranche.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/derive-tranche.test.ts',
  'packages/aeg-core/src/issue-validation.ts':
    'harness/processes/vinaya-strict/tools/task-contract/issue-validation.ts',
  'packages/aeg-core/src/issue-validation.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/issue-validation.test.ts',
  'packages/aeg-core/src/milestone-validation.ts':
    'harness/processes/vinaya-strict/tools/task-contract/milestone-validation.ts',
  'packages/aeg-core/src/milestone-validation.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/milestone-validation.test.ts',
  'packages/aeg-core/src/objectives.ts': 'harness/processes/vinaya-strict/tools/task-contract/objectives.ts',
  'packages/aeg-core/src/objectives.test.ts': 'harness/processes/vinaya-strict/tools/task-contract/objectives.test.ts',
  'packages/aeg-core/src/parse-registry.ts': 'harness/processes/vinaya-strict/tools/task-contract/parse-registry.ts',
  'packages/aeg-core/src/parse-registry.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/parse-registry.test.ts',
  'packages/aeg-core/src/parse-tranche.ts': 'harness/processes/vinaya-strict/tools/task-contract/parse-tranche.ts',
  'packages/aeg-core/src/parse-tranche.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/parse-tranche.test.ts',
  'packages/aeg-core/src/pr-tier.ts': 'harness/processes/vinaya-strict/tools/task-contract/pr-tier.ts',
  'packages/aeg-core/src/pr-tier.test.ts': 'harness/processes/vinaya-strict/tools/task-contract/pr-tier.test.ts',
  'packages/aeg-core/src/premise-check.ts': 'harness/processes/vinaya-strict/tools/task-contract/premise-check.ts',
  'packages/aeg-core/src/premise-check.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/premise-check.test.ts',
  'packages/aeg-core/src/principals-config.ts':
    'harness/processes/vinaya-strict/tools/task-contract/principals-config.ts',
  'packages/aeg-core/src/principals-config.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/principals-config.test.ts',
  'packages/aeg-core/src/protected-paths.ts': 'harness/processes/vinaya-strict/tools/task-contract/protected-paths.ts',
  'packages/aeg-core/src/protected-paths.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/protected-paths.test.ts',
  'packages/aeg-core/src/review-input-manifest.ts':
    'harness/processes/vinaya-strict/tools/task-contract/review-input-manifest.ts',
  'packages/aeg-core/src/review-input-manifest.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/review-input-manifest.test.ts',
  'packages/aeg-core/src/review-policy.ts': 'harness/processes/vinaya-strict/tools/task-contract/review-policy.ts',
  'packages/aeg-core/src/review-policy.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/review-policy.test.ts',
  'packages/aeg-core/src/review-status.ts': 'harness/processes/vinaya-strict/tools/task-contract/review-status.ts',
  'packages/aeg-core/src/review-status.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/review-status.test.ts',
  'packages/aeg-core/src/ruling-ordinal.ts': 'harness/processes/vinaya-strict/tools/task-contract/ruling-ordinal.ts',
  'packages/aeg-core/src/ruling-ordinal.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/ruling-ordinal.test.ts',
  'packages/aeg-core/src/state-machine-model.ts':
    'harness/processes/vinaya-strict/tools/task-contract/state-machine-model.ts',
  'packages/aeg-core/src/state-machine-model.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/state-machine-model.test.ts',
  'packages/aeg-core/src/task-branch-identity.ts':
    'harness/processes/vinaya-strict/tools/task-contract/task-branch-identity.ts',
  'packages/aeg-core/src/task-branch-identity.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/task-branch-identity.test.ts',
  'packages/aeg-core/src/test-plan-section.ts':
    'harness/processes/vinaya-strict/tools/task-contract/test-plan-section.ts',
  'packages/aeg-core/src/test-plan-section.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/test-plan-section.test.ts',
  'packages/aeg-core/src/verdict-extraction.ts':
    'harness/processes/vinaya-strict/tools/task-contract/verdict-extraction.ts',
  'packages/aeg-core/src/verdict-extraction.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/verdict-extraction.test.ts',
  'packages/aeg-core/src/waiver-label.ts': 'harness/processes/vinaya-strict/tools/task-contract/waiver-label.ts',
  'packages/aeg-core/src/waiver-label.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/waiver-label.test.ts',
  'packages/aeg-core/src/gate-cutovers.ts': 'harness/processes/vinaya-strict/tools/task-contract/gate-cutovers.ts',
  'packages/aeg-core/src/live-record.ts': 'harness/processes/vinaya-strict/tools/task-contract/live-record.ts',
  'packages/aeg-core/src/objectives-cutover-config.ts':
    'harness/processes/vinaya-strict/tools/task-contract/objectives-cutover-config.ts',
  'packages/aeg-core/src/state-source.ts': 'harness/processes/vinaya-strict/tools/task-contract/state-source.ts',
  'packages/aeg-core/src/types.ts': 'harness/processes/vinaya-strict/tools/task-contract/types.ts',
  'packages/aeg-core/src/parse-ledger.ts': 'harness/processes/vinaya-strict/tools/pr-report/tokens/parse-ledger.ts',
  'packages/aeg-core/src/parse-ledger.test.ts':
    'harness/processes/vinaya-strict/tools/pr-report/tokens/parse-ledger.test.ts',
  'packages/aeg-core/src/parse-token-report.ts':
    'harness/processes/vinaya-strict/tools/pr-report/tokens/parse-token-report.ts',
  'packages/aeg-core/src/parse-token-report.test.ts':
    'harness/processes/vinaya-strict/tools/pr-report/tokens/parse-token-report.test.ts',
  'packages/aeg-core/src/report-tokens.ts': 'harness/processes/vinaya-strict/tools/pr-report/tokens/report-tokens.ts',
  'packages/aeg-core/src/report-tokens.test.ts':
    'harness/processes/vinaya-strict/tools/pr-report/tokens/report-tokens.test.ts',
  'packages/aeg-core/src/sum-ledger.ts': 'harness/processes/vinaya-strict/tools/pr-report/tokens/sum-ledger.ts',
  'packages/aeg-core/src/sum-ledger.test.ts':
    'harness/processes/vinaya-strict/tools/pr-report/tokens/sum-ledger.test.ts',
  'packages/aeg-core/src/pr-report-density.ts': 'harness/processes/vinaya-strict/checks/pr-report-density.ts',
  'packages/aeg-core/src/pr-report-density.test.ts': 'harness/processes/vinaya-strict/checks/pr-report-density.test.ts',
  'packages/aeg-core/src/task-phase-history.ts': 'harness/processes/vinaya-strict/tools/task-phase-history.ts',
  'packages/aeg-core/src/anchored-region.test.ts':
    'harness/processes/vinaya-strict/integration/gates/checks/anchored-region.test.ts',
  'packages/aeg-core/bin/open-issue.ts': 'harness/processes/vinaya-strict/thinking/planner/tools/open-issue.ts',
  'packages/aeg-core/bin/open-issue.test.ts':
    'harness/processes/vinaya-strict/thinking/planner/tools/open-issue.test.ts',
  'packages/aeg-core/bin/open-pr.ts': 'harness/processes/vinaya-strict/tools/pull-request/bin/open-pr.ts',
  'packages/aeg-core/bin/open-pr.test.ts': 'harness/processes/vinaya-strict/tools/pull-request/bin/open-pr.test.ts',
  'packages/aeg-core/bin/report-tokens.ts':
    'harness/processes/vinaya-strict/tools/pr-report/tokens/bin/report-tokens.ts',
  'packages/aeg-core/bin/report-tokens.test.ts':
    'harness/processes/vinaya-strict/tools/pr-report/tokens/bin/report-tokens.test.ts',
  'apps/cli/tests/lib/issue-surface.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/issue-surface.test.ts',
  'apps/cli/tests/lib/planning-collisions.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/planning-collisions.test.ts',
  'packages/aeg-forge-state/src/check-milestone-attachment.test.ts':
    'harness/processes/vinaya-strict/tools/milestone/check-milestone-attachment.test.ts',
  'packages/aeg-forge-state/src/list-issue-milestones.test.ts':
    'harness/processes/vinaya-strict/checks/forge/list-issue-milestones.test.ts',
  'packages/aeg-forge-state/src/prior-tranche-archival.ts':
    'harness/processes/vinaya-strict/tools/prior-tranche-archival.ts',
  'packages/aeg-forge-state/src/fetch-task-issue-refs.test.ts':
    'harness/processes/vinaya-strict/checks/forge/fetch-task-issue-refs.test.ts',
  'packages/aeg-forge-state/src/fetch-milestone.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/fetch-milestone.ts',
  'packages/aeg-forge-state/src/list-tasks.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/list-tasks.test.ts',
  'packages/aeg-forge-state/src/labels.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/labels.test.ts',
  'packages/aeg-forge-state/src/map-forge-facts.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/map-forge-facts.test.ts',
  'packages/aeg-forge-state/src/fetch-forge-facts.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/fetch-forge-facts.test.ts',
  'packages/aeg-forge-state/src/fetch-forge-facts.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/fetch-forge-facts.ts',
  'packages/aeg-forge-state/src/derive-from-forge.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/derive-from-forge.ts',
  'packages/aeg-forge-state/src/duplicate-task-ids.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/duplicate-task-ids.test.ts',
  'packages/aeg-forge-state/src/derive-from-forge.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/derive-from-forge.test.ts',
  'packages/aeg-forge-state/src/fetch-provenance.ts':
    'harness/processes/vinaya-strict/checks/forge/fetch-provenance.ts',
  'packages/aeg-forge-state/src/fetch-open-issues.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/fetch-open-issues.test.ts',
  'packages/aeg-forge-state/src/list-issue-milestones.ts':
    'harness/processes/vinaya-strict/checks/forge/list-issue-milestones.ts',
  'packages/aeg-forge-state/src/parse-rationale-deps.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/parse-rationale-deps.test.ts',
  'packages/aeg-forge-state/src/fetch-open-issues.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/fetch-open-issues.ts',
  'packages/aeg-forge-state/src/fetch-task-issue-refs.ts':
    'harness/processes/vinaya-strict/checks/forge/fetch-task-issue-refs.ts',
  'packages/aeg-forge-state/src/fetch-provenance.test.ts':
    'harness/processes/vinaya-strict/checks/forge/fetch-provenance.test.ts',
  'packages/aeg-forge-state/src/list-tasks.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/list-tasks.ts',
  'packages/aeg-forge-state/src/map-forge-facts.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/map-forge-facts.ts',
  'packages/aeg-forge-state/src/check-milestone-attachment.ts':
    'harness/processes/vinaya-strict/tools/milestone/check-milestone-attachment.ts',
  'packages/aeg-forge-state/src/fetch-milestone.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/fetch-milestone.test.ts',
  'packages/aeg-forge-state/src/amend-rationale-deps.ts':
    'harness/processes/vinaya-strict/thinking/planner/tools/amend-rationale-deps.ts',
  'packages/aeg-forge-state/src/fetch-forge-facts.entry.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/fetch-forge-facts.entry.test.ts',
  'packages/aeg-forge-state/src/gh.test.ts':
    'harness/processes/vinaya-strict/integration/adapters/code-host/github/gh.test.ts',
  'packages/aeg-forge-state/src/amend-rationale-deps.test.ts':
    'harness/processes/vinaya-strict/thinking/planner/tools/amend-rationale-deps.test.ts',
  'packages/aeg-forge-state/src/parse-rationale-deps.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/parse-rationale-deps.ts',
  'packages/aeg-forge-state/src/milestone-adopt-lifecycle.test.ts':
    'harness/processes/vinaya-strict/tools/task-contract/forge/milestone-adopt-lifecycle.test.ts',
  'packages/aeg-forge-state/src/labels.ts': 'harness/processes/vinaya-strict/tools/task-contract/forge/labels.ts',
  'packages/aeg-forge-state/src/prior-tranche-archival.test.ts':
    'harness/processes/vinaya-strict/tools/prior-tranche-archival.test.ts',
  'packages/aeg-forge-state/src/test-support/mock-gh.ts':
    'harness/processes/vinaya-strict/tools/test-support/mock-gh.ts',
  'packages/aeg-forge-state/tests/fixtures/issue-429-body.md':
    'harness/processes/vinaya-strict/tools/task-contract/forge/fixtures/issue-429-body.md',
  'packages/aeg-forge-state/tests/fixtures/issue-382-body.md':
    'harness/processes/vinaya-strict/tools/task-contract/forge/fixtures/issue-382-body.md',
  'packages/aeg-forge-state/tests/fixtures/issue-383-body.md':
    'harness/processes/vinaya-strict/tools/task-contract/forge/fixtures/issue-383-body.md',
  'packages/aeg-forge-state/tests/fixtures/issue-388-body.md':
    'harness/processes/vinaya-strict/tools/task-contract/forge/fixtures/issue-388-body.md',
  'packages/aeg-forge-state/tests/fixtures/issue-384-body.md':
    'harness/processes/vinaya-strict/tools/task-contract/forge/fixtures/issue-384-body.md',
  'packages/aeg-forge-state/tests/fixtures/issue-509-body.md':
    'harness/processes/vinaya-strict/tools/task-contract/forge/fixtures/issue-509-body.md',
  'packages/aeg-forge-state/tests/fixtures/milestones-empty.json':
    'harness/processes/vinaya-strict/tools/task-contract/forge/fixtures/milestones-empty.json',
  'packages/aeg-types/src/index.ts': 'harness/processes/vinaya-strict/tools/task-contract/tranche-types.ts'
} as const

describe('task contract placement', () => {
  test('every old path is absent and every destination exists', () => {
    for (const [oldPath, destination] of Object.entries(moves)) {
      expect(existsSync(join(root, oldPath)), oldPath).toBe(false)
      expect(existsSync(join(root, destination)), destination).toBe(true)
    }
  })

  test('the source-comment sweep preserves the per-file set', () => {
    const config = JSON.parse(readFileSync(join(root, 'vinaya.config.json'), 'utf8'))
    const roots = config.proseGates.sourceComments.globs as string[]
    const swept = (path: string) => roots.some((prefix) => path === prefix || path.startsWith(prefix + '/'))
    const expected = Object.entries(moves)
      .filter(
        ([oldPath]) =>
          oldPath.startsWith('packages/aeg-core/src/') || oldPath.startsWith('packages/aeg-forge-state/src/')
      )
      .map(([, destination]) => destination)
      .sort()
    const actual = Object.values(moves).filter(swept).sort()
    expect(actual).toEqual(expected)
  })
})
