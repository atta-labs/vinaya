import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { doctrineCommand, ENTRY_SEGMENTS, resolveDoctrineRoot } from '../src/commands/doctrine.js'

const CLI_ENTRY = join(import.meta.dir, '..', 'src', 'index.ts')

// NOT in the same file as doctrine-pointer.test.ts, deliberately: that file
// mock.module()s package-root.js, and this command needs the real resolver.

/** Capture process.stdout.write output during `fn`, returning the output. */
function captureStdout(fn: () => void): string {
  const original = process.stdout.write.bind(process.stdout)
  let buf = ''
  process.stdout.write = ((chunk: string) => {
    buf += chunk
    return true
  }) as typeof process.stdout.write
  try {
    fn()
  } finally {
    process.stdout.write = original
  }
  return buf
}

describe('vinaya doctrine', () => {
  it('prints an absolute front-door path that exists on this machine', () => {
    const printed = captureStdout(() => doctrineCommand([])).trim()
    expect(isAbsolute(printed)).toBe(true)
    expect(printed.endsWith(join('aeg-root', 'skills', 'aeg', 'SKILL.md'))).toBe(true)
    expect(existsSync(printed)).toBe(true)
  })

  it('--json emits the envelope with a coherent root/entry pair', () => {
    const out = captureStdout(() => doctrineCommand(['--json']))
    const parsed = JSON.parse(out)
    expect(parsed.schema).toBe(1)
    expect(parsed.data.entry).toBe(join(parsed.data.root, 'skills', 'aeg', 'SKILL.md'))
    expect(existsSync(parsed.data.entry)).toBe(true)
  })

  it('--role <name> resolves straight to roles/<name>.md under the same root', () => {
    const root = resolveDoctrineRoot()
    if (root === null) throw new Error('no doctrine root on this machine — cannot exercise --role')
    const [firstRole] = readdirSync(join(root, 'roles'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .sort()
    if (firstRole === undefined) throw new Error('no role files found under aeg-root/roles')

    const printed = captureStdout(() => doctrineCommand(['--role', firstRole])).trim()
    expect(isAbsolute(printed)).toBe(true)
    expect(printed).toBe(join(root, 'roles', `${firstRole}.md`))
    expect(existsSync(printed)).toBe(true)
  })

  it('--role <name> --json emits the envelope with a coherent root/entry pair', () => {
    const root = resolveDoctrineRoot()
    if (root === null) throw new Error('no doctrine root on this machine — cannot exercise --role')
    const [firstRole] = readdirSync(join(root, 'roles'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .sort()
    if (firstRole === undefined) throw new Error('no role files found under aeg-root/roles')

    const out = captureStdout(() => doctrineCommand(['--role', firstRole, '--json']))
    const parsed = JSON.parse(out)
    expect(parsed.schema).toBe(1)
    expect(parsed.data.entry).toBe(join(parsed.data.root, 'roles', `${firstRole}.md`))
    expect(existsSync(parsed.data.entry)).toBe(true)
  })

  it('--role <bad-name> fails cleanly, listing the live-enumerated valid role names', async () => {
    const proc = Bun.spawn(['bun', CLI_ENTRY, 'doctrine', '--role', 'nonsense-name'], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()

    expect(exitCode).toBe(1)
    expect(stderr).toContain("'nonsense-name' is not a known role")
    expect(stderr).toContain('reviewer')
    expect(stderr).toContain('developer')
  })

  it('--role with no name attached fails cleanly rather than swallowing the next flag', async () => {
    const proc = Bun.spawn(['bun', CLI_ENTRY, 'doctrine', '--role'], {
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()

    expect(exitCode).toBe(1)
    expect(stderr).toContain('is not a known role')
  })
})

// Synthetic-fixture coverage of every resolution shape — the live tests above
// can only ever exercise whichever shape this workspace happens to be in
// (here: the vendored `../../aeg-root` fallback).
describe('resolveDoctrineRoot', () => {
  let base: string

  const seedDoctrine = (root: string) => {
    const entryDir = join(root, 'skills', 'aeg')
    mkdirSync(entryDir, { recursive: true })
    writeFileSync(join(entryDir, 'SKILL.md'), '# fixture front door\n')
  }

  beforeEach(() => {
    base = join(tmpdir(), `vinaya-doctrine-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(base, { recursive: true })
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('resolves the published-tarball shape: the package root’s own bundled aeg-root', () => {
    const pkg = join(base, 'node_modules', '@attalabs', 'vinaya')
    seedDoctrine(join(pkg, 'aeg-root'))
    expect(resolveDoctrineRoot(pkg)).toBe(join(pkg, 'aeg-root'))
  })

  it('resolves the vendored dev shape: the monorepo root’s aeg-root two levels up', () => {
    const pkg = join(base, 'apps', 'cli')
    mkdirSync(pkg, { recursive: true })
    seedDoctrine(join(base, 'aeg-root'))
    expect(resolveDoctrineRoot(pkg)).toBe(join(base, 'aeg-root'))
  })

  it('returns null when no doctrine exists at either candidate', () => {
    const pkg = join(base, 'apps', 'cli')
    mkdirSync(pkg, { recursive: true })
    expect(resolveDoctrineRoot(pkg)).toBeNull()
  })

  it('never walks out of a node_modules install: a squatting sibling aeg-root package is not doctrine', () => {
    // A broken tarball (no bundled aeg-root) next to a dependency that
    // happens to be named `aeg-root` and ships the front-door file — the
    // prompt-injection shape the fallback restriction exists to close.
    const pkg = join(base, 'node_modules', '@attalabs', 'vinaya')
    mkdirSync(pkg, { recursive: true })
    seedDoctrine(join(base, 'node_modules', 'aeg-root'))
    expect(resolveDoctrineRoot(pkg)).toBeNull()
  })

  it('front-door constant matches what every resolver probe and the generated pointer name', () => {
    expect(join(...ENTRY_SEGMENTS)).toBe(join('skills', 'aeg', 'SKILL.md'))
  })
})
