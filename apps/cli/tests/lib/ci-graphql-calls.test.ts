/**
 * How many times CI reads the pull request and its task Issue through `gh`'s
 * GraphQL commands, before and after the forge snapshot.
 *
 * A `gh` on `PATH` records every call it is given and answers from the
 * recorded fixture (`fixtures/forge-snapshot/gh-vs-rest.json`). Each check CI
 * runs with a forge token declared runs through the check runner — so a
 * variable the registry does not declare is stripped exactly as in CI — twice:
 *
 * - **live mode** — CI as it is without a snapshot: `GITHUB_ACTIONS=true`, no
 *   `VINAYA_FORGE_SNAPSHOT_DIR`, so every check reads the forge itself;
 * - **snapshot mode** — the generated read steps' own scripts (taken from the
 *   committed workflow files) run first and write the snapshot, then the
 *   checks run with it, as the step that runs checks does.
 *
 * For each mode it prints (a) the `gh pr view` / `gh issue view` calls for the
 * pull request or its task Issue — 0 in snapshot mode — and (b) every `gh`
 * GraphQL call (`gh api graphql`, `pr view|list`, `issue view|list`). A check
 * that talks to GraphQL through its own HTTP client never reaches `gh`, so
 * (b) excludes those direct GraphQL clients; `gh api repos/...` is REST.
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { CheckSpec } from '../../src/checks/contract'
import { coreCheckRegistry } from '../../src/checks/registry'
import { runChecks } from '../../src/checks/runner'
import { FORGE_SNAPSHOT_DIR_ENV } from '../../src/lib/forge-snapshot'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture'

const REPO_ROOT = join(import.meta.dir, '../../../..')
const WORKFLOWS = join(REPO_ROOT, '.github', 'workflows')
const FIXTURE_PATH = join(import.meta.dir, '..', 'fixtures', 'forge-snapshot', 'gh-vs-rest.json')
const CASE = (JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { cases: Array<Record<string, any>> }).cases[0] as {
  rest: Record<string, any>
  gh: Record<string, any>
}
const PR = CASE.rest.pull.number as number
const ISSUE = CASE.rest.issue.number as number
const BRANCH = CASE.rest.pull.head.ref as string
const HEAD_SHA = CASE.rest.pull.head.sha as string
const BODY = CASE.rest.pull.body as string

let root = ''
let binDir = ''
let callLog = ''
const savedCwd = process.cwd()

/** The fake `gh`: records argv as one JSON line, answers from the fixture, and applies `--jq` with the real `jq`. */
function fakeGhSource(dataPath: string, logPath: string): string {
  return `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n')
const d = JSON.parse(readFileSync(${JSON.stringify(dataPath)}, 'utf8'))
const joined = args.join(' ')
const at = Math.max(args.indexOf('--jq'), args.indexOf('-q'))
const jq = at === -1 ? null : args[at + 1]
const path = args.find((a) => a.startsWith('repos/')) ?? ''
const page = Number((/[?&]page=(\\d+)/.exec(path) ?? [])[1] ?? '1')
let out
const pr = ${PR}, issue = ${ISSUE}
if (args[0] === 'api' && args[1] === 'rate_limit') out = d.rateLimit
else if (args[0] === 'api' && /^repos\\/[^/]+\\/[^/]+\\/pulls\\/\\d+$/.test(path) && path.endsWith('/' + pr)) out = d.rest.pull
else if (args[0] === 'api' && path.includes('/issues/' + pr + '/comments')) out = args.includes('--slurp') ? d.rest.pullComments : page === 1 ? d.rest.pullComments.flat() : []
else if (args[0] === 'api' && path.includes('/issues/' + issue + '/comments')) out = page === 1 ? d.rest.issueComments : []
else if (args[0] === 'api' && /\\/issues\\/\\d+$/.test(path) && path.endsWith('/' + issue)) out = d.rest.issue
else if (args[0] === 'pr' && args[1] === 'view' && (args[2] === String(pr) || args[2] === undefined || args[2].startsWith('-') || args[2] === ${JSON.stringify(BRANCH)})) out = { ...d.gh.pull, comments: d.gh.pullComments }
else if (args[0] === 'issue' && args[1] === 'view' && args[2] === String(issue)) out = { ...d.gh.issue, comments: d.gh.issueComments }
else if (args[0] === 'issue' && args[1] === 'view' && args[2] === String(pr)) out = { ...d.gh.pull, comments: d.gh.pullComments }
else { process.stderr.write('unhandled fake gh call: ' + joined + '\\n'); process.exit(1) }
const text = JSON.stringify(out)
process.stdout.write(jq ? execFileSync('jq', ['-r', jq], { input: text, encoding: 'utf8' }) : text)
`
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ci-graphql-calls-'))
  binDir = join(root, 'bin')
  mkdirSync(binDir)
  callLog = join(root, 'gh-calls.jsonl')
  const dataPath = join(root, 'data.json')
  const reset = Math.floor(Date.UTC(2026, 9, 18, 14, 0, 0) / 1000)
  writeFileSync(
    dataPath,
    JSON.stringify({
      ...CASE,
      rateLimit: {
        resources: {
          core: { limit: 5000, used: 10, remaining: 4990, reset },
          graphql: { limit: 5000, used: 10, remaining: 4990, reset }
        }
      }
    })
  )
  writeFileSync(join(binDir, 'gh'), fakeGhSource(dataPath, callLog))
  chmodSync(join(binDir, 'gh'), 0o755)
  // The checks resolve the repository's config, doctrine and git history from
  // their working directory, as CI's checkout does.
  process.chdir(REPO_ROOT)
})

