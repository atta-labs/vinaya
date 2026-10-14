import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PLAN_ON_DISK_PATTERNS, rulesForGroup } from './prose-rules'
import { FORGE_NUMBER_PATTERN as FORGE_NUMBER_REGEXP } from './reader-resolvable-prose'

/**
 * The doctrine sweep, as a check instead of a habit.
 *
 * The retired patterns come from the shared rule module (`prose-rules.ts`)
 * and are evaluated here with the JavaScript regular expression engine; this
 * suite keeps only its own scopes and exemptions. The CheckSpec adapter
 * (`apps/cli/src/checks/bin/check-retired-vocabulary.ts`) reads the same
 * patterns. The product citation members
 * (`FORGE_NUMBER_PATTERN`/`LEGACY_SLUG_PATTERN`) are NOT copied there — those
 * ban a live, unexplained citation, not a retired concept, and are already
 * `reader-resolvable-prose.ts`'s own `checkUnresolvableReferences`. The
 * tranche-slug citation pattern (`TRANCHE_SLUG_VN_PATTERN`) used to be a
 * third member of this list, grepped here against a hand-picked list of
 * other packages' paths (`apps/cli/src`, `.github/workflows`, `.vinaya`, two
 * product READMEs); it no longer is. That citation ban — including its
 * extension to product code, not just doctrine — now lives entirely in
 * `reader-resolvable-prose.ts`'s `PRODUCT_SLUG_SCOPE`, proved by
 * `reader-resolvable-prose.test.ts`, so a change to one package's files can
 * no longer pass this package's cached test result at the push hook (a
 * CLI-only diff never marks `aeg-core` affected, so a rule about CLI files
 * living in an `aeg-core` test never ran on that push at all).
 *
 * Five review rounds each declared the decision-log claim swept, and each time
 * it resurfaced a few lines from where the previous pass fixed it — usually in
 * a more authoritative document than the last. That is the signature of a rule
 * enforced by attention rather than by a gate, which is the exact failure this
 * whole change exists to end. So: the rule gets a gate.
 *
 * A retired mechanism must not be described as live anywhere an agent reads.
 * `EXEMPT` is the honest, enumerated list of places a mention is legitimate —
 * frozen archives, historical records, and this file. Anything else is a
 * failure with the file and line printed.
 *
 * A second, related class joined this suite later: `RETIRED_IN_PRODUCT` also
 * bans a forge number cited bare in the doctrine `aeg-root/**`
 * publishes. It is not retired — it is the product's live vocabulary — but
 * citing one as an unexplained doctrine reference is exactly the residue the
 * ruling that ended the decision log already named: "a decision id, a
 * retired mechanism's vocabulary, an internal tranche slug — none of it
 * means anything to someone who was not here, and a tool meant to be adopted
 * cannot ship the residue of the monorepo it grew in." That ruling's
 * enforcement covered `D-###` and stopped; forge numbers and slugs survived
 * unwatched until this pattern (and the tranche-slug pattern below) closed
 * the gap. `FORGE_NUMBER_PATTERN` and `LEGACY_SLUG_PATTERN` are scoped to
 * `aeg-root` only via `PATTERN_SCOPE` — that directory is pure doctrine
 * prose, no test fixtures, so a blind grep there cannot mistake a legitimate
 * occurrence for a citation. The tranche-slug pattern once lived here too,
 * scoped wider than `aeg-root` to also reach product code
 * (`apps/cli/src`/`.github/workflows`/`.vinaya`/two READMEs) — that wider
 * reach, and the pattern itself, now belong entirely to
 * `reader-resolvable-prose.ts`'s `PRODUCT_SLUG_SCOPE`: this
 * suite grepping another package's files let a CLI-only push slip past the
 * rule, since the push hook's affected-test-suite run never touches
 * `aeg-core` for a CLI-only diff.
 *
 * A third failure mode, found by post-merge review, joined coverage to
 * vacuity: `[a-z][a-z-]+-v[0-9]` only sees a tranche slug that ends `-vN`.
 * Four of this repo's own archived tranches — `aeg-governance-hardening`,
 * `aeg-consolidation`, `aeg-studio-cleanup`, `herald-onto-engine` — predate
 * that suffix convention, and the shape-based pattern is structurally blind
 * to them; its self-guard sample happened to be drawn
 * from the class the pattern already covers, so it proved non-vacuity
 * without ever proving coverage. `LEGACY_SLUG_PATTERN` below closes that:
 * derived from `aeg-root/tranches/completed/*.md` filenames — the
 * authoritative list of what a real slug looks like — instead of a
 * hand-shaped regex guess, so it cannot drift from reality the way the
 * `-vN` guess did.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Legacy-style tranche slugs that predate the `-vN` naming convention.
 * `aeg-root/tranches/completed` — the archive these would normally be read
 * live from — is legitimately absent in this repo (task 4's ratified
 * boundary — attalabs' operational archive, not doctrine). This suite's
 * subject is whether `LEGACY_SLUG_PATTERN` catches the class the `-vN`
 * pattern is blind to, not this repo's own archive contents, so the corpus
 * is a committed fixture instead of a live directory read. Same fixture
 * `reader-resolvable-prose.test.ts` uses. Slugs the `-vN` pattern
 * (`reader-resolvable-prose.ts`'s `TRANCHE_SLUG_VN_PATTERN`) already sees are
 * excluded — no point banning the same string with two patterns.
 */
