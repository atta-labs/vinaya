import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'bun:test'

/**
 * `vinaya pr create` splits the brief out of the body (task 4, #397) end to
 * end, against a `gh` stub on `PATH` — the same discipline
 * `pr-refreeze.test.ts`/`review-status.test.ts` use. `rings.
 * ring1_forgeWriteInterception: true` keeps this test scoped to the split
 * itself: it empties `resolveSections` (nothing config-driven to satisfy)
 * and skips `refuseOnRedBody`'s registry `PR_BODY` pass, leaving only
 * `checkForgeTitle` and `body-bare-digits` — both trivially satisfied by an
 * ordinary title and a digit-free report — as the gates a synthetic fixture
 * body must pass.
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

/**
 * A `gh` stub answering `pr create` with a fake PR URL (copying the exact
 * body-file `gh` was handed to `createBodyLogPath`, for the test to inspect
 * afterward) and `pr comment <n> --body-file <path>` by appending its
 * content to `commentsLogPath` — one entry per call, in call order, so the
 * test can tell the body-hash marker comment from the brief comment by
 * which one landed first.
 */
function stubGh(prUrl: string): { path: Record<string, string>; createBodyLogPath: string; commentsLogPath: string } {
  const dir = tempDir('pr-create-stub-')
  const createBodyLogPath = join(dir, 'create-body.log')
  const commentsLogPath = join(dir, 'comments.log')
  writeFileSync(createBodyLogPath, '')
  writeFileSync(commentsLogPath, '')
  const gh = join(dir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh
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
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  # args: pr comment <n> --body-file <path>
  bodyFile="$5"
  echo "PR:$3" >> "${commentsLogPath}"
  cat "$bodyFile" >> "${commentsLogPath}"
  echo "---" >> "${commentsLogPath}"
  exit 0
fi
exit 1
`
  )
  chmodSync(gh, 0o755)
  return { path: { PATH: `${dir}:${process.env.PATH ?? ''}` }, createBodyLogPath, commentsLogPath }
}

const BRIEF_TEXT = [
  '**For:** Sonnet (coding-agent CLI)',
  '**Goal:** exercise the brief/report split end to end.',
  '',
  '## 2. Context',
  '',
  '- Fixture brief, not a real dispatch.'
].join('\n')

function fixtureBody(): string {
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
    '## Summary',
    '',
    'Splits the brief out of the PR body into its own comment.',
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
    '',
    '---',
    '',
    '<!-- aeg:brief:start -->',
    '## Reference — the dispatched brief',
    '',
    BRIEF_TEXT,
    '<!-- aeg:brief:end -->',
    ''
  ].join('\n')
}

describe('vinaya pr create — splits the brief into its own comment (task 4, #397)', () => {
  it('the body sent to gh carries no brief/reference section; the aeg:brief comment carries the brief verbatim', () => {
    const repo = tempDir('pr-create-repo-')
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
    writeFileSync(
      join(repo, 'vinaya.config.json'),
      `${JSON.stringify({ rings: { ring1_forgeWriteInterception: true, ring2_asyncAudits: false } }, null, 2)}\n`
    )
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })

    const bodyPath = join(repo, 'pr-body.md')
    writeFileSync(bodyPath, fixtureBody())

    const { path, createBodyLogPath, commentsLogPath } = stubGh('https://github.com/acme/widget/pull/42')

    const r = runCli(['pr', 'create', '--body-file', bodyPath, '--title', 'Fix(cli): split brief comment'], repo, path)
    expect(r.status).toBe(0)

    const sentBody = readFileSync(createBodyLogPath, 'utf-8')
    expect(sentBody).not.toContain('aeg:brief:start')
    expect(sentBody).not.toContain('<details>')
    expect(sentBody).not.toContain('## Reference — the dispatched brief')
    expect(sentBody).not.toContain(BRIEF_TEXT)
    expect(sentBody).toContain('## Summary')
    expect(sentBody).toContain('**Tier:** 1')

    const comments = readFileSync(commentsLogPath, 'utf-8')
    const entries = comments.split('---\n').filter((s) => s.trim().length > 0)
    expect(entries.length).toBe(2)
    expect(entries[0]).toContain('aeg:body-hash:')
    expect(entries[1]).toContain('<!-- aeg:brief -->')
    expect(entries[1]).toContain(BRIEF_TEXT)
  })

  it('a body with no aeg:brief section posts no brief comment — one comment only', () => {
    const repo = tempDir('pr-create-repo-nobrief-')
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
    writeFileSync(
      join(repo, 'vinaya.config.json'),
      `${JSON.stringify({ rings: { ring1_forgeWriteInterception: true, ring2_asyncAudits: false } }, null, 2)}\n`
    )
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })

    const bodyPath = join(repo, 'pr-body.md')
    const bodyNoBrief = fixtureBody().split('---\n')[0] as string
    writeFileSync(bodyPath, bodyNoBrief)

    const { path, createBodyLogPath, commentsLogPath } = stubGh('https://github.com/acme/widget/pull/43')

    const r = runCli(['pr', 'create', '--body-file', bodyPath, '--title', 'Fix(cli): no brief section'], repo, path)
    expect(r.status).toBe(0)

    const sentBody = readFileSync(createBodyLogPath, 'utf-8')
    expect(sentBody).toContain('## Summary')

    const comments = readFileSync(commentsLogPath, 'utf-8')
    const entries = comments.split('---\n').filter((s) => s.trim().length > 0)
    expect(entries.length).toBe(1)
    expect(entries[0]).toContain('aeg:body-hash:')
  })
})
