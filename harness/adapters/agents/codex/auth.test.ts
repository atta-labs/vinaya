import { describe, expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { operatorCodexAuthPath, stageCodexAuth } from './auth'

const tempHome = (withLogin: boolean) => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
  if (withLogin) {
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'auth.json'), '{"tokens":"t"}')
  }
  return home
}

describe('stageCodexAuth', () => {
  test("copies the operator's ~/.codex/auth.json into the generated home with mode 0600", () => {
    const home = tempHome(true)
    const generated = join(mkdtempSync(join(tmpdir(), 'gen-')), 'developer')
    const staged = stageCodexAuth(generated, { env: {}, home })
    expect(staged).toBe(join(generated, 'auth.json'))
    expect(readFileSync(staged, 'utf8')).toBe('{"tokens":"t"}')
    expect(lstatSync(staged).isSymbolicLink()).toBe(false)
    expect(statSync(staged).mode & 0o777).toBe(0o600)
  })

  test('honours an existing CODEX_HOME', () => {
    const home = tempHome(false)
    const codexHome = mkdtempSync(join(tmpdir(), 'op-codex-'))
    writeFileSync(join(codexHome, 'auth.json'), 'from-env')
    expect(operatorCodexAuthPath({ CODEX_HOME: codexHome }, home)).toBe(join(codexHome, 'auth.json'))
    const generated = mkdtempSync(join(tmpdir(), 'gen-'))
    expect(readFileSync(stageCodexAuth(generated, { env: { CODEX_HOME: codexHome }, home }), 'utf8')).toBe('from-env')
  })

  test('no login fails naming the path', () => {
    const home = tempHome(false)
    expect(() => stageCodexAuth(mkdtempSync(join(tmpdir(), 'gen-')), { env: {}, home })).toThrow(
      join(home, '.codex', 'auth.json')
    )
  })
})

describe('createRoleLauncher stages the Codex login', () => {
  test('a Codex launch whose CODEX_HOME is the generated dir gets auth.json; without the opt-in it does not', async () => {
    const { createRoleLauncher } = await import('../../../dev-process/engine-runtime/run-process')
    const opHome = mkdtempSync(join(tmpdir(), 'op-codex-'))
    writeFileSync(join(opHome, 'auth.json'), 'login')
    const saved = process.env.CODEX_HOME
    process.env.CODEX_HOME = opHome
    try {
      for (const stage of [true, false]) {
        const generatedDir = mkdtempSync(join(tmpdir(), 'gen-'))
        createRoleLauncher(
          {
            vendor: 'codex',
            launch: ['codex'],
            env: { CODEX_HOME: generatedDir },
            files: {},
            executableFiles: []
          } as never,
          { generatedDir, allowedPermissions: [], stageCodexLogin: stage }
        )
        const { existsSync } = await import('node:fs')
        expect(existsSync(join(generatedDir, 'auth.json'))).toBe(stage)
      }
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = saved
    }
  })
})

describe('createRoleLauncher stageCodexLogin guard', () => {
  const launch = async (config: Record<string, unknown>, generatedDir: string) => {
    const { createRoleLauncher } = await import('../../../dev-process/engine-runtime/run-process')
    return createRoleLauncher({ launch: ['x'], files: {}, executableFiles: [], ...config } as never, {
      generatedDir,
      allowedPermissions: [],
      stageCodexLogin: true
    })
  }
  const withCodexHome = async (value: string, run: () => Promise<void>) => {
    const saved = process.env.CODEX_HOME
    process.env.CODEX_HOME = value
    try {
      await run()
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = saved
    }
  }

  test('a missing operator login fails the launch, naming the path', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'op-empty-'))
    await withCodexHome(empty, async () => {
      const generatedDir = mkdtempSync(join(tmpdir(), 'gen-'))
      await expect(launch({ vendor: 'codex', env: { CODEX_HOME: generatedDir } }, generatedDir)).rejects.toThrow(
        join(empty, 'auth.json')
      )
    })
  })

  test('nothing is staged for Claude or for a Codex home that is not the generated dir', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'op-empty-'))
    await withCodexHome(empty, async () => {
      const generatedDir = mkdtempSync(join(tmpdir(), 'gen-'))
      await launch({ vendor: 'claude-code', env: {} }, generatedDir)
      await launch({ vendor: 'codex', env: { CODEX_HOME: '/elsewhere' } }, generatedDir)
      const { existsSync } = await import('node:fs')
      expect(existsSync(join(generatedDir, 'auth.json'))).toBe(false)
    })
  })
})