function legacySlugs(): string[] {
  return readFileSync(join(__dirname, '..', 'tests', 'fixtures', 'legacy-tranche-slugs.txt'), 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((slug) => !/-v[0-9]+$/.test(slug))
}

const MODULE_PATTERNS = rulesForGroup('retired-vocabulary').map((rule) => String(rule.patterns.repository))
const FORGE_NUMBER_PATTERN = FORGE_NUMBER_REGEXP.source
const LEGACY_SLUGS = legacySlugs()
// Empty only if every archived tranche ever adopts the `-vN` suffix — in
// which case there is nothing left for this pattern to catch, and it is
// dropped rather than shipped as a pattern with no positive sample.
const LEGACY_SLUG_PATTERN = LEGACY_SLUGS.length > 0 ? `(${LEGACY_SLUGS.join('|')})` : null

/** Claims that a removed mechanism is current. */
const RETIRED_IN_PRODUCT = [
  ...MODULE_PATTERNS.filter((pattern) => !PLAN_ON_DISK_PATTERNS.includes(pattern)),
  // A pull-request or Issue number cited as an unexplained parenthetical —
  // `#NNN` — inside the doctrine `aeg-root/**` publishes. It
  // resolves only inside this repo's own tracker; an adopter reading the
  // installed doc has no forge to look it up in. Scoped to `aeg-root` only
  // via `PATTERN_SCOPE` below, not the full `PRODUCT` surface: the same
  // digit shape is the live PR/Issue-number grammar the product's own code
  // parses everywhere else (`Closes #N`, golden fixtures, coherence
  // checks) — banning it repo-wide would flag the mechanism itself, not
  // the citation habit this class exists to stop.
  FORGE_NUMBER_PATTERN,
  // The same citation class, for the slugs that predate `-vN`. See the file
  // header for why this is a second pattern rather than a broader regex.
  ...(LEGACY_SLUG_PATTERN ? [LEGACY_SLUG_PATTERN] : [])
]

/**
 * Scopes a `RETIRED_IN_PRODUCT` pattern narrower than the full `PRODUCT`
 * surface. Unlike `D-###`/`decision log` — genuinely retired concepts that
 * appear nowhere live — a forge number is the product's own working
 * vocabulary: it appears legitimately in fixtures, tests, and source across
 * every `PRODUCT` path. What's banned is narrower than the string: citing
 * one as an unexplained doctrine reference.
 *
 * `FORGE_NUMBER_PATTERN` and `LEGACY_SLUG_PATTERN` scope to `aeg-root` only
 * — pure doctrine prose, no test fixtures live there, so a blind grep can't
 * mistake a legitimate occurrence for a citation. Both members here stay
 * aeg-root-only; neither needs the wider, product-code-reaching surface the
 * tranche-slug pattern used to carry in this map. See the module header for
 * where that pattern and its wider surface live now.
 */
const PATTERN_SCOPE: Record<string, string[]> = {
  [FORGE_NUMBER_PATTERN]: ['aeg-root'],
  // This repo's layout (task 2's graft): `apps/vinaya/cli` -> `apps/cli`,
  // `apps/vinaya/sources` -> `packages/sources`. The old product-umbrella
  // paths (a root `CLAUDE.md`, `apps/vinaya/CLAUDE.md`/`README.md`,
  // `apps/vinaya/specs`, and the whole `apps/vinaya/web` tree) do not exist
  // in this repo at all — there is no `apps/vinaya` umbrella folder, no
  // `CLAUDE.md` anywhere, and no web app — so they are dropped rather than
  // grep'd against a path that can never resolve here.
  //
  // TRANCHE_SLUG_VN_PATTERN is deliberately absent from this map: it is not
  // one of this suite's `RETIRED_IN_PRODUCT` members any more, and this
  // suite no longer greps `apps/cli/src`/`.github/workflows`/`.vinaya`/the
  // two product READMEs for it at all. `reader-resolvable-prose.ts`'s own
  // `PRODUCT_SLUG_SCOPE` now owns that exact surface, enforced through its
  // own check rather than through this package's grep of another package's
  // files — see the module header above.
  //
  // LEGACY_SLUG_PATTERN stays aeg-root-only, deliberately not widened the way
  // the VN pattern used to be: every slug it can ever match is, by
  // construction, already archived (derived from
  // aeg-root/tranches/completed/*.md) — citing a closed tranche is the safe
  // case (same durability class as a closed PR), not the live-citation
  // problem the (now-removed) widening existed to catch.
  ...(LEGACY_SLUG_PATTERN ? { [LEGACY_SLUG_PATTERN]: ['aeg-root'] } : {})
}

/**
 * Paths a single pattern may legitimately mention, on top of `EXEMPT`.
 *
 * Scoped per pattern rather than added to the global list: `file-classify.ts`
 * must name the archives to exclude them, and its tests must assert the real
 * paths (round 5 proved what happens when they assert a synthetic one). None of
 * that licenses those files to carry the rest of the retired vocabulary.
 */
const PATTERN_EXEMPT: Record<string, string[]> = {
  '\\bD-[0-9]{3}\\b': [
    // The one confirmed load-bearing exception (task-729 sweep, widening PRODUCT
    // to `['.']`): a foundational architectural fact (Cetana's retirement) whose
    // D-numbers resolve to the permanent archive — not a routine build-log
    // citation like the ~300 others the same sweep stripped.
    './CLAUDE.md'
  ],
  '(^|[^-_a-zA-Z0-9])decisions\\.md': [
    // `engine/design-decisions.md` is Vāda's own live, current design-decisions
    // doc — not the retired global `decisions.md`. The bare-substring pattern
    // can't distinguish the two; these are the citing files (task-729 sweep).
    'docs-index.md',
    'apps/vada-ai/specs/legacy/README.md',
    'apps/vada-ai/specs/vada-product-spec.md',
    'apps/vada-ai/web/CLAUDE.md',
    'apps/vada-ai/CLAUDE.md'
  ],
  'decisions-legacy': [
    'packages/aeg-core/src/file-classify.ts',
    'packages/aeg-core/src/file-classify.test.ts',
    'packages/aeg-core/src/pr-tier.test.ts',
    // Legitimate archive-index pointers ("see X for history"), not claims that
    // the frozen archive is a live/writable artifact (task-729 sweep).
    'docs-index.md',
    '.claude/skills/database/SKILL.md',
    '.claude/skills/vada-architecture/SKILL.md',
    'apps/vada-ai/specs/vada-byok-principles.md',
    'apps/vada-ai/web/CLAUDE.md',
    'apps/vada-ai/CLAUDE.md'
  ],
  CONTRADICTION: [
    // Vāda Reviewers' live "CONTRADICTIONS" output section — a real product
    // feature, coincidentally matching the retired decision-log's
    // "## CONTRADICTION — <topic>" entry-shape ban. Not a citation
    // (task-729 sweep).
    'apps/vada-ai/specs/vada-reviewers-spec.md'
  ]
  // No `[a-z][a-z-]+-v[0-9]` entry: that pattern is no longer a
  // `RETIRED_IN_PRODUCT` member (see the module header), so this map is
  // never consulted for it any more.
}

/**
 * The plan-on-disk layout the forge-native cutover retired — the tranche
 * topology file, the directory that held it, and the per-project state
 * directory. A plan is a Milestone plus labeled Issues now. Scoped to the
 * doctrine tree: product source still names the archive directory it reads
 * old ledgers from, which is a live code path, not a doctrine claim.
 *
 * The tranche model is exempt by file because one of its sections exists to
 * record that retirement; the suite below proves every mention it carries
 * sits inside that one section, so the file exemption cannot hide a live
 * claim anywhere else in it.
 */
const RETIRED_IN_DOCTRINE = [...PLAN_ON_DISK_PATTERNS]
const DOCTRINE_SCOPE = ['aeg-root']
const TRANCHE_MODEL = 'aeg-root/tranche-model.md'
const RETIREMENT_SECTION_HEADING = '## 4. The thin tranche file — retired, and what survives it'

/**
 * Where a mention is legitimate:
 *  - the frozen archive and per-product logs are records of what was decided
 *  - `tranches/completed/**` and retrospectives are history, never rewritten
 *  - the published-prose check must contain the tokens it exists to catch
 *  - this file names them in order to ban them
 */
const EXEMPT = [
  'docs/decisions-legacy.md',
  'apps/herald-ai/docs/',
  'apps/vada-ai/docs/',
  'aeg-root/tranches/completed/',
  'packages/aeg-core/src/docs/published-prose',
  'packages/aeg-core/src/retired-vocabulary.test.ts',
  // The task 7 CheckSpec adapter (see the module header above) — it
  // legitimately names every retired term as pattern data, the same
  // self-reference reason this file exempts itself, one line up.
  'packages/aeg-core/src/retired-vocabulary.ts',
  // The shared rule module holds every retired pattern as data.
  'packages/aeg-core/src/prose-rules.ts',
  'packages/aeg-core/src/prose-rules.test.ts',
  // The task 7 CheckSpec adapter bin, and its own pure-evaluator test —
  // same self-reference reason: both legitimately name every retired term
  // as pattern data or a matching sample.
  'apps/cli/src/checks/bin/check-retired-vocabulary.ts',
  'packages/aeg-core/src/retired-vocabulary-scan.test.ts',
  '/fixtures/',
  '/node_modules/',
  '/.next/',
  '/.turbo/'
]

/**
 * The scope `RETIRED_IN_PRODUCT` checks against.
 *
 * Repo-wide (`['.']`), not an enumerated adopter-surface list. It used to be
 * a 7-path array (`aeg-root`, `packages/aeg-core`, `packages/aeg-forge-state`,
 * `apps/vinaya`, `.vinaya`, and 2 of 22 `.claude/skills`) — but an enumerated
 * list has the exact blind-spot shape that let a `D-###` citation sit
 * unwatched in root `CLAUDE.md` and a dangling reference survive a real
 * manual citation-strip: a new package/app lands and nobody remembers to add
 * it here. `['.']` is self-maintaining — every current and future surface is
 * covered by construction. `SCOPE` below (for the separate `RETIRED`
 * pattern list) is unaffected by this change.
 */
const PRODUCT = ['.']

/**
 * Everything an agent in this repo reads.
 *
 * Repo-wide (`['.']`), not an enumerated list — same defect and same fix as
 * `PRODUCT` above: an enumerated surface has the exact blind-spot shape that
 * lets a new path go unwatched, and it drifted concretely here. The prior
 * 8-path list (`.aeg`, `aeg-root`, `.claude`, `.github`, `.vinaya`,
 * `packages/aeg-core`, `apps/vinaya`, `packages/aeg-forge-state`) named three
 * paths this repo doesn't have (`.aeg`, `.claude`, `apps/vinaya` — leftovers
 * from the attalabs layout this suite was copied from) and one tool's own
 * directory (`.claude`) that has no business in an agent-agnostic product's
 * test. GNU grep exits non-zero on a missing path, which `grep()` below reads
 * as a real failure — so every pattern using this scope failed outright on a
 * clean Linux checkout, while passing locally wherever a leftover directory
 * happened to still exist. `['.']` is self-maintaining and layout-agnostic:
 * every current and future surface is covered by construction, no path to
 * remember to add.
 */
const SCOPE = ['.']

/** Same extension/bare-name set the old `--include` flags encoded, read off `git ls-files` instead of a directory walk. */
const INCLUDE_EXTENSIONS = ['.md', '.ts', '.tsx', '.yml']
/** Both extensionless governance files: the doc-ownership manifest and the collision-domain list. An extension-only filter cannot see either. */
const INCLUDE_BARE_NAMES = new Set(['doc-owners', 'packages'])

/**
 * O11 — the files this sweep can possibly see are exactly the files `git`
 * tracks, scoped by `git ls-files -- <scope>` rather than a directory walk
 * behind a hand-maintained `--exclude-dir` list. A concurrent linked
 * worktree (`.worktrees/**`), a build output (`dist/`), or a vendored
 * dependency (`studio-standalone/_node_modules/`, confirmed absent from
 * `git ls-files` — never assumed) is out of scope by construction, because
 * none of them is ever a tracked file; no real source directory can be
 * skipped for merely sharing a name with one of those, because nothing here
 * names one. The extension/bare-name filter is unchanged from the old
 * `--include` flags, so the sweep's own surface does not silently widen.
 */
function trackedFiles(scope: string[]): string[] {
  let out: string
  try {
    out = execFileSync('git', ['ls-files', '--', ...scope], { cwd: REPO_ROOT, encoding: 'utf8' })
  } catch {
    return []
  }
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => INCLUDE_EXTENSIONS.some((ext) => f.endsWith(ext)) || INCLUDE_BARE_NAMES.has(f.split('/').pop() ?? f))
}

