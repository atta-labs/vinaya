// The fixed JUnit report path each bunfig.toml names is pointed, once per process, at the scheduler's report or at
// a new stored report with its run note; stored reports are read back with their notes.
import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  JUNIT_LINK_DIR,
  JUNIT_REPORT_ENV,
  junitFileResults,
  junitLinkName,
  linkJunitReport,
  ownedByAncestor,
  storedJunitReports
} from './junit-store'

function repository(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'junit-store-')))
  const env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, env, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  mkdirSync(join(dir, 'pkg'))
  writeFileSync(join(dir, 'pkg/a.test.ts'), 'export {}\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'one')
  return dir
}

describe('the JUnit report link', () => {
  it('names one fixed file per run folder', () => {
    expect(junitLinkName('.')).toBe('root.xml')
    expect(junitLinkName('')).toBe('root.xml')
    expect(junitLinkName('harness/processes/vinaya-strict')).toBe('harness-processes-vinaya-strict.xml')
  })

  it('points at the scheduler report when one is named, once per process, and hides it from child runs', () => {
    const dir = repository()
    try {
      const report = join(dir, 'scheduler.xml')
      const env: NodeJS.ProcessEnv = { [JUNIT_REPORT_ENV]: report } as NodeJS.ProcessEnv
      expect(linkJunitReport(join(dir, 'pkg'), env)).toBe(report)
      expect(readlinkSync(join(dir, JUNIT_LINK_DIR, 'pkg.xml'))).toBe(report)
      expect(env[JUNIT_REPORT_ENV]).toBeUndefined()
      // An isolated file's preload in the same process leaves the link alone.
      expect(linkJunitReport(join(dir, 'pkg'), { ...env, [JUNIT_REPORT_ENV]: join(dir, 'other.xml') })).toBeNull()
      expect(readlinkSync(join(dir, JUNIT_LINK_DIR, 'pkg.xml'))).toBe(report)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('otherwise stores a new report under the git directory with the commit, the folder and a clean flag', () => {
    const dir = repository()
    try {
      const target = linkJunitReport(dir, {} as NodeJS.ProcessEnv)
      expect(target).not.toBeNull()
      const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: dir, encoding: 'utf8' }).trim()
      expect((target as string).startsWith(join(gitDir, 'vinaya/junit/'))).toBe(true)
      writeFileSync(target as string, '<testsuites></testsuites>\n')
      const stored = storedJunitReports(gitDir)
      expect(stored).toHaveLength(1)
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
      expect(stored[0]?.note).toMatchObject({ version: 1, head, cwd: '.', clean: true })
      expect(readFileSync(join(dir, JUNIT_LINK_DIR, 'root.xml'), 'utf8')).toBe('<testsuites></testsuites>\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a run a test starts in the same folder leaves the outer run’s link alone; an unrelated or ended run does not', () => {
    const dir = repository()
    try {
      const report = join(dir, 'outer.xml')
      expect(linkJunitReport(dir, { [JUNIT_REPORT_ENV]: report } as NodeJS.ProcessEnv)).toBe(report)
      const owner = join(dir, JUNIT_LINK_DIR, 'root.xml.owner')
      expect(readFileSync(owner, 'utf8').trim()).toBe(String(process.pid))
      // A real nested process: its parent (this test process) owns the link, so it links nothing.
      const nested = Bun.spawnSync([
        'bun',
        '-e',
        `const m = await import(${JSON.stringify(join(import.meta.dir, 'junit-store.ts'))}); console.log(JSON.stringify(m.linkJunitReport(${JSON.stringify(dir)}, {})))`
      ])
      expect(nested.stdout.toString().trim()).toBe('null')
      expect(readlinkSync(join(dir, JUNIT_LINK_DIR, 'root.xml'))).toBe(report)
      // A live process that is no ancestor of this one does not hold the link.
      const other = Bun.spawn(['sleep', '30'])
      try {
        writeFileSync(owner, `${other.pid}\n`)
        expect(ownedByAncestor(owner)).toBe(false)
      } finally {
        other.kill()
      }
      // A mark left by a run that ended is ignored.
      writeFileSync(owner, `${Bun.spawnSync(['true']).pid}\n`)
      expect(ownedByAncestor(owner)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a real Bun run filtered by -t, or with a skip or a todo, counts no file passed but the fully run one', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'junit-store-real-')))
    try {
      writeFileSync(
        join(dir, 'filtered.test.ts'),
        "import { it } from 'bun:test'\nit('keep a', () => {})\nit('drop a', () => {})\n"
      )
      writeFileSync(join(dir, 'whole.test.ts'), "import { it } from 'bun:test'\nit('keep b', () => {})\n")
      writeFileSync(
        join(dir, 'skip.test.ts'),
        "import { it } from 'bun:test'\nit('keep c', () => {})\nit.skip('keep d', () => {})\n"
      )
      writeFileSync(
        join(dir, 'todo.test.ts'),
        "import { it } from 'bun:test'\nit('keep e', () => {})\nit.todo('keep f')\n"
      )
      const out = join(dir, 'report.xml')
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env))
        if (value !== undefined && !key.startsWith('VINAYA_') && !key.startsWith('GIT_')) env[key] = value
      const run = Bun.spawnSync(
        [
          'bun',
          'test',
          '-t',
          'keep',
          '--reporter=junit',
          `--reporter-outfile=${out}`,
          './filtered.test.ts',
          './whole.test.ts',
          './skip.test.ts',
          './todo.test.ts'
        ],
        { cwd: dir, env }
      )
      expect(run.exitCode).toBe(0)
      const results = junitFileResults(readFileSync(out, 'utf8'))
      expect(results).not.toBeNull()
      const passed = Object.fromEntries((results ?? []).map((r) => [r.file.replace(/^\.\//, ''), r.passed]))
      expect(passed).toEqual({
        'filtered.test.ts': false,
        'whole.test.ts': true,
        'skip.test.ts': false,
        'todo.test.ts': false
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('outside a repository does nothing and never throws', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'junit-store-none-')))
    try {
      expect(linkJunitReport(dir, {} as NodeJS.ProcessEnv)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
