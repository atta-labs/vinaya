import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseIssueNumberFromRef } from '../../src/commands/issue'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')
const FORGE_FIXTURES = join(CLI_ROOT, 'tests', 'fixtures', 'forge')

const ISSUE_CONFIG = {
  briefSchema: { issue: { sections: [{ builtin: 'issueRationale' }] } }
}

type CliResult = { status: number; stdout: string; stderr: string }

function runCli(args: string[], cwd: string, env?: Record<string, string>): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

/**
 * A fake `gh` on PATH whose `issue view <ref> --json labels` answers with a
 * single task-tranche label — enough for `fetchForgeLabels` to treat the
 * target as a task Issue, without a real network call. Also answers
 * `--json body,comments` (O3's `fetchForgeIssueContext`, unconditional
 * whenever the target is a task Issue) with an empty body and no comments —
 * "no frozen brief exists", O3 dormant, the same as every real Issue this
 * suite's fixtures target before `vinaya task dispatch` ever runs on them.
 */
function fakeGhLabelsPath(dir: string): string {
  const gh = join(dir, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh
case "$*" in
  *labels*) echo '{"labels":[{"name":"vinaya/tranche:demo"}]}' ;;
  *) echo '{"body":"","comments":[]}' ;;
esac
`
  )
  execFileSync('chmod', ['+x', gh])
  return `${dir}:${process.env.PATH}`
}

describe('vinaya issue create --validate-only', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-issue-test-'))
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify(ISSUE_CONFIG), 'utf8')
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('refuses a task Issue (tranche:* label) lacking the rationale', () => {
    const r = runCli(
      [
        'issue',
        'create',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-no-rationale.md'),
        '--label',
        'vinaya/tranche:demo'
      ],
      cwd
    )
    expect(r.status).toBe(1)
    const lines = r.stderr.trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(8)
    for (const line of lines) {
      const finding = JSON.parse(line)
      expect(finding.check).toBe('brief-schema')
      expect(finding.agent_recovery_prompt).toContain('vinaya issue create')
    }
  })

  it('passes a task Issue carrying the full rationale', () => {
    const r = runCli(
      [
        'issue',
        'create',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-valid-with-objectives.md'),
        '--label',
        'vinaya/tranche:demo'
      ],
      cwd
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })

  it('passes a non-task Issue through unvalidated (no tranche label)', () => {
    const r = runCli(
      ['issue', 'create', '--validate-only', '--body-file', join(FORGE_FIXTURES, 'issue-no-rationale.md')],
      cwd
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })

  it('--json emits an enveloped outcome for a validated task Issue', () => {
    const r = runCli(
      [
        'issue',
        'create',
        '--validate-only',
        '--json',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-valid-with-objectives.md'),
        '--label',
        'vinaya/tranche:demo'
      ],
      cwd
    )
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.schema).toBe(1)
    expect(parsed.data.validated).toBe(true)
    expect(parsed.data.written).toBe(false)
  })
})

// The three content checks `open-issue.ts` gates task Issues on
// (`checkBlastRadiusScope`, `checkNoBriefContent`, `checkRationaleNamesDocs`)
// never reached `apps/cli`'s real validation path until this task — real,
// adversarial CLI invocations, not a source-only read (the same gap this
// task exists to close was invisible to a prior source-only read).
describe('vinaya issue create --validate-only — content gate', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-issue-content-test-'))
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify(ISSUE_CONFIG), 'utf8')
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('refuses a rationale that touches a shared package without a second project or ack', () => {
    // A real git repo with `vinaya.config.json`'s `blastRadius.extraDomains`
    // declaring a collision domain, and a single-project registry that does
    // NOT own it — the shape `checkBlastRadiusScope` exists to catch.
    execFileSync('git', ['init', '--quiet'], { cwd })
    writeFileSync(
      join(cwd, 'vinaya.config.json'),
      JSON.stringify({ ...ISSUE_CONFIG, blastRadius: { extraDomains: ['packages/ui'] } }),
      'utf8'
    )
    mkdirSync(join(cwd, '.vinaya'), { recursive: true })
    writeFileSync(
      join(cwd, '.vinaya', 'projects.md'),
      [
        '## Registry',
        '',
        '| Project | Path | Specs | Per-project state |',
        '|---------|------|-------|---------------------|',
        '| vinaya | `.` | `specs/` | (state tracked globally for now) |',
        ''
      ].join('\n'),
      'utf8'
    )

    const r = runCli(
      [
        'issue',
        'create',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-blast-radius-violation.md'),
        '--label',
        'vinaya/tranche:demo'
      ],
      cwd
    )
    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('issue-content')
    expect(finding.message).toContain('blast radius')
    expect(finding.message).toContain('packages/ui')
  })

  it('refuses an Issue body carrying a brief-shaped section', () => {
    const r = runCli(
      [
        'issue',
        'create',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-brief-content.md'),
        '--label',
        'vinaya/tranche:demo'
      ],
      cwd
    )
    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('issue-content')
    expect(finding.message).toContain('Technical surface map')
  })

  it('refuses a rationale that names no concrete doc/skill path', () => {
    const r = runCli(
      [
        'issue',
        'create',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-no-doc-path.md'),
        '--label',
        'vinaya/tranche:demo'
      ],
      cwd
    )
    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('issue-content')
    expect(finding.message).toContain('docs read')
  })

  it('passes a task Issue that clears both the presence gate and the content gate', () => {
    const r = runCli(
      [
        'issue',
        'create',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-valid-with-objectives.md'),
        '--label',
        'vinaya/tranche:demo'
      ],
      cwd
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })
})

describe('parseIssueNumberFromRef', () => {
  it('parses a bare number', () => {
    expect(parseIssueNumberFromRef('411')).toBe(411)
  })

  it('parses the trailing number off a full Issue URL', () => {
    expect(parseIssueNumberFromRef('https://github.com/atta-labs/vinaya/issues/411')).toBe(411)
  })

  it('parses the trailing number off a URL with a trailing slash trimmed', () => {
    expect(parseIssueNumberFromRef('  411  ')).toBe(411)
  })

  it('returns null for a ref with no digits at all', () => {
    expect(parseIssueNumberFromRef('not-a-ref')).toBeNull()
  })
})

describe('vinaya issue edit --validate-only — URL-form ref reaches the Objectives cutover end-to-end (review round 2, MINOR)', () => {
  // issue-valid.md carries the full eight-field rationale but no
  // `## Objectives` section — exactly the fixture needed to prove
  // `parseIssueNumberFromRef`'s number, not just `null`, decides the
  // cutover through the real command, not only at the unit level.
  const OBJECTIVES_CONFIG = {
    briefSchema: { issue: { sections: [{ builtin: 'issueRationale' }, { builtin: 'objectives' }] } }
  }
  let cwd: string
  let ghDir: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-issue-edit-test-'))
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify(OBJECTIVES_CONFIG), 'utf8')
    ghDir = mkdtempSync(join(tmpdir(), 'vinaya-issue-edit-fake-gh-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(ghDir, { recursive: true, force: true })
  })

  it('refuses a URL-form ref at/above the cutover for an Issue missing Objectives', () => {
    const r = runCli(
      [
        'issue',
        'edit',
        'https://github.com/atta-labs/vinaya/issues/404',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-valid.md')
      ],
      cwd,
      { PATH: fakeGhLabelsPath(ghDir) }
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('## Objectives')
  })

  it('passes the same URL-form ref below the cutover — grandfathered, not guessed as unknown', () => {
    const r = runCli(
      [
        'issue',
        'edit',
        'https://github.com/atta-labs/vinaya/issues/403',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-valid.md')
      ],
      cwd,
      { PATH: fakeGhLabelsPath(ghDir) }
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })
})

