import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { declarationsIn, findCollisions } from './symbol-collisions'

/**
 * Every source file under `dir`, recursively, as `[relative, absolute]`.
 * Recursive because a nested directory is precisely how a file escapes a flat
 * `readdirSync` while the gate goes on reporting green. `.mts`/`.cts` for the
 * same reason.
 */
function sourceFiles(dir: string, prefix = ''): [string, string][] {
  const out: [string, string][] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const abs = join(dir, entry.name)
    // `isDirectory()` is false for a symlinked directory, so one would be
    // dropped silently. Reported as a hard failure instead of skipped: a
    // silent skip is the fail-open this gate exists to prevent.
    if (entry.isSymbolicLink()) throw new Error(`symlink in source tree, cannot enumerate honestly: ${rel}`)
    if (entry.isDirectory()) {
      out.push(...sourceFiles(abs, rel))
      continue
    }
    if (!/\.(ts|mts|cts)$/.test(entry.name) || /\.test\.(ts|mts|cts)$/.test(entry.name)) continue
    out.push([rel, abs])
  }
  return out
}

/**
 * Every non-test source file this package ships, both directories: `src/`
 * (this file's own directory) and the sibling `bin/` — every published CI
 * enforcement binary, and until now entirely unscanned. `bin/` entries are
 * prefixed so a name collision report can tell the two directories apart;
 * `src/` keeps its bare relative path, matching every existing baseline entry.
 */
function packageSourceFiles(): [string, string][] {
  const srcDir = fileURLToPath(new URL('.', import.meta.url))
  const binDir = join(srcDir, '..', 'bin')
  return [...sourceFiles(srcDir), ...sourceFiles(binDir, 'bin')]
}

/** Every collision in this package, from the recursive scan — shared by the live case above and the gate below. */
function packageCollisions() {
  return findCollisions(packageSourceFiles().flatMap(([rel, abs]) => declarationsIn(rel, readFileSync(abs, 'utf8'))))
}

describe('symbol-collision detection', () => {
  it('finds a name declared in two files', () => {
    const decls = [
      ...declarationsIn('a.ts', 'function stripBackticks(s) {}'),
      ...declarationsIn('b.ts', 'function stripBackticks(s) {}')
    ]
    expect(findCollisions(decls)).toEqual([{ name: 'stripBackticks', files: ['a.ts', 'b.ts'], anyExported: false }])
  })

  it('does not report a name declared twice in ONE file', () => {
    expect(findCollisions(declarationsIn('a.ts', 'function f() {}\nfunction f() {}'))).toEqual([])
  })

  it('records whether any of the colliding declarations is exported', () => {
    const decls = [...declarationsIn('a.ts', 'export function f() {}'), ...declarationsIn('b.ts', 'function f() {}')]
    expect(findCollisions(decls)[0]?.anyExported).toBe(true)
  })

  it('reads the declaration forms this codebase actually uses', () => {
    const src =
      'export const A = 1\nfunction b() {}\nexport async function c() {}\ntype D = string\ninterface E {}\nclass F {}'
    expect(declarationsIn('x.ts', src).map((d) => d.name)).toEqual(['A', 'b', 'c', 'D', 'E', 'F'])
  })

  it('reads the declaration forms a wider grammar allows', () => {
    const src = [
      'export default function d() {}',
      'export async function* g() {}',
      'var v = 1',
      'enum E {}',
      'export const enum CE {}',
      'declare const dc: number',
      'export abstract class AC {}'
    ].join('\n')
    expect(declarationsIn('x.ts', src).map((d) => d.name)).toEqual(['d', 'g', 'v', 'E', 'CE', 'dc', 'AC'])
  })

  // `export const enum E` must yield `E`, not the keyword `enum` — the bare
  // `const` alternative would otherwise win and capture the next word.
  it('does not report a keyword as a symbol name', () => {
    const names = declarationsIn('x.ts', 'export const enum E {}').map((d) => d.name)
    expect(names).not.toContain('enum')
  })

  it('ignores indented declarations — only top level', () => {
    expect(declarationsIn('x.ts', '  const inner = 1').map((d) => d.name)).toEqual([])
  })

  it('sorts files and collisions, so a report does not reorder between runs', () => {
    const decls = [
      ...declarationsIn('z.ts', 'function b() {}\nfunction a() {}'),
      ...declarationsIn('a.ts', 'function b() {}\nfunction a() {}')
    ]
    const got = findCollisions(decls)
    expect(got.map((c) => c.name)).toEqual(['a', 'b'])
    expect(got[0]?.files).toEqual(['a.ts', 'z.ts'])
  })

  /**
   * The live case this exists for. `parse-registry.ts` and `registry-parse.ts`
   * are transpositions of each other, and a THIRD copy sits in
   * `parse-tranche.ts` — so "the registry's backtick stripper" names nothing
   * resolvable by eye, and a grep-based check of a claim about it returns a
   * confident answer about whichever copy it happened to land on.
   *
   * Asserting the exact file set keeps the detector honest against the real
   * tree rather than a fixture. If this list changes, that is signal — a fourth
   * copy appeared, or one was consolidated away — not maintenance noise.
   */
  it('detects the real stripBackticks collision in this package', () => {
    const hit = packageCollisions().find((c) => c.name === 'stripBackticks')
    expect(hit?.files).toEqual(['parse-registry.ts', 'parse-tranche.ts', 'registry-parse.ts'])
  })
})

