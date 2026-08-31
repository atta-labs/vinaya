import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { CheckSpec } from '../../src/checks/contract'
import { coreCheckRegistry } from '../../src/checks/registry'
import { VinayaConfigSchema } from '../../src/lib/config'

/**
 * Proves the task 2 (#775) audit actually landed: every registered core
 * check carries an `env` declaration, and every declaration is valid
 * against the exact same `CheckEntrySchema` an adopter's
 * `vinaya.config.json` entry would be parsed with — the no-privileged-API
 * invariant extended to this new field.
 */
/**
 * A check bin's source with comments stripped. The source-text guards below
 * assert things about real CODE — a doc comment that merely NAMES
 * `loadTrustAnchorConfig()` while explaining why the guard exists is not a
 * second call site, and counting it made these very tests fail on their own
 * explanatory prose.
 */
function readCode(binName: string): string {
  return readFileSync(join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', binName), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('registry env declarations', () => {
  const specs = coreCheckRegistry()

  it('registers exactly this name set as core checks (the audited surface)', () => {
    expect(specs.map((s) => s.name).sort()).toEqual(
      [
        'body-bare-digits',
        'brief-shape',
        'branch-topology',
        'changeset-coverage',
        'closes-n',
        'coherence',
        'dead-branch-push',
        'dispatch-readiness',
        'doc-coverage',
        'doc-coverage-push',
        'doctrine-portability',
        'evidence-fresh',
        'first-push-dispatch',
        'issue-assignment',
        'main-branch-refusal',
        'no-disk-state',
        'quoted-command',
        'reader-resolvable-prose',
        'registry-gates',
        'retired-vocabulary',
        'review-gate',
        'single-plan-pr',
        'test-plan',
        'token-collection-wired',
        'workspace-escape'
      ].sort()
    )
  })

  it('every core check carries an env declaration', () => {
    const undeclared = specs.filter((s) => !s.env).map((s) => s.name)
    expect(undeclared).toEqual([])
  })

  it('every declared env shape parses through the same schema a config-file entry would', () => {
    for (const spec of specs) {
      const asConfigEntry = {
        checks: {
          [spec.name]: {
            run: spec.run,
            scope: spec.scope,
            ...(spec.env ? { env: spec.env } : {})
          }
        }
      }
      const parsed = VinayaConfigSchema.safeParse(asConfigEntry)
      expect(parsed.success, `check "${spec.name}"'s env declaration failed schema validation`).toBe(true)
    }
  })

  it('no core check declares `anyOf` — reserved for adopter-facing custom checks only', () => {
    const offenders: string[] = []
    for (const spec of specs) {
      for (const [key, decl] of Object.entries(spec.env ?? {})) {
        if (typeof decl === 'object' && decl !== null && 'anyOf' in decl) {
          offenders.push(`${spec.name}.${key}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('every check whose bin shells to `gh` forwards GITHUB_TOKEN and GH_TOKEN', () => {
    // The runner spawns children with ONLY the baseline env plus declared
    // keys. On a CI runner `gh` authenticates exclusively from
    // GITHUB_TOKEN/GH_TOKEN — a bin that shells to `gh` without forwarding
    // them runs unauthenticated there: hard-fail (review-gate, pre-fix) or
    // silently vacuous fail-open (single-plan-pr, dead-branch-push,
    // issue-assignment, pre-fix). Coupling: read each bin's source, detect
    // the `gh` shell-out, demand both token declarations.
    const SRC_BIN_DIR = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin')
    const offenders: string[] = []
    for (const spec of specs) {
      const srcPath = join(SRC_BIN_DIR, `${basename(spec.run).replace(/\.(js|ts)$/, '')}.ts`)
      const source = readFileSync(srcPath, 'utf8')
      // Detect `gh` as a spawned command in ANY call shape: execFileSync's
      // array form (`'gh'`), execSync's string form (`'gh auth status'`),
      // and template-literal commands (`` `gh issue view ${n}` ``) — the
      // string forms slipped past an earlier exact-`'gh'` match and left
      // check-registry-gates undeclared.
      if (!/['"`]gh['"`\s]/.test(source)) continue
      const env = spec.env ?? {}
      if (!('GITHUB_TOKEN' in env) || !('GH_TOKEN' in env)) {
        offenders.push(spec.name)
      }
    }
    expect(offenders).toEqual([])
  })

  it('core registry CheckSpecs still carry no field a config-derived CheckSpec cannot carry, env included', () => {
    const ALLOWED_KEYS = new Set<keyof CheckSpec>([
      'name',
      'run',
      'args',
      'scope',
      'include',
      'timeoutMs',
      'env',
      'requiresOpenPr',
      // Expressible in config (CheckEntrySchema) and documented in
      // CONFIG_REFERENCE, so it is not a privileged core-only field.
      'ownWorkflow'
    ])
    for (const spec of specs) {
      const extra = (Object.keys(spec) as Array<keyof CheckSpec>).filter((k) => !ALLOWED_KEYS.has(k))
      expect(extra, `check "${spec.name}" carries an unexpected field: ${extra.join(', ')}`).toEqual([])
    }
  })

  // Security regression, PR #862 rounds 2-3. Round 2 added a `BASE_SHA` env
  // declaration to review-gate, forwarding an attacker-steerable ref into the
  // trust-anchor read; round 3 hardcoded a local `origin/main`, which the PR's
  // own workflow YAML could still `git update-ref`. `review-gate` must never
  // regain a ref-shaped env knob, and no bin may resolve `principals` from
  // any local/env source — only `loadTrustAnchorConfig()` (GitHub API).
  it('review-gate never declares BASE_SHA — its trust anchor is never caller-suppliable', () => {
    const reviewGate = specs.find((s) => s.name === 'review-gate')
    expect(reviewGate?.env).toBeDefined()
    expect(Object.keys(reviewGate?.env ?? {})).not.toContain('BASE_SHA')
  })

  it('every principals-resolving bin calls loadTrustAnchorConfig() with NO arguments, and never a local-git/env-derived config', () => {
    const bins = [
      'check-review-gate.ts',
      'check-doc-coverage.ts',
      'check-doc-coverage-push.ts',
      'check-body-bare-digits.ts'
    ]
    for (const name of bins) {
      const src = readCode(name)
      const calls = src.match(/loadTrustAnchorConfig\(([^)]*)\)/g) ?? []
      expect(calls.length, `${name} should call loadTrustAnchorConfig exactly once`).toBe(1)
      expect(calls[0], `${name} must pass no argument — the fetcher param is test-only`).toBe('loadTrustAnchorConfig()')
      // The retired, PR-rewritable sources must not reappear for this purpose.
      expect(src, `${name} must not resolve principals from local git`).not.toContain('loadConfigFromRef')
      expect(src, `${name} must not resolve principals from the working tree`).not.toMatch(
        /resolvePrincipalAllowlist\(\s*loadConfig\(\)/
      )
    }
  })

  // Perf regression, PR #862 round 4: the waiver check is an eagerly
  // evaluated ARGUMENT to `evaluateC5(...)`, so without an early return every
  // local pre-commit/pre-push paid a real ~0.5s `gh api` round-trip for a
  // waiver that cannot possibly be active outside a PR.
  it('doc-coverage-push short-circuits on the waiver label BEFORE the network-bound trust-anchor read', () => {
    const src = readCode('check-doc-coverage-push.ts')
    const guardAt = src.indexOf('if (!labels.includes(WAIVER_LABEL)) return false')
    const fetchAt = src.indexOf('loadTrustAnchorConfig()')
    expect(guardAt, 'must guard on the waiver label before fetching').toBeGreaterThan(-1)
    expect(guardAt, 'label guard must come BEFORE the trust-anchor fetch').toBeLessThan(fetchAt)
  })

  // Perf regression, PR #169 round 1: `resolveReleaseActor(loadTrustAnchorConfig())`
  // was inlined as a direct argument to `isChangesetsReleasePr`, so JS's
  // eager argument evaluation ran the trust-anchor fetch on every ordinary
  // PR, not just release-branch ones — the exact anti-pattern the
  // doc-coverage-push test above already guards against.
  it('body-bare-digits short-circuits on the release branch BEFORE the network-bound trust-anchor read', () => {
    const src = readCode('check-body-bare-digits.ts')
    const guardAt = src.indexOf('pr.headRefName !== CHANGESET_RELEASE_BRANCH')
    const fetchAt = src.indexOf('loadTrustAnchorConfig()')
    expect(guardAt, 'must guard on the release branch before fetching').toBeGreaterThan(-1)
    expect(guardAt, 'branch guard must come BEFORE the trust-anchor fetch').toBeLessThan(fetchAt)
  })

  // doc-coverage resolves labels live via `gh` (task 4, atta-labs/attalabs#948
  // — the env-injected PR_LABELS/WAIVER_LABEL_ACTOR it used to read were never
  // set by any generated workflow), so its short-circuit is on PR_NUMBER
  // absence instead: no PR means no waiver can be active, and every
  // network-bound call — `fetchPrLabels`, `fetchWaiverLabelActor`,
  // `loadTrustAnchorConfig` — must sit after that guard.
  it('doc-coverage short-circuits on PR_NUMBER absence BEFORE any network-bound waiver read', () => {
    const src = readCode('check-doc-coverage.ts')
    const guardAt = src.indexOf('if (!prNumberStr) return false')
    const fetchLabelsAt = src.indexOf('fetchPrLabels(prNumber)')
    const fetchActorAt = src.indexOf('fetchWaiverLabelActor(prNumber, WAIVER_LABEL)')
    const trustAnchorAt = src.indexOf('loadTrustAnchorConfig()')
    expect(guardAt, 'must guard on PR_NUMBER before any network read').toBeGreaterThan(-1)
    expect(guardAt, 'PR_NUMBER guard must come BEFORE fetching labels').toBeLessThan(fetchLabelsAt)
    expect(guardAt, 'PR_NUMBER guard must come BEFORE fetching the waiver actor').toBeLessThan(fetchActorAt)
    expect(guardAt, 'PR_NUMBER guard must come BEFORE the trust-anchor fetch').toBeLessThan(trustAnchorAt)
  })

  // `PR_AUTHOR` is banned outright, not just discouraged: a `pull_request`-
  // triggered workflow runs the PR's OWN copy of its YAML, so any env var it
  // sets — however it's computed — can be replaced with a hardcoded literal
  // by the PR being evaluated. `review-gate.ts`'s own module comment
  // documents three real rounds closing this exact hole for `principals`;
  // `check-body-bare-digits.ts` reopened it once already (security review,
  // PR #165 round 2) by trusting this exact variable before switching to a
  // live `gh pr view` fetch. This is the mechanical guard that should have
  // caught that the first time — no check bin may read this variable, full
  // stop; an identity/author decision must be fetched live, every time.
  it('no check bin reads process.env.PR_AUTHOR — identity must be fetched live, never trusted from env', () => {
    const offenders = specs
      .map((s) => `${basename(s.run).replace(/\.(js|ts)$/, '')}.ts`)
      .filter((binName) => readCode(binName).includes('PR_AUTHOR'))
    expect(offenders).toEqual([])
  })
})
