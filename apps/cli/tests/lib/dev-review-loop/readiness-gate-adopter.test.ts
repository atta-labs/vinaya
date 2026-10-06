import { beforeAll, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveGateStep } from '../../../src/checks/registry.js'
import { checkTaskDispatchReadiness } from '../../../src/lib/dev-review-loop/developer-dispatch.js'

const PKG = join(import.meta.dir, '..', '..', '..')
const DIST_INDEX = pathToFileURL(join(PKG, 'dist', 'index.js')).href

beforeAll(() => {
  const built = spawnSync('bun', ['scripts/build.ts'], { cwd: PKG, encoding: 'utf8' })
  if (built.status !== 0) throw new Error(`build failed: ${built.stderr}`)
}, 120_000)

describe('readiness gate outside this repository', () => {
  it('finds both steps in the built distribution and runs them from a foreign directory without a module error', () => {
    const readiness = resolveGateStep('check-dispatch-readiness', PKG, DIST_INDEX)
    const existingWork = resolveGateStep('verify-dispatch', PKG, DIST_INDEX)
    expect(readiness).toBe(join(PKG, 'dist', 'checks', 'bin', 'check-dispatch-readiness.js'))
    expect(existingWork).toBe(join(PKG, 'dist', 'checks', 'bin', 'verify-dispatch.js'))
    const cwd = mkdtempSync(join(tmpdir(), 'vinaya-adopter-'))
    try {
      for (const script of [readiness, existingWork]) {
        const ran = spawnSync(
          'bun',
          [script as string, '--issue', '1', ...(script === existingWork ? ['--existing-work'] : [])],
          {
            cwd,
            encoding: 'utf8',
            timeout: 60_000
          }
        )
        const out = `${ran.stdout}${ran.stderr}`
        expect(out).not.toContain('Module not found')
        expect(out).not.toContain('Cannot find module')
        expect(out.trim().length).toBeGreaterThan(0)
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 120_000)

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