/**
 * The gate, as opposed to the unit tests above: a NEW name declared in two
 * files of this package fails here.
 *
 * Baselined rather than emptied. Each entry below is either a confirmed
 * byte-identical harmless duplicate, or a real hazard needing a behaviour-
 * affecting consolidation that does not belong in the same change as the
 * detector. `bin/` joined the scan and surfaced everything from
 * `AssociatedPr` through `shJson` below — every one individually diffed, not
 * bulk-accepted:
 *
 *   - `AssociatedPr`   — `check-direct-main-push.ts`'s `{ number, merged_at }`
 *                        vs `archive-task.ts`'s `{ number }` only. Different
 *                        shape, unfixed.
 *   - `BodyResult`     — `{ body, source }`, byte-identical in `open-issue.ts`
 *                        and `open-pr.ts`. Harmless.
 *   - `BodySource`     — byte-identical union type, same two files. Harmless.
 *   - `createLabel`    — `check-direct-main-push.ts` shells out through an
 *                        execFileSync-array-shaped local `sh`; `dead-branch-
 *                        audit.ts` through a shell-string-shaped local `sh`.
 *                        Different call shape, unfixed.
 *   - `ensureLabelExists` — three-way. `check-direct-main-push.ts`'s wrapper
 *                        takes `(owner, repo)`; `dead-branch-audit.ts`'s takes
 *                        one `{ owner, repo }`; both wrap the real shared
 *                        4-arg `ensureLabelExists` in `src/ensure-label.ts`,
 *                        imported under an alias — so the alias's own name
 *                        collides with two locally-named shadows of itself.
 *   - `extractTitle`   — byte-identical in `open-issue.ts`/`open-pr.ts`. Harmless.
 *   - `fail`           — same shape in `open-issue.ts`/`open-pr.ts`, differs
 *                        only in the literal script-name prefix each message
 *                        carries (`[open-issue]` vs `[open-pr]`). Unfixed as a
 *                        byte difference, though the divergence is intentional.
 *   - `fetchOtherOpenPrFiles` — same body; `open-pr.ts` accepts
 *                        `number | null`, `verify-single-plan-pr.ts` requires
 *                        `number`. Signature differs, unfixed.
 *   - `ghReachable`    — byte-identical in `check-first-push-dispatch.ts`/
 *                        `verify-registry.ts`. Harmless.
 *   - `isEmDashOrDash` — two copies, byte-identical; harmless, listed for
 *                        completeness so the set is exhaustive.
 *   - `isSpecFile`     — the export in `file-classify.ts` excludes frozen
 *                        archives (`!isFrozenArchive(p)`); the private shadow in
 *                        `reader-resolvable-prose.ts` does not. Same name, two
 *                        different definitions of "spec file".
 *   - `LABEL`          — different label values per script
 *                        (`direct-main-push` vs `dead-branch-push`). Unfixed.
 *   - `LABEL_DESCRIPTION` — different description strings per script. Unfixed.
 *   - `listLabelNames` — same intent, different `sh` backend and error
 *                        handling (throws vs `?? []` on a parse failure).
 *                        Unfixed.
 *   - `locateBody`     — byte-identical in `open-issue.ts`/`open-pr.ts`. Harmless.
 *   - `main`           — nine standalone bin entrypoints. Each `main()` is
 *                        genuinely different code with a different signature
 *                        (`void`, `Promise<void>`, some take `prNumber` or
 *                        `argv`/`deps`) — a real collision by the letter of
 *                        the rule, but each is called only from its own
 *                        file's own `import.meta.main`-style guard, never
 *                        referenced elsewhere. Unfixed, not renamed away.
 *   - `MARKER`         — the derivation `` `<!-- ${LABEL} -->` `` is
 *                        byte-identical text in both files; the VALUE it
 *                        produces differs only because `LABEL` (above)
 *                        differs. The declaration itself is harmless.
 *   - `parseArgs`      — completely different flag sets: `--sample`/`--json`
 *                        in `eval-agent-compliance.ts` vs `--phase`/`--role`/
 *                        `--model`/`--transcript` in `report-tokens.ts`.
 *                        Unfixed.
 *   - `ParsedArgs`     — the companion type to `parseArgs` above; same divergence.
 *   - `PrListEntry`    — three-way, three different field sets across
 *                        `check-push-target.ts` (`{ number, state }`),
 *                        `dead-branch-audit.ts` (adds `mergedAt`/`closedAt`),
 *                        and `verify-dispatch.ts` (adds `headRefName`/`mergedAt`,
 *                        no `closedAt`). Unfixed.
 *   - `PrView`         — `archive-task.ts`'s `{ number, headRefName, body,
 *                        mergedAt, comments }` vs `verify-review-gate.ts`'s
 *                        `{ number, comments (different shape), labels,
 *                        headRefOid }`. Unfixed.
 *   - `readManifest`   — two unrelated functions: `bin/verify-brief.ts`'s
 *                        private `readManifest(dir): PackageManifest | null`
 *                        reads a workspace `package.json`, while
 *                        `src/control-store/local.ts`'s exported
 *                        `readManifest(deps, task, round)` reads a control-store
 *                        `manifest` record. Same `read<Kind>` verb, no
 *                        shared code. Not renamed: `read<Kind>` is the control
 *                        store's own API convention (`readRun`/`readInput`/
 *                        `readTransitions`), so the src/ export is correctly
 *                        named among its siblings; `bin/` is I/O-shim code that
 *                        imports `src/`, never the reverse, so the two never
 *                        resolve to one another.
 *   - `REPO_ROOT`      — seventeen files; twelve use `import.meta.dirname`,
 *                        five (`archive-task.ts`, `check-no-disk-state.ts`,
 *                        `verify-brief.ts`, `verify-docs.ts`, `verify-task.ts`)
 *                        use the deprecated Bun-only `import.meta.dir`. A real
 *                        inconsistency, unfixed.
 *   - `resolvePrBody`  — byte-identical in `verify-docs.ts`/`verify-task.ts`. Harmless.
 *   - `resolveShippableArgs` — same logic in `open-issue.ts`/`open-pr.ts`,
 *                        differs only in the temp-dir name prefix
 *                        (`aeg-open-issue-body-` vs `aeg-open-pr-body-`).
 *                        Unfixed as a byte difference.
 *   - `sh`             — eight files, at least six distinct implementations
 *                        (execFileSync-array vs execSync-string args,
 *                        throwing vs catching, differing option shapes).
 *                        `verify-docs.ts` and `check-no-disk-state.ts` are
 *                        byte-identical to each other; every other pair
 *                        differs. Unfixed.
 *   - `shJson`         — three files, three distinct signatures:
 *                        `archive-task.ts` throws and returns non-null `T`;
 *                        `dead-branch-audit.ts` catches and returns
 *                        `T | null` from one `cmd` arg; `verify-dispatch.ts`
 *                        catches and returns `T | null` from `cmd, args`.
 *                        Unfixed.
 *   - `stripBackticks` — three copies, see the test above.
 *   - `TASK_BRANCH_PATTERN` — now four regexes: the three
 *                        already known, plus `bin/verify-brief.ts:60`, which
 *                        `bin/` joining the scan now also reaches.
 *                        `archive-task.ts`'s has capture groups, the other
 *                        three do not.
 *
 * `sanitizeKey`/`collisionResistantKey`/`legacyTranscriptPointerPath`/
 * `transcriptPointerPath` — private helpers in `src/claude-code-transcript.ts`,
 * each with an identically-named counterpart in `bin/report-tokens.ts`.
 * Deliberately duplicated, not a collision to fix: `bin/` is I/O-shim code
 * that imports `src/`, never the reverse, and is not part of this package's
 * published `exports` map, so `claude-code-transcript.ts` cannot import
 * `bin/report-tokens.ts`'s copies without inverting that direction — see the
 * doc comment on `transcriptPointerPath` in `claude-code-transcript.ts` for
 * the full reasoning. `sanitizeKey`/`transcriptPointerPath` introduced by
 * a real PR; omitted from this list by that PR, which is why this gate went red
 * the first time the full (non-diff-scoped) suite ran against it.
 * `collisionResistantKey`/`legacyTranscriptPointerPath` added by a later migration,
 * which gave `transcriptPointerPath` a collision-resistant key while keeping
 * `sanitizeKey` as the (still collision-prone) legacy derivation, so a
 * pointer already on disk under the old name stays readable.
 */
