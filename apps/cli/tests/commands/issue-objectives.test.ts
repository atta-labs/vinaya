import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'bun:test'

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

// Task-run-v1 task 11's O1 refuses a task-shaped body (carrying `##
// Objectives`/`## Planner's rationale`) with no `vinaya/tranche:*` label —
// this fixture's body always carries both headings, so it must be a real,
// fully-rationale'd, labeled task Issue (`stubGh`'s default labels below)
// rather than the bare single-paragraph rationale this file used before that
// gate existed. The eight rationale fields are new; the one paragraph the
// byte-identity assertion checks for is unchanged and still present verbatim.
const RATIONALE_TAIL = [
  "## Planner's rationale",
  '',
  '**Boundary** — Amend the Objectives section only.',
  '',
  '**Sizing** — n/a, test fixture.',
  '',
  '**Project(s) + blast radius** — `Project: cli`. No shared-primitive fan-out.',
  '',
  '**Dependency rationale** — `Depends-on: —`; `Conflicts-with: —`.',
  '',
  '**Traps to avoid** — n/a.',
  '',
  '**Suggested agent-class** — fast — test fixture.',
  '',
  '**Stop-and-escalate** — n/a.',
  '',
  '**Docs to keep coherent** — no-doc-surface.',
  '',
  'This paragraph must survive byte-for-byte across every objectives edit.',
  ''
].join('\n')

function issueBody(objectivesSection: string[]): string {
  return [
    '## Task Issue',
    '',
    'Intro text before the Objectives section.',
    '',
    ...objectivesSection,
    '',
    RATIONALE_TAIL
  ].join('\n')
}

const THREE_OBJECTIVES = [
  '## Objectives',
  '',
  'O1. First objective sentence here.',
  'O2. Second objective sentence here.',
  'O3. Third objective sentence here.'
]

/**
 * A `gh` stub answering `issue view <n> --json body,comments` and
 * `issue view <n> --json labels` (a real `vinaya/tranche:*` label — this
 * file's fixture body always carries `## Objectives`/`## Planner's
 * rationale`, and O1 (task-run-v1 task 11) now refuses that shape unlabeled,
 * so the label and the fixture's full eight-field rationale must both be
 * real for `writeValidatedIssueEdit`'s validated-write path to succeed),
 * `issue edit <n> --body-file <path>` (captured to a log, never a real
 * write), and `issue comment <n> --body-file <path>` (captured to a log,
 * printing `commentUrl`). `issue view <n> --json milestone` (O5's best-effort
 * read) falls through to the same `body-comments.json` payload, which
 * carries no `milestone` key — read as "no Milestone", O5 dormant.
 */
