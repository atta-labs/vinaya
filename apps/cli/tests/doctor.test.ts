import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import type { DoctorDeps, Finding } from '../src/commands/doctor.js'
import {
  credentialVarNames,
  logDestinationTargetFrom,
  probeLogDestinationServer,
  runDoctor,
  urlForDisplay,
  withoutCredentialValues
} from '../src/commands/doctor.js'
import type { VinayaConfig } from '../src/lib/config.js'
import type { InitDeps } from '../src/commands/init.js'
import { runInit } from '../src/commands/init.js'
import { DOC_OWNERS_PATH } from '@attalabs/aeg-core'
import { CHECKS_WORKFLOW_PATH, CONFIG_PATH, DOCTRINE_POINTER_PATH, REVIEW_WORKFLOW_PATH } from '../src/lib/artifacts.js'
import { CLAUDE_COMMAND_PATH } from '../src/lib/claude-command-emitter.js'
import { CLAUDE_SETTINGS_PATH, CLAUDE_STOP_HOOK_SCRIPT_PATH } from '../src/lib/claude-stop-hook-emitter.js'
import { GEMINI_COMMAND_PATH } from '../src/lib/gemini-command-emitter.js'
import type { LabelGateway } from '../src/lib/ops.js'
import { freshProjectsRegistry, PROJECTS_REGISTRY_PATH } from '../src/lib/registry-write.js'

let root: string

function initDeps(overrides: Partial<InitDeps> = {}): InitDeps {
  const labels: LabelGateway = {
    async exists() {
      return false
    },
    async create() {}
  }
  return {
    detectRepo: async () => ({ repoRoot: root, owner: 'acme', repo: 'widget' }),
    checkGhAuth: async () => true,
    labelGateway: () => labels,
    hookDirFor: () => '.husky',
    customHooksPath: async () => null,
    setHooksPath: async () => {},
    confirm: async () => true,
    ...overrides
  }
}

function doctorDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    detectRepo: async () => ({ repoRoot: root, owner: 'acme', repo: 'widget' }),
    ghAuthStatus: async () => ({ authenticated: true, detail: 'Logged in to github.com as tester' }),
    branchProtectionConfigured: async () => null,
    hookDirFor: () => '.husky',
    readHooksPath: async () => null,
    nodeVersion: () => 'v99.0.0',
    bunVersion: () => 'test-bun',
    packageVersion: () => '0.1.0-test',
    meteringCapability: () => ({
      capable: false,
      reason: 'no-transcript-resolved',
      detail: 'no --transcript given and no pointer file in this fixture'
    }),
    // Declaring no destination is what keeps every OTHER test in this file
    // off a real folder and off the network — the log-destination check's own
    // cases below each override this with the destination they are about.
    resolveLogDestination: async () => ({
      destination: { kind: 'none', reason: 'this fixture declares no destination' },
      credentialVars: []
    }),
    probeLogServer: async () => ({ kind: 'accepted', status: 200 }),
    // Nothing in the Keychain by default — CI is Linux, where the real reader
    // returns null anyway. The O4 cases below override this to prove each source.
    readLogCredentialKeychain: () => null,
    ...overrides
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/**
 * Recursive snapshot of the fixture tree: relative path → content. Skips
 * `.git` — a git-backed fixture's object/pack files are binary and huge
 * relative to the fixture itself; nothing under `.git` is a doctor mutation
 * target, so it's outside what this comparison needs to prove.
 */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === '.git') continue
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.set(relative(dir, p), readFileSync(p, 'utf-8'))
    }
  }
  walk(dir)
  return out
}

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout)
  let buf = ''
  process.stdout.write = ((chunk: string) => {
    buf += chunk
    return true
  }) as typeof process.stdout.write
  try {
    await fn()
  } finally {
    process.stdout.write = original
  }
  return buf
}

async function runDoctorJson(overrides: Partial<DoctorDeps> = {}): Promise<{ healthy: boolean; findings: Finding[] }> {
  const original = process.stdout.write.bind(process.stdout)
  let buf = ''
  process.stdout.write = ((chunk: string) => {
    buf += chunk
    return true
  }) as typeof process.stdout.write
  try {
    await runDoctor(['--json'], doctorDeps(overrides))
  } finally {
    process.stdout.write = original
  }
  return JSON.parse(buf).data
}