// plan-brief-v1 task 1, Issue #426 — the `briefSections` builtin's own gate
// (`## Surface`/`## Parts`/`## Test plan`/`## Stop conditions`), wired
// through the real `issue create`/`issue edit` command paths.
describe('vinaya issue create --validate-only — briefSections builtin', () => {
  const BRIEF_SECTIONS_CONFIG = {
    briefSchema: { issue: { sections: [{ builtin: 'issueRationale' }, { builtin: 'briefSections' }] } }
  }
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-issue-brief-sections-test-'))
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify(BRIEF_SECTIONS_CONFIG), 'utf8')
    // O1 — checkSurfaceGlobsResolve resolves the fixture's `## Surface` `in:`
    // globs (`apps/cli/src/commands`, `apps/cli/src/lib`) against REAL
    // tracked files via `git ls-files`, so the "passes" test below needs a
    // real repo carrying matching paths, not just a bare scratch directory.
    execFileSync('git', ['init', '--quiet'], { cwd })
    mkdirSync(join(cwd, 'apps/cli/src/commands'), { recursive: true })
    mkdirSync(join(cwd, 'apps/cli/src/lib'), { recursive: true })
    writeFileSync(join(cwd, 'apps/cli/src/commands/fixture.ts'), '')
    writeFileSync(join(cwd, 'apps/cli/src/lib/fixture.ts'), '')
    execFileSync('git', ['add', '.'], { cwd })
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('passes a task Issue carrying all four sections', () => {
    // O1 — the shared fixture's own "Docs to keep coherent" pointer
    // (`apps/cli/README.md`) falls outside its declared `## Surface` `in:`
    // globs but inside no `out:` glob either — `checkDocsWithinSurface`
    // accepts a pointer the surface simply does not enclose, so the fixture
    // is used as-is, no patched copy needed.
    const r = runCli(
      [
        'issue',
        'create',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-brief-sections-valid.md'),
        '--label',
        'vinaya/tranche:demo'
      ],
      cwd
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })

  it('refuses, naming Parts, when `## Parts` is missing — `issue create` has no number yet, so the cutover never exempts it', () => {
    const r = runCli(
      [
        'issue',
        'create',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-brief-sections-missing-parts.md'),
        '--label',
        'vinaya/tranche:demo'
      ],
      cwd
    )
    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('brief-schema')
    expect(finding.message).toMatch(/Parts/)
  })
})

