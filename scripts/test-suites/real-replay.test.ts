/**
 * The chain on this repository's own history: five real changes, each replayed as a new commit on top of the commit
 * the committed read record was taken at (`fixtures/read-record-350fe961d.json.gz`, the default branch's
 * `Record test reads (Linux)` artifact of that commit), through `loadSelectionInputs` and `selectTests` with the
 * Linux platform. Each case pins the selected set (`fixtures/real-replay-pins.json`), pins the static selection's
 * count of the same change, and gets the same set from the local push caller and the CI caller.
 *
 * Every one of the five changes is an ancestor of the record's commit, so its diff is already part of that commit.
 * A replay therefore changes the same lines back: each changed file's diff applied in reverse, or — when later
 * commits moved those lines — the file as it was before the change; a file the record's commit no longer holds
 * cannot be changed there and is left out.
 */
import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { plannedTests, type ReadRecord, selectTests } from '@attalabs/test-selection'
import { loadSelectionInputs } from './repository-selection.js'

const REPO_ROOT = join(import.meta.dir, '../..')
const RECORD = JSON.parse(
  gunzipSync(readFileSync(join(import.meta.dir, 'fixtures/read-record-350fe961d.json.gz'))).toString('utf8')
) as ReadRecord
const PINS = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/real-replay-pins.json'), 'utf8')) as Record<
  string,
  { selected: string[]; staticCount: number }
>
const CHANGES = ['ccaf6e717', 'c943bc67f', '30fb6efbc', '4044a489f', '3aca29afb'] as const
const reach = () => ({ record: RECORD, reason: 'the committed default-branch record of 350fe961d' })

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value
  return { ...env, ...extra }
}

/** The replay of `change` on top of the record's commit, as a new unreferenced commit with a fixed identity and date. */
function replayCommit(change: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-replay-'))
  const env = cleanEnv({
    GIT_INDEX_FILE: join(dir, 'index'),
    GIT_AUTHOR_NAME: 'replay',
    GIT_AUTHOR_EMAIL: 'replay@localhost',
    GIT_COMMITTER_NAME: 'replay',
    GIT_COMMITTER_EMAIL: 'replay@localhost',
    GIT_AUTHOR_DATE: '2026-11-08T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-11-08T00:00:00Z'
  })
  const git = (args: string[], input?: string) =>
    execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env,
      input,
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 1 << 30
    }).trim()
  try {
    git(['read-tree', RECORD.commit])
    const paths = git(['diff', '--name-only', '--no-renames', `${change}^`, change])
      .split('\n')
      .filter(Boolean)
    for (const path of paths) {
      if (git(['ls-tree', RECORD.commit, '--', path]) === '') continue
      const diff = git(['diff', '--binary', '--no-renames', `${change}^`, change, '--', path])
      try {
        git(['apply', '--cached', '-R'], `${diff}\n`)
      } catch {
        const before = /^(\d+) blob ([0-9a-f]+)\t/.exec(git(['ls-tree', `${change}^`, '--', path]))
        if (before) git(['update-index', '--add', '--cacheinfo', `${before[1]},${before[2]},${path}`])
        else git(['update-index', '--force-remove', '--', path])
      }
    }
    return git(['commit-tree', git(['write-tree']), '-p', RECORD.commit, '-m', `replay ${change}`])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The push caller's planned tests, from a checkout of `head` whose remote base is the record's commit. */
function pushPlanned(head: string): string[] {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-replay-push-')))
  const worktree = join(dir, 'checkout')
  const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv(), maxBuffer: 1 << 30 }).trim()
  git(REPO_ROOT, ['worktree', 'add', '--detach', '--quiet', worktree, head])
  try {
    return plannedTests(
      selectTests(
        loadSelectionInputs({ repoRoot: worktree, caller: 'push', base: RECORD.commit, reach, platform: 'linux' })
      )
    )
  } finally {
    git(REPO_ROOT, ['worktree', 'remove', '--force', worktree])
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('five real changes replayed onto the record’s commit', () => {
  it('the record fixture is the Linux record of its commit', () => {
    expect(RECORD.platform).toBe('linux')
    expect(RECORD.commit).toBe('350fe961d679d9c30d2b7434d281047b03a45fc5')
    expect(Object.keys(RECORD.tests).length).toBeGreaterThan(500)
    expect(Object.keys(PINS).sort()).toEqual([...CHANGES].sort())
  })

  for (const change of CHANGES)
    it(`${change}: the pinned set, from the CI caller and the push caller alike`, () => {
      const head = replayCommit(change)
      const input = loadSelectionInputs({
        repoRoot: REPO_ROOT,
        caller: 'ci',
        base: RECORD.commit,
        head,
        reach,
        platform: 'linux'
      })
      const selected = plannedTests(selectTests(input))
      const pin = PINS[change] as { selected: string[]; staticCount: number }
      expect(selected).toEqual(pin.selected)
      // The static selection of the same change: what the plan would be with no record.
      expect(plannedTests(selectTests({ ...input, records: null })).length).toBe(pin.staticCount)
      expect(pushPlanned(head)).toEqual(selected)
    }, 120_000)
})