function grep(pattern: string, scope: string[] = SCOPE): string[] {
  const files = trackedFiles(scope)
  if (files.length === 0) return []
  const expression = new RegExp(pattern)
  const hits: string[] = []
  for (const file of files) {
    const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')
    for (let index = 0; index < lines.length; index++) {
      if (expression.test(lines[index] ?? '')) hits.push(`${file}:${index + 1}:${lines[index]}`)
      expression.lastIndex = 0
    }
  }
  return hits
}

/**
 * Does this pattern, run through the same `grep -E` the gate uses, actually
 * match the thing it exists to catch?
 *
 * A pattern that matches nothing passes every scope silently — which is not a
 * hypothetical: `\bD-(###|NNN)\b` shipped as green over eleven live sites
 * because `\b` cannot anchor after `#`. Every pattern is therefore proved
 * against a positive sample below, so the gate fails loud when a pattern is
 * broken rather than reporting a clean repo.
 */
function matches(pattern: string, sample: string): boolean {
  return new RegExp(pattern).test(sample)
}

describe('the product carries no trace of a history the adopter lacks', () => {
  for (const pattern of RETIRED_IN_PRODUCT) {
    it(`absent from the installed surfaces: ${pattern}`, () => {
      const exempt = [...EXEMPT, ...(PATTERN_EXEMPT[pattern] ?? [])]
      const hits = grep(pattern, PATTERN_SCOPE[pattern] ?? PRODUCT).filter((line) => {
        const path = line.slice(0, line.indexOf(':'))
        return !exempt.some((e) => path.includes(e))
      })
      expect(hits, `\n${hits.slice(0, 30).join('\n')}\n(${hits.length} total)\n`).toEqual([])
    })
  }
})

