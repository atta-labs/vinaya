import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packageRoot } from '../src/lib/package-root'

describe('packageRoot', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `vinaya-package-root-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('resolves the nearest package.json above the calling module', () => {
    const pkgRoot = join(tmpDir, 'pkg')
    const moduleDir = join(pkgRoot, 'src', 'deep')
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'fixture-pkg' }))

    const result = packageRoot(pathToFileURL(join(moduleDir, 'mod.js')).href)

    expect(realpathSync(result)).toBe(realpathSync(pkgRoot))
  })

  it('does not walk past the enclosing git repository to a planted package.json', () => {
    // Security review, PR #94: same walk class as studio.ts/config.ts. When
    // no package.json exists inside the enclosing repo, the walk must stop
    // at the repo root rather than resolving a planted ancestor file.
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'planted' }))

    const innerRepo = join(tmpDir, 'inner-repo')
    const moduleDir = join(innerRepo, 'deep')
    mkdirSync(moduleDir, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: innerRepo })

    const result = packageRoot(pathToFileURL(join(moduleDir, 'mod.js')).href)

    expect(realpathSync(result)).toBe(realpathSync(innerRepo))
    expect(realpathSync(result)).not.toBe(realpathSync(tmpDir))
  })
})