afterAll(() => {
  process.chdir(savedCwd)
  if (root) rmSync(root, { recursive: true, force: true })
})

function readCalls(): string[][] {
  let text = ''
  try {
    text = readFileSync(callLog, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as string[])
}

function resetCalls(): void {
  writeFileSync(callLog, '')
}

function isGraphql(args: string[]): boolean {
  if (args[0] === 'api') return args[1] === 'graphql'
  return (args[0] === 'pr' || args[0] === 'issue') && (args[1] === 'view' || args[1] === 'list')
}

/** `gh pr view` / `gh issue view` of the pull request (by number, by branch, or the current branch) or its task Issue. */
function isTargetView(args: string[]): boolean {
  if (args[1] !== 'view') return false
  const ref = args[2]
  if (args[0] === 'pr') return ref === undefined || ref.startsWith('-') || ref === String(PR) || ref === BRANCH
  if (args[0] === 'issue') return ref === String(ISSUE) || ref === String(PR)
  return false
}

/** Every check CI runs that is handed a forge token — the only checks whose `gh` can reach the forge in CI. */
function forgeReadingChecks(): CheckSpec[] {
  return coreCheckRegistry().filter(
    (s) => s.validates !== 'issue' && s.env !== undefined && ('GH_TOKEN' in s.env || 'GITHUB_TOKEN' in s.env)
  )
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
}

/** CI's environment for the step that runs checks, minus any real credential (the fake `gh` needs none, and no direct client may reach the network). */
function ciEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = stripVinayaEnv()
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_REPO', 'GITHUB_REPOSITORY', 'BASE_SHA', 'PR_BODY_FILE'])
    delete env[k]
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  return {
    ...env,
    PATH: `${binDir}:${process.env.PATH}`,
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'OWNER/REPO',
    PR_NUMBER: String(PR),
    BRANCH,
    PR_BODY: BODY,
    PULL_REQUEST_HEAD_SHA: HEAD_SHA,
    BASE_SHA: git('rev-parse', 'HEAD'),
    ...extra
  }
}

async function runCiChecks(env: NodeJS.ProcessEnv): Promise<void> {
  await runChecks(forgeReadingChecks(), {
    parallel: 6,
    diffOnly: false,
    changedFiles: null,
    defaultTimeoutMs: 60_000,
    callerEnv: env,
    log: () => {}
  })
}

/** The `run:` script of the step `name` in `job` of a committed generated workflow. */
function stepScript(file: string, job: string, name: string): string {
  const lines = readFileSync(join(WORKFLOWS, file), 'utf8').split('\n')
  const jobAt = lines.indexOf(`  ${job}:`)
  if (jobAt === -1) throw new Error(`${file} has no job ${job}`)
  const stepAt = lines.findIndex((l, i) => i > jobAt && l === `      - name: ${name}`)
  if (stepAt === -1) throw new Error(`${file}:${job} has no step "${name}"`)
  const runAt = lines.findIndex((l, i) => i > stepAt && l.startsWith('        run:'))
  const inline = (lines[runAt] ?? '').slice('        run:'.length).trim()
  if (inline !== '|') return inline
  const body: string[] = []
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i] ?? ''
    if (l.trim() !== '' && !l.startsWith('          ')) break
    body.push(l.slice(10))
  }
  return body.join('\n')
}

/** Runs one generated step's script as Actions would (bash), with the CLI run from source. */
function runStep(script: string, env: Record<string, string>): void {
  const resolved = script
    .replaceAll('node apps/cli/dist/index.js', `bun ${join(REPO_ROOT, 'apps/cli/src/index.ts')}`)
    .replaceAll('${{ github.event.issue.number }}', String(PR))
  const r = spawnSyncBudgeted('bash', ['-e', '-c', resolved], { cwd: REPO_ROOT, env, encoding: 'utf8' }, 60_000)
  if (r.status !== 0) throw new Error(`step exited ${r.status}: ${r.stderr}`)
}