function stubGh(opts: {
  body: string
  comments: Array<{ body: string; author?: { login: string } | null; url?: string }>
  issueUrl: string
  commentUrl: string
  login?: string
  /** Override the `[<tranche>] <n> — ...` title `resolveTaskIssueRef` (O6) reads — defaults to a well-formed one so the supersede path resolves cleanly when a frozen brief is present. */
  title?: string
}): {
  path: Record<string, string>
  editedBodyLogPath: string
  commentsLogPath: string
} {
  const dir = tempDir('issue-objectives-stub-')
  const bodyCommentsJsonPath = join(dir, 'body-comments.json')
  const fullContextJsonPath = join(dir, 'full-context.json')
  const labelsJsonPath = join(dir, 'labels.json')
  const editedBodyLogPath = join(dir, 'edited-body.log')
  const commentsLogPath = join(dir, 'posted-comments.log')
  // `--json body,comments` (O3's `fetchForgeIssueContext`, called from
  // inside `writeValidatedIssueEdit`) and `--json body,title,labels,comments`
  // (`issue-objectives.ts`'s own `fetchIssueBodyAndComments`) both hit this
  // same `gh`. Both payloads carry `opts.comments` unmodified — neither
  // fixture in this file posts a frozen `aeg:brief:v<k>` comment, so O6's
  // supersede path stays dormant and only `title`/`labels` need placeholder
  // values that never get read for these tests.
  writeFileSync(bodyCommentsJsonPath, JSON.stringify({ body: opts.body, comments: opts.comments }))
  writeFileSync(
    fullContextJsonPath,
    JSON.stringify({
      body: opts.body,
      title: opts.title ?? '[task-run-v1] 11 — fixture',
      labels: [{ name: 'vinaya/tranche:task-run-v1' }],
      comments: opts.comments
    })
  )
  writeFileSync(labelsJsonPath, JSON.stringify({ labels: [{ name: 'vinaya/tranche:demo' }] }))
  writeFileSync(editedBodyLogPath, '')
  writeFileSync(commentsLogPath, '')
  const login = opts.login ?? 'daniboomerang'
  const gh = join(dir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  echo "${login}"
  exit 0
fi
if [ "$1" = "label" ] && [ "$2" = "list" ]; then
  echo '[{"name":"vinaya/tranche:demo"}]'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$*" in
    *title*) cat "${fullContextJsonPath}" ;;
    *comments*) cat "${bodyCommentsJsonPath}" ;;
    *labels*) cat "${labelsJsonPath}" ;;
    *) echo "unhandled issue view: $*" >&2; exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then
  bodyFile="$5"
  cat "$bodyFile" > "${editedBodyLogPath}"
  echo "${opts.issueUrl}"
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  bodyFile="$5"
  echo "ISSUE:$3" >> "${commentsLogPath}"
  cat "$bodyFile" >> "${commentsLogPath}"
  echo "---" >> "${commentsLogPath}"
  echo "${opts.commentUrl}"
  exit 0
