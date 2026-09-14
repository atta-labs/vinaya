import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tokenReportRowForCapability } from '../../src/commands/pr'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_ROOT = join(CLI_ROOT, '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')
const FORGE_FIXTURES = join(CLI_ROOT, 'tests', 'fixtures', 'forge')
const AEG_CORE_FIXTURES = join(REPO_ROOT, 'packages', 'aeg-core', 'tests', 'fixtures')

const FULL_PR_CONFIG = {
  briefSchema: {
    pr: {
      sections: [
        { builtin: 'tier' },
        { builtin: 'testPlan' },
        { builtin: 'testPlanExclusivity' },
        { builtin: 'principalPlaceholder' },
        { builtin: 'surfaceMap' },
        { builtin: 'docUpdateList' },
        { builtin: 'worktreeStep0' },
        { builtin: 'stopConditions' },
        { builtin: 'autonomyClause' },
        { builtin: 'project' },
        { builtin: 'for' },
        { builtin: 'closesN' },
        { builtin: 'premiseCoverage' }
      ]
    }
  }
}

type CliResult = { status: number; stdout: string; stderr: string }

function runCli(args: string[], opts: { cwd: string; input?: string }): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], {
      cwd: opts.cwd,
      encoding: 'utf8',
      input: opts.input,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

describe('vinaya pr create --validate-only', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-pr-test-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  function writeConfig(config: unknown): void {
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify(config), 'utf8')
  }

  it('refuses a malformed body (missing Tier) with a CheckError naming the corrective command', () => {
    writeConfig(FULL_PR_CONFIG)
    const r = runCli(
      [
        'pr',
        'create',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'pr-no-tier.md'),
        '--title',
        '[vinaya-cli-v1] 5 — x'
      ],
      { cwd }
    )
    expect(r.status).toBe(1)
    const lines = r.stderr.trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(1)
    const finding = JSON.parse(lines[0] as string)
    expect(finding.schema).toBe(1)
    expect(finding.check).toBe('brief-schema')
    expect(finding.agent_recovery_prompt).toContain('vinaya pr create')
    expect(finding.agent_recovery_prompt).not.toBe(finding.message)
  })

  it('passes a valid body and writes nothing', () => {
    writeConfig(FULL_PR_CONFIG)
    const r = runCli(
      [
        'pr',
        'create',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'pr-valid.md'),
        '--title',
        '[vinaya-cli-v1] 5 — x'
      ],
      { cwd }
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })

  it('is config-driven: a custom-section schema refuses a body lacking that section', () => {
    // Fixture config requires a "Rollback Plan" heading; pr-valid.md has none.
    const raw = execFileSync('cat', [join(FORGE_FIXTURES, 'vinaya.config.custom.json')], { encoding: 'utf8' })
    writeFileSync(join(cwd, 'vinaya.config.json'), raw, 'utf8')
    const r = runCli(
      ['pr', 'create', '--validate-only', '--body-file', join(FORGE_FIXTURES, 'pr-valid.md'), '--title', 'Feat: x'],
      { cwd }
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Rollback Plan')
  })

  it('validates the same streamed bytes (#333) via --body-file /dev/stdin', () => {
    writeConfig(FULL_PR_CONFIG)
    const body = execFileSync('cat', [join(FORGE_FIXTURES, 'pr-valid.md')], { encoding: 'utf8' })
    const r = runCli(['pr', 'create', '--validate-only', '--body-file', '/dev/stdin', '--title', 'Feat: x'], {
      cwd,
      input: body
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })

  it('--json emits an enveloped outcome', () => {
    writeConfig(FULL_PR_CONFIG)
    const r = runCli(
      [
        'pr',
        'create',
        '--validate-only',
        '--json',
        '--body-file',
        join(FORGE_FIXTURES, 'pr-valid.md'),
        '--title',
        'Feat: x'
      ],
      { cwd }
    )
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.schema).toBe(1)
    expect(parsed.data.validated).toBe(true)
    expect(parsed.data.written).toBe(false)
  })

  it('refuses when no body argument is given', () => {
    writeConfig(FULL_PR_CONFIG)
    const r = runCli(['pr', 'create', '--validate-only', '--title', 'Feat: x'], { cwd })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('body')
  })

  it('refuses a body carrying a bare digit — the check CI runs, run here first', () => {
    writeConfig(FULL_PR_CONFIG)
    const r = runCli(
      [
        'pr',
        'create',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'pr-bare-digit.md'),
        '--title',
        '[vinaya-cli-v1] 5 — x'
      ],
      { cwd }
    )
    expect(r.status).toBe(1)
    const lines = r.stderr.trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(1)
    const finding = JSON.parse(lines[0] as string)
    expect(finding.check).toBe('body-bare-digits')
  })

  it('has no branch-name exemption — a bare-digit body refuses even on a branch literally named changeset-release/main', () => {
    // `branch` is read from the local checkout, fully caller-controlled — no
    // author is fetched or fetchable before the PR exists, so unlike the
    // CI-side check (which live-fetches the real PR author before exempting)
    // this command must never grant the Changesets-release exemption from
    // branch name alone. Regression test for exactly that shape of bug.
    writeConfig(FULL_PR_CONFIG)
    // A CI runner has no global git identity — never rely on it, set one
    // local to this commit instead.
    const identityEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'x',
      GIT_AUTHOR_EMAIL: 'x@x.com',
      GIT_COMMITTER_NAME: 'x',
      GIT_COMMITTER_EMAIL: 'x@x.com'
    }
    execFileSync('git', ['init', '-q'], { cwd })
    execFileSync('git', ['checkout', '-q', '-b', 'changeset-release/main'], { cwd })
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'x'], { cwd, env: identityEnv })
    const r = runCli(
      [
        'pr',
        'create',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'pr-bare-digit.md'),
        '--title',
        '[vinaya-cli-v1] 5 — x'
      ],
      { cwd }
    )
    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('body-bare-digits')
  })
})

