import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentVendor } from '../../src/lib/agent-vendors.js'
import { buildInitOps } from '../../src/lib/artifacts.js'
import { PROCESS_FIXTURE_BUDGET_MS, stripVinayaEnv } from './process-fixture.js'
import { fixtureDir } from './test-temp-fixture.js'
import { ADOPTER_TEST_RUNNER, NO_LOCAL_TESTS_MARKER, readyTestCommand } from '../../src/lib/pre-push-test-runner.js'

// The adopter test-runner contract, as the generated pre-push hook carries it: in its ready mode the hook runs the
// repository's declared runner, or prints the no-local-tests line; every other push is unchanged; no toolchain is
// assumed.

const prePush = (selfHost: Parameters<typeof buildInitOps>[0]['selfHost']): string => {
  const op = buildInitOps({
    owner: 'acme',
    repo: 'widget',
    hookDir: '.husky',
    selfHost,
    ciSetup: null,
    agents: new Set<AgentVendor>()
  }).find((candidate) => candidate.kind === 'managed-block' && candidate.path.endsWith('/pre-push'))
  if (op?.kind !== 'managed-block') throw new Error('no pre-push hook generated')
  return op.body
}

/** Runs the adopter hook body in a throwaway repository, with a stand-in `npx` for the doctrine gate. */
function runAdopterHook(mode: string, runner: string | null): { status: number | null; out: string; ran: boolean } {
  const dir = fixtureDir('adopter-hook-')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'npx'), 0o755)
  if (runner !== null) {
    mkdirSync(join(dir, '.vinaya'))
    writeFileSync(join(dir, ADOPTER_TEST_RUNNER), `#!/bin/sh\ntouch runner-ran\n${runner}\n`)
    chmodSync(join(dir, ADOPTER_TEST_RUNNER), 0o755)
  }
  const run = spawnSync('sh', ['-c', prePush(null)], {
    cwd: dir,
    input: 'refs/heads/b 1 refs/heads/b 0\n',
    encoding: 'utf8',
    env: { ...stripVinayaEnv({ PATH: `${bin}:/usr/bin:/bin` }), VINAYA_PUSH_MODE: mode },
    timeout: PROCESS_FIXTURE_BUDGET_MS,
    killSignal: 'SIGKILL'
  })
  const ran = existsSync(join(dir, 'runner-ran'))
  return { status: run.status, out: `${run.stdout}${run.stderr}`, ran }
}

describe('the adopter pre-push hook and its test runner', () => {
  test('a ready push with no declared runner prints the no-local-tests line and passes', () => {
    const result = runAdopterHook('ready', null)
    expect(result.status).toBe(0)
    expect(result.out).toContain(NO_LOCAL_TESTS_MARKER)
  })

  test('a ready push runs the declared runner; its exit status is the verdict', () => {
    const green = runAdopterHook('ready', 'exit 0')
    expect(green.status).toBe(0)
    expect(green.ran).toBe(true)
    expect(green.out).not.toContain(NO_LOCAL_TESTS_MARKER)
    const red = runAdopterHook('ready', 'exit 3')
    expect(red.status).toBe(1)
    expect(red.out).toContain('the declared test runner')
  })

  test('every other push is unchanged: the runner is not run and nothing is printed about tests', () => {
    const result = runAdopterHook('default', 'exit 1')
    expect(result.status).toBe(0)
    expect(result.ran).toBe(false)
    expect(result.out).not.toContain(NO_LOCAL_TESTS_MARKER)
  })

  test('the adopter hook assumes no toolchain: no bun, biome or turbo', () => {
    const body = prePush(null)
    expect(body).not.toMatch(/\bbun\b|\bbunx\b|biome|turbo/)
  })
})

describe('the ready test command', () => {
  test('is the exact text the vendored hook builds and caches as its test command', () => {
    const body = prePush({ dir: 'apps/cli', bin: 'apps/cli/dist/index.js' } as never)
    expect(body).toContain(`VINAYA_TEST_CMD="${readyTestCommand([]).trimEnd()} $(printf`)
  })
})
