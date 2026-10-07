/**
 * The real-runtime-directory observer, shared by `real-runtime-guard.test.ts`
 * (the detector's own test, and a mid-run check) and `test-env-preload.ts`
 * (the end-of-run check every test process carries, so each CI shard and each
 * local run is covered, not just the process the guard test happens to be
 * listed in). Metadata only (`lstat`) — never a file's contents. It imports
 * nothing from `src/`, so it adds no dependent to any module's test selection.
 *
 * Every entry whose mtime/ctime is at or after this process's own start was
 * written during this run. Two paths are exempt, only when `VINAYA_TASK` says a
 * dispatched run is live, because that run legitimately writes them while its
 * own suite runs: `tasks-execution/<VINAYA_TASK>` and `tasks-execution/unscoped`.
 * A task whose `tasks-execution/<task>/driver.pid.json` names a running process
 * is live too: its folder and its `logs/<task>.ndjson` are exempt, since another
 * loop on this host writes them. A dead pid is not live and stays flagged.
 */
import { execFileSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

export const PROCESS_START_MS = Date.now() - process.uptime() * 1000 - 1000

/**
 * The real runtime directory, `~/.vinaya/runtime/<owner>-<repo>`, resolved from
 * the default home — never from `VINAYA_RUNTIME_DIR`, which a test or a
 * dispatched run may point elsewhere. The repository comes from `AEG_REPO`,
 * else `origin`, as `run-paths.ts` resolves it; it is derived here rather than
 * imported so this adds no dependent to the path resolver's own test selection.
 */
export function realRuntimeDir(): string {
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

export function exemptPrefixes(env: NodeJS.ProcessEnv): string[] {
  const task = env.VINAYA_TASK
  if (!task) return []
  return [join('tasks-execution', task), join('tasks-execution', 'unscoped')]
}

function pidRunning(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Exempt prefixes for every task under `root` whose lock names a running process. */
export function liveTaskPrefixes(root: string): string[] {
  let tasks: string[]
  try {
    tasks = readdirSync(join(root, 'tasks-execution'))
  } catch {
    return []
  }
  const out: string[] = []
  for (const task of tasks) {
    try {
      const lock = JSON.parse(readFileSync(join(root, 'tasks-execution', task, 'driver.pid.json'), 'utf-8'))
      if (pidRunning(lock?.pid)) out.push(join('tasks-execution', task), join('logs', `${task}.ndjson`))
    } catch {
      // no readable lock — not live
    }
  }
  return out
}

/** Paths (relative to `root`) touched since `sinceMs`; `[]` when the directory does not exist. */
export function touchedSince(root: string, sinceMs: number, exempt: string[]): string[] {
  const touched: string[] = []
  const exemptAll = [...exempt, ...liveTaskPrefixes(root)]
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
      if (exemptAll.some((p) => rel === p || rel.startsWith(`${p}/`))) continue
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