describe('vinaya pr create --validate-only — rings.ring1_forgeWriteInterception', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-pr-ring1-test-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  function writeConfig(config: unknown): void {
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify(config), 'utf8')
  }

  it('`true` is a no-op — validation still refuses a malformed body, same as no rings key at all', () => {
    writeConfig({ ...FULL_PR_CONFIG, rings: { ring1_forgeWriteInterception: true, ring2_asyncAudits: true } })
    const r = runCli(
      ['pr', 'create', '--validate-only', '--body-file', join(FORGE_FIXTURES, 'pr-no-tier.md'), '--title', 'Feat: x'],
      { cwd }
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('brief-schema')
  })

  it('`false` is the opt-out — skips brief-schema validation entirely, even on a malformed body', () => {
    writeConfig({ ...FULL_PR_CONFIG, rings: { ring1_forgeWriteInterception: false, ring2_asyncAudits: true } })
    // No bare digits anywhere — `body-bare-digits` is its own unconditional
    // gate (never governed by `rings.ring1_forgeWriteInterception`, which
    // scopes only the config-driven `briefSchema` sections), so a digit here
    // would refuse regardless of the opt-out and prove nothing about it.
    const noTierNoDigits = join(cwd, 'no-tier-no-digits.md')
    writeFileSync(noTierNoDigits, '## Summary\n\nno tier field here, and no digits anywhere in this body.\n', 'utf8')
    const r = runCli(['pr', 'create', '--validate-only', '--body-file', noTierNoDigits, '--title', 'Feat: x'], { cwd })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })
})

/**
 * `pr create` runs every registry check declaring `PR_BODY` over the body
 * before it ever reaches the forge (task 12, #387) — the same set CI's
 * `vinaya-checks.yml` runs against the live body, so a body that opens here
 * is a body that passes there too. Run from THIS repo's own root (not a
 * synthetic tmpdir): these are real registry-check subprocesses
 * (`brief-shape`, `pr-report-density`, `doc-coverage`), and a bare tmpdir
 * gives them no real workspace/doc-owners context to run against.
 */
