import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixtureDir } from '../../../../kernel/conformance/unit/test-temp-fixture'
import { CHECK_SCHEMA_VERSION, type CheckError } from '../../../../kernel/gates/checks/contract'
import { checkPinnedFileImportersCovered, boundaryPinnedFiles } from './issue-validation'
import { dispatchPremiseRefusals } from './brief-assembly'
import {
  repairPlan,
  repairPreservesScope,
  readUnchangedRenames,
  waitForDependencies,
  DEPENDENCY_WAIT_BOUND_MS,
  DEPENDENCY_WAIT_INTERVAL_MS
} from './plan-repair'

const body =
  '## Objectives\nO1. Preserve the objective.\n\n## Surface\nin: src\nout: —\n\n**Boundary** — Pinned files: `src/module.ts`. Out: other work.\n\n**Traps to avoid** — Keep it bounded.\n'
const error = (message: string): CheckError => ({
  schema: CHECK_SCHEMA_VERSION,
  check: 'issue-content',
  severity: 'error',
  message,
  agent_recovery_prompt: 'Fix it.'
})
const importers = [{ file: 'src/module.ts', importers: ['consumer/use.ts'] }]

describe('deterministic plan repair', () => {
  test('disclaims each uncovered importer, preserving objectives and Surface, and reuses the gate facts', async () => {
    const findings = checkPinnedFileImportersCovered(body, importers).errors.map(error)
    let graded = ''
    const repaired = await repairPlan({
      body,
      findings,
      importers: () => importers,
      renames: [],
      validate: async (candidate) => {
        graded = candidate
        return checkPinnedFileImportersCovered(candidate, importers).errors.map(error)
      }
    })
    expect(repaired?.body).toBe(graded)
    expect(repaired?.body).toContain('`consumer/use.ts`')
    expect(repaired?.reasons).toHaveLength(1)
    expect(repairPreservesScope(body, repaired!.body)).toBe(true)
    expect(boundaryPinnedFiles(repaired!.body)).toEqual(['src/module.ts'])
  })

  test('adds an Out clause when the Boundary did not have one', async () => {
    const original = body.replace(' Out: other work.', '')
    const repaired = await repairPlan({
      body: original,
      findings: [error('opaque')],
      importers: () => importers,
      renames: [],
      validate: async (candidate) => checkPinnedFileImportersCovered(candidate, importers).errors.map(error)
    })
    expect(repaired?.body).toContain('Out: Importers')
  })

  test('keeps nothing when an unrelated finding remains; warnings alone trigger no repair', async () => {
    const base = { body, importers: () => importers, renames: [], validate: async () => [error('requires a ruling')] }
    expect(await repairPlan({ ...base, findings: [error('opaque')] })).toBeNull()
    expect(await repairPlan({ ...base, findings: [{ ...error('warning'), severity: 'warning' }] })).toBeNull()
  })

  test('never disclaims an importer the Boundary itself pins as task work', async () => {
    const original = body.replace('Pinned files:', 'Pinned files: `consumer/use.ts`,')
    expect(
      await repairPlan({
        body: original,
        findings: [error('uncovered importer and pinned file')],
        importers: () => importers,
        renames: [],
        validate: async () => {
          throw new Error('must preserve the pinned work before grading')
        }
      })
    ).toBeNull()
  })

  test('replaces an exact renamed path and rechecks the whole body', async () => {
    const repaired = await repairPlan({
      body,
      findings: [error('missing pin')],
      importers: () => [],
      renames: [{ from: 'src/module.ts', to: 'src/renamed.ts' }],
      validate: async () => []
    })
    expect(repaired?.body).toContain('`src/renamed.ts`')
    expect(repaired?.body).not.toContain('`src/module.ts`')
  })

  test('refuses objective edits and Surface in changes even when the candidate gate would pass', async () => {
    const pinnedObjective = body.replace('Preserve the objective.', 'Preserve `src/module.ts`.')
    expect(
      await repairPlan({
        body: pinnedObjective,
        findings: [error('missing')],
        importers: () => [],
        renames: [{ from: 'src/module.ts', to: 'src/renamed.ts' }],
        validate: async () => {
          throw new Error('must refuse before grading')
        }
      })
    ).toBeNull()
    expect(repairPreservesScope(body, body.replace('in: src', 'in: src, consumer'))).toBe(false)
    expect(repairPreservesScope(body, body.replace('O1. Preserve', 'O1. Alter'))).toBe(false)
  })

  test('requires git R100 and a still-identical destination blob, never a delete/add guess', () => {
    const root = fixtureDir('plan-repair-renames-')
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    writeFileSync(join(root, 'old.ts'), 'export const original = 1\n')
    git('add', '.')
    git('commit', '-qm', 'seed')
    git('mv', 'old.ts', 'new.ts')
    git('commit', '-qam', 'rename')
    expect(readUnchangedRenames(root)).toEqual([{ from: 'old.ts', to: 'new.ts' }])
    writeFileSync(join(root, 'new.ts'), 'export const changed = 2\n')
    git('commit', '-qam', 'change content')
    expect(readUnchangedRenames(root)).toEqual([])
    git('mv', 'new.ts', 'changed.ts')
    writeFileSync(join(root, 'changed.ts'), 'export const entirelyDifferent = true\n')
    git('add', '.')
    git('commit', '-qm', 'rename with changed content')
    expect(readUnchangedRenames(root)).toEqual([])
  })
})

describe('bounded dependency wait', () => {
  test('only a premise deferred to the pending dependency waits; due premises still refuse', () => {
    const body = '## Premises\n- after #9: `src/dependency.ts` contains `created`\n'
    const read = () => null
    expect(dispatchPremiseRefusals(body, 'revision', 'all', read, [9])).toEqual([])
    expect(dispatchPremiseRefusals(body, 'revision', 'all', read)).toHaveLength(1)
    expect(
      dispatchPremiseRefusals(`${body}- \`src/existing.ts\` contains \`due now\`\n`, 'revision', 'all', read, [9])
    ).toHaveLength(1)
  })
  test('uses fixed intervals and returns the final check at the total bound', async () => {
    let now = 0
    let checks = 0
    const sleeps: number[] = []
    const result = await waitForDependencies(
      () => ++checks,
      () => true,
      {
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms)
          now += ms
        }
      }
    )
    expect(now).toBe(DEPENDENCY_WAIT_BOUND_MS)
    expect(sleeps.every((ms) => ms === DEPENDENCY_WAIT_INTERVAL_MS)).toBe(true)
    expect(result).toBe(sleeps.length + 1)
  })
})
