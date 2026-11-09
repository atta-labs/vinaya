// The fixed JUnit report path each bunfig.toml names is pointed, once per process, at the scheduler's report or at
// a new stored report with its run note; stored reports are read back with their notes.
import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JUNIT_LINK_DIR, JUNIT_REPORT_ENV, junitLinkName, linkJunitReport, storedJunitReports } from './junit-store'

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

  it('outside a repository does nothing and never throws', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'junit-store-none-')))
    try {
      expect(linkJunitReport(dir, {} as NodeJS.ProcessEnv)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