fi
exit 1
`
  )
  chmodSync(gh, 0o755)
  return { path: { PATH: `${dir}:${process.env.PATH ?? ''}` }, editedBodyLogPath, commentsLogPath }
}

describe('vinaya issue objectives edit', () => {
  it('requires a non-empty --reason', () => {
    const repo = tempDir('issue-objectives-repo-')
    const r = runCli(['issue', 'objectives', 'edit', '413', '--add', 'x'], repo, {})
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('--reason')
  })

  it('refuses a --reason containing a newline before any forge fetch or write — no gh stub needed', () => {
    const repo = tempDir('issue-objectives-repo-')
    const r = runCli(['issue', 'objectives', 'edit', '413', '--add', 'x', '--reason', 'line one\nline two'], repo, {})
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('single line')
  })

  it('refuses --add and --drop together', () => {
    const repo = tempDir('issue-objectives-repo-')
    const r = runCli(
      ['issue', 'objectives', 'edit', '413', '--add', 'x', '--drop', 'O1', '--reason', 'because'],
      repo,
      {}
    )
    expect(r.status).toBe(1)
  })

  it('refuses --replace of an id that does not exist', () => {
    const repo = tempDir('issue-objectives-repo-')
    const { path, editedBodyLogPath } = stubGh({
      body: issueBody(THREE_OBJECTIVES),
      comments: [],
      issueUrl: 'https://github.com/acme/widget/issues/413',
      commentUrl: 'https://github.com/acme/widget/issues/413#issuecomment-1'
    })
    const r = runCli(
      ['issue', 'objectives', 'edit', '413', '--replace', 'O9', 'new sentence', '--reason', 'because'],
      repo,
      path
    )
    expect(r.status).toBe(1)
    expect(readFileSync(editedBodyLogPath, 'utf-8')).toBe('')
  })

  it('refuses when the Objectives section does not parse — nothing written', () => {
    const repo = tempDir('issue-objectives-repo-')
    const { path, editedBodyLogPath, commentsLogPath } = stubGh({
      body: issueBody(['## Objectives', '', '1. Missing the O prefix.']),
      comments: [],
      issueUrl: 'https://github.com/acme/widget/issues/413',
      commentUrl: 'https://github.com/acme/widget/issues/413#issuecomment-1'
    })
    const r = runCli(['issue', 'objectives', 'edit', '413', '--add', 'x', '--reason', 'because'], repo, path)
    expect(r.status).toBe(1)
    expect(readFileSync(editedBodyLogPath, 'utf-8')).toBe('')
    expect(readFileSync(commentsLogPath, 'utf-8')).toBe('')
  })

  it('--add appends O<max+1>, leaves the rationale byte-identical, and posts the marker comment', () => {
    const repo = tempDir('issue-objectives-repo-')
    const { path, editedBodyLogPath, commentsLogPath } = stubGh({
      body: issueBody(THREE_OBJECTIVES),
      comments: [],
      issueUrl: 'https://github.com/acme/widget/issues/413',
      commentUrl: 'https://github.com/acme/widget/issues/413#issuecomment-5'
    })
    const r = runCli(
      ['issue', 'objectives', 'edit', '413', '--add', 'Fourth objective sentence here.', '--reason', 'scope grew'],
      repo,
      path
    )
    expect(r.status).toBe(0)
    // Prints the COMMENT's url, never the plain issue-edit url (quiet mode).
    // `.split('\n').pop()`: an unresolvable trust-anchor repo (no git remote
    // in this tempDir) prints its own warning line to stdout first.
    expect(r.stdout.trim().split('\n').pop()).toBe('https://github.com/acme/widget/issues/413#issuecomment-5')

    const editedBody = readFileSync(editedBodyLogPath, 'utf-8')
    expect(editedBody).toContain('O4. Fourth objective sentence here.')
    expect(editedBody).toContain(RATIONALE_TAIL.trim())
    expect(editedBody).toContain('Intro text before the Objectives section.')

    const posted = readFileSync(commentsLogPath, 'utf-8')
    expect(posted).toContain('<!-- aeg:objectives:v1 -->')
    expect(posted).toContain('Reason: scope grew')
    expect(posted).toMatch(/Version: [0-9a-f]{64}/)
  })

  it('--replace keeps the id and changes only the sentence', () => {
    const repo = tempDir('issue-objectives-repo-')
    const { path, editedBodyLogPath } = stubGh({
      body: issueBody(THREE_OBJECTIVES),
      comments: [],
      issueUrl: 'https://github.com/acme/widget/issues/413',
      commentUrl: 'https://github.com/acme/widget/issues/413#issuecomment-5'
    })
    const r = runCli(
      ['issue', 'objectives', 'edit', '413', '--replace', 'O2', 'Rewritten second objective.', '--reason', 'clarify'],
      repo,
      path
    )
    expect(r.status).toBe(0)
    const editedBody = readFileSync(editedBodyLogPath, 'utf-8')
    expect(editedBody).toContain('O2. Rewritten second objective.')
    expect(editedBody).toContain('O1. First objective sentence here.')
    expect(editedBody).toContain('O3. Third objective sentence here.')
  })

  it('--drop of the LAST objective succeeds — no gap, no renumbering needed', () => {
    const repo = tempDir('issue-objectives-repo-')
    const { path, editedBodyLogPath } = stubGh({
      body: issueBody(THREE_OBJECTIVES),
      comments: [],
      issueUrl: 'https://github.com/acme/widget/issues/413',
      commentUrl: 'https://github.com/acme/widget/issues/413#issuecomment-5'
    })
    const r = runCli(['issue', 'objectives', 'edit', '413', '--drop', 'O3', '--reason', 'descoped'], repo, path)
    expect(r.status).toBe(0)
    const editedBody = readFileSync(editedBodyLogPath, 'utf-8')
    expect(editedBody).toContain('O1. First objective sentence here.')
    expect(editedBody).toContain('O2. Second objective sentence here.')
    expect(editedBody).not.toContain('O3.')
  })

  it('--drop of a middle objective is refused — never renumbers, reports the contiguity contradiction', () => {
    const repo = tempDir('issue-objectives-repo-')
    const { path, editedBodyLogPath, commentsLogPath } = stubGh({
      body: issueBody(THREE_OBJECTIVES),
      comments: [],
      issueUrl: 'https://github.com/acme/widget/issues/413',
      commentUrl: 'https://github.com/acme/widget/issues/413#issuecomment-5'
    })
    const r = runCli(['issue', 'objectives', 'edit', '413', '--drop', 'O2', '--reason', 'descoped'], repo, path)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('never renumbers')
    expect(readFileSync(editedBodyLogPath, 'utf-8')).toBe('')
    expect(readFileSync(commentsLogPath, 'utf-8')).toBe('')
  })

  it('numbers the marker from existing objectives comments on the forge, never a local counter', () => {
    const repo = tempDir('issue-objectives-repo-')
    const { path, commentsLogPath } = stubGh({
      body: issueBody(THREE_OBJECTIVES),
      comments: [{ body: '<!-- aeg:objectives:v1 -->\nPrevious: ...\n' }, { body: 'unrelated comment' }],
      issueUrl: 'https://github.com/acme/widget/issues/413',
      commentUrl: 'https://github.com/acme/widget/issues/413#issuecomment-9'
    })
    const r = runCli(
      ['issue', 'objectives', 'edit', '413', '--add', 'Fourth objective sentence here.', '--reason', 'scope grew'],
      repo,
      path
    )
    expect(r.status).toBe(0)
    const posted = readFileSync(commentsLogPath, 'utf-8')
    expect(posted).toContain('<!-- aeg:objectives:v2 -->')
  })

  it('refuses when the authenticated actor is not an allowlisted principal — nothing written or posted', () => {
    const repo = tempDir('issue-objectives-repo-')
    const { path, editedBodyLogPath, commentsLogPath } = stubGh({
      body: issueBody(THREE_OBJECTIVES),
      comments: [],
      issueUrl: 'https://github.com/acme/widget/issues/413',
      commentUrl: 'https://github.com/acme/widget/issues/413#issuecomment-5',
      login: 'some-random-collaborator'
    })
    const r = runCli(
      ['issue', 'objectives', 'edit', '413', '--add', 'Fourth objective sentence here.', '--reason', 'scope grew'],
      repo,
      path
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Principal-only')
    expect(readFileSync(editedBodyLogPath, 'utf-8')).toBe('')
    expect(readFileSync(commentsLogPath, 'utf-8')).toBe('')
  })

  // task-run-v1 task 11, review round 1, O6 — once the Objectives comment is
  // posted, a frozen brief must be superseded in the same command. This
  // fixture cannot exercise the real supersede (it needs a real/mocked
  // `assembleAndRenderBrief` network round trip — covered instead by
  // `dispatch-task.test.ts`'s bundle-integration fixture for that shared
  // machinery); it proves the OTHER half: a frozen brief whose Issue title
  // does not resolve to a `[<tranche>] <n> — ...` task identity is refused
  // by name rather than silently skipping the supersede O6 promises.
  it('refuses, naming O6, when a frozen brief exists but the title/label do not resolve to a task identity', () => {
    const repo = tempDir('issue-objectives-repo-')
    const { path, commentsLogPath } = stubGh({
      body: issueBody(THREE_OBJECTIVES),
      comments: [
        { body: '<!-- aeg:brief:v1 -->\nBrief hash: x\nfrozen brief text', author: { login: 'daniboomerang' } }
      ],
      issueUrl: 'https://github.com/acme/widget/issues/413',
      commentUrl: 'https://github.com/acme/widget/issues/413#issuecomment-5',
      title: 'not a task-shaped title at all'
    })
    const r = runCli(
      ['issue', 'objectives', 'edit', '413', '--add', 'Fourth objective sentence here.', '--reason', 'scope grew'],
      repo,
      path
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/already frozen/)
    expect(r.stderr).toContain('O6')
    // The Objectives comment was already posted before the supersede check —
    // this refusal reports the resulting disagreement, it does not undo it.
    const posted = readFileSync(commentsLogPath, 'utf-8')
    expect(posted).toContain('<!-- aeg:objectives:v1 -->')
  })
})