describe('vinaya pr create --validate-only — runs the registry PR_BODY checks (task 12, #387)', () => {
  it('refuses the PR #394-as-opened body, naming pr-report-density among the findings', () => {
    const r = runCli(
      [
        'pr',
        'create',
        '--validate-only',
        '--body-file',
        join(AEG_CORE_FIXTURES, 'pr-body-394-as-opened.md'),
        '--title',
        'Fix: x'
      ],
      { cwd: REPO_ROOT }
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('"check":"pr-report-density"')
  })

  it('opens a clean, fully-conformant body — --validate-only reports PASS, writes nothing', () => {
    const r = runCli(
      ['pr', 'create', '--validate-only', '--body-file', join(FORGE_FIXTURES, 'pr-clean-body.md'), '--title', 'Fix: x'],
      { cwd: REPO_ROOT }
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })
})

describe('tokenReportRowForCapability (pure) — O7 (#595)', () => {
  it('a capable fake adapter with figures produces numbers', () => {
    const row = tokenReportRowForCapability(
      {
        capable: true,
        transcriptPath: '/fake/transcript.jsonl',
        summary: {
          components: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          model: 'claude-sonnet-5',
          messageCount: 2
        }
      },
      '9: develop',
      '2026-09-14'
    )
    expect(row).toBe('| 9: develop | Developer | claude-sonnet-5 | 100 | 50 | — | 2026-09-14 |')
  })

  it('an incapable fake adapter (no figures) produces the accepted unavailable form, never a bare —', () => {
    const row = tokenReportRowForCapability(
      { capable: false, reason: 'no-transcript-resolved', detail: 'no pointer found for this session' },
      '9: develop',
      '2026-09-14'
    )
    expect(row).toBe('| 9: develop | Developer | — (no-transcript-resolved) | — | — | — | 2026-09-14 |')
    // The Agent/Model cell always carries the reason inline — never a bare
    // `—` with nothing said about why.
    expect(row.split('|')[3]?.trim()).not.toBe('—')
  })
})

/**
 * O8 (`#595`): a `Premise:` `contains:` pin must name something already
 * true on the base branch — never something only THIS PR's own diff adds.
 * A real git repo (not a fixture body alone): the check reads `base.ts`'s
 * content via `git show main:base.ts`, so the base branch actually has to
 * carry (or lack) the pinned symbol.
 */
describe('vinaya pr create --validate-only — refuses a Premise about the PR’s own additions (O8)', () => {
  let cwd: string

  function initRepoWithBase(): void {
    const identityEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'x',
      GIT_AUTHOR_EMAIL: 'x@x.com',
      GIT_COMMITTER_NAME: 'x',
      GIT_COMMITTER_EMAIL: 'x@x.com'
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd })
    writeFileSync(
      join(cwd, 'vinaya.config.json'),
      JSON.stringify({ rings: { ring1_forgeWriteInterception: false, ring2_asyncAudits: true } })
    )
    writeFileSync(join(cwd, 'base.ts'), 'export const BASE_SYMBOL = 1\n')
    execFileSync('git', ['add', '.'], { cwd })
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd, env: identityEnv })
    execFileSync('git', ['checkout', '-q', '-b', 'task/x/1'], { cwd })
  }

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-pr-premise-own-additions-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('refuses a body naming a symbol only the head adds', () => {
    initRepoWithBase()
    const bodyPath = join(cwd, 'pr-body.md')
    writeFileSync(
      bodyPath,
      ['**Premise:**', '- base.ts contains: HEAD_ONLY_SYMBOL', '', '## Summary', '', 'no bare digits here.'].join('\n')
    )
    const r = runCli(['pr', 'create', '--validate-only', '--body-file', bodyPath, '--title', 'Feat: x'], { cwd })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('pr-premise-own-additions')
    expect(r.stderr).toContain('HEAD_ONLY_SYMBOL')
    expect(r.stderr).toContain('main')
  })

  it('opens a body naming a symbol already on the base', () => {
    initRepoWithBase()
    const bodyPath = join(cwd, 'pr-body.md')
    writeFileSync(
      bodyPath,
      ['**Premise:**', '- base.ts contains: BASE_SYMBOL', '', '## Summary', '', 'no bare digits here.'].join('\n')
    )
    const r = runCli(['pr', 'create', '--validate-only', '--body-file', bodyPath, '--title', 'Feat: x'], { cwd })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })
})