type Counts = { views: number; graphql: number; total: number }

function counts(calls: string[][]): Counts {
  return { views: calls.filter(isTargetView).length, graphql: calls.filter(isGraphql).length, total: calls.length }
}

const results: Record<'live' | 'snapshot', Counts | undefined> = { live: undefined, snapshot: undefined }

describe('CI reads of the pull request and its task Issue, counted at a recording `gh`', () => {
  it('no generated workflow step calls `gh pr view` or `gh issue view`', () => {
    for (const file of [
      'vinaya-checks.yml',
      'vinaya-body-checks.yml',
      'vinaya-review.yml',
      'vinaya-review-verdict.yml',
      'vinaya-archivist.yml'
    ]) {
      const text = readFileSync(join(WORKFLOWS, file), 'utf8')
      expect(`${file}: ${/gh (pr|issue) view/.test(text)}`).toBe(`${file}: false`)
    }
  })

  it('live mode: every check reads the forge itself', async () => {
    resetCalls()
    await runCiChecks(ciEnv({}))
    const c = counts(readCalls())
    results.live = c
    console.log(
      `live mode: (a) ${c.views} gh pr view / gh issue view calls for the pull request or its task Issue; (b) ${c.graphql} gh GraphQL calls in all (excluding direct GraphQL clients); ${c.total} gh calls in all`
    )
    // The baseline the snapshot removes: without it the checks do read them.
    expect(c.views).toBeGreaterThan(0)
  }, 240_000)

  it('snapshot mode: the read steps write the snapshot, and no check reads the pull request or its task Issue through GraphQL', async () => {
    resetCalls()
    const runnerTemp = join(root, 'runner-temp')
    mkdirSync(runnerTemp, { recursive: true })
    const githubEnv = join(root, 'github-env')
    const summary = join(root, 'step-summary')
    writeFileSync(githubEnv, '')
    writeFileSync(summary, '')
    const stepEnv = {
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      RUNNER_TEMP: runnerTemp,
      GITHUB_ENV: githubEnv,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: join(root, 'github-output'),
      GITHUB_ACTIONS: 'true',
      GH_REPO: 'OWNER/REPO',
      PR_NUMBER: String(PR),
      BRANCH,
      READ_RESULT: 'success'
    }
    // Each generated job's read steps, in their own order.
    for (const [file, job, names] of [
      [
        'vinaya-checks.yml',
        'vinaya-checks',
        ['Record the GraphQL budget at job start', 'Read the pull request over REST', 'Write the forge snapshot']
      ],
      [
        'vinaya-body-checks.yml',
        'vinaya-forge-read',
        ['Record the GraphQL budget at job start', 'Read the pull request over REST', 'Write the forge snapshot']
      ],
      [
        'vinaya-body-checks.yml',
        'vinaya-body-checks',
        ['Require the pull request read', 'Export the pull request body']
      ],
      [
        'vinaya-review.yml',
        'vinaya-review',
        ['Read the pull request over REST', 'Require a verdict or waiver before building', 'Write the forge snapshot']
      ],
      [
        'vinaya-review-verdict.yml',
        'evaluate',
        ['Read the pull request over REST', 'Resolve PR head', 'Write the forge snapshot']
      ]
    ] as const) {
      for (const name of names) runStep(stepScript(file, job, name), stepEnv)
    }
    const stepCalls = readCalls()
    const dir = join(runnerTemp, 'vinaya-forge-snapshot')
    expect(readFileSync(join(dir, 'body.md'), 'utf8')).toBe(BODY)
    expect(readFileSync(githubEnv, 'utf8')).toContain(BODY.trimEnd())
    expect(readFileSync(summary, 'utf8')).toContain('GraphQL budget at job start: 10 used of 5000')
    // The read steps themselves are REST only.
    expect(stepCalls.filter(isGraphql)).toEqual([])

    await runCiChecks(ciEnv({ [FORGE_SNAPSHOT_DIR_ENV]: dir, PR_BODY_FILE: join(dir, 'body.md') }))
    const c = counts(readCalls())
    results.snapshot = c
    console.log(
      `snapshot mode: (a) ${c.views} gh pr view / gh issue view calls for the pull request or its task Issue; (b) ${c.graphql} gh GraphQL calls in all (excluding direct GraphQL clients); ${c.total} gh calls in all, read steps included`
    )
    expect(readCalls().filter(isTargetView)).toEqual([])
    expect(c.views).toBe(0)
    if (results.live) expect(c.graphql).toBeLessThan(results.live.graphql)
  }, 240_000)
})
