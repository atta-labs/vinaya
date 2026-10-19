import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { type CheckError, CHECK_SCHEMA_VERSION } from '../../src/checks/contract'
import { spawnBudgetedAsync, stripVinayaEnv } from '../lib/process-fixture'

/**
 * `check-dead-branch-push.ts` spawned with a fake `gh` first on `PATH`: the
 * forge's answer decides the exit code, and only an unanswered read (a failed
 * `gh`, output that does not parse) writes a `warning` finding.
 */
const BIN = join(import.meta.dir, '../../src/checks/bin/check-dead-branch-push.ts')
const BRANCH = 'task/some-tranche/1'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

type Forge = { kind: 'fail' } | { kind: 'output'; text: string }

async function run(forge: Forge): Promise<{ exitCode: number; errors: CheckError[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'dead-branch-push-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' })
  const ghDir = join(dir, 'fakebin')
  mkdirSync(ghDir)
  const body =
    forge.kind === 'fail'
      ? "process.stderr.write('error connecting to api.github.com\\n')\nprocess.exit(1)"
      : `process.stdout.write(${JSON.stringify(forge.text)})`
  writeFileSync(join(ghDir, 'gh'), `#!/usr/bin/env bun\n${body}\n`)
  chmodSync(join(ghDir, 'gh'), 0o755)
  const { status, stderr } = await spawnBudgetedAsync(['bun', BIN], {
    cwd: dir,
    env: { ...stripVinayaEnv(), PATH: `${ghDir}:${process.env.PATH}`, BRANCH }
  })
  const errors = stderr
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as CheckError)
  for (const e of errors) expect(e.schema).toBe(CHECK_SCHEMA_VERSION)
  return { exitCode: status, errors }
}

const entry = (state: string) => ({ kind: 'output', text: JSON.stringify([{ number: 5, state }]) }) as const

describe('dead-branch-push bin', () => {
  it('a failing gh allows the push with one warning naming the unvouched push', async () => {
    const r = await run({ kind: 'fail' })
    expect(r.exitCode).toBe(0)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]?.severity).toBe('warning')
    expect(r.errors[0]?.message).toContain('could not vouch')
    expect(r.errors[0]?.message).toContain('forge')
  })

  it('malformed JSON allows the push with one warning', async () => {
    const r = await run({ kind: 'output', text: 'not json' })
    expect(r.exitCode).toBe(0)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]?.severity).toBe('warning')
  })

  it('an open pull request exits 0 with no finding', async () => {
    const r = await run(entry('OPEN'))
    expect(r).toEqual({ exitCode: 0, errors: [] })
  })

  it('no pull request exits 0 with no finding', async () => {
    const r = await run({ kind: 'output', text: '[]' })
    expect(r).toEqual({ exitCode: 0, errors: [] })
  })

  for (const state of ['MERGED', 'CLOSED']) {
    it(`a ${state} pull request refuses with one error`, async () => {
      const r = await run(entry(state))
      expect(r.exitCode).toBe(1)
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0]?.severity).toBe('error')
    })
  }
})
