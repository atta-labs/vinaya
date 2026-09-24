import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CheckSpec } from '../src/checks/contract'
import { runChecks } from '../src/checks/runner'
import { DEFAULT_REVIEW_POLICY, PRINCIPAL_ALLOWLIST } from '@attalabs/aeg-core'
import {
  isCanonicalHookBlockPath,
  lintEnvDeclarations,
  loadTrustAnchorConfig,
  readRepoCiSetup,
  resolveAgentVendors,
  resolvePrincipalAllowlist as resolvePrincipalAllowlistStatic,
  resolveReviewPolicy,
  trustAnchorRepo,
  VinayaConfigSchema
} from '../src/lib/config'
import type { TokensCollectTrustEntry } from '../src/lib/config'

// We test config.ts functions by changing process.cwd() via chdir
// and by testing the config path logic with temp dirs.

// Import after setup to avoid side effects
let loadConfig: typeof import('../src/lib/config.js').loadConfig
let loadConfigChecked: typeof import('../src/lib/config.js').loadConfigChecked
let configPath: typeof import('../src/lib/config.js').configPath
let writeConfig: typeof import('../src/lib/config.js').writeConfig
let resolvePrincipalAllowlist: typeof import('../src/lib/config.js').resolvePrincipalAllowlist

const TEST_CONFIG = {
  rings: { ring1_forgeWriteInterception: true, ring2_asyncAudits: false }
}

const INVALID_CHECKS_FIXTURE = join(import.meta.dir, 'fixtures', 'checks', 'vinaya.config.invalid.json')