beforeEach(() => {
  root = join(tmpdir(), `vinaya-doctor-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'README.md'), '# widget\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('vinaya doctor — never mutates', () => {
  it('reports healthy on a clean install, and the tree is byte-identical before and after', async () => {
    await runInit(['--yes'], initDeps())
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(true)
    expect(report.findings.every((f) => f.severity === 'ok' || f.severity === 'info')).toBe(true)

    expect(snapshot(root)).toEqual(before)
  })

  it('exits 0 on a healthy repo and 1 when findings exist', async () => {
    await runInit(['--yes'], initDeps())
    let rc = -1
    let out = ''
    out = await captureStdout(async () => {
      rc = await runDoctor([], doctorDeps())
    })
    expect(rc).toBe(0)
    expect(out).toContain('Healthy')

    rmSync(join(root, '.husky/pre-commit'))
    out = await captureStdout(async () => {
      rc = await runDoctor([], doctorDeps())
    })
    expect(rc).toBe(1)
    expect(out).toContain('hooks')
  })

  it('flags a deleted hook without recreating it', async () => {
    await runInit(['--yes'], initDeps())
    rmSync(join(root, '.husky/pre-commit'))
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'hooks' && f.message.includes('pre-commit'))
    expect(hit?.severity).toBe('error')
    expect(hit?.message).toContain('missing')

    expect(snapshot(root)).toEqual(before) // doctor fixed nothing
  })

  it('flags a corrupted managed block (markers stripped) without fixing it', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, '.husky/pre-push'), '#!/usr/bin/env sh\necho not-a-vinaya-hook-anymore\n')
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'hooks' && f.message.includes('pre-push'))
    expect(hit?.severity).toBe('error')
    expect(hit?.message).toMatch(/missing or corrupted/)

    expect(snapshot(root)).toEqual(before)
  })

  it('flags a deleted commit-msg hook without recreating it (Issue #63)', async () => {
    await runInit(['--yes'], initDeps())
    rmSync(join(root, '.husky/commit-msg'))
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'hooks' && f.message.includes('commit-msg'))
    expect(hit?.severity).toBe('error')
    expect(hit?.message).toContain('missing')

    expect(snapshot(root)).toEqual(before) // doctor fixed nothing
  })

  it('flags a drifted commit-msg hook (markers present, body hand-edited) without fixing it', async () => {
    await runInit(['--yes'], initDeps())
    const original = readFileSync(join(root, '.husky/commit-msg'), 'utf-8')
    // Edit the invocation line specifically, leaving the `>>> vinaya:managed:
    // commit-msg >>>` marker line untouched — corrupting the marker would
    // misclassify this as "missing or corrupted" (error) rather than drift.
    writeFileSync(join(root, '.husky/commit-msg'), original.replace('"$1" "$2"', '"$1" "$2" # hand-edited'))
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'hooks' && f.message.includes('commit-msg'))
    expect(hit?.severity).toBe('warn')
    expect(hit?.message).toContain('drifted')

    expect(snapshot(root)).toEqual(before)
  })

  it('flags a broken vinaya.config.json (invalid JSON) without fixing it', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, CONFIG_PATH), '{ this is not json')
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'config')
    expect(hit?.severity).toBe('error')
    expect(hit?.message).toContain('invalid')

    expect(snapshot(root)).toEqual(before)
  })

  it('flags a removed workflow without recreating it', async () => {
    await runInit(['--yes'], initDeps())
    rmSync(join(root, CHECKS_WORKFLOW_PATH))
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'workflows' && f.message.includes(CHECKS_WORKFLOW_PATH))
    expect(hit?.severity).toBe('error')

    expect(snapshot(root)).toEqual(before)
  })

  it('flags a drifted workflow (content differs from the current generator) without fixing it', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, CHECKS_WORKFLOW_PATH), 'name: hand-edited\n')
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'workflows' && f.message.includes(CHECKS_WORKFLOW_PATH))
    expect(hit?.severity).toBe('warn')
    expect(hit?.message).toContain('drifted')

    expect(snapshot(root)).toEqual(before)
  })

  it('O5: flags a managed workflow that lacks the Bun install-cache step as drifted', async () => {
    // The cache step (O1) is only emitted when the repo vendors vinaya as a
    // workspace member — an ordinary npx-fetching adopter needs no install
    // step for vinaya at all, cache included.
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'widget', private: true, workspaces: ['apps/*'] }, null, 2)}\n`
    )
    mkdirSync(join(root, 'apps/cli'), { recursive: true })
    writeFileSync(
      join(root, 'apps/cli/package.json'),
      `${JSON.stringify(
        {
          name: '@attalabs/vinaya',
          version: '0.4.6',
          bin: { vinaya: './dist/index.js' },
          scripts: { build: 'bun scripts/build.ts' }
        },
        null,
        2
      )}\n`
    )
    await runInit(['--yes'], initDeps())
    const generated = readFileSync(join(root, REVIEW_WORKFLOW_PATH), 'utf-8')
    expect(generated).toContain('Restore Bun install cache')

    const withoutCache = generated
      .split('\n')
      .filter((line) => !line.includes('Restore Bun install cache') && !line.includes('actions/cache@v4'))
      .join('\n')
    writeFileSync(join(root, REVIEW_WORKFLOW_PATH), withoutCache)
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'workflows' && f.message.includes(REVIEW_WORKFLOW_PATH))
    expect(hit?.severity).toBe('warn')
    expect(hit?.message).toContain('drifted')

    expect(snapshot(root)).toEqual(before)
  })

  it('O3 (task-run-v1 18, #525): flags the task-16 pre-check shape (verdict-only, no waiver-label check) as drifted', async () => {
    await runInit(['--yes'], initDeps())
    const generated = readFileSync(join(root, REVIEW_WORKFLOW_PATH), 'utf-8')
    expect(generated).toContain('vinaya/waiver:review')

    // The exact shape `task-run-v1 16` shipped, before this task added the
    // waiver-label check alongside it: a single-condition pre-check that
    // only ever reads comments, never labels.
    const task16Shape = generated
      .split('\n')
      .flatMap((line) => {
        if (line.includes('PR_JSON=$(gh pr view "$PR_NUMBER"')) {
          return [
            `          HAS_VERDICT=$(gh pr view "$PR_NUMBER" --repo \${{ github.repository }} --json comments \\`,
            '            --jq \'[.comments[].body | select((. / "\\n") | any(test("^[ \\t]*(\\\\*{1,3}|_{1,3})?VERDICT:")))] | length > 0\')'
          ]
        }
        if (line.includes('HAS_VERDICT=$(echo "$PR_JSON"')) return []
        if (line.includes('HAS_WAIVER_LABEL=$(echo "$PR_JSON"')) return []
        if (line.includes('if [ "$HAS_VERDICT" != "true" ] && [ "$HAS_WAIVER_LABEL" != "true" ]; then')) {
          return [line.replace(' && [ "$HAS_WAIVER_LABEL" != "true" ]', '')]
        }
        return [line]
      })
      .join('\n')
    expect(task16Shape).not.toContain('HAS_WAIVER_LABEL')
    writeFileSync(join(root, REVIEW_WORKFLOW_PATH), task16Shape)
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'workflows' && f.message.includes(REVIEW_WORKFLOW_PATH))
    expect(hit?.severity).toBe('warn')
    expect(hit?.message).toContain('drifted')

    expect(snapshot(root)).toEqual(before) // doctor fixed nothing
  })

  it('does not flag .vinaya/doc-owners as drifted once a real binding is added (found live: was recommending `vinaya upgrade`, which would have wiped it)', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, DOC_OWNERS_PATH), 'apps/foo/src/**  apps/foo/specs/foo.md\n', { flag: 'a' })

    const report = await runDoctorJson()
    const hit = report.findings.find((f) => f.message.includes(DOC_OWNERS_PATH))
    expect(hit?.severity).toBe('ok')
    expect(hit?.message).not.toContain('drift')
  })

  it('flags a dropped manifest entry (file present on disk, absent from `managed.files`)', async () => {
    await runInit(['--yes'], initDeps())
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    cfg.managed.files = cfg.managed.files.filter((f: string) => f !== DOCTRINE_POINTER_PATH)
    writeFileSync(join(root, CONFIG_PATH), `${JSON.stringify(cfg, null, 2)}\n`)
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'doctrine-pointer' && f.message.includes("isn't recorded"))
    expect(hit?.severity).toBe('warn')

    expect(snapshot(root)).toEqual(before)
  })

  it('flags a custom check pointing at a missing script', async () => {
    await runInit(['--yes'], initDeps())
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    cfg.checks = { ghost: { run: 'scripts/vinaya-checks/ghost.ts', scope: 'full' } }
    writeFileSync(join(root, CONFIG_PATH), `${JSON.stringify(cfg, null, 2)}\n`)
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'checks')
    expect(hit?.severity).toBe('error')
    expect(hit?.message).toContain('ghost')

    expect(snapshot(root)).toEqual(before)
  })

  // The execution flip removed these two from `vinaya check`'s own output —
  // a rejected config now refuses the run outright. They must SURVIVE here,
  // permanently: doctor is the only surface left that can explain why a run
  // that executes nothing executes nothing.
  it('still surfaces the bare-key rejection on a config `vinaya check` now refuses outright', async () => {
    await runInit(['--yes'], initDeps())
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    cfg.checks = { my_check: { run: 'scripts/vinaya-checks/my_check.ts', scope: 'full' } }
    writeFileSync(join(root, CONFIG_PATH), `${JSON.stringify(cfg, null, 2)}\n`)
    mkdirSync(join(root, 'scripts', 'vinaya-checks'), { recursive: true })
    writeFileSync(join(root, 'scripts', 'vinaya-checks', 'my_check.ts'), '#!/usr/bin/env bun\n')
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'checks' && f.message.includes('REJECTED'))
    expect(hit).toBeDefined()
    // `error`, not `warn`: post-flip this is fatal to every `vinaya check`.
    expect(hit?.severity).toBe('error')
    expect(hit?.message).toContain('my_check')
    expect(hit?.message).toContain('prefixing alone is not enough')

    expect(snapshot(root)).toEqual(before)
  })

  it('still surfaces the override diagnostic, now stating the core check is replaced', async () => {
    await runInit(['--yes'], initDeps())
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    cfg.checks = { 'doc-coverage': { run: 'scripts/vinaya-checks/mine.ts', scope: 'full' } }
    writeFileSync(join(root, CONFIG_PATH), `${JSON.stringify(cfg, null, 2)}\n`)
    mkdirSync(join(root, 'scripts', 'vinaya-checks'), { recursive: true })
    writeFileSync(join(root, 'scripts', 'vinaya-checks', 'mine.ts'), '#!/usr/bin/env bun\n')

    const report = await runDoctorJson()
    const hit = report.findings.find((f) => f.check === 'checks' && f.message.includes('REPLACES'))
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('warn')
    expect(hit?.message).toContain('doc-coverage')
    expect(hit?.message).toContain('The core check does not run')
  })

  it('reports "not initialized" on a repo that never ran init, and still writes nothing', async () => {
    const before = snapshot(root)
    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    expect(report.findings.some((f) => f.check === 'install')).toBe(true)
    expect(snapshot(root)).toEqual(before)
  })

  it('refuses on a non-git-repo', async () => {
    let rc = -1
    await captureStdout(async () => {
      rc = await runDoctor([], doctorDeps({ detectRepo: async () => null }))
    })
    expect(rc).toBe(1)
  })

  it('silence when a workflow invokes the test script', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'widget', scripts: { test: 'turbo test' } }))
    writeFileSync(join(root, '.github/workflows/ci.yml'), 'jobs:\n  test:\n    steps:\n      - run: bunx turbo test\n')

    const report = await runDoctorJson()
    expect(report.findings.some((f) => f.check === 'test-ci')).toBe(false)
  })

  it('flags no workflow invoking the test script', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'widget', scripts: { test: 'turbo test' } }))
    const before = snapshot(root)

    const report = await runDoctorJson()
    const hit = report.findings.find((f) => f.check === 'test-ci')
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('warn')
    expect(hit?.message).toContain('Test Plan')

    expect(snapshot(root)).toEqual(before)
  })

  it('does not flag a repo with no scripts.test at all', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'widget', scripts: { build: 'tsc' } }))

    const report = await runDoctorJson()
    expect(report.findings.some((f) => f.check === 'test-ci')).toBe(false)
  })

  it('reports the private-repo-needs-a-paid-plan case distinctly from the generic "could not be determined" (found live)', async () => {
    await runInit(['--yes'], initDeps())
    const report = await runDoctorJson({
      ghAuthStatus: async () => ({ authenticated: true, detail: 'Logged in to github.com as tester' }),
      branchProtectionConfigured: async () => 'plan-required'
    })
    const bp = report.findings.find((f) => f.check === 'branch-protection')
    expect(bp?.severity).toBe('info')
    expect(bp?.message).toContain('paid plan')
    expect(bp?.message).not.toContain('no gh auth, no remote, or a permission gap')
  })

  it('does not let environment/branch-protection info findings affect health', async () => {
    await runInit(['--yes'], initDeps())
    const report = await runDoctorJson({
      ghAuthStatus: async () => ({ authenticated: false, detail: 'not logged in' }),
      branchProtectionConfigured: async () => false
    })
    // gh-not-authenticated is a warn (findings, not healthy) but branch
    // protection unconfigured is info-only — assert the two are distinguished.
    const auth = report.findings.find((f) => f.check === 'environment' && f.message.startsWith('gh:'))
    const bp = report.findings.find((f) => f.check === 'branch-protection')
    expect(auth?.severity).toBe('warn')
    expect(bp?.severity).toBe('info')
  })

  it('codeowners: reports info when .github/CODEOWNERS is absent — never a suggested identity, just the gap', async () => {
    await runInit(['--yes'], initDeps())
    const report = await runDoctorJson()
    const codeowners = report.findings.find((f) => f.check === 'codeowners')
    expect(codeowners?.severity).toBe('info')
    expect(codeowners?.message).toContain('no .github/CODEOWNERS')
  })

  it('codeowners: warns when the file exists but has no line covering .github/workflows/**', async () => {
    await runInit(['--yes'], initDeps())
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(join(root, '.github', 'CODEOWNERS'), '*.md @docs-team\n')

    const report = await runDoctorJson()
    const codeowners = report.findings.find((f) => f.check === 'codeowners')
    expect(codeowners?.severity).toBe('warn')
    expect(codeowners?.message).toContain('no entry covering .github/workflows/**')
  })

  it('codeowners: reports info when a real (adopter-chosen) coverage line exists', async () => {
    await runInit(['--yes'], initDeps())
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(join(root, '.github', 'CODEOWNERS'), '/.github/workflows/** @someone-the-adopter-chose\n')

    const report = await runDoctorJson()
    const codeowners = report.findings.find((f) => f.check === 'codeowners')
    expect(codeowners?.severity).toBe('info')
    expect(codeowners?.message).toContain('covers .github/workflows/**')
  })

  it('codeowners: a commented-out coverage line does not count', async () => {
    await runInit(['--yes'], initDeps())
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(join(root, '.github', 'CODEOWNERS'), '# /.github/workflows/** @someone\n')

    const report = await runDoctorJson()
    const codeowners = report.findings.find((f) => f.check === 'codeowners')
    expect(codeowners?.severity).toBe('warn')
  })

  it('codeowners: a narrower single-file entry does NOT count as covering the whole directory (code review, PR #168)', async () => {
    await runInit(['--yes'], initDeps())
    mkdirSync(join(root, '.github'), { recursive: true })
    // Names one file inside workflows/, not the directory itself — vinaya-review.yml,
    // the file this feature exists to protect, stays unprotected by this line.
    writeFileSync(join(root, '.github', 'CODEOWNERS'), '/.github/workflows/deploy.yml @someone\n')

    const report = await runDoctorJson()
    const codeowners = report.findings.find((f) => f.check === 'codeowners')
    expect(codeowners?.severity).toBe('warn')
  })

  it('codeowners: a bare directory entry with no trailing glob still counts', async () => {
    await runInit(['--yes'], initDeps())
    mkdirSync(join(root, '.github'), { recursive: true })
    writeFileSync(join(root, '.github', 'CODEOWNERS'), '/.github/workflows @someone\n')

    const report = await runDoctorJson()
    const codeowners = report.findings.find((f) => f.check === 'codeowners')
    expect(codeowners?.severity).toBe('info')
  })
})

// task 5 (#152) — the three agent-vendor emitters diagnosed like any other
// vinaya-owned artifact, PLUS the one property specific to them: a vendor the
// adopter deliberately excluded via `--agents` gets no finding at all, never
// a false "not installed" error.
describe('vinaya doctor — agent-vendor emitters (--agents)', () => {
  it('reports drift on a hand-edited Claude Code command file, without fixing it', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, CLAUDE_COMMAND_PATH), '# hand-edited\n')
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.message.includes(CLAUDE_COMMAND_PATH))
    expect(hit?.check).toBe('claude-command')
    expect(hit?.severity).toBe('warn')
    expect(hit?.message).toContain('drifted')

    expect(snapshot(root)).toEqual(before) // doctor fixed nothing
  })

  it('reports drift on a hand-edited Gemini CLI command file, without fixing it', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, GEMINI_COMMAND_PATH), '# hand-edited\n')

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.message.includes(GEMINI_COMMAND_PATH))
    expect(hit?.check).toBe('gemini-command')
    expect(hit?.severity).toBe('warn')
    expect(hit?.message).toContain('drifted')
  })

  it('reports drift on a hand-edited agent-skill file, without fixing it', async () => {
    await runInit(['--yes'], initDeps())
    const skillPath = '.agents/skills/vinaya-developer/SKILL.md'
    writeFileSync(join(root, skillPath), '# hand-edited\n')

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.message.includes(skillPath))
    expect(hit?.check).toBe('agent-skills')
    expect(hit?.severity).toBe('warn')
    expect(hit?.message).toContain('drifted')
  })

  it('flags a removed agent-vendor file as missing, without recreating it', async () => {
    await runInit(['--yes'], initDeps())
    rmSync(join(root, CLAUDE_COMMAND_PATH))
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.message.includes(CLAUDE_COMMAND_PATH))
    expect(hit?.severity).toBe('error')
    expect(hit?.message).toContain('missing')

    expect(snapshot(root)).toEqual(before)
  })

  it('a vendor deliberately excluded via --agents gets NO finding at all — never a false "not installed"', async () => {
    const rc = await runInit(['--yes', '--agents=claude'], initDeps())
    expect(rc).toBe(0)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(true)
    expect(report.findings.some((f) => f.check === 'gemini-command')).toBe(false)
    expect(report.findings.some((f) => f.check === 'agent-skills')).toBe(false)
    // the selected vendor is still diagnosed normally
    const claude = report.findings.find((f) => f.check === 'claude-command')
    expect(claude?.severity).toBe('ok')
  })

  it('reports the Claude Code Stop hook (script + settings.json) as ok on a clean install, and missing after removal', async () => {
    await runInit(['--yes'], initDeps())
    const clean = await runDoctorJson()
    const cleanFindings = clean.findings.filter((f) => f.check === 'claude-stop-hook' || f.check === 'hooks')
    expect(cleanFindings.some((f) => f.message.includes(CLAUDE_SETTINGS_PATH) && f.severity === 'ok')).toBe(true)
    expect(cleanFindings.some((f) => f.message.includes(CLAUDE_STOP_HOOK_SCRIPT_PATH) && f.severity === 'ok')).toBe(
      true
    )

    rmSync(join(root, CLAUDE_SETTINGS_PATH))
    const afterRemoval = await runDoctorJson()
    expect(afterRemoval.healthy).toBe(false)
    const missing = afterRemoval.findings.find((f) => f.check === 'claude-stop-hook')
    expect(missing?.severity).toBe('error')
    expect(missing?.message).toContain('missing on disk')
  })

  it('a manifest with no recorded agents selection (pre-task-5) is treated as every vendor — missing files are reported as missing, not silently ignored forever', async () => {
    await runInit(['--yes'], initDeps())
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    delete cfg.managed.agents
    cfg.managed.files = cfg.managed.files.filter(
      (f: string) => f !== CLAUDE_COMMAND_PATH && f !== GEMINI_COMMAND_PATH && !f.startsWith('.agents/skills/')
    )
    writeFileSync(join(root, CONFIG_PATH), `${JSON.stringify(cfg, null, 2)}\n`)
    rmSync(join(root, CLAUDE_COMMAND_PATH))
    rmSync(join(root, GEMINI_COMMAND_PATH))
    rmSync(join(root, '.agents'), { recursive: true, force: true })

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const claude = report.findings.find((f) => f.check === 'claude-command')
    expect(claude?.severity).toBe('error')
    expect(claude?.message).toContain('missing on disk — run `vinaya upgrade`')
    const gemini = report.findings.find((f) => f.check === 'gemini-command')
    expect(gemini?.severity).toBe('error')
    expect(gemini?.message).toContain('missing on disk — run `vinaya upgrade`')
    const skills = report.findings.find((f) => f.check === 'agent-skills')
    expect(skills?.severity).toBe('error')
    expect(skills?.message).toContain('missing on disk — run `vinaya upgrade`')
  })
})

// Code review, PR #279: these two diagnostics (added alongside the matching
// `init`-time print notes in lib/artifacts.ts) had zero test coverage at
// all — no test file touched them. `info`, not `warn`/`error`: same
// blast-radius reasoning as codeowners/branch-protection above, so neither
// flips `healthy`/exit code for every existing adopter that hasn't set
// `principals` or doesn't have `vinaya` globally installed.
describe('vinaya doctor — principals and vinaya-on-PATH (PR #279 review)', () => {
  it('principals: reports info naming the DANGLING risk when vinaya.config.json has no "principals"', async () => {
    await runInit(['--yes'], initDeps())
    const report = await runDoctorJson()
    const principals = report.findings.find((f) => f.check === 'principals')
    expect(principals?.severity).toBe('info')
    expect(principals?.message).toContain('no "principals"')
    expect(principals?.message).toContain('DANGLING')
    expect(report.healthy).toBe(true) // info severity never flips the exit code
  })

  it('principals: reports info naming the count when principals is set', async () => {
    await runInit(['--yes'], initDeps())
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    cfg.principals = ['someone-the-adopter-chose']
    writeFileSync(join(root, CONFIG_PATH), `${JSON.stringify(cfg, null, 2)}\n`)

    const report = await runDoctorJson()
    const principals = report.findings.find((f) => f.check === 'principals')
    expect(principals?.severity).toBe('info')
    expect(principals?.message).toContain('trusts 1 declared principal')
  })

  describe('vinaya-on-path', () => {
    const originalPath = process.env.PATH

    afterEach(() => {
      process.env.PATH = originalPath
    })

    it('reports no finding at all when no agent vendor was selected', async () => {
      await runInit(['--yes', '--agents=none'], initDeps())
      process.env.PATH = '/nonexistent-dir-for-this-test'
      const report = await runDoctorJson()
      expect(report.findings.some((f) => f.check === 'vinaya-on-path')).toBe(false)
    })

    it('reports info-gap when a vendor is selected but no `vinaya` file sits on PATH', async () => {
      await runInit(['--yes', '--agents=claude'], initDeps())
      // A PATH with no `vinaya` on it — but with a reachable `gh`, so the
      // separate `[gh]`-reachability finding (issue #836) stays `info` and the
      // `healthy === true` assertion still isolates the point here: an `info`
      // vinaya-on-path gap never flips the exit code.
      const binDir = join(root, 'gh-only-bin')
      mkdirSync(binDir, { recursive: true })
      writeFileSync(join(binDir, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      process.env.PATH = binDir
      const report = await runDoctorJson()
      const finding = report.findings.find((f) => f.check === 'vinaya-on-path')
      expect(finding?.severity).toBe('info')
      expect(finding?.message).toContain('not resolvable on PATH')
      expect(finding?.message).toContain('npm install -g @attalabs/vinaya')
      expect(report.healthy).toBe(true) // info severity never flips the exit code
    })

    it('reports ok when a `vinaya` file exists somewhere on PATH — a pure scan, no subprocess spawn', async () => {
      await runInit(['--yes', '--agents=claude'], initDeps())
      const fakeBinDir = join(root, 'fake-bin')
      mkdirSync(fakeBinDir, { recursive: true })
      // Not a real, runnable vinaya — proves the diagnostic never spawns it
      // (a real spawn on this garbage file would throw or hang; a hang here
      // is exactly the regression this pure-existsSync-scan design fixed).
      writeFileSync(join(fakeBinDir, 'vinaya'), '#!/bin/sh\nexit 1\n')
      process.env.PATH = fakeBinDir

      const report = await runDoctorJson()
      const finding = report.findings.find((f) => f.check === 'vinaya-on-path')
      expect(finding?.severity).toBe('ok')
      expect(finding?.message).toContain('resolves on PATH')
    })
  })
})

// Regression coverage for a real hooks false-negative found live: `roles/developer.md`
// requires every Developer to work in a linked git worktree, and in one a bare
// `join(repoRoot, '.git/hooks/pre-commit')` never resolves — `.git` there is a
// FILE (a gitdir pointer), not a directory — even though the hooks are present
// and firing correctly (they are never per-worktree; every linked worktree
// shares the main checkout's hooks). Doctor reported both hooks "missing" and
// recommended `vinaya upgrade`, which would not have fixed anything.
describe('vinaya doctor — raw git hooks inside a linked worktree', () => {
  it('reports installed .git/hooks as present and matching, probed from a linked worktree', async () => {
    git(root, ['init', '-q', '-b', 'main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    git(root, ['add', 'README.md'])
    git(root, ['commit', '-q', '-m', 'Chore: initial commit'])

    await runInit(['--yes'], initDeps({ hookDirFor: () => '.git/hooks' }))
    git(root, ['add', '-A'])
    // --no-verify: this commit's only job is to land the files `runInit` just
    // wrote (doctor compares their on-disk bytes against the generator, so the
    // real hook content must survive untouched — no local-fixture swap here,
    // unlike quickstart.test.ts). Running the real hook for real would shell
    // to `npx --yes @attalabs/vinaya@<this workspace's current package.json
    // version>`, which is network-dependent and fails outright whenever that
    // version isn't published yet (e.g. mid-bump, exactly the state this repo
    // is in right now) — orthogonal to what this test actually verifies.
    git(root, ['commit', '-q', '-m', 'Chore: install Vinaya', '--no-verify'])

    const wtRoot = join(tmpdir(), `vinaya-doctor-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    git(root, ['worktree', 'add', wtRoot, '-b', 'task/demo/1'])

    try {
      const report = await runDoctorJson({
        detectRepo: async () => ({ repoRoot: wtRoot, owner: 'acme', repo: 'widget' }),
        hookDirFor: () => '.git/hooks'
      })
      const hookFindings = report.findings.filter((f) => f.check === 'hooks')
      expect(hookFindings.length).toBeGreaterThan(0)
      expect(hookFindings.some((f) => f.message.includes('is missing'))).toBe(false)
      // Every file-level finding is ok; the ONE non-ok is the deliberate
      // clone-gap routing warn a `.git/hooks` install now always carries
      // (atta-labs/attalabs#927) — git never tracks `.git/hooks`, so this
      // install shape leaves every fresh clone without ring 0.
      const nonOk = hookFindings.filter((f) => f.severity !== 'ok')
      expect(nonOk.length).toBe(1)
      expect(nonOk[0]?.severity).toBe('warn')
      expect(nonOk[0]?.message).toContain('which git does not track')
    } finally {
      git(root, ['worktree', 'remove', '--force', wtRoot])
    }
  }, 20_000) // real `runInit` + two `git commit`s + `worktree add` — bun's 5s default is too tight on a cold CI runner
})

// Regression coverage for Issue #77: C5 (`evaluateC5`) only ever tests a
// binding's glob against the current PR's changed files, so a binding whose
// code was deleted or renamed wholesale never fires on any diff again — it
// reads as healthy forever. These tests need a REAL git-tracked-file list
// (the diagnostic shells to `git ls-files`), so — unlike the rest of this
// file — the fixture must be a real `git init` + `git add` + `git commit`
// tree, not the plain tmpdir the other describe blocks use. A plain,
// non-git tmpdir makes `git ls-files` fail outright (not a git repository),
// which would make every binding in a plain-tmpdir fixture falsely report
// "matches zero files" — a test that can never fail.
describe('vinaya doctor — doc-owners binding health', () => {
  function writeTracked(relPath: string, content: string): void {
    const abs = join(root, relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }

  async function initAndCommit(docOwnersContent: string, extraFiles: Record<string, string>): Promise<void> {
    git(root, ['init', '-q', '-b', 'main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    await runInit(['--yes'], initDeps())
    writeTracked(DOC_OWNERS_PATH, docOwnersContent)
    for (const [relPath, content] of Object.entries(extraFiles)) writeTracked(relPath, content)
    git(root, ['add', '-A'])
    git(root, ['commit', '-q', '-m', 'Chore: fixture', '--no-verify'])
  }

  it('measured shape + negative control: a glob naming a deleted tree warns; a live glob in the same manifest does not', async () => {
    const docOwners = ['apps/deleted-tool/src/**  docs/deleted-tool.md', 'apps/live/src/**  docs/live.md'].join('\n')
    await initAndCommit(docOwners, {
      'docs/deleted-tool.md': '# deleted tool\n',
      'apps/live/src/index.ts': 'export {}\n',
      'docs/live.md': '# live\n'
    })

    const report = await runDoctorJson()
    const docOwnersFindings = report.findings.filter((f) => f.check === 'doc-owners')

    const dead = docOwnersFindings.find((f) => f.message.includes(`${DOC_OWNERS_PATH}:1`))
    expect(dead?.severity).toBe('warn')
    expect(dead?.message).toContain('apps/deleted-tool/src/**')
    expect(dead?.message).toContain('matches none of')

    const live = docOwnersFindings.find((f) => f.message.includes(`${DOC_OWNERS_PATH}:2`))
    expect(live?.severity).toBe('ok')
  })

  it('dangling pointer is independent of the glob-match check: a live glob with a missing pointer fires only the pointer warning', async () => {
    await initAndCommit('apps/live2/src/**  docs/missing.md\n', {
      'apps/live2/src/index.ts': 'export {}\n'
    })

    const report = await runDoctorJson()
    const docOwnersFindings = report.findings.filter((f) => f.check === 'doc-owners')

    expect(docOwnersFindings.some((f) => f.message.includes('matches none of'))).toBe(false)
    const dangling = docOwnersFindings.find((f) => f.message.includes('docs/missing.md'))
    expect(dangling?.severity).toBe('warn')
    expect(dangling?.message).toContain('does not exist on disk')
  })

  it('a URL pointer never trips the dangling-pointer check, even when its glob matches nothing', async () => {
    await initAndCommit('apps/deleted-tool2/src/**  https://example.com/docs\n', {})

    const report = await runDoctorJson()
    const docOwnersFindings = report.findings.filter((f) => f.check === 'doc-owners')

    const dead = docOwnersFindings.find((f) => f.message.includes('apps/deleted-tool2/src/**'))
    expect(dead?.severity).toBe('warn')
    expect(dead?.message).toContain('matches none of')
    expect(docOwnersFindings.some((f) => f.message.includes('does not exist on disk'))).toBe(false)
  })

  it('dormancy: no .vinaya/doc-owners, and separately an empty one, produce zero doc-owners findings', async () => {
    await runInit(['--yes'], initDeps())
    rmSync(join(root, DOC_OWNERS_PATH))

    let report = await runDoctorJson()
    expect(report.findings.filter((f) => f.check === 'doc-owners')).toEqual([])

    writeFileSync(join(root, DOC_OWNERS_PATH), '')
    report = await runDoctorJson()
    expect(report.findings.filter((f) => f.check === 'doc-owners')).toEqual([])
  })

  it('never mutates: fixture tree is byte-identical before and after runDoctor runs this diagnostic', async () => {
    await initAndCommit('apps/deleted-tool3/src/**  docs/deleted-tool3.md\n', {
      'docs/deleted-tool3.md': '# deleted tool 3\n'
    })
    const before = snapshot(root)

    await runDoctorJson()

    expect(snapshot(root)).toEqual(before)
  })
})

describe('vinaya doctor — token-metering capability', () => {
  it('surfaces an info finding naming the reason when the probe reports incapable', async () => {
    await runInit(['--yes'], initDeps())

    const report = await runDoctorJson({
      meteringCapability: () => ({
        capable: false,
        reason: 'transcript-empty',
        detail: 'Transcript at /tmp/x.jsonl yielded zero assistant messages with usage data.'
      })
    })

    const finding = report.findings.find((f) => f.check === 'tokens')
    expect(finding?.severity).toBe('info')
    expect(finding?.message).toContain('transcript-empty')
    expect(finding?.message).toContain('/tmp/x.jsonl')
  })

  it('emits nothing when the probe reports capable — capable is the unremarkable default', async () => {
    await runInit(['--yes'], initDeps())

    const report = await runDoctorJson({
      meteringCapability: () => ({
        capable: true,
        transcriptPath: '/tmp/real.jsonl',
        summary: {
          components: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          model: 'claude-sonnet-5',
          messageCount: 1
        }
      })
    })

    expect(report.findings.filter((f) => f.check === 'tokens')).toEqual([])
  })
})

describe('vinaya doctor — blast-radius deprecation', () => {
  it('no package.json, no .aeg/packages — check is active with zero derived/default domains, not dormant', async () => {
    const report = await runDoctorJson()
    const hit = report.findings.find((f) => f.check === 'blast-radius')
    expect(hit?.severity).toBe('info')
    expect(hit?.message).toContain('0 packages/* domain(s)')
    expect(hit?.message).toContain('0 present')
    expect(hit?.message).toContain('not dormant')
  })

  it('a real package.json + present defaults, no .aeg/packages — reports the live counts, not dormant', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }), 'utf8')
    mkdirSync(join(root, 'packages/foo'), { recursive: true })
    mkdirSync(join(root, 'packages/bar'), { recursive: true })
    writeFileSync(join(root, 'turbo.json'), '{}', 'utf8')

    const report = await runDoctorJson()
    const hit = report.findings.find((f) => f.check === 'blast-radius')
    expect(hit?.severity).toBe('info')
    expect(hit?.message).toContain('2 packages/* domain(s)')
    expect(hit?.message).toContain('1 present')
  })

  it('a pnpm adopter (pnpm-workspace.yaml, no `workspaces` key in package.json) still derives packages/* domains', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root' }), 'utf8')
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n", 'utf8')
    mkdirSync(join(root, 'packages/foo'), { recursive: true })

    const report = await runDoctorJson()
    const hit = report.findings.find((f) => f.check === 'blast-radius')
    expect(hit?.severity).toBe('info')
    expect(hit?.message).toContain('1 packages/* domain(s)')
  })

  it('.aeg/packages present, fully covered by derivation + defaults — deprecated, safe to delete', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }), 'utf8')
    mkdirSync(join(root, 'packages/foo'), { recursive: true })
    mkdirSync(join(root, '.aeg'), { recursive: true })
    writeFileSync(join(root, '.aeg/packages'), 'packages/foo\n', 'utf8')

    const report = await runDoctorJson()
    const hit = report.findings.find((f) => f.check === 'blast-radius')
    expect(hit?.severity).toBe('warn')
    expect(hit?.message).toContain('deprecated')
    expect(hit?.message).toContain('the file can be deleted')
  })

  it('.aeg/packages present with an entry NOT covered — names exactly it as needing migration', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }), 'utf8')
    mkdirSync(join(root, 'packages/foo'), { recursive: true })
    mkdirSync(join(root, '.aeg'), { recursive: true })
    writeFileSync(join(root, '.aeg/packages'), 'packages/foo\nmigrations/legacy\n', 'utf8')

    const report = await runDoctorJson()
    const hit = report.findings.find((f) => f.check === 'blast-radius')
    expect(hit?.severity).toBe('warn')
    expect(hit?.message).toContain('migrate 1 entry')
    expect(hit?.message).toContain('migrations/legacy')
    expect(hit?.message).not.toContain('packages/foo not')
  })

  it('an entry already declared in vinaya.config.json blastRadius.extraDomains does not need migrating', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }), 'utf8')
    mkdirSync(join(root, 'packages/foo'), { recursive: true })
    mkdirSync(join(root, '.aeg'), { recursive: true })
    writeFileSync(join(root, '.aeg/packages'), 'packages/foo\nmigrations/legacy\n', 'utf8')
    writeFileSync(
      join(root, CONFIG_PATH),
      JSON.stringify({ blastRadius: { extraDomains: ['migrations/legacy'] } }),
      'utf8'
    )

    const report = await runDoctorJson()
    const hit = report.findings.find((f) => f.check === 'blast-radius')
    expect(hit?.severity).toBe('warn')
    expect(hit?.message).toContain('the file can be deleted')
  })

  it('never mutates: fixture tree is byte-identical before and after this diagnostic runs', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }), 'utf8')
    mkdirSync(join(root, 'packages/foo'), { recursive: true })
    mkdirSync(join(root, '.aeg'), { recursive: true })
    writeFileSync(join(root, '.aeg/packages'), 'packages/foo\nmigrations/legacy\n', 'utf8')
    const before = snapshot(root)

    await runDoctorJson()

    expect(snapshot(root)).toEqual(before)
  })
})

describe('vinaya doctor — projects coherence (task 15, #44)', () => {
  it('neither the registry nor config projects exist — silent, no finding', async () => {
    const report = await runDoctorJson()
    expect(report.findings.find((f) => f.check === 'projects')).toBeUndefined()
  })

  it('a registry row with no config entry — info finding, never error, exit stays healthy', async () => {
    await runInit(['--yes'], initDeps())
    mkdirSync(join(root, '.vinaya'), { recursive: true })
    writeFileSync(
      join(root, PROJECTS_REGISTRY_PATH),
      freshProjectsRegistry('mobile', 'apps/mobile', 'apps/mobile/specs')
    )

    const report = await runDoctorJson()
    const hit = report.findings.find((f) => f.check === 'projects')
    expect(hit?.severity).toBe('info')
    expect(hit?.message).toContain('mobile')
    expect(hit?.message).toContain(PROJECTS_REGISTRY_PATH)
    expect(hit?.message).toContain('no matching')
    expect(report.healthy).toBe(true)
  })

  it('a config entry with no registry row — info finding, never error', async () => {
    await runInit(['--yes'], initDeps())
    const config = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    writeFileSync(
      join(root, CONFIG_PATH),
      JSON.stringify({ ...config, projects: [{ name: 'mobile', path: 'apps/mobile' }] })
    )

    const report = await runDoctorJson()
    const hit = report.findings.find((f) => f.check === 'projects')
    expect(hit?.severity).toBe('info')
    expect(hit?.message).toContain('mobile')
    expect(hit?.message).toContain('vinaya.config.json')
    expect(report.healthy).toBe(true)
  })

  it('a project declared in both — no finding for it, no incoherence at all', async () => {
    await runInit(['--yes'], initDeps())
    mkdirSync(join(root, '.vinaya'), { recursive: true })
    writeFileSync(
      join(root, PROJECTS_REGISTRY_PATH),
      freshProjectsRegistry('mobile', 'apps/mobile', 'apps/mobile/specs')
    )
    const config = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    writeFileSync(
      join(root, CONFIG_PATH),
      JSON.stringify({ ...config, projects: [{ name: 'mobile', path: 'apps/mobile' }] })
    )

    const report = await runDoctorJson()
    expect(report.findings.find((f) => f.check === 'projects')).toBeUndefined()
    expect(report.healthy).toBe(true)
  })

  it('never mutates: fixture tree is byte-identical before and after this diagnostic runs', async () => {
    mkdirSync(join(root, '.vinaya'), { recursive: true })
    writeFileSync(
      join(root, PROJECTS_REGISTRY_PATH),
      freshProjectsRegistry('mobile', 'apps/mobile', 'apps/mobile/specs')
    )
    const before = snapshot(root)

    await runDoctorJson()

    expect(snapshot(root)).toEqual(before)
  })
})

describe('vinaya doctor — brief-schema divergence', () => {
  /** `vinaya init`'s own config, minus whichever `briefSchema.pr` builtins the caller names. */
  function dropPrBuiltins(...drop: string[]): void {
    const config = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf8'))
    config.briefSchema.pr.sections = config.briefSchema.pr.sections.filter(
      (s: { builtin?: string }) => !(s.builtin && drop.includes(s.builtin))
    )
    writeFileSync(join(root, CONFIG_PATH), JSON.stringify(config, null, 2), 'utf8')
  }

  it('a pristine install reports no divergence — the shipped default is not its own finding', async () => {
    await runInit(['--yes'], initDeps())

    const report = await runDoctorJson()
    expect(report.findings.filter((f) => f.check === 'brief-schema')).toEqual([])
  })

  it('names a deleted builtin, at info severity, and stays healthy', async () => {
    await runInit(['--yes'], initDeps())
    dropPrBuiltins('closesN')

    const report = await runDoctorJson()
    const hit = report.findings.find((f) => f.check === 'brief-schema')
    expect(hit?.severity).toBe('info')
    expect(hit?.message).toContain('briefSchema.pr')
    expect(hit?.message).toContain('closesN')
    // The whole point: an adopter running without a builtin is exercising
    // legitimate configuration and must not be failed into a shape they
    // rejected. If this ever becomes `warn`/`error` it breaks their CI.
    expect(report.healthy).toBe(true)
  })

  it('names every deleted builtin, not just the first', async () => {
    await runInit(['--yes'], initDeps())
    dropPrBuiltins('closesN', 'tier')

    const report = await runDoctorJson()
    const hit = report.findings.find((f) => f.check === 'brief-schema')
    expect(hit?.message).toContain('closesN')
    expect(hit?.message).toContain('tier')
    expect(hit?.message).toContain('2 builtins')
  })

  it('briefSchema.ack silences exactly the acked builtin and nothing else', async () => {
    await runInit(['--yes'], initDeps())
    dropPrBuiltins('closesN', 'tier')
    const config = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf8'))
    config.briefSchema.ack = ['closesN']
    writeFileSync(join(root, CONFIG_PATH), JSON.stringify(config, null, 2), 'utf8')

    const report = await runDoctorJson()
    const hit = report.findings.find((f) => f.check === 'brief-schema')
    expect(hit?.message).not.toContain('closesN')
    expect(hit?.message).toContain('tier')
  })

  it('acking every dropped builtin removes the finding entirely', async () => {
    await runInit(['--yes'], initDeps())
    dropPrBuiltins('closesN')
    const config = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf8'))
    config.briefSchema.ack = ['closesN']
    writeFileSync(join(root, CONFIG_PATH), JSON.stringify(config, null, 2), 'utf8')

    const report = await runDoctorJson()
    expect(report.findings.filter((f) => f.check === 'brief-schema')).toEqual([])
  })

  it('an absent briefSchema.pr block reads as every builtin missing — the gate is off, not adopter-shaped', async () => {
    await runInit(['--yes'], initDeps())
    const config = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf8'))
    config.briefSchema.pr = undefined
    writeFileSync(join(root, CONFIG_PATH), JSON.stringify(config, null, 2), 'utf8')

    const report = await runDoctorJson()
    const hit = report.findings.find((f) => f.check === 'brief-schema' && f.message.includes('briefSchema.pr'))
    expect(hit?.severity).toBe('info')
    for (const builtin of ['tier', 'testPlan', 'testPlanExclusivity', 'closesN', 'project']) {
      expect(hit?.message).toContain(builtin)
    }
  })

  it('reports the issue kind independently of the pr kind', async () => {
    await runInit(['--yes'], initDeps())
    const config = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf8'))
    config.briefSchema.issue.sections = []
    writeFileSync(join(root, CONFIG_PATH), JSON.stringify(config, null, 2), 'utf8')

    const report = await runDoctorJson()
    const hits = report.findings.filter((f) => f.check === 'brief-schema')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.message).toContain('briefSchema.issue')
    expect(hits[0]?.message).toContain('issueRationale')
  })

  it('an adopter-added section is an addition, never reported as divergence', async () => {
    await runInit(['--yes'], initDeps())
    const config = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf8'))
    config.briefSchema.pr.sections.push({ heading: 'Rollback Plan' })
    writeFileSync(join(root, CONFIG_PATH), JSON.stringify(config, null, 2), 'utf8')

    const report = await runDoctorJson()
    expect(report.findings.filter((f) => f.check === 'brief-schema')).toEqual([])
  })

  it('never mutates: the config is byte-identical after the diagnostic runs', async () => {
    await runInit(['--yes'], initDeps())
    dropPrBuiltins('closesN')
    const before = readFileSync(join(root, CONFIG_PATH), 'utf8')

    await runDoctorJson()

    expect(readFileSync(join(root, CONFIG_PATH), 'utf8')).toBe(before)
  })
})

// O4 (PR #410 review, MAJOR and MINOR): the `doctrine: <root> (<source>)`
// line had zero automated coverage — only a manually-pasted CLI transcript
// in that PR's own evidence — and `--json` carried no doctrineInfo signal
// at all, an inconsistency with text mode for the same command.
describe('vinaya doctor — doctrine root/source line (PR #410 review)', () => {
  async function runDoctorJsonFull(overrides: Partial<DoctorDeps> = {}): Promise<{
    healthy: boolean
    findings: Finding[]
    doctrineInfo: { root: string; source: 'tree' | 'bundle' } | null
  }> {
    const original = process.stdout.write.bind(process.stdout)
    let buf = ''
    process.stdout.write = ((chunk: string) => {
      buf += chunk
      return true
    }) as typeof process.stdout.write
    try {
      await runDoctor(['--json'], doctorDeps(overrides))
    } finally {
      process.stdout.write = original
    }
    return JSON.parse(buf).data
  }

  it('a repo carrying its own aeg-root/roles/ prints "(tree)", rooted at that repo\'s own aeg-root', async () => {
    git(root, ['init', '-q'])
    mkdirSync(join(root, 'aeg-root', 'roles'), { recursive: true })
    writeFileSync(join(root, 'aeg-root', 'roles', 'developer.md'), '# Developer\n')
    await runInit(['--yes'], initDeps())

    const out = await captureStdout(async () => {
      await runDoctor([], doctorDeps())
    })
    const realRoot = realpathSync(root)
    expect(out).toContain(`doctrine: ${join(realRoot, 'aeg-root')} (tree)`)

    const report = await runDoctorJsonFull()
    expect(report.doctrineInfo).toEqual({ root: join(realRoot, 'aeg-root'), source: 'tree' })
  })

  it('a repo with no aeg-root/roles/ of its own prints "(bundle)"', async () => {
    await runInit(['--yes'], initDeps())

    const out = await captureStdout(async () => {
      await runDoctor([], doctorDeps())
    })
    expect(out).toMatch(/doctrine: .*\(bundle\)/)
    expect(out).not.toContain('(tree)')

    const report = await runDoctorJsonFull()
    expect(report.doctrineInfo?.source).toBe('bundle')
  })
})

// The log destination is the one thing here a file cannot answer: a server
// that refuses every event looks exactly like a healthy one from the config's
// side, because the sink is fail-open by design. This repository's own server
// refused every event for most of a day with nothing surfacing it.
describe('vinaya doctor — the log destination works (Issue #793)', () => {
  const SERVER = 'https://logs.example.com/v1/repos/acme/widget/events'

  function logFinding(findings: Finding[]): Finding {
    const found = findings.filter((f) => f.check === 'logs')
    expect(found).toHaveLength(1)
    return found[0] as Finding
  }

  it('reports a server that accepts this machine credential, and stays healthy', async () => {
    await runInit(['--yes'], initDeps())
    const report = await runDoctorJson({
      resolveLogDestination: async () => ({
        destination: { kind: 'server', url: SERVER, headers: { authorization: 'Bearer real-token' } },
        credentialVars: ['VINAYA_LOG_TOKEN']
      }),
      probeLogServer: async () => ({ kind: 'accepted', status: 200 })
    })

    const finding = logFinding(report.findings)
    expect(finding.severity).toBe('ok')
    expect(finding.message).toContain(SERVER)
    expect(finding.message).toContain('accepts')
    expect(finding.message).toContain('Nothing was stored')
    expect(report.healthy).toBe(true)
  })

  it('reports a rejected credential as an error naming the variable to fix, never its value', async () => {
    await runInit(['--yes'], initDeps())
    const report = await runDoctorJson({
      resolveLogDestination: async () => ({
        destination: { kind: 'server', url: SERVER, headers: { authorization: 'Bearer stale-token' } },
        credentialVars: ['VINAYA_LOG_TOKEN']
      }),
      probeLogServer: async () => ({ kind: 'credential-rejected', status: 401 })
    })

    const finding = logFinding(report.findings)
    expect(finding.severity).toBe('error')
    expect(finding.message).toContain('VINAYA_LOG_TOKEN')
    expect(finding.message).toContain('REFUSED')
    expect(finding.message).not.toContain('stale-token')
    expect(report.healthy).toBe(false)
  })

  it('an unreachable destination never fails the command — an offline machine loses nothing', async () => {
    await runInit(['--yes'], initDeps())
    const report = await runDoctorJson({
      resolveLogDestination: async () => ({
        destination: { kind: 'server', url: SERVER, headers: { authorization: 'Bearer secret-token' } },
        credentialVars: ['VINAYA_LOG_TOKEN']
      }),
      probeLogServer: async () => ({ kind: 'unreachable', detail: 'connect ECONNREFUSED' })
    })

    const finding = logFinding(report.findings)
    // `info`, not `warn`: doctor's own health rule turns anything above `info`
    // into exit code `1`, and an offline run must not fail this command.
    expect(finding.severity).toBe('info')
    expect(finding.message).toContain('could not be reached')
    expect(finding.message).toContain('queue')
    expect(report.healthy).toBe(true)
  })

  it('a destination answering anything but 2xx or 401/403 is reported as refusing delivery, never as ok', async () => {
    await runInit(['--yes'], initDeps())
    for (const status of [404, 500, 405, 413]) {
      const report = await runDoctorJson({
        resolveLogDestination: async () => ({
          destination: { kind: 'server', url: SERVER, headers: { authorization: 'Bearer real-token' } },
          credentialVars: ['VINAYA_LOG_TOKEN']
        }),
        probeLogServer: async () => ({ kind: 'refused', status })
      })

      const finding = logFinding(report.findings)
      expect(finding.severity).toBe('error')
      expect(finding.message).toContain(`HTTP ${status}`)
      expect(finding.message).toContain('not an acceptance')
      expect(finding.message).not.toContain('accepts this machine')
      expect(report.healthy).toBe(false)
    }
  })

  it('a credential reaching the failure text without its scheme word, or only as part of a header, is redacted', async () => {
    await runInit(['--yes'], initDeps())
    const previous = process.env.DOCTOR_TEST_LOG_TOKEN
    process.env.DOCTOR_TEST_LOG_TOKEN = 'inner-secret-value'
    try {
      const report = await runDoctorJson({
        resolveLogDestination: async () => ({
          // The credential is only PART of this header's value, so neither the
          // whole value nor a scheme split finds it — the variable's own value
          // is what closes that.
          destination: {
            kind: 'server',
            url: SERVER,
            headers: { authorization: 'Bearer secret-token', 'x-vinaya-key': 'prefix-inner-secret-value-suffix' }
          },
          credentialVars: ['DOCTOR_TEST_LOG_TOKEN']
        }),
        // A destination composes its own failure text; doctor prints none of it
        // until every value that authenticates this machine is out of it.
        probeLogServer: async () => ({
          kind: 'unreachable',
          detail: 'upstream rejected token secret-token for key inner-secret-value'
        })
      })

      const finding = logFinding(report.findings)
      expect(finding.message).not.toContain('secret-token')
      expect(finding.message).not.toContain('inner-secret-value')
      expect(finding.message).toContain('<redacted>')
    } finally {
      if (previous === undefined) delete process.env.DOCTOR_TEST_LOG_TOKEN
      else process.env.DOCTOR_TEST_LOG_TOKEN = previous
    }
  })

  it('a credential inside logs.url itself is never printed', async () => {
    await runInit(['--yes'], initDeps())
    const report = await runDoctorJson({
      resolveLogDestination: async () => ({
        destination: {
          kind: 'server',
          url: 'https://ingest:url-secret@logs.example.com/events?access_token=query-secret&repo=widget',
          headers: undefined
        },
        credentialVars: []
      }),
      probeLogServer: async () => ({ kind: 'accepted', status: 200 })
    })

    const finding = logFinding(report.findings)
    expect(finding.message).not.toContain('url-secret')
    expect(finding.message).not.toContain('query-secret')
    // The host, path and non-credential query stay readable — they are what
    // makes the finding actionable.
    expect(finding.message).toContain('logs.example.com/events')
    expect(finding.message).toContain('repo=widget')
  })

  it('reports a writable folder destination as ok, and an undeliverable one as an error', async () => {
    await runInit(['--yes'], initDeps())
    const folder = join(root, 'telemetry', 'logs')

    const okReport = await runDoctorJson({
      resolveLogDestination: async () => ({ destination: { kind: 'folder', folder }, credentialVars: [] })
    })
    const okFinding = logFinding(okReport.findings)
    expect(okFinding.severity).toBe('ok')
    expect(okFinding.message).toContain(folder)
    expect(okReport.healthy).toBe(true)

    // A regular file where a parent directory has to be: the sink's own
    // recursive mkdir cannot succeed, so no event is ever written.
    const blocker = join(root, 'not-a-directory')
    writeFileSync(blocker, 'x\n')
    const badReport = await runDoctorJson({
      resolveLogDestination: async () => ({
        destination: { kind: 'folder', folder: join(blocker, 'logs') },
        credentialVars: []
      })
    })
    const badFinding = logFinding(badReport.findings)
    expect(badFinding.severity).toBe('error')
    expect(badFinding.message).toContain('cannot be written')
    expect(badReport.healthy).toBe(false)
  })

  it('a folder that is a fallback from an unreadable trust anchor reports why, at info (Issue #832)', async () => {
    await runInit(['--yes'], initDeps())
    const folder = join(root, 'telemetry', 'logs')
    const report = await runDoctorJson({
      resolveLogDestination: async () => ({
        destination: {
          kind: 'folder',
          folder,
          fallbackReason: { kind: 'anchor-unreadable', intendedUrl: SERVER }
        },
        credentialVars: ['VINAYA_LOG_TOKEN']
      })
    })

    const finding = logFinding(report.findings)
    // `info`, not `warn`: nothing is lost — the folder holds the events and
    // `vinaya log send` delivers them later — so this must not fail the command,
    // exactly as the offline server-`unreachable` case does not.
    expect(finding.severity).toBe('info')
    expect(finding.message).toContain(folder)
    expect(finding.message).toContain(SERVER)
    expect(finding.message).toContain('could not be read')
    expect(finding.message).toContain('vinaya log send')
    expect(report.healthy).toBe(true)
  })

  it('a folder that is a fallback from an anchor mismatch reports why, at warn', async () => {
    await runInit(['--yes'], initDeps())
    const folder = join(root, 'telemetry', 'logs')
    const report = await runDoctorJson({
      resolveLogDestination: async () => ({
        destination: {
          kind: 'folder',
          folder,
          fallbackReason: { kind: 'anchor-mismatch', intendedUrl: 'https://attacker.example/x' }
        },
        credentialVars: []
      })
    })

    const finding = logFinding(report.findings)
    // `warn`: a standing configuration divergence — the working-tree url the
    // default branch does not declare — that the operator has to resolve.
    expect(finding.severity).toBe('warn')
    expect(finding.message).toContain('does not declare it')
    expect(finding.message).toContain('https://attacker.example/x')
    expect(report.healthy).toBe(false)
  })

  it('a destination of none is reported, and is never a failure', async () => {
    await runInit(['--yes'], initDeps())
    const report = await runDoctorJson({
      resolveLogDestination: async () => ({
        destination: { kind: 'none', reason: 'this job holds no delivery credential' },
        credentialVars: []
      })
    })

    const finding = logFinding(report.findings)
    expect(finding.severity).toBe('info')
    expect(finding.message).toContain('this job holds no delivery credential')
    expect(report.healthy).toBe(true)
  })

  it('a destination of none still names the variable whose absence produced it', async () => {
    await runInit(['--yes'], initDeps())
    const report = await runDoctorJson({
      resolveLogDestination: async () => ({
        destination: {
          kind: 'none',
          reason: 'a logs.url server destination is configured, but this job holds no delivery credential'
        },
        credentialVars: ['VINAYA_LOG_TOKEN']
      })
    })

    const finding = logFinding(report.findings)
    expect(finding.severity).toBe('info')
    expect(finding.message).toContain('VINAYA_LOG_TOKEN')
    expect(report.healthy).toBe(true)
  })

  // O4: doctor reports WHERE each log credential was found — the environment,
  // the macOS login Keychain, or nowhere — never its value.
  describe('where the log credential was found (O4)', () => {
    function credentialFinding(findings: Finding[]): Finding {
      const found = findings.filter((f) => f.check === 'log-credential')
      expect(found).toHaveLength(1)
      return found[0] as Finding
    }

    it('names no credential-source line when no variable is referenced', async () => {
      await runInit(['--yes'], initDeps())
      const report = await runDoctorJson({
        resolveLogDestination: async () => ({
          destination: { kind: 'server', url: SERVER, headers: undefined },
          credentialVars: []
        }),
        probeLogServer: async () => ({ kind: 'accepted', status: 200 })
      })
      expect(report.findings.filter((f) => f.check === 'log-credential')).toHaveLength(0)
    })

    it('reports the environment as the source when the variable is set there — Keychain not consulted', async () => {
      await runInit(['--yes'], initDeps())
      const prev = process.env.VINAYA_LOG_TOKEN
      process.env.VINAYA_LOG_TOKEN = 'set-in-env'
      try {
        const report = await runDoctorJson({
          resolveLogDestination: async () => ({
            destination: { kind: 'server', url: SERVER, headers: { authorization: 'Bearer x' } },
            credentialVars: ['VINAYA_LOG_TOKEN']
          }),
          probeLogServer: async () => ({ kind: 'accepted', status: 200 }),
          readLogCredentialKeychain: () => {
            throw new Error('the environment was set — the Keychain must not be read')
          }
        })
        const finding = credentialFinding(report.findings)
        expect(finding.severity).toBe('info')
        expect(finding.message).toContain('VINAYA_LOG_TOKEN: found in the environment')
        expect(finding.message).not.toContain('set-in-env')
        expect(report.healthy).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.VINAYA_LOG_TOKEN
        else process.env.VINAYA_LOG_TOKEN = prev
      }
    })

    it('reports the macOS login Keychain when the variable is unset but stored there', async () => {
      await runInit(['--yes'], initDeps())
      const prev = process.env.VINAYA_LOG_TOKEN
      delete process.env.VINAYA_LOG_TOKEN
      try {
        const report = await runDoctorJson({
          resolveLogDestination: async () => ({
            destination: { kind: 'server', url: SERVER, headers: { authorization: 'Bearer x' } },
            credentialVars: ['VINAYA_LOG_TOKEN']
          }),
          probeLogServer: async () => ({ kind: 'accepted', status: 200 }),
          readLogCredentialKeychain: (name) => (name === 'VINAYA_LOG_TOKEN' ? 'kc-secret' : null)
        })
        const finding = credentialFinding(report.findings)
        expect(finding.message).toContain('VINAYA_LOG_TOKEN: found in the macOS login Keychain')
        expect(finding.message).not.toContain('kc-secret')
      } finally {
        if (prev === undefined) delete process.env.VINAYA_LOG_TOKEN
        else process.env.VINAYA_LOG_TOKEN = prev
      }
    })

    it('reports nowhere when the variable is in neither the environment nor the Keychain', async () => {
      await runInit(['--yes'], initDeps())
      const prev = process.env.VINAYA_LOG_TOKEN
      delete process.env.VINAYA_LOG_TOKEN
      try {
        const report = await runDoctorJson({
          resolveLogDestination: async () => ({
            destination: { kind: 'server', url: SERVER, headers: { authorization: 'Bearer x' } },
            credentialVars: ['VINAYA_LOG_TOKEN']
          }),
          probeLogServer: async () => ({ kind: 'credential-rejected', status: 401 }),
          readLogCredentialKeychain: () => null
        })
        const finding = credentialFinding(report.findings)
        expect(finding.message).toContain(
          'VINAYA_LOG_TOKEN: found in neither the environment nor the macOS login Keychain'
        )
      } finally {
        if (prev === undefined) delete process.env.VINAYA_LOG_TOKEN
        else process.env.VINAYA_LOG_TOKEN = prev
      }
    })
  })

  // The real probe, against a real server: what it sends is what decides
  // whether this check can store an event, so a fake would prove nothing.
  describe('probeLogDestinationServer — the real request', () => {
    function fixtureServer(status: number): {
      url: string
      seen: { method: string; body: string; authorization: string | null }[]
      stop: () => void
    } {
      const seen: { method: string; body: string; authorization: string | null }[] = []
      const server = Bun.serve({
        port: 0,
        async fetch(req) {
          seen.push({
            method: req.method,
            body: await req.text(),
            authorization: req.headers.get('authorization')
          })
          return new Response(status >= 200 && status < 300 ? '{"accepted":0}' : 'no', { status })
        }
      })
      return { url: `http://127.0.0.1:${server.port}/v1/repos/acme/widget/events`, seen, stop: () => server.stop() }
    }

    it('posts an empty body with the credential, and reads any non-401/403 answer as accepted', async () => {
      const fixture = fixtureServer(200)
      try {
        const probe = await probeLogDestinationServer(fixture.url, { authorization: 'Bearer real-token' })
        expect(probe).toEqual({ kind: 'accepted', status: 200 })
        expect(fixture.seen).toHaveLength(1)
        // O2, the whole point: the request carries no event, so the
        // destination has nothing to store — it authenticates and no more.
        expect(fixture.seen[0]?.body).toBe('')
        expect(fixture.seen[0]?.method).toBe('POST')
        expect(fixture.seen[0]?.authorization).toBe('Bearer real-token')
      } finally {
        fixture.stop()
      }
    })

    it('reads 401 and 403 as the credential being refused', async () => {
      for (const status of [401, 403]) {
        const fixture = fixtureServer(status)
        try {
          expect(await probeLogDestinationServer(fixture.url, { authorization: 'Bearer stale' })).toEqual({
            kind: 'credential-rejected',
            status
          })
        } finally {
          fixture.stop()
        }
      }
    })

    it('reads every other status as the destination refusing delivery, never as acceptance', async () => {
      // A `404` is what a mistyped path answers, and the route produces it
      // BEFORE any token is compared, so it authenticates nothing; a `500` is
      // a destination missing its own ingest secret. Both discard every event.
      for (const status of [404, 405, 413, 500, 502]) {
        const fixture = fixtureServer(status)
        try {
          expect(await probeLogDestinationServer(fixture.url, { authorization: 'Bearer real-token' })).toEqual({
            kind: 'refused',
            status
          })
        } finally {
          fixture.stop()
        }
      }
    })

    it('reads a 2xx that is not 200 as accepted', async () => {
      const fixture = fixtureServer(202)
      try {
        expect(await probeLogDestinationServer(fixture.url, undefined)).toEqual({ kind: 'accepted', status: 202 })
      } finally {
        fixture.stop()
      }
    })

    it('a destination nothing is listening on is unreachable, never a throw', async () => {
      // A port claimed and immediately released: nothing is listening there,
      // which is what an offline machine looks like to this probe.
      const idle = Bun.serve({ port: 0, fetch: () => new Response('') })
      const port = idle.port
      idle.stop()

      const probe = await probeLogDestinationServer(`http://127.0.0.1:${port}/events`, undefined)
      expect(probe.kind).toBe('unreachable')
    })
  })

  // The resolution and the variable-naming rule are what produce "name the
  // environment variable to fix" — the half every injected-deps case above
  // hands in pre-baked. Driven here directly, against the pure function the
  // real wiring calls.
  describe('the resolution the real wiring uses', () => {
    const configWith = (logs: unknown): VinayaConfig => ({ logs }) as unknown as VinayaConfig
    const base = {
      env: {} as NodeJS.ProcessEnv,
      defaultFolder: '/var/lib/vinaya/logs',
      repoRoot: '/repo'
    }

    it('names the variables both the working tree and the trust anchor reference, deduplicated', () => {
      const target = logDestinationTargetFrom({
        ...base,
        unattended: false,
        localConfig: configWith({
          url: 'https://logs.example.com/events',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} reference IS the config syntax under test, never a JS template
          headers: { authorization: 'Bearer ${LOCAL_TOKEN}' }
        }),
        trustAnchorConfig: configWith({
          url: 'https://logs.example.com/events',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} reference IS the config syntax under test, never a JS template
          headers: { authorization: 'Bearer ${LOCAL_TOKEN}', 'x-extra': '${ANCHOR_TOKEN}' }
        })
      })

      expect(target.destination.kind).toBe('server')
      expect([...target.credentialVars].sort()).toEqual(['ANCHOR_TOKEN', 'LOCAL_TOKEN'])
    })

    it('a folder destination has no credential to name', () => {
      const target = logDestinationTargetFrom({
        ...base,
        unattended: false,
        localConfig: configWith({ folder: '/srv/telemetry' }),
        trustAnchorConfig: null
      })

      expect(target.destination).toEqual({ kind: 'folder', folder: '/srv/telemetry' })
      expect(target.credentialVars).toEqual([])
    })

    it('an unattended caller whose working tree redirects the destination gets the fallback, not the redirect, and names why (anchor-mismatch)', () => {
      const target = logDestinationTargetFrom({
        ...base,
        unattended: true,
        localConfig: configWith({
          url: 'https://attacker.example/x',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} reference IS the config syntax under test, never a JS template
          headers: { authorization: 'Bearer ${GH_TOKEN}' }
        }),
        trustAnchorConfig: configWith({
          url: 'https://logs.example.com/events',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} reference IS the config syntax under test, never a JS template
          headers: { authorization: 'Bearer ${VINAYA_LOG_TOKEN}' }
        })
      })

      // O2: the default branch WAS read and does not declare this working-tree
      // url, so the fallback is named `anchor-mismatch` and carries the url that
      // was refused — never delivered, only reported.
      expect(target.destination).toEqual({
        kind: 'folder',
        folder: base.defaultFolder,
        fallbackReason: { kind: 'anchor-mismatch', intendedUrl: 'https://attacker.example/x' }
      })
    })

    it('an unattended caller whose trust-anchor read failed falls back with an anchor-unreadable reason (Issue #832: the Mac case)', () => {
      const target = logDestinationTargetFrom({
        ...base,
        unattended: true,
        localConfig: configWith({
          url: 'https://logs.example.com/events',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} reference IS the config syntax under test, never a JS template
          headers: { authorization: 'Bearer ${VINAYA_LOG_TOKEN}' }
        }),
        // `null` = the default branch's config could not be read at all (offline,
        // unauthenticated, or slower than the deadline) — distinct from a read
        // that returned a config declaring a different destination.
        trustAnchorConfig: null
      })

      expect(target.destination).toEqual({
        kind: 'folder',
        folder: base.defaultFolder,
        fallbackReason: { kind: 'anchor-unreadable', intendedUrl: 'https://logs.example.com/events' }
      })
    })

    it('a CI host with a configured server but no credential resolves to none, and the variable is still named', () => {
      const target = logDestinationTargetFrom({
        ...base,
        env: { GITHUB_ACTIONS: 'true' } as NodeJS.ProcessEnv,
        unattended: true,
        localConfig: configWith({
          url: 'https://logs.example.com/events',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} reference IS the config syntax under test, never a JS template
          headers: { authorization: 'Bearer ${VINAYA_LOG_TOKEN}' }
        }),
        trustAnchorConfig: configWith({
          url: 'https://logs.example.com/events',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} reference IS the config syntax under test, never a JS template
          headers: { authorization: 'Bearer ${VINAYA_LOG_TOKEN}' }
        })
      })

      expect(target.destination.kind).toBe('none')
      expect(target.credentialVars).toEqual(['VINAYA_LOG_TOKEN'])
    })

    it('a header carrying no variable reference names nothing, and a literal is never mistaken for a name', () => {
      expect(credentialVarNames([{ url: 'https://x/y', headers: { authorization: 'Bearer literal-token' } }])).toEqual(
        []
      )
      expect(credentialVarNames([null, { folder: '/srv' }])).toEqual([])
      expect(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} reference IS the config syntax under test, never a JS template
        credentialVarNames([{ url: 'https://x/y', headers: { a: 'p-${ONE}-q', b: '${TWO}${ONE}' } }]).sort()
      ).toEqual(['ONE', 'TWO'])
    })

    it('a credential is stripped by whole value, by the credential inside it, and by the variable value', () => {
      const headers = { authorization: 'Bearer abc123', 'x-key': 'prefix-deadbeef-suffix' }
      const env = { TOKEN: 'deadbeef' } as NodeJS.ProcessEnv
      const text = 'sent Bearer abc123; token abc123; key deadbeef'
      const cleaned = withoutCredentialValues(text, headers, ['TOKEN'], env)

      expect(cleaned).not.toContain('abc123')
      expect(cleaned).not.toContain('deadbeef')
    })

    it('a two-character variable value is left alone rather than corrupting the text', () => {
      expect(
        withoutCredentialValues('an ordinary message', undefined, ['SHORT'], { SHORT: 'an' } as NodeJS.ProcessEnv)
      ).toBe('an ordinary message')
    })

    it('a printable url keeps its host and path, loses its userinfo and credential query values', () => {
      expect(urlForDisplay('https://user:pw@logs.example.com/events?token=SECRET&repo=widget')).toBe(
        'https://%3Credacted%3E@logs.example.com/events?token=%3Credacted%3E&repo=widget'
      )
      expect(urlForDisplay('https://logs.example.com/events')).toBe('https://logs.example.com/events')
      expect(urlForDisplay('not a url at all')).toBe('<unparseable logs.url>')
    })
  })
})
