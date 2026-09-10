import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `vinaya task dispatch <tranche> <n> --agent <vendor>` reaching the real
 * `dispatchRole` (task-run-v1 task 8, Issue #492): `dispatch-task.ts` used to
 * resolve `dispatchRole` through a runtime-built `import('./dispatch.js')`
 * specifier, soft-failing to a printed "start it yourself" instruction
 * naming a `--tranche` flag `dispatch` does not accept. That dynamic
 * specifier never resolves inside the single-file bundle `apps/cli/scripts/
 * build.ts` produces (there is no `dist/dispatch.js` — everything is inlined
 * into `dist/index.js`), so the published CLI always hit the fallback,
 * silently. `dispatch-task.ts` now imports `dispatchRole` statically, so a
 * build where it cannot be reached fails to compile rather than degrading at
 * runtime — this file proves the published, BUILT bundle (`dist/index.js`,
 * run under `node`, never `bun`) reaches it with a real spawn.
 *
 * `assembleAndRenderBrief`'s render step needs a real Issue — two of its own
 * reads (`fetchOpenIssuesByLabel`, `fetchForgeFacts`) go straight to
 * `@octokit/graphql` over HTTPS, not through a stubbable `gh` binary
 * (`apps/cli/tests/commands/brief-render.test.ts` documents the same
 * constraint for the same reason). Rather than skip proving O1 end to end,
 * this file intercepts `fetch` itself via a Node `--import` preload — the
 * one seam that lets a single synthetic Issue answer `LabeledIssues`
 * honestly without a live repo or a live network. `fetchForgeFacts`'s own
 * query is untouched by the preload (this fixture task declares no
 * `Depends-on`/`Conflicts-with`, so nothing ever reads its response) and
 * degrades to its own documented graceful `unavailable` snapshot instead of
 * crashing.
 */

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_ROOT = join(CLI_ROOT, '..', '..')
const DIST_INDEX = join(CLI_ROOT, 'dist', 'index.js')
const SRC_INDEX = join(CLI_ROOT, 'src', 'index.ts')

const TRANCHE_SLUG = 'task-run-v1-bundle-test'
const TASK_ID = '1'
const ISSUE_NUMBER = 9001
const OWNER = 'fake-owner'
const REPO = 'fake-repo'
const TRANCHE_LABEL = `vinaya/tranche:${TRANCHE_SLUG}`

const ISSUE_BODY = `[${TRANCHE_SLUG}] ${TASK_ID} — synthetic fixture issue for a bundle integration test

**Tier:** 1
**Project:** cli

## Objectives

O1. A synthetic objective proving the dispatch-to-vendor path end to end.

## Planner's rationale

**Boundary** — Nothing real; a synthetic fixture Issue for a bundle test. Out: everything else.

**Sizing** — n/a, synthetic fixture.

**Project(s) + blast radius** — \`Project: cli\`. No shared-primitive fan-out.

**Dependency rationale** — \`Depends-on: —\`; \`Conflicts-with: —\`.

**Traps to avoid** — n/a.

**Suggested agent-class** — fast — synthetic fixture.

**Stop-and-escalate** — n/a.

**Docs to keep coherent** — none.

## Surface

in: apps/cli/src/lib
out: aeg-root

## Parts

Part 1 (O1) — synthetic.

## Test plan

\`\`\`
echo ok → ok
\`\`\`

## Stop conditions

- n/a
`

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/**
 * Fakes the small, fixed set of `gh` invocations this render+post path makes
 * — everything else `assembleAndRenderBrief`/`prepareTask`/`dispatchTask`
 * need is either read from `AEG_REPO`/`GITHUB_TOKEN` (set in the child's
 * env, below) or from the intercepted `fetch` (the two real GraphQL reads).
 */
function writeFakeGh(dir: string, issueListPath: string): void {
  const gh = join(dir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh
ARGS="$*"
case "$ARGS" in
  "api user -q .login")
    echo "daniboomerang"
    ;;
  *"contents/vinaya.config.json"*)
    echo "gh: 404 Not Found" >&2
    exit 1
    ;;
  *"milestones?state=all&per_page=100"*)
    echo "[]"
    ;;
  "issue list --repo ${OWNER}/${REPO} --label ${TRANCHE_LABEL} --state all --json number,title,body,state,labels,milestone,stateReason --limit 200")
    cat "${issueListPath}"
    ;;
  "issue view ${ISSUE_NUMBER} --json comments")
    echo '{"comments":[]}'
    ;;
  *"issue comment ${ISSUE_NUMBER}"*)
    echo "https://github.com/${OWNER}/${REPO}/issues/${ISSUE_NUMBER}#issuecomment-1"
    ;;
  *)
    echo "unhandled gh: $ARGS" >&2
    exit 1
    ;;
esac
`
  )
  chmodSync(gh, 0o755)
}

/** The fake `claude` vendor binary — records the brief it received on stdin so the test can prove it was really invoked, not merely that the command exited 0. */
function writeFakeVendor(dir: string, callLog: string): void {
  const p = join(dir, 'claude')
  writeFileSync(p, `#!/bin/sh\ncat > "${callLog}"\necho '{"usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`)
  chmodSync(p, 0o755)
}