describe('vinaya issue edit --validate-only — briefSections builtin reaches the cutover end-to-end', () => {
  const BRIEF_SECTIONS_CONFIG = {
    briefSchema: { issue: { sections: [{ builtin: 'issueRationale' }, { builtin: 'briefSections' }] } }
  }
  let cwd: string
  let ghDir: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-issue-edit-brief-sections-test-'))
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify(BRIEF_SECTIONS_CONFIG), 'utf8')
    ghDir = mkdtempSync(join(tmpdir(), 'vinaya-issue-edit-brief-sections-fake-gh-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(ghDir, { recursive: true, force: true })
  })

  it('passes an Issue numbered below the cutover (425) carrying none of the four sections', () => {
    const r = runCli(
      [
        'issue',
        'edit',
        '425',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-valid-with-objectives.md')
      ],
      cwd,
      { PATH: fakeGhLabelsPath(ghDir) }
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })

  it('refuses, naming Surface, an Issue numbered at the cutover (426) carrying none of the four sections', () => {
    const r = runCli(
      ['issue', 'edit', '426', '--validate-only', '--body-file', join(FORGE_FIXTURES, 'issue-valid.md')],
      cwd,
      { PATH: fakeGhLabelsPath(ghDir) }
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/Surface/)
  })
})

// task-run-v1 task 11, review round 1, O3 — a plain `vinaya issue edit` real
// write must refuse an Objectives/Surface/Parts change once the task's brief
// is frozen, naming the frozen comment and `issue objectives edit`.
describe('vinaya issue edit (real write) — O3 frozen-brief section lock', () => {
  let cwd: string
  let ghDir: string

  const OLD_BODY = [
    '## Objectives',
    '',
    'O1. Do the thing.',
    '',
    "## Planner's rationale",
    '',
    '**Boundary** — n/a.',
    '',
    '## Surface',
    '',
    'in: apps/cli/src/lib',
    'out: apps/cli/src/commands'
  ].join('\n')

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-issue-edit-frozen-test-'))
    ghDir = mkdtempSync(join(tmpdir(), 'vinaya-issue-edit-frozen-fake-gh-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(ghDir, { recursive: true, force: true })
  })

  /** A fake `gh` answering `issue view <ref> --json labels` (task label) and `--json body,comments` (the pre-edit body plus one frozen `aeg:brief:v1` comment authored by the default principal, `daniboomerang`). `issue edit` is never expected to be reached when O3 refuses first. */
  function fakeGhFrozenPath(dir: string): string {
    const gh = join(dir, 'gh')
    const bodyCommentsPath = join(dir, 'body-comments.json')
    writeFileSync(
      bodyCommentsPath,
      JSON.stringify({
        body: OLD_BODY,
        comments: [
          { body: '<!-- aeg:brief:v1 -->\nBrief hash: x\nfrozen brief text', author: { login: 'daniboomerang' } }
        ]
      })
    )
    writeFileSync(
      gh,
      `#!/bin/sh
case "$*" in
  *labels*) echo '{"labels":[{"name":"vinaya/tranche:demo"}]}' ;;
  *comments*) cat "${bodyCommentsPath}" ;;
  *) echo "unhandled: $*" >&2; exit 1 ;;
esac
`
    )
    execFileSync('chmod', ['+x', gh])
    return `${dir}:${process.env.PATH}`
  }

  it('refuses an Objectives change, naming the frozen comment and `issue objectives edit`', () => {
    const newBody = OLD_BODY.replace('O1. Do the thing.', 'O1. Do a different thing.')
    const bodyPath = join(cwd, 'new-body.md')
    writeFileSync(bodyPath, newBody)
    const r = runCli(['issue', 'edit', '999', '--body-file', bodyPath], cwd, { PATH: fakeGhFrozenPath(ghDir) })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/already frozen/)
    expect(r.stderr).toContain('issue objectives edit')
    expect(r.stderr).toMatch(/Objectives/)
  })

  it('refuses the same way via `--validate-only`, previewing what the real write would do', () => {
    const newBody = OLD_BODY.replace('in: apps/cli/src/lib', 'in: apps/cli/src/lib, packages/aeg-core/src')
    const bodyPath = join(cwd, 'new-body.md')
    writeFileSync(bodyPath, newBody)
    const r = runCli(['issue', 'edit', '999', '--validate-only', '--body-file', bodyPath], cwd, {
      PATH: fakeGhFrozenPath(ghDir)
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/already frozen/)
    expect(r.stderr).toMatch(/Surface/)
  })
})