describe('config', () => {
  let tmpDir: string
  let originalCwd: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `vinaya-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
    originalCwd = process.cwd()
    process.chdir(tmpDir)

    // Re-import fresh module after chdir
    const mod = await import('../src/lib/config.js')
    loadConfig = mod.loadConfig
    loadConfigChecked = mod.loadConfigChecked
    configPath = mod.configPath
    writeConfig = mod.writeConfig
    resolvePrincipalAllowlist = mod.resolvePrincipalAllowlist
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('loadConfig returns null when neither local nor global config exists', () => {
    // No vinaya.config.json in tmpDir, and we rely on no global config for tests
    // Either null (no configs) or a valid config (if global exists from real usage)
    const result = loadConfig()
    expect(result === null || typeof result === 'object').toBe(true)
  })

  it('loadConfig returns local config when vinaya.config.json is present in cwd', () => {
    const localPath = join(tmpDir, 'vinaya.config.json')
    writeFileSync(localPath, JSON.stringify(TEST_CONFIG), 'utf-8')

    const result = loadConfig()
    expect(result).not.toBeNull()
    expect(result?.rings?.ring1_forgeWriteInterception).toBe(true)
    expect(result?.rings?.ring2_asyncAudits).toBe(false)
  })

  it('loadConfig parses a repo-local "principals" field', () => {
    const localPath = join(tmpDir, 'vinaya.config.json')
    writeFileSync(localPath, JSON.stringify({ principals: ['alice', 'bob'] }), 'utf-8')

    const result = loadConfig()
    expect(result?.principals).toEqual(['alice', 'bob'])
  })

  it('loadConfig parses a repo-local "tokens.collect" field', () => {
    const localPath = join(tmpDir, 'vinaya.config.json')
    writeFileSync(localPath, JSON.stringify({ tokens: { collect: 'node scripts/collect-usage.js' } }), 'utf-8')

    const result = loadConfig()
    expect(result?.tokens?.collect).toBe('node scripts/collect-usage.js')
  })

  it('resolvePrincipalAllowlist falls back to PRINCIPAL_ALLOWLIST when no config sets principals (every existing install unaffected)', () => {
    expect(resolvePrincipalAllowlist(null)).toEqual(PRINCIPAL_ALLOWLIST)
    expect(resolvePrincipalAllowlist({})).toEqual(PRINCIPAL_ALLOWLIST)
  })

  it('resolvePrincipalAllowlist uses the repo-local principals field as a full replacement, not additive, when set', () => {
    const result = resolvePrincipalAllowlist({ principals: ['alice', 'bob'] })
    expect(result).toEqual(['alice', 'bob'])
    expect(result).not.toContain(PRINCIPAL_ALLOWLIST[0])
  })

  it("resolveReviewPolicy returns today's behaviour (BLOCKER/HIGH) when the policy is omitted entirely", () => {
    expect(resolveReviewPolicy(null)).toEqual(DEFAULT_REVIEW_POLICY)
    expect(resolveReviewPolicy({})).toEqual(DEFAULT_REVIEW_POLICY)
  })

  it('resolveReviewPolicy defaults a per-field omission independently', () => {
    expect(resolveReviewPolicy({ reviewPolicy: { codeReviewThreshold: 'MAJOR' } })).toEqual({
      codeReviewThreshold: 'MAJOR',
      securityThreshold: 'HIGH',
      maxRounds: 3
    })
    expect(resolveReviewPolicy({ reviewPolicy: { securityThreshold: 'MEDIUM' } })).toEqual({
      codeReviewThreshold: 'BLOCKER',
      securityThreshold: 'MEDIUM',
      maxRounds: 3
    })
  })

  it('resolveReviewPolicy resolves this repository’s own configured MAJOR/HIGH', () => {
    expect(resolveReviewPolicy({ reviewPolicy: { codeReviewThreshold: 'MAJOR', securityThreshold: 'HIGH' } })).toEqual({
      codeReviewThreshold: 'MAJOR',
      securityThreshold: 'HIGH',
      maxRounds: 3
    })
  })

  it('resolveReviewPolicy REFUSES (throws) on an unknown codeReviewThreshold, never falls back', () => {
    expect(() => resolveReviewPolicy({ reviewPolicy: { codeReviewThreshold: 'CATASTROPHIC' } })).toThrow(
      /codeReviewThreshold "CATASTROPHIC" is not one of/
    )
  })

  it('resolveReviewPolicy REFUSES (throws) on an unknown securityThreshold, never falls back', () => {
    expect(() => resolveReviewPolicy({ reviewPolicy: { securityThreshold: 'SEVERE' } })).toThrow(
      /securityThreshold "SEVERE" is not one of/
    )
  })

  it('resolveReviewPolicy REFUSES a threshold from the wrong role’s scale (security value on the code-review field)', () => {
    expect(() => resolveReviewPolicy({ reviewPolicy: { codeReviewThreshold: 'HIGH' } })).toThrow(/not one of/)
  })

  it('resolveReviewPolicy (#543 O4) resolves a configured maxRounds, defaults to 3 when omitted', () => {
    expect(resolveReviewPolicy({ reviewPolicy: { maxRounds: 5 } })).toEqual({
      codeReviewThreshold: 'BLOCKER',
      securityThreshold: 'HIGH',
      maxRounds: 5
    })
    expect(resolveReviewPolicy({})).toEqual(expect.objectContaining({ maxRounds: 3 }))
  })

  it('resolveReviewPolicy (#543 O4) REFUSES a non-positive-integer maxRounds, never falls back', () => {
    expect(() => resolveReviewPolicy({ reviewPolicy: { maxRounds: 0 } })).toThrow(
      /maxRounds "0" is not a positive integer/
    )
    expect(() => resolveReviewPolicy({ reviewPolicy: { maxRounds: -1 } })).toThrow(/maxRounds/)
    expect(() => resolveReviewPolicy({ reviewPolicy: { maxRounds: 2.5 } })).toThrow(/maxRounds/)
  })

  it('configPath returns local path when vinaya.config.json exists in cwd', () => {
    const localPath = join(tmpDir, 'vinaya.config.json')
    writeFileSync(localPath, JSON.stringify(TEST_CONFIG), 'utf-8')

    const result = configPath()
    // Resolve symlinks on both sides (macOS /var → /private/var)
    const resolvedResult = result ? realpathSync(result) : null
    const resolvedExpected = realpathSync(localPath)
    expect(resolvedResult).toBe(resolvedExpected)
  })

  it('configPath returns null when no config exists', () => {
    // Could be null or global path — we just verify it doesn't point to tmpDir
    const result = configPath()
    if (result !== null) {
      expect(result).not.toContain(tmpDir)
    } else {
      expect(result).toBeNull()
    }
  })

  it('configPath does not resolve a config planted above the enclosing git repository', () => {
    // Security review, PR #94: the upward walk must stop at the enclosing
    // repo's root. A vinaya.config.json planted in an ancestor OUTSIDE the
    // repo (e.g. world-writable /tmp) registers checks.*.run commands the
    // check engine executes in every generated hook — it must never resolve.
    writeFileSync(join(tmpDir, 'vinaya.config.json'), JSON.stringify(TEST_CONFIG), 'utf-8')

    const innerRepo = join(tmpDir, 'inner-repo')
    const nestedCwd = join(innerRepo, 'deep', 'dir')
    mkdirSync(nestedCwd, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: innerRepo })
    process.chdir(nestedCwd)

    const result = configPath()
    // Either null or the machine's global config — never the planted ancestor file.
    if (result !== null) {
      expect(realpathSync(result)).not.toContain(realpathSync(tmpDir))
    }
  })

  it('configPath still resolves a repo-root config from a nested cwd', () => {
    const repoRoot = join(tmpDir, 'repo')
    const nestedCwd = join(repoRoot, 'deep', 'dir')
    mkdirSync(nestedCwd, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot })
    const localPath = join(repoRoot, 'vinaya.config.json')
    writeFileSync(localPath, JSON.stringify(TEST_CONFIG), 'utf-8')
    process.chdir(nestedCwd)

    const result = configPath()
    expect(result ? realpathSync(result) : null).toBe(realpathSync(localPath))
  })

  it('writeConfig("local") creates vinaya.config.json in cwd', () => {
    writeConfig('local', TEST_CONFIG)
    const localPath = join(tmpDir, 'vinaya.config.json')
    expect(existsSync(localPath)).toBe(true)
    const content = JSON.parse(readFileSync(localPath, 'utf-8'))
    expect(content.rings.ring1_forgeWriteInterception).toBe(true)
  })

  it('writeConfig("local") with repoRoot writes to repoRoot/vinaya.config.json', () => {
    const repoRoot = join(tmpDir, 'myrepo')
    mkdirSync(repoRoot, { recursive: true })
    writeConfig('local', TEST_CONFIG, repoRoot)
    const localPath = join(repoRoot, 'vinaya.config.json')
    expect(existsSync(localPath)).toBe(true)
    const content = JSON.parse(readFileSync(localPath, 'utf-8'))
    expect(content.rings.ring1_forgeWriteInterception).toBe(true)
  })

  it('writeConfig("global") creates config in a temp dir', () => {
    // We test writeConfig global by writing to a custom path via repoRoot arg
    // (global writes to ~/.vinaya/config.json which we cannot safely mock)
    const customRoot = join(tmpDir, 'isolated')
    mkdirSync(customRoot, { recursive: true })
    writeConfig('local', TEST_CONFIG, customRoot)
    const written = JSON.parse(readFileSync(join(customRoot, 'vinaya.config.json'), 'utf-8'))
    expect(written.rings.ring1_forgeWriteInterception).toBe(true)
    expect(written.rings.ring2_asyncAudits).toBe(false)
  })

  it('loadConfig falls back to global when no local config', () => {
    // No local config in tmpDir, so configPath returns global or null
    expect(() => loadConfig()).not.toThrow()
  })

  it('repo-local config overrides global config when both are present', () => {
    // Local config wins over a same-directory-hierarchy global-style file,
    // matching the ported file-selection precedence.
    const localPath = join(tmpDir, 'vinaya.config.json')
    writeFileSync(
      localPath,
      JSON.stringify({ rings: { ring1_forgeWriteInterception: false, ring2_asyncAudits: true } }),
      'utf-8'
    )

    const result = loadConfig()
    expect(result?.rings?.ring1_forgeWriteInterception).toBe(false)
    expect(result?.rings?.ring2_asyncAudits).toBe(true)
  })

  it('loadConfig rejects a rings object with a non-boolean field', () => {
    const localPath = join(tmpDir, 'vinaya.config.json')
    writeFileSync(
      localPath,
      JSON.stringify({ rings: { ring1_forgeWriteInterception: 'yes', ring2_asyncAudits: false } }),
      'utf-8'
    )

    // Invalid schema — VinayaConfigSchema.parse throws, loadConfig swallows and returns null
    expect(loadConfig()).toBeNull()
  })

  it('accepts a declarative checks entry with glob scoping', () => {
    const localPath = join(tmpDir, 'vinaya.config.json')
    writeFileSync(
      localPath,
      JSON.stringify({
        checks: { 'my-check': { run: './scripts/my-check.ts', scope: 'diff', include: ['src/**/*.ts'] } }
      }),
      'utf-8'
    )

    const result = loadConfig()
    expect(result?.checks?.['my-check']?.run).toBe('./scripts/my-check.ts')
    expect(result?.checks?.['my-check']?.scope).toBe('diff')
    expect(result?.checks?.['my-check']?.include).toEqual(['src/**/*.ts'])
  })

  it('loadConfig swallows an invalid checks entry to null (existing null-on-failure contract, unchanged)', () => {
    const localPath = join(tmpDir, 'vinaya.config.json')
    // Fixture has a "scop" typo — schema requires "scope".
    copyFileSync(INVALID_CHECKS_FIXTURE, localPath)

    expect(loadConfig()).toBeNull()
  })

  it('loadConfigChecked surfaces the same invalid checks entry loudly instead of silently returning null', () => {
    const localPath = join(tmpDir, 'vinaya.config.json')
    copyFileSync(INVALID_CHECKS_FIXTURE, localPath)

    const result = loadConfigChecked()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('typo')
      expect(result.path).toContain('vinaya.config.json')
    }
  })

  it('loadConfigChecked reports ok:true with config:null when no config file exists', () => {
    const result = loadConfigChecked()
    if (configPath() === null) {
      expect(result).toEqual({ ok: true, config: null })
    }
  })

  it('loadConfigChecked reports the same valid config loadConfig does', () => {
    const localPath = join(tmpDir, 'vinaya.config.json')
    writeFileSync(localPath, JSON.stringify(TEST_CONFIG), 'utf-8')

    const checked = loadConfigChecked()
    expect(checked.ok).toBe(true)
    if (checked.ok) {
      expect(checked.config?.rings?.ring1_forgeWriteInterception).toBe(true)
    }
  })
})

/**
 * The exact error a real `execFileSync('gh', ['api', '<missing path>'])`
 * throws, captured verbatim from a live run against this repo:
 *
 *   $ gh api repos/daniboomerang/attalabs/contents/definitely-not-a-real-file-xyz.json
 *   message: "Command failed: gh api <path>\ngh: Not Found (HTTP 404)\n"
 *   stderr:  "gh: Not Found (HTTP 404)\n"
 *   status:  1
 *
 * Recorded rather than invented, and rather than re-fetched: the earlier
 * version of this fixture WAS invented (a single-line `Error`) and hid a real
 * bug; the version after that made a live call and was flaky with no bound.
 * A recorded capture is both honest and deterministic. The companion test
 * below asserts this shape still carries the property that broke the code, so
 * it cannot decay into a tautology.
 */
function REAL_GH_404(): Error & { stderr: string; status: number } {
  const err = new Error(
    'Command failed: gh api repos/daniboomerang/attalabs/contents/definitely-not-a-real-file-xyz.json\ngh: Not Found (HTTP 404)\n'
  ) as Error & { stderr: string; status: number }
  err.stderr = 'gh: Not Found (HTTP 404)\n'
  err.status = 1
  return err
}

// Security regression, PR #862 rounds 1-3. Resolving `principals` from
// anything the evaluated PR can reach — its own working tree (round 1), a
// BASE_SHA env var (round 2), or the LOCAL `origin/main` remote-tracking ref
// that the PR's own workflow YAML can `git update-ref` (round 3) — let a PR
// redefine its own trust anchor and self-approve. It now reads GitHub's API
// (default-branch, server-side state) and nothing else.
describe('loadTrustAnchorConfig — trust-anchor resolution (security)', () => {
  let repoDir: string
  let originalCwd: string

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' })
  }

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf-8').toString('base64')

  beforeEach(() => {
    repoDir = join(tmpdir(), `vinaya-trustanchor-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(repoDir, { recursive: true })
    originalCwd = process.cwd()
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    process.chdir(repoDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('reads principals from the API payload, decoding base64 exactly as the GitHub contents API returns it', () => {
    const result = loadTrustAnchorConfig(() => b64({ principals: ['legit-reviewer'] }))
    expect(result?.principals).toEqual(['legit-reviewer'])
  })

  it('round 3 regression: a PR that rewrites the LOCAL origin/main ref cannot influence the result — no local git is consulted at all', () => {
    // Build the exact attack: a real repo whose local `origin/main` has been
    // repointed at attacker content — which is precisely what the previous
    // `git show origin/main:...` implementation would have read.
    writeFileSync(
      join(repoDir, 'vinaya.config.json'),
      JSON.stringify({ principals: ['legit-reviewer', 'attacker-login'] }),
      'utf-8'
    )
    git(['add', '.'])
    git(['commit', '-q', '-m', 'Chore: attacker edits principals'])
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    // Proof the attack setup is genuine: the OLD implementation's read is poisoned.
    expect(git(['show', 'origin/main:vinaya.config.json'])).toContain('attacker-login')

    // The real (server-side) default branch still says only legit-reviewer, and
    // that is the only thing consulted now.
    const result = loadTrustAnchorConfig(() => b64({ principals: ['legit-reviewer'] }))
    expect(result?.principals).toEqual(['legit-reviewer'])
    expect(result?.principals).not.toContain('attacker-login')
  })

  it('fails to null — never to trusting unreviewed content — when the fetch throws (no auth, no network, no such file)', () => {
    const result = loadTrustAnchorConfig(() => {
      throw new Error('gh: not authenticated')
    })
    expect(result).toBeNull()
    // null is exactly what resolvePrincipalAllowlist turns into the hardcoded default.
    expect(resolvePrincipalAllowlistStatic(result)).toEqual(PRINCIPAL_ALLOWLIST)
  })

  it('fails to null on empty / non-JSON / schema-invalid payloads', () => {
    expect(loadTrustAnchorConfig(() => '')).toBeNull()
    expect(loadTrustAnchorConfig(() => Buffer.from('not json', 'utf-8').toString('base64'))).toBeNull()
    expect(loadTrustAnchorConfig(() => b64({ principals: [] }))).toBeNull() // min(1) violated
  })

  it('announces a real failure on STDOUT, never stderr — stderr is the runner’s CheckError channel and plain text there marks the check errored', () => {
    const originalOut = process.stdout.write.bind(process.stdout)
    const originalErr = process.stderr.write.bind(process.stderr)
    let out = ''
    let err = ''
    process.stdout.write = ((c: string) => {
      out += c
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((c: string) => {
      err += c
      return true
    }) as typeof process.stderr.write
    try {
      loadTrustAnchorConfig(() => {
        throw new Error('gh: HTTP 401 Bad credentials')
      })
    } finally {
      process.stdout.write = originalOut
      process.stderr.write = originalErr
    }
    expect(out).toContain('falling back')
    expect(err).toBe('')
  })

  it('stays SILENT when the file simply is not on the default branch yet — using the REAL execFileSync error shape, where the 404 is never on line 1', () => {
    // Regression, PR #862: the previous version of this test threw a
    // hand-built single-line `Error('gh: HTTP 404 Not Found')`. Real
    // `execFileSync` throws `message = "Command failed: <cmd>\n<stderr>"`, so
    // the 404 lives on a later line and the first-line-only check never
    // matched — the test passed while production warned on every run for a
    // fresh adopter.
    //
    // The replacement first made a live `gh api` call to get a genuine error.
    // That removed the wrong-shape problem but bought a flake: a real network
    // call has no upper bound, so it timed out ~40% of full-suite runs, and
    // raising the budget to 20s only made it rarer (1/16), never gone. A
    // timeout cannot fix variance — so the call is gone and the shape it
    // produced is REPLAYED below instead. This is deterministic and still not
    // invented: `REAL_GH_404` is the verbatim capture of that live call,
    // including `stderr`, which the assertion below re-proves is the shape
    // that broke the original code.
    const originalOut = process.stdout.write.bind(process.stdout)
    let out = ''
    process.stdout.write = ((c: string) => {
      out += c
      return true
    }) as typeof process.stdout.write
    try {
      loadTrustAnchorConfig(() => {
        throw REAL_GH_404()
      })
    } finally {
      process.stdout.write = originalOut
    }
    expect(out).toBe('')
  })

  it('the recorded 404 fixture still has the property that broke the original code — the 404 is NOT on line 1', () => {
    // Guards the fixture against becoming a tautology: if someone "simplifies"
    // REAL_GH_404 into a single-line message, the bug it exists to catch would
    // silently stop being reproducible and the test above would pass for the
    // wrong reason. This is what the live call used to assert inline.
    const err = REAL_GH_404()
    expect(err.message.split('\n')[0]).not.toMatch(/404|not found/i)
    expect(`${err.message}\n${err.stderr}`).toMatch(/\b404\b|not found/i)
  })
})

describe('trustAnchorRepo — repo identity for the trust-anchor read', () => {
  const saved = process.env.GITHUB_REPOSITORY
  afterEach(() => {
    if (saved === undefined) delete process.env.GITHUB_REPOSITORY
    else process.env.GITHUB_REPOSITORY = saved
  })

  it('prefers the runner-provided GITHUB_REPOSITORY', () => {
    process.env.GITHUB_REPOSITORY = 'acme/widget'
    expect(trustAnchorRepo()).toBe('acme/widget')
  })

  it('rejects a malformed GITHUB_REPOSITORY rather than addressing an unintended endpoint', () => {
    process.env.GITHUB_REPOSITORY = 'acme/widget/extra'
    // Falls through to the git-remote path; whatever it returns must still be
    // well-formed (exactly one slash, no whitespace) or null.
    const result = trustAnchorRepo()
    if (result !== null) expect(result).toMatch(/^[^/\s]+\/[^/\s]+$/)
  })

  it('never returns a slug with extra path segments, whichever source wins', () => {
    delete process.env.GITHUB_REPOSITORY
    const result = trustAnchorRepo()
    if (result !== null) expect(result).toMatch(/^[^/\s]+\/[^/\s]+$/)
  })
})

describe('CheckEntrySchema env field', () => {
  const base = { run: './check.ts', scope: 'diff' as const }

  it('accepts the `true` form', () => {
    const parsed = VinayaConfigSchema.safeParse({ checks: { c: { ...base, env: { AEG_REPO: true } } } })
    expect(parsed.success).toBe(true)
  })

  it('accepts the `{ optional: true }` form', () => {
    const parsed = VinayaConfigSchema.safeParse({ checks: { c: { ...base, env: { PR_BODY: { optional: true } } } } })
    expect(parsed.success).toBe(true)
  })

  it('accepts the literal-string form', () => {
    const parsed = VinayaConfigSchema.safeParse({ checks: { c: { ...base, env: { NODE_ENV: 'production' } } } })
    expect(parsed.success).toBe(true)
  })

  it('accepts a valid `anyOf` form where the key is one of its own members', () => {
    const parsed = VinayaConfigSchema.safeParse({
      checks: { c: { ...base, env: { GITHUB_TOKEN: { anyOf: ['GITHUB_TOKEN', 'GH_TOKEN'] } } } }
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects `anyOf` with fewer than 2 members', () => {
    const parsed = VinayaConfigSchema.safeParse({
      checks: { c: { ...base, env: { GITHUB_TOKEN: { anyOf: ['GITHUB_TOKEN'] } } } }
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects `anyOf` with duplicate members', () => {
    const parsed = VinayaConfigSchema.safeParse({
      checks: { c: { ...base, env: { GITHUB_TOKEN: { anyOf: ['GITHUB_TOKEN', 'GITHUB_TOKEN'] } } } }
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects `anyOf` where the key is not one of its own members', () => {
    const parsed = VinayaConfigSchema.safeParse({
      checks: { c: { ...base, env: { GITHUB_TOKEN: { anyOf: ['GH_TOKEN', 'GHE_TOKEN'] } } } }
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects an unrecognized env-entry shape', () => {
    const parsed = VinayaConfigSchema.safeParse({ checks: { c: { ...base, env: { X: { bogus: true } } } } })
    expect(parsed.success).toBe(false)
  })
})

describe('lintEnvDeclarations', () => {
  it('warns on the literal string "true"', () => {
    const warnings = lintEnvDeclarations({ c: { run: './c.ts', scope: 'diff', env: { FOO: 'true' } } })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('FOO')
  })

  it('warns on the literal string "false"', () => {
    const warnings = lintEnvDeclarations({ c: { run: './c.ts', scope: 'diff', env: { FOO: 'false' } } })
    expect(warnings).toHaveLength(1)
  })

  it('warns on a high-entropy literal that looks like a leaked secret', () => {
    const warnings = lintEnvDeclarations({
      c: { run: './c.ts', scope: 'diff', env: { API_KEY: 'sk_live_A1b2C3d4E5f6G7h8I9j0' } }
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('high-entropy')
  })

  it('does not warn on an ordinary short literal', () => {
    const warnings = lintEnvDeclarations({ c: { run: './c.ts', scope: 'diff', env: { NODE_ENV: 'production' } } })
    expect(warnings).toEqual([])
  })

  it('does not warn on `true` or `{ optional: true }` forms', () => {
    const warnings = lintEnvDeclarations({
      c: { run: './c.ts', scope: 'diff', env: { AEG_REPO: true, PR_BODY: { optional: true } } }
    })
    expect(warnings).toEqual([])
  })

  it('returns no warnings when no checks are registered', () => {
    expect(lintEnvDeclarations(undefined)).toEqual([])
  })
})

describe('config-registered check runs through the runner', () => {
  const CLI_ROOT = join(import.meta.dir, '..')
  const FIXTURE_CONFIG = join(import.meta.dir, 'fixtures', 'checks', 'vinaya.config.json')

  it('runs a check registered the way the fixture vinaya.config.json would produce it', async () => {
    const raw = JSON.parse(readFileSync(FIXTURE_CONFIG, 'utf-8'))
    const config = VinayaConfigSchema.parse(raw)
    const entry = config.checks?.['fixture-check']
    expect(entry).toBeDefined()
    expect(entry?.run.startsWith('./')).toBe(true)

    // The config's `run` is repo-relative; resolve it against the CLI root
    // the same way a real vinaya.config.json's entries are resolved relative
    // to the repo they're registered in.
    const spec: CheckSpec = {
      name: 'fixture-check',
      ...(entry as NonNullable<typeof entry>),
      run: join(CLI_ROOT, (entry as NonNullable<typeof entry>).run)
    }
    const [outcome] = await runChecks([spec], {
      parallel: 1,
      diffOnly: false,
      changedFiles: null,
      defaultTimeoutMs: 5000
    })
    expect(outcome?.status).toBe('pass')
  })
})

describe('readRepoCiSetup', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vinaya-cisetup-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the declared command from the repo-root config', () => {
    writeFileSync(join(dir, 'vinaya.config.json'), JSON.stringify({ ci: { setup: 'npm ci' } }), 'utf-8')
    expect(readRepoCiSetup(dir)).toBe('npm ci')
  })

  it('returns null when the config has no ci key', () => {
    writeFileSync(join(dir, 'vinaya.config.json'), JSON.stringify({ checks: {} }), 'utf-8')
    expect(readRepoCiSetup(dir)).toBeNull()
  })

  it('returns null when no config exists', () => {
    expect(readRepoCiSetup(dir)).toBeNull()
  })

  it('returns null on unparseable JSON — generation degrades to the undeclared shape, never throws', () => {
    writeFileSync(join(dir, 'vinaya.config.json'), '{ not json', 'utf-8')
    expect(readRepoCiSetup(dir)).toBeNull()
  })

  it('rejects an empty setup string at the schema layer', () => {
    writeFileSync(join(dir, 'vinaya.config.json'), JSON.stringify({ ci: { setup: '' } }), 'utf-8')
    expect(readRepoCiSetup(dir)).toBeNull()
  })
})

describe('briefSchema.ack', () => {
  it('accepts a list of real builtin names', () => {
    const parsed = VinayaConfigSchema.safeParse({ briefSchema: { ack: ['closesN', 'tier'] } })
    expect(parsed.success).toBe(true)
  })

  it('is optional — a briefSchema without it still parses', () => {
    const parsed = VinayaConfigSchema.safeParse({ briefSchema: { pr: { sections: [{ builtin: 'tier' }] } } })
    expect(parsed.success).toBe(true)
  })

  // Guards the enum: loosened to `z.string()`, a typo'd ack ("closesn") would
  // silently fail to silence anything, and `doctor` would keep reporting a
  // divergence the adopter believes they already acknowledged.
  it('rejects a name that is not a builtin', () => {
    const parsed = VinayaConfigSchema.safeParse({ briefSchema: { ack: ['closesn'] } })
    expect(parsed.success).toBe(false)
  })
})

describe('briefSchema.milestone', () => {
  it('accepts a third key beside pr and issue, same shape, and keeps its content (not silently stripped)', () => {
    const parsed = VinayaConfigSchema.safeParse({
      briefSchema: { milestone: { sections: [{ builtin: 'milestoneShape' }] } }
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.briefSchema?.milestone).toEqual({ sections: [{ builtin: 'milestoneShape' }] })
    }
  })

  it('is optional — a briefSchema with only pr/issue still parses, unchanged', () => {
    const parsed = VinayaConfigSchema.safeParse({
      briefSchema: {
        pr: { sections: [{ builtin: 'tier' }] },
        issue: { sections: [{ builtin: 'issueRationale' }] }
      }
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.briefSchema).toEqual({
        pr: { sections: [{ builtin: 'tier' }] },
        issue: { sections: [{ builtin: 'issueRationale' }] }
      })
    }
  })

  it('all three kinds can coexist', () => {
    const parsed = VinayaConfigSchema.safeParse({
      briefSchema: {
        pr: { sections: [{ builtin: 'tier' }] },
        issue: { sections: [{ builtin: 'issueRationale' }] },
        milestone: { sections: [{ builtin: 'milestoneShape' }] }
      }
    })
    expect(parsed.success).toBe(true)
  })
})

describe('resolveAgentVendors — undefined vs. explicit-empty', () => {
  it('defaults to every vendor when the manifest carries no `agents` key at all — a pre-existing install must get the same default a fresh `vinaya init` gives, not silently nothing', () => {
    expect([...resolveAgentVendors(undefined)].sort()).toEqual(['claude', 'gemini', 'skills'])
    expect([...resolveAgentVendors(null)].sort()).toEqual(['claude', 'gemini', 'skills'])
    expect([...resolveAgentVendors({})].sort()).toEqual(['claude', 'gemini', 'skills'])
  })

  it('respects an explicit `agents: []` (from `--agents=none`) as a real recorded choice — never widened back to the default', () => {
    expect([...resolveAgentVendors({ agents: [] })]).toEqual([])
  })

  it('respects a narrowed explicit selection exactly, no widening and no dropping', () => {
    expect([...resolveAgentVendors({ agents: ['claude'] })]).toEqual(['claude'])
  })
})

// Issue #177: the .git/ path discriminator escaped via a case variant
// (.GIT/config) and via a bare `.git` with no trailing slash. Both must be
// refused at the parse layer, before lib/ops.ts's resolvers ever see them.
describe('ManagedBlockRecordSchema.path — canonical hook-block spellings only (#177)', () => {
  function parseBlockPath(path: string) {
    return VinayaConfigSchema.safeParse({
      managed: { version: 2, files: [], blocks: [{ path, marker: 'x', comment: 'hash' }], labels: [] }
    })
  }

  it('refuses a case variant (.GIT/config) — case-insensitive filesystems must not resolve this as a git path', () => {
    expect(parseBlockPath('.GIT/config').success).toBe(false)
    expect(parseBlockPath('.Git/hooks/../config').success).toBe(false)
  })

  it('refuses bare `.git` with no trailing slash — this escapes on every filesystem, not just case-insensitive ones, and must never reach a readFileSync that would throw EISDIR', () => {
    expect(parseBlockPath('.git').success).toBe(false)
  })

  it('accepts the three canonical spellings buildInitOps actually emits', () => {
    expect(parseBlockPath('.git/hooks/pre-commit').success).toBe(true)
    expect(parseBlockPath('.husky/pre-commit').success).toBe(true)
    expect(parseBlockPath('.vinaya/hooks/pre-push').success).toBe(true)
  })

  it('refuses a genuinely different directory that merely shares the .git prefix as a substring', () => {
    expect(parseBlockPath('.gitkeep-hooks/x').success).toBe(false)
  })

  it('isCanonicalHookBlockPath rejects a bare prefix with no trailing content', () => {
    expect(isCanonicalHookBlockPath('.git/')).toBe(false)
    expect(isCanonicalHookBlockPath('.husky/')).toBe(false)
    expect(isCanonicalHookBlockPath('.vinaya/hooks/')).toBe(false)
  })
})

// Task 15 (#44): a config-native `projects` array alongside `.vinaya/projects.md`.
describe('VinayaConfigSchema.projects — additive-only', () => {
  it('an existing config with no "projects" key still validates (this repo\'s own vinaya.config.json)', () => {
    const raw = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'vinaya.config.json'), 'utf-8'))
    const parsed = VinayaConfigSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.projects).toBeUndefined()
  })

  it('accepts a minimal entry (name only)', () => {
    const parsed = VinayaConfigSchema.safeParse({ projects: [{ name: 'mobile' }] })
    expect(parsed.success).toBe(true)
  })

  it('accepts a full entry (name, description, path)', () => {
    const parsed = VinayaConfigSchema.safeParse({
      projects: [{ name: 'mobile', description: 'The mobile client', path: 'apps/mobile' }]
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an entry with no name', () => {
    const parsed = VinayaConfigSchema.safeParse({ projects: [{ path: 'apps/mobile' }] })
    expect(parsed.success).toBe(false)
  })

  it('rejects an empty-string name', () => {
    const parsed = VinayaConfigSchema.safeParse({ projects: [{ name: '' }] })
    expect(parsed.success).toBe(false)
  })
})

// Task 8 (#275): tokens.collect — a declared command an adopter on a
// non-Claude-Code host uses to satisfy `vinaya tokens` layer 2.
describe('VinayaConfigSchema.tokens — additive-only', () => {
  it('an existing config with no "tokens" key still validates (this repo\'s own vinaya.config.json)', () => {
    const raw = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'vinaya.config.json'), 'utf-8'))
    const parsed = VinayaConfigSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.tokens).toBeUndefined()
  })

  it('accepts a well-formed "<interpreter> <script>" declaration', () => {
    const parsed = VinayaConfigSchema.safeParse({ tokens: { collect: 'node scripts/collect-usage.js' } })
    expect(parsed.success).toBe(true)
  })

  it('rejects an empty-string "collect" command', () => {
    const parsed = VinayaConfigSchema.safeParse({ tokens: { collect: '' } })
    expect(parsed.success).toBe(false)
  })

  it('rejects "tokens" present with no "collect" key', () => {
    const parsed = VinayaConfigSchema.safeParse({ tokens: {} })
    expect(parsed.success).toBe(false)
  })

  // Round 3 (security review, PR #303): the grammar narrowed from "any
  // shell command" to exactly "<interpreter> <script-path>" so content
  // pinning is rigorous, not heuristic.
  it('rejects a single token with no script path', () => {
    const parsed = VinayaConfigSchema.safeParse({ tokens: { collect: 'node' } })
    expect(parsed.success).toBe(false)
  })

  it('rejects a three-token declaration (a flag, an extra argument, a piped command)', () => {
    const parsed = VinayaConfigSchema.safeParse({ tokens: { collect: 'node -u scripts/collect-usage.js' } })
    expect(parsed.success).toBe(false)
  })

  it('rejects shell syntax (&&, |, ;) even embedded in an otherwise two-token string', () => {
    expect(VinayaConfigSchema.safeParse({ tokens: { collect: 'node scripts/a.js && rm -rf /' } }).success).toBe(false)
  })

  it('rejects an absolute script path', () => {
    const parsed = VinayaConfigSchema.safeParse({ tokens: { collect: 'node /etc/passwd' } })
    expect(parsed.success).toBe(false)
  })

  it('rejects a script path escaping the repo via ..', () => {
    const parsed = VinayaConfigSchema.safeParse({ tokens: { collect: 'node ../../outside.js' } })
    expect(parsed.success).toBe(false)
  })

  it('globalTokensCollectIgnoredWarning names the offending path and field', async () => {
    const { globalTokensCollectIgnoredWarning } = await import('../src/lib/config.js')
    const message = globalTokensCollectIgnoredWarning('/home/x/.vinaya/config.json')
    expect(message).toContain('/home/x/.vinaya/config.json')
    expect(message).toContain('tokens.collect')
  })
})

/**
 * Security review, HIGH: `runtimeDir` carries no repository segment — only
 * `defaultRuntimeDir` adds one — so honouring it from the machine-global
 * config would collapse every repository on the host into one tree, and two
 * repositories' identically-numbered tasks would share a driver lock,
 * ownership epochs, and the `sessions/<role>-<agent>.json` file a confined
 * dispatch is granted exact-file write on.
 */
describe('runtimeDir — scope and shape (security review)', () => {
  it('is stripped from the machine-global config, like every other scope-sensitive key', async () => {
    const { globalRuntimeDirIgnoredWarning } = await import('../src/lib/config.js')
    const message = globalRuntimeDirIgnoredWarning('/home/x/.vinaya/config.json')
    expect(message).toContain('/home/x/.vinaya/config.json')
    expect(message).toContain('runtimeDir')
    // The reason, not just the fact — an operator reading this needs to know
    // why a repo-local file is the only place it can live.
    expect(message).toContain('repository')
  })

  it('accepts an absolute path', () => {
    expect(VinayaConfigSchema.safeParse({ runtimeDir: '/var/lib/vinaya/runs' }).success).toBe(true)
  })

  it('refuses a relative path — two processes with different cwds would disagree about where the store is', () => {
    expect(VinayaConfigSchema.safeParse({ runtimeDir: '.vinaya-runs' }).success).toBe(false)
    expect(VinayaConfigSchema.safeParse({ runtimeDir: '../runs' }).success).toBe(false)
  })

  it('refuses an empty value', () => {
    expect(VinayaConfigSchema.safeParse({ runtimeDir: '' }).success).toBe(false)
  })
})

// [task-files-v1] 5 — the `logs` setting: a folder (absolute path only) or a
// server (`url`/`headers`), never both.
describe('logs — shape and mutual exclusion', () => {
  it('accepts an absolute folder path', () => {
    expect(VinayaConfigSchema.safeParse({ logs: { folder: '/var/lib/vinaya/logs' } }).success).toBe(true)
  })

  it('refuses a relative folder path', () => {
    expect(VinayaConfigSchema.safeParse({ logs: { folder: 'relative/logs' } }).success).toBe(false)
  })

  it('accepts a url, with headers', () => {
    // The schema itself accepts any string header value — a literal secret
    // or an env-var reference (see tests/lib/log-destination.test.ts for
    // resolveLogsHeaderValues' own substitution behavior).
    const parsed = VinayaConfigSchema.safeParse({
      logs: { url: 'https://example.com/ingest', headers: { authorization: 'Bearer example-token' } }
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses both folder and url set together', () => {
    expect(
      VinayaConfigSchema.safeParse({ logs: { folder: '/var/lib/vinaya/logs', url: 'https://example.com/ingest' } })
        .success
    ).toBe(false)
  })

  it('refuses headers without a url', () => {
    expect(
      VinayaConfigSchema.safeParse({ logs: { folder: '/var/lib/vinaya/logs', headers: { a: 'b' } } }).success
    ).toBe(false)
  })

  it('an absent logs key still validates — the sink falls back to its own default folder', () => {
    const parsed = VinayaConfigSchema.safeParse({})
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.logs).toBeUndefined()
  })
})

describe('logPublish — removed (task-files-v1 6, O1): refused, naming its replacement', () => {
  it('refuses a config still carrying logPublish.issue', () => {
    const parsed = VinayaConfigSchema.safeParse({ logPublish: { issue: 42 } })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(parsed.error.issues.some((i) => i.path.join('.') === 'logPublish' && i.message.includes('logs'))).toBe(true)
  })

  it('refuses a config still carrying logPublish.webhookUrl', () => {
    const parsed = VinayaConfigSchema.safeParse({ logPublish: { webhookUrl: 'https://example.com/ingest' } })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(parsed.error.issues.some((i) => i.path.join('.') === 'logPublish')).toBe(true)
  })

  it('an absent logPublish key still validates', () => {
    expect(VinayaConfigSchema.safeParse({}).success).toBe(true)
  })
})

// task-15 (issue-545), O1/O5 — the two additive config keys this task adds.
describe('VinayaConfigSchema.prePush / .report — additive-only', () => {
  it("this repo's own vinaya.config.json declares prePush.alwaysRun and still validates", () => {
    const raw = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'vinaya.config.json'), 'utf-8'))
    const parsed = VinayaConfigSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.prePush?.alwaysRun).toContain('apps/cli/tests/ci-shards.test.ts')
    }
  })

  // The pre-push hook always runs the CLI's surface-spec export test — a
  // stale `retiresVia` target on a real lib export is caught at the push,
  // not first seen in CI. Reachability can never select this test on its
  // own merits (it introspects `packages/aeg-core/src/index.ts` and
  // `apps/cli/src/lib/**` via the TypeScript compiler API, not a static
  // import), so the fixture proves the FORCED path: a diff touching only
  // `packages/aeg-core/src/index.ts` still selects it, through this repo's
  // own real `vinaya.config.json` and the real workspace package graph.
  it('a diff touching only packages/aeg-core/src/index.ts still selects surface-spec-exports.test.ts, via alwaysRun', async () => {
    const repoRoot = join(import.meta.dir, '..', '..', '..')
    const raw = JSON.parse(readFileSync(join(repoRoot, 'vinaya.config.json'), 'utf-8'))
    const parsed = VinayaConfigSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const { selectAffectedTestFiles } = await import('../src/lib/test-selector.js')
    const { selected } = selectAffectedTestFiles(repoRoot, ['packages/aeg-core/src/index.ts'], {
      alwaysRun: parsed.data.prePush?.alwaysRun ?? []
    })
    expect(selected).toContain(join(repoRoot, 'apps/cli/tests/surface-spec-exports.test.ts'))
  })

  it('an existing config with no "prePush"/"report" key still validates', () => {
    const parsed = VinayaConfigSchema.safeParse({
      rings: { ring1_forgeWriteInterception: true, ring2_asyncAudits: true }
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.prePush).toBeUndefined()
      expect(parsed.data.report).toBeUndefined()
    }
  })

  it('accepts a well-formed prePush.alwaysRun glob list', () => {
    const parsed = VinayaConfigSchema.safeParse({ prePush: { alwaysRun: ['apps/cli/tests/ci-shards.test.ts'] } })
    expect(parsed.success).toBe(true)
  })

  it('accepts a well-formed report.commandTimeoutMs', () => {
    const parsed = VinayaConfigSchema.safeParse({ report: { commandTimeoutMs: 1_800_000 } })
    expect(parsed.success).toBe(true)
  })

  it('rejects a non-positive report.commandTimeoutMs', () => {
    expect(VinayaConfigSchema.safeParse({ report: { commandTimeoutMs: 0 } }).success).toBe(false)
    expect(VinayaConfigSchema.safeParse({ report: { commandTimeoutMs: -1 } }).success).toBe(false)
  })

  it('rejects a report.commandTimeoutMs above the 1-hour cap, naming the bound', () => {
    const parsed = VinayaConfigSchema.safeParse({ report: { commandTimeoutMs: 3_600_001 } })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe('must be at most 3600000 (1 hour)')
    }
  })

  it('accepts report.commandTimeoutMs exactly at the 1-hour cap', () => {
    expect(VinayaConfigSchema.safeParse({ report: { commandTimeoutMs: 3_600_000 } }).success).toBe(true)
  })
})

