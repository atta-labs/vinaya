/**
 * Finding a read record for a base commit: the search behind `test-selection --fetch-record`.
 *
 * The recording workflow stores each default-branch commit's record as a workflow run artifact named for the commit.
 * The search walks the base commit and the nine before it on its first-parent line, nearest first, and stops at the
 * first commit that gives a record: a copy kept under the repository's common git directory, or one fetched with the
 * GitHub CLI (`gh`, which needs a login or a `GH_TOKEN`, and `actions: read` inside a workflow). Anything that goes
 * wrong gives no record, with a reason, and never throws: a missing record is never read as "no test reads anything".
 *
 * This module and the command given the flag are the only code in the package that starts `gh`.
 */
import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isReadRecord, type ReadRecord } from './recorded-reads.js'
import { RECORD_FILE } from './recorder.js'

/** The workflow file whose push run on the default branch records the reads. */
export const RECORD_WORKFLOW_FILE = 'test-selection-record.yml'

/** The prefix of the artifact that holds a commit's record; the artifact's name is this prefix and the commit id. */
export const RECORD_ARTIFACT_PREFIX = 'read-record-'

/** How many first-parent commits, the base included, the search looks through. */
const CANDIDATE_LIMIT = 10

/** The time limit of each `gh` call. */
const GH_TIMEOUT_MS = 20_000

/** The folder of kept records, under the repository's common git directory. */
const KEPT_FOLDER = 'test-selection/read-records'

/** Runs a command and returns its standard output; throws as `execFileSync` does, a start error and a timeout included. */
export type CommandRunner = (file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string

/** Where a found record came from. */
export type RecordSource = 'kept' | 'fetched'

/** The end of a search: the record found and where it came from, or the first reason there is none. */
export type RecordSearch =
  | { record: ReadRecord; source: RecordSource; commit: string }
  | { record: null; reason: string }

function cleanEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(out)) if (key.startsWith('GIT_')) delete out[key]
  return out
}

const defaultRunner: CommandRunner = (file, args, options) => execFileSync(file, args, options)

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0] as string
}

function gitOutput(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

/** The base commit and the commits before it on its first-parent line; the base alone when git cannot list them. */
function candidates(repoRoot: string, base: string): string[] {
  const out = gitOutput(repoRoot, ['rev-list', '--first-parent', `--max-count=${CANDIDATE_LIMIT}`, base])
  const line = out ? out.split('\n').filter(Boolean) : []
  return line.length > 0 ? line : [base]
}

/** The folder of kept records, shared by every worktree of the repository; null when git cannot name it. */
function keptFolder(repoRoot: string): string | null {
  const common = gitOutput(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return common ? join(common, KEPT_FOLDER) : null
}

/** Parses a record's text; null unless it is a valid record of exactly `commit`. */
function recordFor(text: string, commit: string): ReadRecord | null {
  try {
    const value = JSON.parse(text) as unknown
    return isReadRecord(value) && value.commit === commit ? value : null
  } catch {
    return null
  }
}

/**
 * The record of the nearest commit at or before `base`, among ten on its first-parent line, that is kept or can be
 * fetched. `run` starts `gh` (and only `gh`); a test passes its own. After a `gh` that cannot be started, or that fails
 * when asked for the default branch, for a commit's runs, or when a download runs out of time, `gh` is started no
 * more and only kept records are used.
 */
export function findReadRecord(repoRoot: string, base: string, run: CommandRunner = defaultRunner): RecordSearch {
  const kept = keptFolder(repoRoot)
  const reasons: string[] = []
  let ghUsable = true
  let branch: string | null = null

  const gh = (args: string[]): string =>
    run('gh', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GH_TIMEOUT_MS
    })

  for (const commit of candidates(repoRoot, base)) {
    const path = kept ? join(kept, `${commit}.json`) : null
    if (path && existsSync(path)) {
      try {
        const record = recordFor(readFileSync(path, 'utf8'), commit)
        if (record) return { record, source: 'kept', commit }
      } catch {}
    }
    if (!ghUsable) {
      reasons.push(`no record of ${commit} is kept and gh is not used after an earlier failure`)
      continue
    }

    if (branch === null) {
      try {
        branch = (
          JSON.parse(gh(['repo', 'view', '--json', 'defaultBranchRef'])) as { defaultBranchRef: { name: string } }
        ).defaultBranchRef.name
      } catch (err) {
        ghUsable = false
        reasons.push(`gh cannot name the default branch: ${firstLine(err)}`)
        continue
      }
    }

    let runs: { databaseId: number }[]
    try {
      runs = JSON.parse(
        gh([
          'run',
          'list',
          '--workflow',
          RECORD_WORKFLOW_FILE,
          '--branch',
          branch,
          '--event',
          'push',
          '--commit',
          commit,
          '--json',
          'databaseId',
          '--limit',
          '5'
        ])
      ) as { databaseId: number }[]
    } catch (err) {
      ghUsable = false
      reasons.push(`gh run list failed for ${commit}: ${firstLine(err)}`)
      continue
    }
    if (!Array.isArray(runs) || runs.length === 0) {
      reasons.push(`no ${RECORD_WORKFLOW_FILE} push run for ${commit}`)
      continue
    }

    const name = `${RECORD_ARTIFACT_PREFIX}${commit}`
    const dir = mkdtempSync(join(tmpdir(), 'test-selection-record-'))
    let text: string | null = null
    try {
      for (const found of runs) {
        try {
          gh(['run', 'download', String(found.databaseId), '--name', name, '--dir', dir])
          text = readFileSync(join(dir, RECORD_FILE), 'utf8')
          break
        } catch (err) {
          if ((err as { code?: unknown }).code === 'ETIMEDOUT') {
            ghUsable = false
            reasons.push(`the download of ${name} ran out of time`)
            break
          }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    if (text === null) {
      if (ghUsable) reasons.push(`no run for ${commit} holds the ${name} artifact`)
      continue
    }
    const record = recordFor(text, commit)
    if (!record) {
      reasons.push(`the fetched file is not a read record of ${commit}`)
      continue
    }
    if (path) {
      try {
        mkdirSync(join(path, '..'), { recursive: true })
        writeFileSync(path, text)
      } catch {}
    }
    return { record, source: 'fetched', commit }
  }
  return { record: null, reason: reasons[0] ?? `no record is reachable for ${base}` }
}
