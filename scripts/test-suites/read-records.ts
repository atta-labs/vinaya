/**
 * Where a commit's read record is kept and how a selection reaches it.
 *
 * The recorder (`scripts/ci/record-reads.ts`) runs on every push to the default
 * branch and stores the record as a workflow run artifact named for the exact
 * commit. A caller that wants it fetches that artifact with `gh run download`
 * (which needs `actions: read`), keeps a copy under the git directory, and
 * hands the parsed record to the selection. Anything that goes wrong — no `gh`,
 * no login, no run for the commit, an expired artifact, a record for another
 * commit — gives no record, with the reason; a missing record is never read as
 * "no test reads anything".
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isReadRecord, type ReadRecord } from '../../harness/kernel/gates/ring0-hooks/pre-push/verification/index.js'

/** The file inside the artifact. */
export const RECORD_FILE = 'read-record.json'

/** The workflow whose default-branch run records the reads. */
export const RECORD_WORKFLOW = 'ci.yml'

/** The artifact that holds a commit's record. */
export const recordArtifactName = (commit: string): string => `read-record-${commit}`

/** Returns the record file's text for `commit`, or throws with the reason it could not be reached. */
export type RecordFetch = (commit: string) => string

function cleanEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(out)) if (key.startsWith('GIT_')) delete out[key]
  return out
}

/** The default fetch: the run of the commit's push on the default branch, then its artifact. */
export function ghRecordFetch(repoRoot: string): RecordFetch {
  return (commit) => {
    const gh = (args: string[]) =>
      execFileSync('gh', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        env: cleanEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000
      })
    let runs: { databaseId: number }[]
    try {
      const branch = (
        JSON.parse(gh(['repo', 'view', '--json', 'defaultBranchRef'])) as { defaultBranchRef: { name: string } }
      ).defaultBranchRef.name
      runs = JSON.parse(
        gh([
          'run',
          'list',
          '--branch',
          branch,
          '--workflow',
          RECORD_WORKFLOW,
          '--commit',
          commit,
          '--event',
          'push',
          '--json',
          'databaseId',
          '--limit',
          '5'
        ])
      ) as { databaseId: number }[]
    } catch (err) {
      throw new Error(`gh run list failed: ${(err as Error).message.split('\n')[0]}`)
    }
    if (runs.length === 0) throw new Error(`no ${RECORD_WORKFLOW} push run for ${commit}`)
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-read-record-'))
    try {
      for (const run of runs) {
        try {
          gh(['run', 'download', String(run.databaseId), '--name', recordArtifactName(commit), '--dir', dir])
          return readFileSync(join(dir, RECORD_FILE), 'utf8')
        } catch {}
      }
      throw new Error(`no run for ${commit} holds the ${recordArtifactName(commit)} artifact`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function cachePath(repoRoot: string, commit: string): string | null {
  try {
    const dir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'vinaya/read-records'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return dir ? join(dir, `${commit}.json`) : null
  } catch {
    return null
  }
}

/** Parses a record's text; `null` unless it is a valid record of exactly `commit`. */
export function parseRecordFor(text: string, commit: string): ReadRecord | null {
  try {
    const value = JSON.parse(text) as unknown
    return isReadRecord(value) && value.commit === commit ? value : null
  } catch {
    return null
  }
}

export type ReachedRecord = { record: ReadRecord | null; reason: string }

/** The record of exactly `commit`: the local copy when one is kept, else the fetched one (then kept). */
export function reachableRecord(
  repoRoot: string,
  commit: string,
  fetch: RecordFetch = ghRecordFetch(repoRoot)
): ReachedRecord {
  if (process.env.VINAYA_READ_RECORD === 'off')
    return { record: null, reason: 'record use is switched off (VINAYA_READ_RECORD=off)' }
  const path = cachePath(repoRoot, commit)
  if (path && existsSync(path)) {
    const kept = parseRecordFor(readFileSync(path, 'utf8'), commit)
    if (kept) return { record: kept, reason: 'the record kept under the git directory' }
  }
  let text: string
  try {
    text = fetch(commit)
  } catch (err) {
    return { record: null, reason: `no record is reachable: ${(err as Error).message.split('\n')[0]}` }
  }
  const record = parseRecordFor(text, commit)
  if (!record) return { record: null, reason: `the fetched record is not a valid record of ${commit}` }
  if (path) {
    try {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, text)
    } catch {}
  }
  return { record, reason: 'the record fetched from the commit run' }
}

/** How many first-parent commits, from the comparison commit back, a caller looks through for a record. */
export const RECORD_ANCESTOR_LIMIT = 10

/**
 * The record of the nearest commit at or before `commit` on its first-parent line that has one, looking through at
 * most `limit` commits. A record of an earlier commit is still a record: the selection compares its commit with the
 * base and leaves every test whose recorded paths changed in between to the static selection. A new default-branch
 * commit has no record until its recording run finishes, so the exact commit alone is rarely reachable.
 */
export function nearestReachableRecord(
  repoRoot: string,
  commit: string,
  fetch: RecordFetch = ghRecordFetch(repoRoot),
  limit: number = RECORD_ANCESTOR_LIMIT,
  ancestors: (commit: string, limit: number) => string[] = (c, n) => firstParentLine(repoRoot, c, n)
): ReachedRecord {
  if (process.env.VINAYA_READ_RECORD === 'off')
    return { record: null, reason: 'record use is switched off (VINAYA_READ_RECORD=off)' }
  const line = ancestors(commit, limit)
  const reasons: string[] = []
  for (const candidate of line.length > 0 ? line : [commit]) {
    const reached = reachableRecord(repoRoot, candidate, fetch)
    if (reached.record)
      return {
        record: reached.record,
        reason:
          candidate === commit
            ? reached.reason
            : `${reached.reason}, of ${candidate}, the nearest earlier commit that has one`
      }
    reasons.push(reached.reason)
  }
  return { record: null, reason: reasons[0] ?? `no record is reachable for ${commit}` }
}

function firstParentLine(repoRoot: string, commit: string, limit: number): string[] {
  try {
    return execFileSync('git', ['rev-list', '--first-parent', `--max-count=${limit}`, commit], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}