describe('the plan-on-disk layout stays retired in the doctrine', () => {
  for (const pattern of RETIRED_IN_DOCTRINE) {
    it(`no doctrine page but the tranche model names: ${pattern}`, () => {
      const hits = grep(pattern, DOCTRINE_SCOPE).filter((line) => {
        const path = line.slice(0, line.indexOf(':'))
        return path !== TRANCHE_MODEL && !EXEMPT.some((e) => path.includes(e))
      })
      expect(hits, `\n${hits.join('\n')}\n`).toEqual([])
    })
  }

  it('the tranche model names them only inside its retirement section', () => {
    const lines = readFileSync(join(REPO_ROOT, TRANCHE_MODEL), 'utf8').split('\n')
    const start = lines.indexOf(RETIREMENT_SECTION_HEADING)
    expect(start, 'the retirement section heading moved — update RETIREMENT_SECTION_HEADING').toBeGreaterThan(-1)
    const next = lines.findIndex((line, i) => i > start && line.startsWith('## '))
    const end = next === -1 ? lines.length : next
    const outside = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ n }) => n - 1 < start || n - 1 >= end)
      .filter(({ line }) => RETIRED_IN_DOCTRINE.some((pattern) => new RegExp(pattern).test(line)))
      .map(({ line, n }) => `${TRANCHE_MODEL}:${n}: ${line}`)
    expect(outside, `\n${outside.join('\n')}\n`).toEqual([])
    const inside = lines
      .slice(start, end)
      .filter((line) => RETIRED_IN_DOCTRINE.some((pattern) => new RegExp(pattern).test(line)))
    expect(inside.length, 'the retirement section no longer names what it retired').toBeGreaterThan(0)
  })
})

