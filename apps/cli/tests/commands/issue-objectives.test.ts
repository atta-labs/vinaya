import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'bun:test'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_ROOT = join(CLI_ROOT, '..', '..')
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

function issueBody(objectivesSection: string[], partsSection: string[] = THREE_PARTS): string {
  return [
    '## Task Issue',
    '',
    'Intro text before the Objectives section.',
    '',
    ...objectivesSection,
    '',
    ...partsSection,
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

// task-run-v1 task 15, O5: every `--add` fixture needs a real `## Parts`
// section to append its `--part` line into.
const THREE_PARTS = [
  '## Parts',
  '',
  'Part 1 (O1) — outcome one.',
  'Part 2 (O2) — outcome two.',
  'Part 3 (O3) — outcome three.'
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
      [
        'issue',
        'objectives',
        'edit',
        '413',
        '--add',
        'Fourth objective sentence here.',
        '--part',
        'Part 4 (O4) — outcome four.',
        '--reason',
        'scope grew'
      ],
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
    // task-run-v1 task 15, O5: the --part line lands in `## Parts` in the SAME edit.
    expect(editedBody).toContain('Part 4 (O4) — outcome four.')
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
    // task-run-v1 task 15, O5: Part 3 cited ONLY O3 — removed in the same edit.
    expect(editedBody).not.toContain('Part 3 (O3)')
    expect(editedBody).toContain('Part 1 (O1) — outcome one.')
    expect(editedBody).toContain('Part 2 (O2) — outcome two.')
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
      [
        'issue',
        'objectives',
        'edit',
        '413',
        '--add',
        'Fourth objective sentence here.',
        '--part',
        'Part 4 (O4) — outcome four.',
        '--reason',
        'scope grew'
      ],
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
      [
        'issue',
        'objectives',
        'edit',
        '413',
        '--add',
        'Fourth objective sentence here.',
        '--part',
        'Part 4 (O4) — outcome four.',
        '--reason',
        'scope grew'
      ],
      repo,
      path
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Principal-only')
    expect(readFileSync(editedBodyLogPath, 'utf-8')).toBe('')
    expect(readFileSync(commentsLogPath, 'utf-8')).toBe('')
  })

  // O3 — a frozen brief whose title/label do not resolve to a
  // `[<tranche>] <n> — ...` task identity is no longer refused by name: it
  // supersedes through the backlog `--issue` path (`prepareIssueTask`)
  // instead, the same path `task brief --issue` already uses. This fixture
  // has no real git remote/template to render from, so that render itself
  // fails — proving the OTHER half of O3's ordering fix: the failure
  // surfaces BEFORE this edit's own objectives comment posts, leaving none
  // behind (the full success case — a real render producing a v2 brief —
  // is `issueObjectivesEdit --add supersedes a backlog brief` below).
  it('a render failure on the backlog supersede path leaves no objectives comment behind', () => {
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
      [
        'issue',
        'objectives',
        'edit',
        '413',
        '--add',
        'Fourth objective sentence here.',
        '--part',
        'Part 4 (O4) — outcome four.',
        '--reason',
        'scope grew'
      ],
      repo,
      path
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('brief render refused')
    // Fixed ordering (O3): the supersede attempt runs BEFORE the objectives
    // comment post, so a failure here leaves no objectives comment at all —
    // not even a v1.
    expect(readFileSync(commentsLogPath, 'utf-8')).toBe('')
  })
})