/**
 * Intercepts `fetch` for the two real `@octokit/graphql` HTTPS calls this
 * path makes, answering `LabeledIssues` (`fetchOpenIssuesByLabel`) with the
 * one synthetic Issue above and letting every other GraphQL query
 * (`fetchForgeFacts`'s `ForgeFacts`) fall through to an empty-but-valid
 * `repository` object — that query's result is never read here (no
 * `Depends-on`/`Conflicts-with` edges to resolve), so its own graceful
 * `unavailable` degradation is exactly what should happen, not a crash.
 */
function writeFetchPreload(dir: string, issueListPath: string): string {
  const preload = join(dir, 'fetch-preload.mjs')
  writeFileSync(
    preload,
    `import { readFileSync } from 'node:fs'
const issues = JSON.parse(readFileSync(${JSON.stringify(issueListPath)}, 'utf8'))
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const href = typeof url === 'string' ? url : (url?.url ?? String(url))
  if (href.includes('api.github.com/graphql')) {
    const bodyText = typeof init?.body === 'string' ? init.body : ''
    if (bodyText.includes('LabeledIssues')) {
      const m = /tranche_(\\w+):/.exec(bodyText)
      const alias = m ? \`tranche_\${m[1]}\` : 'tranche_unknown'
      const nodes = issues.map((i) => ({ number: i.number, body: i.body, labels: { nodes: i.labels } }))
      const payload = { data: { repository: { [alias]: { nodes } } } }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ data: { repository: {} } }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  return realFetch(url, init)
}
`
  )
  return preload
}

function writeIssueList(dir: string): string {
  const p = join(dir, 'issue-list.json')
  writeFileSync(
    p,
    JSON.stringify([
      {
        number: ISSUE_NUMBER,
        title: `[${TRANCHE_SLUG}] ${TASK_ID} — synthetic fixture issue for a bundle integration test`,
        body: ISSUE_BODY,
        state: 'OPEN',
        labels: [{ name: TRANCHE_LABEL }],
        milestone: null,
        stateReason: null
      }
    ])
  )
  return p
}

type Fixture = { binDir: string; home: string; callLog: string; preload: string; path: string }

function buildFixture(): Fixture {
  const binDir = tempDir('vinaya-dispatch-task-bin-')
  const home = tempDir('vinaya-dispatch-task-home-')
  const dataDir = tempDir('vinaya-dispatch-task-data-')
  const issueListPath = writeIssueList(dataDir)
  writeFakeGh(binDir, issueListPath)
  const callLog = join(dataDir, 'vendor-call.log')
  writeFakeVendor(binDir, callLog)
  const preload = writeFetchPreload(dataDir, issueListPath)
  return { binDir, home, callLog, preload, path: `${binDir}:${process.env.PATH ?? ''}` }
}

type RunResult = { status: number; stdout: string; stderr: string }

/** Runs `task dispatch --agent claude` against `entry` (either the TS
 * source, under `bun`, or the built bundle, under `node`) with the fixture's
 * faked `gh`/vendor on `PATH` and its `fetch`-intercepting preload. */
async function runTaskDispatch(runtime: 'bun' | 'node', entry: string, fixture: Fixture): Promise<RunResult> {
  const preloadFlag = runtime === 'node' ? ['--import', fixture.preload] : ['--preload', fixture.preload]
  const proc = Bun.spawn(
    [
      runtime,
      ...preloadFlag,
      entry,
      'task',
      'dispatch',
      TRANCHE_SLUG,
      TASK_ID,
      '--agent',
      'claude',
      '--model',
      'sonnet'
    ],
    {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        HOME: fixture.home,
        PATH: fixture.path,
        GITHUB_TOKEN: 'fake-token',
        AEG_REPO: `${OWNER}/${REPO}`
      }
    }
  )
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const status = await proc.exited
  return { status, stdout, stderr }
}

beforeAll(async () => {
  // Always rebuild rather than trusting a possibly-stale dist/ from a prior
  // session — a stale bundle would silently test the WRONG code, and this
  // file's entire point is the BUILT artifact, not the TS source.
  const build = Bun.spawnSync(['bun', 'run', '--cwd', CLI_ROOT, 'build'], { stdout: 'pipe', stderr: 'pipe' })
  if (build.exitCode !== 0) {
    throw new Error(`apps/cli build failed:\n${build.stderr.toString()}`)
  }
}, 120_000)

describe('vinaya task dispatch --agent — reaches the real developer, on the published bundle (O1, O2)', () => {
  it('the BUILT bundle (dist/index.js, under node) spawns the fake claude vendor with the frozen brief on stdin — no fallback instruction printed', async () => {
    const fixture = buildFixture()
    const r = await runTaskDispatch('node', DIST_INDEX, fixture)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Posted:')
    // The old dynamic-import fallback printed this instruction, naming a
    // `--tranche` flag `dispatch` never accepted — its absence here is the
    // regression proof, not merely a side note.
    expect(r.stdout).not.toContain('is not available yet')
    expect(r.stdout).not.toContain('start the developer yourself')

    const vendorCall = Bun.file(fixture.callLog)
    expect(await vendorCall.exists()).toBe(true)
    const receivedBrief = await vendorCall.text()
    expect(receivedBrief).toContain('You are the AEG Developer.')
    expect(receivedBrief).toContain('Closes #9001')
  }, 30_000)

  it('the workspace TS source (src/index.ts, under bun) reaches the exact same dispatch function — same outcome as the bundle', async () => {
    const fixture = buildFixture()
    const r = await runTaskDispatch('bun', SRC_INDEX, fixture)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Posted:')

    const vendorCall = Bun.file(fixture.callLog)
    expect(await vendorCall.exists()).toBe(true)
  }, 30_000)
})