describe('the JavaScript matcher distinguishes no matches from an invalid pattern', () => {
  // The exact regression this task exists to prevent: a bare `catch { return
  // [] }` cannot tell grep's real "nothing found" (exit 1) apart from a
  // genuine failure (bad scope, ENOBUFS) — it silently reported both as a
  // clean repo. Pinned directly against `grep()`, not just observed as a
  // side effect of the pattern suites above passing.
  it('returns [] for a pattern with zero matches (exit 1) — the legitimate case', () => {
    expect(grep('ZZZ_NO_SUCH_STRING_EVER_MATCHES_ANYTHING_ZZZ', ['aeg-root'])).toEqual([])
  })

  it('rethrows for a malformed pattern (grep exits 2) — a real failure, not "no matches"', () => {
    expect(() => grep('[', ['aeg-root'])).toThrow()
  })
})

/**
 * A sample every pattern must match. Not a convenience — the gate's own
 * failure mode is a pattern that matches nothing and therefore passes.
 */
const SAMPLES: Record<string, string> = {
  '\\bD-[0-9]{3}\\b': 'see D-097 for the rule',
  'D-(###|NNN|nnn|xxx)': 'a Tier 3 change requiring a D-###',
  'decision log(s|ged|ging)?([^a-z]|$)': 'read the decision log first',
  'decision-log': 'a decision-log entry is required',
  'decision entr': 'add a decision entry',
  'decisions? (are |is )?logged': 'why decisions are logged',
  'log entries': 'Type 1 decisions without log entries',
  '(^|[^-_a-zA-Z0-9])decisions\\.md': 'log it to decisions.md',
  'decisions-legacy': 'a task updates docs/decisions-legacy.md',
  CONTRADICTION: 'open a ## CONTRADICTION — <topic> entry',
  'assumes Tier 3': 'verify-docs assumes Tier 3 when no tier is declared',
  'decision (entry|logged)': 'every Tier 3 change needs a decision entry',
  'decision-log entry': 'requires a decision-log entry',
  'decision log entry': 'requires a decision log entry',
  'Lock: ?YES': 'D-035 (`Lock: YES`)',
  'Lock: ?NO': 'a `Lock: NO` decision is just as committed',
  'lock approvals?': 'the Principal grants lock approval',
  'approves locks': 'the Principal approves locks',
  'Conforms to lock': 'Conforms to lock: yes',
  'Challenges lock': 'Challenges lock: no',
  checkDecisionNumbersFresh: 'checkDecisionNumbersFresh refuses the branch',
  'roles/team-leader\\.md': 'see roles/team-leader.md',
  'decision logic': 'NEGATIVE — all decision logic lives in the evaluator',
  [FORGE_NUMBER_PATTERN]: 'fixed the gap (task 3, #365)',
  // No TRANCHE_SLUG_VN_PATTERN sample: it is no longer a `RETIRED_IN_PRODUCT`
  // member (see the module header) — `reader-resolvable-prose.test.ts` proves
  // it now.
  // Drawn from the exact class the `-vN` pattern is blind to (the class
  // this pattern exists to cover) — not a slug the pattern above already
  // catches, so this proves coverage, not just non-vacuity.
  ...(LEGACY_SLUG_PATTERN ? { [LEGACY_SLUG_PATTERN]: `shipped during ${LEGACY_SLUGS[0]}` } : {}),
  // The strip-wreckage shapes, each written as the artifact itself.
  '\\(,': 'a rationale block (, point-of-power principle) shipped once',
  ',\\)': 'the seam contract (planner-brief contract,) named here',
  '\\(\\.\\)': 'forces every agent back for the rules. (.)',
  '[Tt]opology files?': 'the Planner edits the thin topology file at plan time',
  'aeg-root/tranches/': 'every active tranche file sits in aeg-root/tranches/',
  'aeg-project/': 'append the retrospective to aeg-project/lessons.md'
}

describe('the gate can see what it bans', () => {
  for (const pattern of [...RETIRED_IN_PRODUCT, ...RETIRED_IN_DOCTRINE]) {
    it(`matches a real instance: ${pattern}`, () => {
      const sample = SAMPLES[pattern]
      expect(sample, `no sample for pattern ${pattern} — add one`).toBeDefined()
      expect(matches(pattern, sample as string), `pattern never matches its own sample: ${pattern}`).toBe(true)
    })
  }

  it('`decision log` does not match `decision logic` — ordinary English stays legal', () => {
    expect(matches('decision log(s|ged|ging)?([^a-z]|$)', 'all decision logic lives in the evaluator')).toBe(false)
  })

  it('the placeholder pattern matches every form, including the one a word boundary breaks', () => {
    for (const form of ['D-###', 'D-NNN', 'D-nnn', 'D-xxx']) {
      expect(matches('D-(###|NNN|nnn|xxx)', `cites ${form} here`), `missed ${form}`).toBe(true)
    }
    // The exact regression: a trailing `\b` cannot anchor after `#`.
    expect(matches(String.raw`\bD-(###|NNN)\b`, 'cites D-### here')).toBe(false)
  })
})
