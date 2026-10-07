import { beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveGateStep } from '../../../src/checks/registry.js'
import { spawnSyncBudgeted, stripVinayaEnv } from '../process-fixture'
import { checkTaskDispatchReadiness } from '../../../src/lib/dev-review-loop/developer-dispatch.js'

const PKG = join(import.meta.dir, '..', '..', '..')
const DIST_INDEX = pathToFileURL(join(PKG, 'dist', 'index.js')).href

beforeAll(() => {
  const built = spawnSyncBudgeted(
    'bun',
    ['scripts/build.ts'],
    { cwd: PKG, encoding: 'utf8', env: stripVinayaEnv() },
    90_000
  )
  if (built.status !== 0) throw new Error(`build failed: ${built.stderr}`)
}, 120_000)

describe('readiness gate outside this repository', () => {
  it('runs the gate itself from a foreign directory against the built distribution and reaches a verdict', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'vinaya-adopter-'))
    const prev = process.cwd()
    try {
      process.chdir(cwd)
      const result = checkTaskDispatchReadiness(
        'task/issue-1',
        undefined,
        () => ({ control: 'local-gate', active: true, detail: '', remedy: '' }),
        (step) => resolveGateStep(step, PKG, DIST_INDEX)
      )
      expect(typeof result.ready).toBe('boolean')
      expect(result.output).toContain(
        `$ bun ${join(PKG, 'dist', 'checks', 'bin', 'check-dispatch-readiness.js')} --issue 1`
      )
      expect(result.output).toContain(
        `$ bun ${join(PKG, 'dist', 'checks', 'bin', 'verify-dispatch.js')} --issue 1 --existing-work`
      )
      expect(result.output).not.toContain('Module not found')
      expect(result.output).not.toContain('Cannot find module')
      expect(result.output).not.toContain('incomplete')
    } finally {
      process.chdir(prev)
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 120_000)

  it('is not ready, naming the missing step and the incomplete package, when a step cannot be found', () => {
    const result = checkTaskDispatchReadiness(
      'task/issue-1',
      () => 'ok',
      () => ({ control: 'local-gate', active: true, detail: '', remedy: '' }),
      (step) => (step === 'verify-dispatch' ? null : '/resolved/check-dispatch-readiness.js')
    )
    expect(result.ready).toBe(false)
    expect(result.output).toContain("gate step 'verify-dispatch' is missing")
    expect(result.output).toContain('installed @attalabs/vinaya package is incomplete')
    expect(result.output).not.toContain('Module not found')
  })

  it('passes the resolved step paths to the gate, never a cwd-relative source path', () => {
    const seen: string[] = []
    const result = checkTaskDispatchReadiness(
      'task/issue-1',
      (script) => {
        seen.push(script)
        return 'ok'
      },
      () => ({ control: 'local-gate', active: true, detail: '', remedy: '' })
    )
    expect(result.ready).toBe(true)
    expect(seen.length).toBe(2)
    for (const script of seen) {
      expect(existsSync(script)).toBe(true)
      expect(script.startsWith('/')).toBe(true)
    }
  })

  it('reports no path for a step missing from an incomplete package', () => {
    const empty = mkdtempSync(join(tmpdir(), 'vinaya-incomplete-'))
    try {
      expect(resolveGateStep('verify-dispatch', empty, pathToFileURL(join(empty, 'dist', 'index.js')).href)).toBeNull()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