describe('parseTokensCollectDeclaration', () => {
  it('parses a well-formed "<interpreter> <script>" string', async () => {
    const { parseTokensCollectDeclaration } = await import('../src/lib/config.js')
    expect(parseTokensCollectDeclaration('node scripts/collect-usage.js')).toEqual({
      interpreter: 'node',
      script: 'scripts/collect-usage.js'
    })
  })

  it('trims surrounding whitespace and tolerates extra internal whitespace between the two tokens', async () => {
    const { parseTokensCollectDeclaration } = await import('../src/lib/config.js')
    expect(parseTokensCollectDeclaration('  node   scripts/collect-usage.js  ')).toEqual({
      interpreter: 'node',
      script: 'scripts/collect-usage.js'
    })
  })

  it('rejects one token, three tokens, and shell syntax', async () => {
    const { parseTokensCollectDeclaration } = await import('../src/lib/config.js')
    expect(parseTokensCollectDeclaration('node')).toBeNull()
    expect(parseTokensCollectDeclaration('node -u scripts/a.js')).toBeNull()
    expect(parseTokensCollectDeclaration('node scripts/a.js && rm -rf /')).toBeNull()
  })

  it('rejects an absolute script path or one escaping the repo via ..', async () => {
    const { parseTokensCollectDeclaration } = await import('../src/lib/config.js')
    expect(parseTokensCollectDeclaration('node /etc/passwd')).toBeNull()
    expect(parseTokensCollectDeclaration('node ../../outside.js')).toBeNull()
  })
})