const KNOWN_COLLISIONS = [
  'AssociatedPr',
  'BodyResult',
  'BodySource',
  'collisionResistantKey',
  'createLabel',
  'ensureLabelExists',
  'extractTitle',
  'fail',
  'fetchOtherOpenPrFiles',
  'ghReachable',
  'isEmDashOrDash',
  'isSpecFile',
  'LABEL',
  'LABEL_DESCRIPTION',
  'legacyTranscriptPointerPath',
  'listLabelNames',
  'locateBody',
  'main',
  'MARKER',
  'parseArgs',
  'ParsedArgs',
  'PrListEntry',
  'PrView',
  'readManifest',
  'REPO_ROOT',
  'resolvePrBody',
  'resolveShippableArgs',
  'sanitizeKey',
  'sh',
  'shJson',
  'stripBackticks',
  'TASK_BRANCH_PATTERN',
  'transcriptPointerPath'
]

describe('symbol-collision gate over this package', () => {
  it('declares no name in two files beyond the known set', () => {
    const found = packageCollisions().map((c) => c.name)
    expect(
      found,
      "A name is now declared in more than one non-test source file of @attalabs/aeg-core's src/ or bin/ (test files are not scanned). Rename or consolidate it, or add it to KNOWN_COLLISIONS with a reason. A name that resolves to two files cannot be checked by reading one of them."
    ).toEqual([...KNOWN_COLLISIONS].sort((a, b) => a.localeCompare(b)))
  })

  it('scans enough files to be meaningful — a guard on the enumeration', () => {
    expect(packageSourceFiles().length).toBeGreaterThan(20)
  })
})
