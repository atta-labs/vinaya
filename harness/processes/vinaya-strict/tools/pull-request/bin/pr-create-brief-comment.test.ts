import { execFileSync } from 'node:child_process'
import { programCommandLine } from '../../programs.js'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FROZEN_BRIEF_MARKER, REGION_PREFIX } from '../../legacy-markers'
import { afterEach, describe, expect, it } from 'bun:test'

/**
 * `vinaya pr create` no longer splits a brief section out of the body
 * (plan-brief-v1 task 2, #427) — the brief lives on the task Issue's frozen
 * `vinaya:brief:v1` comment (`vinaya task dispatch`), never in the PR body. This
 * file, which used to exercise the retired split end to end, now covers its
 * replacement: a body still carrying either legacy retired brief-start/
 * brief-end marker is refused outright, and an ordinary new-shaped body
 * (no `## Reference` section at all) opens clean, unaffected.
 */

const LEGACY_BRIEF_START = `${FROZEN_BRIEF_MARKER.old}:start`
const LEGACY_BRIEF_END = `${FROZEN_BRIEF_MARKER.old}:end`

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', 'apps', 'cli')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

type CliResult = { status: number; stdout: string; stderr: string }

/**
 * `CLAUDE_PROJECT_DIR`/`CLAUDE_CODE_SESSION_ID` identify THIS test process's
 * own real Claude Code session, and `VINAYA_RUNTIME_DIR`/`VINAYA_TASK`/
 * `VINAYA_ROLE`/`VINAYA_RUN`/`VINAYA_RUN_ID`/`VINAYA_ROUND` identify a real
 * `vinaya` dispatch this test process is itself running inside of —
 * inherited into a spawned `vinaya` child by a plain `{ ...process.env }`
 * spread, they let `resolveMeteringCapability`/`recoverUsageFromDispatchTee`
 * (the process package, `lib/dispatch.ts`) find and read this real session's
 * own Stop-hook transcript pointer or launch-record tee, regardless of the
 * child's own throwaway `cwd` (both key off these env vars, never the
 * caller's `cwd` — found live: a fixture repo in a fresh `mkdtempSync` dir
 * still resolved a real, capable metering verdict when this suite runs from
 * inside a genuine dispatched session). Stripped here so every test in this
 * file spawns the CLI as a host with no metering wiring of its own.
 */