// task-run-v1 task 15, O5: `--add` requires a `--part` citing the objective
// it just created, written into `## Parts` in the same edit; `--part` is
// meaningless (refused) outside `--add`.
describe('vinaya issue objectives edit --part (task-run-v1 task 15, O5)', () => {
  it('refuses --add with no --part, naming the rule', () => {
    const repo = tempDir('issue-objectives-repo-')
    const r = runCli(
      ['issue', 'objectives', 'edit', '413', '--add', 'Fourth objective sentence here.', '--reason', 'scope grew'],
      repo,
      {}
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('objectives-part-required')
    expect(r.stderr).toContain('--part')
  })

  it('refuses --part given with --drop', () => {
    const repo = tempDir('issue-objectives-repo-')
    const r = runCli(
      ['issue', 'objectives', 'edit', '413', '--drop', 'O3', '--part', 'Part 4 (O4) — x.', '--reason', 'descoped'],
      repo,
      {}
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('--part` is only meaningful with `--add`')
  })

  it('refuses a --part that does not cite the newly added objective', () => {
    const repo = tempDir('issue-objectives-repo-')
    const { path, editedBodyLogPath, commentsLogPath } = stubGh({
      body: issueBody(THREE_OBJECTIVES),
      comments: [],
      issueUrl: 'https://github.com/acme/widget/issues/413',
      commentUrl: 'https://github.com/acme/widget/issues/413#issuecomment-5'
    })
    const r = runCli(
      [
        'issue',
        'objectives',
        'edit',
        '413',
        '--add',
        'Fourth objective sentence here.',
        '--part',
        'Part 4 (O1) — wrong citation.',
        '--reason',
        'scope grew'
      ],
      repo,
      path
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('does not cite O4')
    expect(readFileSync(editedBodyLogPath, 'utf-8')).toBe('')
    expect(readFileSync(commentsLogPath, 'utf-8')).toBe('')
  })

  it('refuses a malformed --part line', () => {
    const repo = tempDir('issue-objectives-repo-')
    const { path, editedBodyLogPath } = stubGh({
      body: issueBody(THREE_OBJECTIVES),
      comments: [],
      issueUrl: 'https://github.com/acme/widget/issues/413',
      commentUrl: 'https://github.com/acme/widget/issues/413#issuecomment-5'
    })
    const r = runCli(
      [
        'issue',
        'objectives',
        'edit',
        '413',
        '--add',
        'Fourth objective sentence here.',
        '--part',
        'not a well-formed Part line',
        '--reason',
        'scope grew'
      ],
      repo,
      path
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('objectives-part-malformed')
    expect(readFileSync(editedBodyLogPath, 'utf-8')).toBe('')
  })

  it('a Part citing the dropped objective ALONGSIDE another is left untouched, and the existing citation gate refuses the dangling reference', () => {
    // `removePartLinesCitingOnly` only ever removes a Part whose citation is
    // EXACTLY the dropped objective (O5's own stated scope) — Part 2 here
    // cites O2 too, so it survives untouched, still citing the
    // now-removed O3. `writeValidatedIssueEdit`'s own pre-existing
    // `checkPartsCiteDefinedObjectives` gate (unrelated to this task) then
    // correctly refuses that dangling reference — the Planner resolves it by
    // hand (fix the Part's citation, or `--replace` first), never silently.
    const repo = tempDir('issue-objectives-repo-')
    const { path, editedBodyLogPath, commentsLogPath } = stubGh({
      body: issueBody(THREE_OBJECTIVES, [
        '## Parts',
        '',
        'Part 1 (O1) — outcome one.',
        'Part 2 (O2, O3) — outcome two and three together.',
        'Part 3 (O3) — outcome three alone.'
      ]),
      comments: [],
      issueUrl: 'https://github.com/acme/widget/issues/413',
      commentUrl: 'https://github.com/acme/widget/issues/413#issuecomment-5'
    })
    const r = runCli(['issue', 'objectives', 'edit', '413', '--drop', 'O3', '--reason', 'descoped'], repo, path)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Part 2 cites O3')
    expect(readFileSync(editedBodyLogPath, 'utf-8')).toBe('')
    expect(readFileSync(commentsLogPath, 'utf-8')).toBe('')
  })
})

/**
 * `issue objectives edit` re-renders and re-validates the
 * WHOLE brief in the same command (`validateRenderedBriefForIssue`,
 * reached via `writeValidatedIssueEdit` → `validateTaskIssue`, the same
 * validated-write path every edit in this file already goes through) and
 * posts only when it validates. Needs a real git+template fixture (this
 * file's other tests never reach that gate: their fixture has no
 * `AEG_REPO`/real forge remote, so `canRenderBriefFromHere()` is false and
 * the whole render stays dormant — see `validateRenderedBriefForIssue`'s own
 * doc comment). A BACKLOG (unlabeled) Issue is required to actually
 * exercise it here, without also standing up a real tranche fixture.
 */
describe('vinaya issue objectives edit \u2014 re-renders and re-validates the brief', () => {
  function backlogGh(
    dir: string,
    opts: { body: string; issueUrl: string; commentUrl: string }
  ): {
    path: Record<string, string>
    editedBodyLogPath: string
    commentsLogPath: string
  } {
    const bodyCommentsJsonPath = join(dir, 'body-comments.json')
    const fullContextJsonPath = join(dir, 'full-context.json')
    const labelsJsonPath = join(dir, 'labels.json')
    const editedBodyLogPath = join(dir, 'edited-body.log')
    const commentsLogPath = join(dir, 'posted-comments.log')
    writeFileSync(bodyCommentsJsonPath, JSON.stringify({ body: opts.body, comments: [] }))
    writeFileSync(
      fullContextJsonPath,
      JSON.stringify({ body: opts.body, title: '[fixture] backlog issue', labels: [], comments: [] })
    )
    writeFileSync(labelsJsonPath, JSON.stringify({ labels: [] }))
    writeFileSync(editedBodyLogPath, '')
    writeFileSync(commentsLogPath, '')
    const gh = join(dir, 'gh')
    writeFileSync(
      gh,
      `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  echo "daniboomerang"
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

  function gitCmd(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  }

  const RATIONALE = [
    "## Task Issue \u2014 Planner's rationale",
    '',
    '**Boundary** \u2014 In: nothing real. Out: nothing.',
    '',
    '**Sizing** \u2014 n/a, test fixture.',
    '',
    '**Project(s) + blast radius** \u2014 `Project: cli`. No shared-primitive fan-out.',
    '',
    '**Dependency rationale** \u2014 `Depends-on: \u2014`; `Conflicts-with: \u2014`.',
    '',
    '**Traps to avoid** \u2014 n/a.',
    '',
    '**Suggested agent-class** \u2014 fast \u2014 test fixture.',
    '',
    '**Stop-and-escalate** \u2014 n/a.',
    '',
    '**Docs to keep coherent** \u2014 no-doc-surface.'
  ].join('\n')

  it('refuses the whole write when re-rendering the edited body cannot produce a valid brief \u2014 nothing written, nothing posted', () => {
    const tmp = tempDir('issue-objectives-backlog-')
    const remoteDir = join(tmp, 'remote')
    const localDir = join(tmp, 'local')
    mkdirSync(join(remoteDir, 'aeg-root', 'templates'), { recursive: true })
    gitCmd(tmp, ['init', '-q', '-b', 'main', remoteDir])
    gitCmd(remoteDir, ['config', 'user.email', 'a@example.com'])
    gitCmd(remoteDir, ['config', 'user.name', 'A'])
    cpSync(
      join(REPO_ROOT, 'aeg-root', 'templates', 'brief-template.md'),
      join(remoteDir, 'aeg-root', 'templates', 'brief-template.md')
    )
    gitCmd(remoteDir, ['add', '.'])
    gitCmd(remoteDir, ['commit', '-q', '-m', 'seed'])
    gitCmd(tmp, ['clone', '-q', remoteDir, localDir])
    gitCmd(localDir, ['config', 'user.email', 'a@example.com'])
    gitCmd(localDir, ['config', 'user.name', 'A'])

    // Deliberately missing `## Stop conditions` — a section the brief
    // renderer requires past its own cutover. Adding an objective/Part
    // (otherwise well-formed) never touches this section, so the edit
    // itself is valid, but re-rendering the RESULT still can't produce a
    // brief \u2014 exactly the "leaves the brief invalid" case O4 refuses.
    const body = [
      '**Project:** cli',
      '',
      '## Objectives',
      '',
      'O1. The fixture exercises objectives re-validation.',
      '',
      '## Surface',
      '',
      'in: aeg-root',
      'out: \u2014',
      '',
      '## Parts',
      '',
      'Part 1 (O1) \u2014 the only part, citing the only objective.',
      '',
      '## Test plan',
      '',
      'Test Plan: unit-tests-only',
      '',
      RATIONALE
    ].join('\n')

    const { path, editedBodyLogPath, commentsLogPath } = backlogGh(tmp, {
      body,
      issueUrl: 'https://github.com/acme/widget/issues/999',
      commentUrl: 'https://github.com/acme/widget/issues/999#issuecomment-1'
    })

    const r = runCli(
      [
        'issue',
        'objectives',
        'edit',
        '999',
        '--add',
        'A second, valid-looking objective.',
        '--part',
        'Part 2 (O2) \u2014 the second part.',
        '--reason',
        'exercising O4'
      ],
      localDir,
      { ...path, AEG_REPO: 'test-owner/test-repo' }
    )

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Stop conditions')
    expect(readFileSync(editedBodyLogPath, 'utf-8')).toBe('')
    expect(readFileSync(commentsLogPath, 'utf-8')).toBe('')
  })

  /**
   * A stateful `gh` fake, unlike `backlogGh` above: `issue edit`/`issue
   * comment` mutate a `state.json` on disk, and every `issue view` reads it
   * fresh — so the SECOND render this command triggers (O3/O6's supersede
   * call, `prepareIssueTask`, which re-fetches the Issue after
   * `writeValidatedIssueEdit`'s own real edit landed) sees the Objectives
   * change the first render already validated, the same round trip a real
   * forge gives for free.
   */
  function statefulBacklogGh(
    dir: string,
    opts: { body: string; title: string; comments: Array<{ body: string; author?: { login: string } | null }> }
  ): {
    path: Record<string, string>
    editedBodyLogPath: string
    commentsLogPath: string
    statePath: string
  } {
    const statePath = join(dir, 'state.json')
    writeFileSync(statePath, JSON.stringify({ body: opts.body, title: opts.title, comments: opts.comments }))
    const editedBodyLogPath = join(dir, 'edited-body.log')
    const commentsLogPath = join(dir, 'posted-comments.log')
    writeFileSync(editedBodyLogPath, '')
    writeFileSync(commentsLogPath, '')
    const gh = join(dir, 'gh')
    writeFileSync(
      gh,
      `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const statePath = ${JSON.stringify(statePath)}
const editedBodyLogPath = ${JSON.stringify(editedBodyLogPath)}
const commentsLogPath = ${JSON.stringify(commentsLogPath)}
const args = process.argv.slice(2)

function readState() {
  return JSON.parse(readFileSync(statePath, 'utf8'))
}

if (args[0] === 'api' && args[1] === 'user') {
  console.log('daniboomerang')
  process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'view') {
  const s = readState()
  console.log(
    JSON.stringify({
      number: 999,
      body: s.body,
      title: s.title,
      labels: [],
      comments: s.comments,
      state: 'OPEN'
    })
  )
  process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'edit') {
  const bodyFile = args[args.indexOf('--body-file') + 1]
  const newBody = readFileSync(bodyFile, 'utf8')
  appendFileSync(editedBodyLogPath, newBody)
  const s = readState()
  s.body = newBody
  writeFileSync(statePath, JSON.stringify(s))
  console.log('https://github.com/acme/widget/issues/999')
  process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'comment') {
  const bodyFile = args[args.indexOf('--body-file') + 1]
  const body = readFileSync(bodyFile, 'utf8')
  appendFileSync(commentsLogPath, 'ISSUE:' + args[2] + '\\n' + body + '\\n---\\n')
  const s = readState()
  s.comments.push({ body, author: { login: 'daniboomerang' } })
  writeFileSync(statePath, JSON.stringify(s))
  console.log('https://github.com/acme/widget/issues/999#issuecomment-' + s.comments.length)
  process.exit(0)
}
process.stderr.write('gh stub: unhandled invocation: ' + args.join(' ') + '\\n')
process.exit(1)
`
    )
    chmodSync(gh, 0o755)
    return { path: { PATH: `${dir}:${process.env.PATH ?? ''}` }, editedBodyLogPath, commentsLogPath, statePath }
  }

  it('issueObjectivesEdit --add supersedes a backlog brief: one added objective, one v2 brief, one command', () => {
    const tmp = tempDir('issue-objectives-backlog-supersede-')
    const remoteDir = join(tmp, 'remote')
    const localDir = join(tmp, 'local')
    mkdirSync(join(remoteDir, 'aeg-root', 'templates'), { recursive: true })
    gitCmd(tmp, ['init', '-q', '-b', 'main', remoteDir])
    gitCmd(remoteDir, ['config', 'user.email', 'a@example.com'])
    gitCmd(remoteDir, ['config', 'user.name', 'A'])
    cpSync(
      join(REPO_ROOT, 'aeg-root', 'templates', 'brief-template.md'),
      join(remoteDir, 'aeg-root', 'templates', 'brief-template.md')
    )
    gitCmd(remoteDir, ['add', '.'])
    gitCmd(remoteDir, ['commit', '-q', '-m', 'seed'])
    gitCmd(tmp, ['clone', '-q', remoteDir, localDir])
    gitCmd(localDir, ['config', 'user.email', 'a@example.com'])
    gitCmd(localDir, ['config', 'user.name', 'A'])

    // Carries `## Stop conditions` this time (unlike the O4 fixture above) —
    // a fully renderable backlog brief, so the supersede call below actually
    // produces a v2 rather than refusing.
    const body = [
      '**Project:** cli',
      '',
      '## Objectives',
      '',
      'O1. The fixture exercises the backlog supersede path.',
      '',
      '## Surface',
      '',
      'in: aeg-root',
      'out: —',
      '',
      '## Parts',
      '',
      'Part 1 (O1) — the only part, citing the only objective.',
      '',
      '## Test plan',
      '',
      'Test Plan: unit-tests-only',
      '',
      '## Stop conditions',
      '',
      '- Nothing unexpected.',
      '',
      RATIONALE
    ].join('\n')

    const { path, editedBodyLogPath, commentsLogPath } = statefulBacklogGh(tmp, {
      body,
      title: '[fixture] backlog issue',
      comments: [
        { body: '<!-- aeg:brief:v1 -->\nBrief hash: x\nfrozen brief text', author: { login: 'daniboomerang' } }
      ]
    })

    const r = runCli(
      [
        'issue',
        'objectives',
        'edit',
        '999',
        '--add',
        'A second objective the supersede must cover.',
        '--part',
        'Part 2 (O2) — the second part.',
        '--reason',
        'scope grew on a backlog issue'
      ],
      localDir,
      { ...path, AEG_REPO: 'test-owner/test-repo' }
    )

    expect(r.status).toBe(0)
    const editedBody = readFileSync(editedBodyLogPath, 'utf-8')
    expect(editedBody).toContain('O2. A second objective the supersede must cover.')
    expect(editedBody).toContain('Part 2 (O2) — the second part.')

    const posted = readFileSync(commentsLogPath, 'utf-8')
    // Both comments landed: the objectives audit comment...
    expect(posted).toContain('<!-- aeg:objectives:v1 -->')
    expect(posted).toContain('Reason: scope grew on a backlog issue')
    // ...and the superseding v2 brief, naming the v1 predecessor.
    expect(posted).toContain('<!-- aeg:brief:v2 -->')
    expect(posted).toMatch(/Supersedes: .*scope grew on a backlog issue/)
    // Two separate URLs on stdout — the objectives comment, then the brief.
    const lines = r.stdout.trim().split('\n')
    expect(lines.some((l) => l.includes('issuecomment-'))).toBe(true)
  })
})
