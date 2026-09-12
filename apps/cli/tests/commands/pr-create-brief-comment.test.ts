import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'bun:test'

/**
 * `vinaya pr create` no longer splits a brief section out of the body
 * (plan-brief-v1 task 2, #427) — the brief lives on the task Issue's frozen
 * `aeg:brief:v1` comment (`vinaya task dispatch`), never in the PR body. This
 * file, which used to exercise the retired split end to end, now covers its
 * replacement: a body still carrying either legacy `aeg:brief:start`/
 * `aeg:brief:end` marker is refused outright, and an ordinary new-shaped body
 * (no `## Reference` section at all) opens clean, unaffected.
 */

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
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

function runCli(args: string[], cwd: string, env: Record<string, string | undefined>): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], {
      encoding: 'utf8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env }
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
  execFileSync('git', ['init', '-q'], { cwd: repo })
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
    '<!-- AEG:CLOSES:START -->',
    'Closes #42',
    '<!-- AEG:CLOSES:END -->',
    '',
    '**For:** Sonnet (coding-agent CLI)',
    '<!-- AEG:PROJECT:START -->',
    '**Project:** vinaya',
    '<!-- AEG:PROJECT:END -->',
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
    'Touches `apps/cli/src/commands/pr.ts` only.',
    '',
    '<!-- AEG:TIER:START -->',
    '**Tier:** 1',
    '<!-- AEG:TIER:END -->',
    ''
  ].join('\n')
}

describe('vinaya pr create — refuses a body still carrying the retired brief split (plan-brief-v1 task 2, #427)', () => {
  it('a body carrying <!-- aeg:brief:start --> is refused — gh is never invoked', () => {
    const repo = initRepo()
    const bodyPath = join(repo, 'pr-body.md')
    writeFileSync(
      bodyPath,
      [
        newShapedBody(),
        '---',
        '',
        '<!-- aeg:brief:start -->',
        '## Reference — the dispatched brief',
        '',
        BRIEF_TEXT,
        '<!-- aeg:brief:end -->',
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
    expect(r.stderr).toContain('aeg:brief:start')
    expect(r.stderr).toContain('pr-brief-comment')

    expect(readFileSync(callLogPath, 'utf-8')).toBe('')
  })

  it('a body carrying only the trailing <!-- aeg:brief:end --> marker (unpaired) is still refused', () => {
    const repo = initRepo()
    const bodyPath = join(repo, 'pr-body.md')
    writeFileSync(bodyPath, `${newShapedBody()}\n<!-- aeg:brief:end -->\n`)
    const { path, callLogPath } = stubGh('https://github.com/acme/widget/pull/42')

    const r = runCli(
      ['pr', 'create', '--body-file', bodyPath, '--title', 'Fix(cli): unpaired marker refused'],
      repo,
      path
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('aeg:brief:end')
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
    expect(sentBody).not.toContain('aeg:brief')
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
        'This task retires the `<!-- aeg:brief:start -->`/`<!-- aeg:brief:end -->` marker pair — a body still carrying either as a real, own-line marker is refused.'
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