function runCli(args: string[], cwd: string, env: Record<string, string | undefined>): CliResult {
  const childEnv = { ...process.env, ...env }
  for (const key of [
    'CLAUDE_PROJECT_DIR',
    'CLAUDE_CODE_SESSION_ID',
    'VINAYA_RUNTIME_DIR',
    'VINAYA_TASK',
    'VINAYA_ROLE',
    'VINAYA_RUN',
    'VINAYA_RUN_ID',
    'VINAYA_ROUND',
    'VINAYA_UNATTENDED'
  ]) {
    delete childEnv[key]
  }
  try {
    const stdout = execFileSync('bun', programCommandLine(args) ?? [INDEX, ...args], {
      encoding: 'utf8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

/** A `gh` stub answering `pr create` with a fake PR URL, logging the exact
 * body-file it was handed so a test can assert what actually reached `gh`
 * (or, for the refusal cases, assert it was never invoked at all). */
function stubGh(prUrl: string): { path: Record<string, string>; createBodyLogPath: string; callLogPath: string } {
  const dir = tempDir('pr-create-stub-')
  const createBodyLogPath = join(dir, 'create-body.log')
  const callLogPath = join(dir, 'calls.log')
  writeFileSync(createBodyLogPath, '')
  writeFileSync(callLogPath, '')
  const gh = join(dir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh
echo "$@" >> "${callLogPath}"
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  shift 2
  bodyFile=""
  while [ $# -gt 0 ]; do
    if [ "$1" = "--body-file" ]; then
      bodyFile="$2"
    fi
    shift
  done
  cat "$bodyFile" > "${createBodyLogPath}"
  echo "${prUrl}"
  exit 0
fi
exit 1
`
  )
  chmodSync(gh, 0o755)
  return { path: { PATH: `${dir}:${process.env.PATH ?? ''}` }, createBodyLogPath, callLogPath }
}

function initRepo(): string {
  const repo = tempDir('pr-create-repo-')
  // `-b main`: `derivePhase()`'s fallback names the raw branch when it isn't
  // `task/<tranche>/<n>`-shaped — never left to `git init`'s own default
  // (`init.defaultBranch`, environment-dependent: `main` locally, `master`
  // on the CI runner used here — found live, CI red on exactly this).
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  // ring1_forgeWriteInterception: false opts OUT of brief-schema validation
  // (issue-545, O2 — `false` now means "skip", `true` means "run") so these
  // fixtures can focus on the legacy-marker-refusal/body-pass-through
  // behavior alone, without Tier/Test-Plan/etc. brief-schema requirements
  // getting in the way.
  writeFileSync(
    join(repo, 'vinaya.config.json'),
    `${JSON.stringify({ rings: { ring1_forgeWriteInterception: false, ring2_asyncAudits: true } }, null, 2)}\n`
  )
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  return repo
}

const BRIEF_TEXT = [
  '**For:** Sonnet (coding-agent CLI)',
  '**Goal:** exercise the legacy-marker refusal.',
  '',
  '## 2. Context',
  '',
  '- Fixture brief, not a real dispatch.'
].join('\n')

function newShapedBody(): string {
  return [
    '<!-- VINAYA:CLOSES:START -->',
    'Closes #42',
    '<!-- VINAYA:CLOSES:END -->',
    '',
    '**For:** Sonnet (coding-agent CLI)',
    '<!-- VINAYA:PROJECT:START -->',
    '**Project:** vinaya',
    '<!-- VINAYA:PROJECT:END -->',
    '',
    '## Decisions',
    '',
    'No open choices.',
    '',
    '## Test plan',
    '',
    'Test Plan: unit-tests-only',
    '',
    '## Scope',
    '',
    'Touches `harness/processes/vinaya-strict/tools/pull-request/bin/pr.ts` only.',
    '',
    '<!-- VINAYA:TIER:START -->',
    '**Tier:** 1',
    '<!-- VINAYA:TIER:END -->',
    ''
  ].join('\n')
}

describe('vinaya pr create — refuses a body still carrying the retired brief split (plan-brief-v1 task 2, #427)', () => {
  it('a body carrying the legacy brief-start marker is refused — gh is never invoked', () => {
    const repo = initRepo()
    const bodyPath = join(repo, 'pr-body.md')
    writeFileSync(
      bodyPath,
      [
        newShapedBody(),
        '---',
        '',
        `<!-- ${LEGACY_BRIEF_START} -->`,
        '## Reference — the dispatched brief',
        '',
        BRIEF_TEXT,
        `<!-- ${LEGACY_BRIEF_END} -->`,
        ''
      ].join('\n')
    )
    const { path, callLogPath } = stubGh('https://github.com/acme/widget/pull/42')

    const r = runCli(
      ['pr', 'create', '--body-file', bodyPath, '--title', 'Fix(cli): legacy marker refused'],
      repo,
      path
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(LEGACY_BRIEF_START)
    expect(r.stderr).toContain('pr-brief-comment')

    expect(readFileSync(callLogPath, 'utf-8')).toBe('')
  })

  it('a body carrying only the trailing legacy brief-end marker (unpaired) is still refused', () => {
    const repo = initRepo()
    const bodyPath = join(repo, 'pr-body.md')
    writeFileSync(bodyPath, `${newShapedBody()}\n<!-- ${LEGACY_BRIEF_END} -->\n`)
    const { path, callLogPath } = stubGh('https://github.com/acme/widget/pull/42')

    const r = runCli(
      ['pr', 'create', '--body-file', bodyPath, '--title', 'Fix(cli): unpaired marker refused'],
      repo,
      path
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(LEGACY_BRIEF_END)
    expect(readFileSync(callLogPath, 'utf-8')).toBe('')
  })

  it('an ordinary new-shaped body (no ## Reference section, no legacy markers) opens clean', () => {
    const repo = initRepo()
    const bodyPath = join(repo, 'pr-body.md')
    writeFileSync(bodyPath, newShapedBody())
    const { path, createBodyLogPath } = stubGh('https://github.com/acme/widget/pull/43')

    const r = runCli(['pr', 'create', '--body-file', bodyPath, '--title', 'Fix(cli): new-shaped body'], repo, path)
    expect(r.status).toBe(0)

    const sentBody = readFileSync(createBodyLogPath, 'utf-8')
    expect(sentBody).toContain('## Decisions')
    expect(sentBody).not.toContain('## Reference')
    expect(sentBody).not.toContain(FROZEN_BRIEF_MARKER.old)
  })

  // O1: `pr create` used to splice a token table into the body it sent. Token
  // use is the Vinaya log's `usage` event now, so the body that reaches the
  // forge carries no such block and no metering probe runs to build one.
  it('sends the body with no token table, and never creates one', () => {
    const repo = initRepo()
    const bodyPath = join(repo, 'pr-body.md')
    writeFileSync(bodyPath, newShapedBody())
    const { path, createBodyLogPath } = stubGh('https://github.com/acme/widget/pull/46')

    const r = runCli(['pr', 'create', '--body-file', bodyPath, '--title', 'Fix(cli): no token table'], repo, path)
    expect(r.status).toBe(0)

    const sentBody = readFileSync(createBodyLogPath, 'utf-8')
    expect(sentBody).not.toContain(`${REGION_PREFIX.old}:TOKENS`)
    expect(sentBody).not.toContain('Token report')
    expect(sentBody).toContain('## Decisions')
  })

  it('a body that only MENTIONS a legacy marker inline, backticked, in prose is not refused', () => {
    const repo = initRepo()
    const bodyPath = join(repo, 'pr-body.md')
    writeFileSync(
      bodyPath,
      [
        newShapedBody(),
        '## Decisions',
        '',
        `This task retires the \`<!-- ${LEGACY_BRIEF_START} -->\`/\`<!-- ${LEGACY_BRIEF_END} -->\` marker pair — a body still carrying either as a real, own-line marker is refused.`
      ].join('\n')
    )
    const { path, createBodyLogPath } = stubGh('https://github.com/acme/widget/pull/45')

    const r = runCli(
      ['pr', 'create', '--body-file', bodyPath, '--title', 'Fix(cli): self-mentioning prose'],
      repo,
      path
    )
    expect(r.status).toBe(0)

    const sentBody = readFileSync(createBodyLogPath, 'utf-8')
    expect(sentBody).toContain('retires the')
  })
})

describe('vinaya pr create — refuses once with the union of every failing finding (O1)', () => {
  it('a body failing a title rule and a body check is refused once with both findings', () => {
    const repo = initRepo()
    const bodyPath = join(repo, 'pr-body.md')
    writeFileSync(bodyPath, `${newShapedBody()}\nThis change touches 3 files directly.\n`)
    const { path, callLogPath } = stubGh('https://github.com/acme/widget/pull/44')

    const r = runCli(['pr', 'create', '--body-file', bodyPath, '--title', 'not a valid title at all'], repo, path)
    expect(r.status).toBe(1)
    // Both findings printed from the ONE refusal — never a title-only
    // refusal that would have hidden the body-bare-digits finding behind a
    // second re-run, or vice versa.
    expect(r.stderr).toContain('forge-title')
    expect(r.stderr).toContain('body-bare-digits')
    expect(readFileSync(callLogPath, 'utf-8')).toBe('')
  })
})
