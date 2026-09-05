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

const RATIONALE_TAIL = [
  "## Planner's rationale",
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
 * `issue view <n> --json labels` (empty labels — not a task Issue, so
 * `writeValidatedIssueEdit` skips the rationale gate entirely, keeping this
 * file's fixtures scoped to the objectives grammar itself), `issue edit <n>
 * --body-file <path>` (captured to a log, never a real write), and `issue
 * comment <n> --body-file <path>` (captured to a log, printing `commentUrl`).
 */
function stubGh(opts: { body: string; comments: Array<{ body: string }>; issueUrl: string; commentUrl: string }): {
  path: Record<string, string>
  editedBodyLogPath: string
  commentsLogPath: string
} {
  const dir = tempDir('issue-objectives-stub-')
  const bodyCommentsJsonPath = join(dir, 'body-comments.json')
  const labelsJsonPath = join(dir, 'labels.json')
  const editedBodyLogPath = join(dir, 'edited-body.log')
  const commentsLogPath = join(dir, 'posted-comments.log')
  writeFileSync(bodyCommentsJsonPath, JSON.stringify({ body: opts.body, comments: opts.comments }))
  writeFileSync(labelsJsonPath, JSON.stringify({ labels: [] }))
  writeFileSync(editedBodyLogPath, '')
  writeFileSync(commentsLogPath, '')
  const gh = join(dir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$*" in
    *labels*) cat "${labelsJsonPath}" ;;
    *) cat "${bodyCommentsJsonPath}" ;;
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
    expect(r.stdout.trim()).toBe('https://github.com/acme/widget/issues/413#issuecomment-5')

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
})
