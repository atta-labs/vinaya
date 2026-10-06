/**
 * Guard: no test in this suite may create or change a file under the REAL
 * per-repository runtime directory (`~/.vinaya/runtime/<owner>-<repo>`).
 * Leaks of that kind outlive the test run — they showed up as task folders
 * numbered like fixtures (9, 9001, 9201) that the start-up sweep then logged
 * forge errors for on every loop start.
 *
 * It observes the directory by metadata only (`lstat`, never a file's
 * contents): every entry whose mtime/ctime is at or after this process's own
 * start was written during this `bun test` run. Two paths are exempt because
 * a dispatched run legitimately writes them while its own suite runs:
 * `tasks-execution/<VINAYA_TASK>` (this run's own folder) and
 * `tasks-execution/unscoped`, and only when that env says a run is live.
 *
 * `bun test` runs its files one after another in one process, so this sees
 * everything written by the files that ran before it.
 */
import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const PROCESS_START_MS = Date.now() - process.uptime() * 1000 - 1000

/**
 * The real runtime directory, `~/.vinaya/runtime/<owner>-<repo>`, resolved from
 * the default home — never from `VINAYA_RUNTIME_DIR`, which a test or a
 * dispatched run may point elsewhere. The repository comes from `AEG_REPO`,
 * else `origin`, as `run-paths.ts` resolves it; it is derived here rather than
 * imported so this file adds no dependent to the path resolver's own test
 * selection.
 */
function realRuntimeDir(): string {
  let owner: string | undefined
  let repo: string | undefined
  const fromEnv = /^([^/]+)\/(.+)$/.exec(process.env.AEG_REPO ?? '')
  if (fromEnv) [, owner, repo] = fromEnv
  else {
    try {
      const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url)
      if (m) [, owner, repo] = m
    } catch {
      // no origin — the directory below is simply one that does not exist
    }
  }
  return join(homedir(), '.vinaya', 'runtime', owner && repo ? `${owner}-${repo}` : 'unresolved')
}

function exemptPrefixes(env: NodeJS.ProcessEnv): string[] {
  const task = env.VINAYA_TASK
  if (!task) return []
  return [join('tasks-execution', task), join('tasks-execution', 'unscoped')]
}

/** Paths (relative to `root`) touched since `sinceMs`; `[]` when the directory does not exist. */
function touchedSince(root: string, sinceMs: number, exempt: string[]): string[] {
  const touched: string[] = []
  const walk = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      const rel = relative(root, full)
      if (exempt.some((p) => rel === p || rel.startsWith(`${p}/`))) continue
      let st: ReturnType<typeof lstatSync>
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      if (st.mtimeMs >= sinceMs || st.ctimeMs >= sinceMs) touched.push(rel)
      if (st.isDirectory()) walk(full)
    }
  }
  walk(root)
  return touched
}

/**
 * Taken at module load rather than inside the test, so the test's own TITLE
 * names the leaked paths: a failing run's summary lists failing titles but not
 * their assertion output, and a title is what a reader of a long CI log sees.
 */
const leakedAtLoad = touchedSince(realRuntimeDir(), PROCESS_START_MS, exemptPrefixes(process.env))
const TITLE = 'no test so far has written into the real runtime directory'
const title = leakedAtLoad.length > 0 ? `${TITLE} — LEAKED: ${leakedAtLoad.join(' ').slice(0, 800)}` : TITLE

describe('real runtime directory guard', () => {
  it(title, () => {
    expect(touchedSince(realRuntimeDir(), PROCESS_START_MS, exemptPrefixes(process.env))).toEqual([])
  })

  it('detects a write newer than the cutoff and ignores exempt paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'real-runtime-guard-'))
    try {
      mkdirSync(join(root, 'tasks-execution', '7'), { recursive: true })
      mkdirSync(join(root, 'tasks-execution', '9'), { recursive: true })
      writeFileSync(join(root, 'tasks-execution', '7', 'a'), 'x')
      writeFileSync(join(root, 'tasks-execution', '9', 'b'), 'x')
      const found = touchedSince(root, Date.now() - 60_000, [join('tasks-execution', '7')])
      expect(found).toContain(join('tasks-execution', '9', 'b'))
      expect(found.some((p) => p.startsWith(join('tasks-execution', '7')))).toBe(false)
      expect(touchedSince(root, Date.now() + 60_000, [])).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