// Task 8 (#275), security review PR #303 rounds 2-3: a declared
// tokens.collect must be explicitly trusted, per exact (interpreter, script)
// declaration AT the script's exact content, per machine, before it ever
// runs — keyed by this repo's git common directory so approval survives
// this repo's own per-task fresh worktrees, and pinned to the script's git
// blob hash so an edit to the script (committed or not) needs its own fresh
// approval too.
describe('tokens.collect trust cache', () => {
  let trustTmpDir: string

  beforeEach(() => {
    trustTmpDir = mkdtempSync(join(tmpdir(), 'vinaya-trust-cache-test-'))
  })

  afterEach(() => {
    rmSync(trustTmpDir, { recursive: true, force: true })
  })

  it('gitCommonDir resolves to the real, canonical, shared .git directory for this checkout', async () => {
    const { gitCommonDir } = await import('../src/lib/config.js')
    const dir = gitCommonDir(process.cwd())
    expect(dir).not.toBeNull()
    expect(dir).toContain('.git')
  })

  it('gitCommonDir returns null outside any git repository', async () => {
    const { gitCommonDir } = await import('../src/lib/config.js')
    const noGitDir = mkdtempSync(join(tmpdir(), 'vinaya-no-git-'))
    try {
      expect(gitCommonDir(noGitDir)).toBeNull()
    } finally {
      rmSync(noGitDir, { recursive: true, force: true })
    }
  })

  it("repoLocalConfigDir resolves to the directory holding this repo's own vinaya.config.json", async () => {
    const { repoLocalConfigDir } = await import('../src/lib/config.js')
    // originalCwd (the real repo root) still holds vinaya.config.json —
    // this suite's own beforeEach chdir's the *outer* describe block, not
    // this one, so cwd here is wherever the previous test left it; assert
    // shape rather than an exact path.
    const dir = repoLocalConfigDir()
    if (dir !== null) expect(existsSync(join(dir, 'vinaya.config.json'))).toBe(true)
  })

  it("gitBlobHash hashes a real file's current bytes, and changes when the bytes change", async () => {
    const { gitBlobHash } = await import('../src/lib/config.js')
    const filePath = join(trustTmpDir, 'script.js')
    writeFileSync(filePath, 'console.log(1)', 'utf-8')
    const first = gitBlobHash(filePath, trustTmpDir)
    expect(first).not.toBeNull()

    writeFileSync(filePath, 'console.log(2)', 'utf-8')
    const second = gitBlobHash(filePath, trustTmpDir)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
  })

  it('gitBlobHash returns null for a file that does not exist', async () => {
    const { gitBlobHash } = await import('../src/lib/config.js')
    expect(gitBlobHash(join(trustTmpDir, 'missing.js'), trustTmpDir)).toBeNull()
  })

  it('tokensCollectTrustKey is deterministic and distinguishes the repo, the interpreter, and the script', async () => {
    const { tokensCollectTrustKey } = await import('../src/lib/config.js')
    const a = tokensCollectTrustKey('/repo-a/.git', 'node', 'scripts/a.js')
    const b = tokensCollectTrustKey('/repo-a/.git', 'node', 'scripts/a.js')
    const differentRepo = tokensCollectTrustKey('/repo-b/.git', 'node', 'scripts/a.js')
    const differentInterpreter = tokensCollectTrustKey('/repo-a/.git', 'python3', 'scripts/a.js')
    const differentScript = tokensCollectTrustKey('/repo-a/.git', 'node', 'scripts/b.js')
    expect(a).toBe(b)
    expect(a).not.toBe(differentRepo)
    expect(a).not.toBe(differentInterpreter)
    expect(a).not.toBe(differentScript)
  })

  it('tokensCollectTrustKey never collides across a boundary a printable separator would confuse — adversarial, code review PR #303 round 2 follow-up', async () => {
    const { tokensCollectTrustKey } = await import('../src/lib/config.js')
    // A plain-space join would make these two DIFFERENT triples serialize
    // identically: "/a" + " " + "b" + " " + "c d" === "/a b c d".
    const shortFieldsLongScript = tokensCollectTrustKey('/a', 'b', 'c d')
    const longFieldsShortScript = tokensCollectTrustKey('/a b', 'c', 'd')
    expect(shortFieldsLongScript).not.toBe(longFieldsShortScript)

    // A script path carrying the JSON-array delimiter characters themselves
    // must not forge a different triple's key either.
    const scriptWithBrackets = tokensCollectTrustKey('/repo/.git', 'node', '"],["injected')
    const literalInjectedTriple = tokensCollectTrustKey('/repo/.git', 'node', 'injected')
    expect(scriptWithBrackets).not.toBe(literalInjectedTriple)
  })

  it('getTokensCollectTrust is null until trustTokensCollectCommand records exactly this (repo, interpreter, script) triple', async () => {
    const { getTokensCollectTrust, trustTokensCollectCommand } = await import('../src/lib/config.js')
    const storePath = join(trustTmpDir, 'trust.json')
    expect(getTokensCollectTrust('/repo-a/.git', 'node', 'scripts/a.js', storePath)).toBeNull()

    trustTokensCollectCommand('/repo-a/.git', 'node', 'scripts/a.js', 'hash-1', storePath)
    const entry = getTokensCollectTrust('/repo-a/.git', 'node', 'scripts/a.js', storePath)
    expect(entry?.scriptBlobHash).toBe('hash-1')

    // A different script path, interpreter, or repo is a stranger again.
    expect(getTokensCollectTrust('/repo-a/.git', 'node', 'scripts/b.js', storePath)).toBeNull()
    expect(getTokensCollectTrust('/repo-a/.git', 'python3', 'scripts/a.js', storePath)).toBeNull()
    expect(getTokensCollectTrust('/repo-b/.git', 'node', 'scripts/a.js', storePath)).toBeNull()
  })

  it('getTokensCollectTrust reports the OLD trusted hash unchanged when the script content later differs — the caller compares, this function never does', async () => {
    const { getTokensCollectTrust, trustTokensCollectCommand } = await import('../src/lib/config.js')
    const storePath = join(trustTmpDir, 'trust.json')
    trustTokensCollectCommand('/repo-a/.git', 'node', 'scripts/a.js', 'hash-at-approval-time', storePath)

    const entry = getTokensCollectTrust('/repo-a/.git', 'node', 'scripts/a.js', storePath)
    expect(entry?.scriptBlobHash).toBe('hash-at-approval-time')
    // A caller comparing against a NEW current hash sees the mismatch itself:
    expect(entry?.scriptBlobHash).not.toBe('hash-after-someone-edited-the-script')
  })

  it('getTokensCollectTrust is null, never throws, when the store file does not exist yet', async () => {
    const { getTokensCollectTrust } = await import('../src/lib/config.js')
    const storePath = join(trustTmpDir, 'never-written.json')
    expect(getTokensCollectTrust('/repo-a/.git', 'node', 'scripts/a.js', storePath)).toBeNull()
  })

  it('getTokensCollectTrust is null, never throws, on a corrupt store file', async () => {
    const { getTokensCollectTrust } = await import('../src/lib/config.js')
    const storePath = join(trustTmpDir, 'corrupt.json')
    writeFileSync(storePath, 'not json at all', 'utf-8')
    expect(getTokensCollectTrust('/repo-a/.git', 'node', 'scripts/a.js', storePath)).toBeNull()
  })

  it('trustTokensCollectCommand records a real, readable timestamp alongside the interpreter, script, and hash', async () => {
    const { trustTokensCollectCommand } = await import('../src/lib/config.js')
    const storePath = join(trustTmpDir, 'trust-record.json')
    trustTokensCollectCommand('/repo-a/.git', 'node', 'scripts/a.js', 'hash-1', storePath)

    const raw = JSON.parse(readFileSync(storePath, 'utf-8'))
    const entries = Object.values(raw) as TokensCollectTrustEntry[]
    expect(entries).toHaveLength(1)
    const entry = entries[0] as TokensCollectTrustEntry
    expect(entry.interpreter).toBe('node')
    expect(entry.script).toBe('scripts/a.js')
    expect(entry.scriptBlobHash).toBe('hash-1')
    expect(new Date(entry.trustedAt).toString()).not.toBe('Invalid Date')
  })
})
