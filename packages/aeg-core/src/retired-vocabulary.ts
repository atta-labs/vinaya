/**
 * Retired vocabulary — mechanisms genuinely gone from AEG's own methodology
 * (the decision log, the lock, the `team-leader` role, the `D-###` decision
 * id, …) with no legitimate positive occurrence anywhere but the exempt
 * lists below. This is `retired-vocabulary.test.ts`'s `RETIRED` array and
 * the non-citation members of its `RETIRED_IN_PRODUCT` array (both target
 * the same retired-mechanism concern; the split between the two vitest
 * arrays there is organic history, not a semantic boundary) — the file this
 * module was extracted from names the incident: five review rounds each
 * declared the decision-log claim swept, and each time it resurfaced a few
 * lines from where the previous pass fixed it. A rule enforced by attention,
 * not a gate.
 *
 * Deliberately NOT `RETIRED_IN_PRODUCT`'s forge-number / tranche-slug /
 * legacy-slug patterns: those ban a LIVE, unexplained citation, not a
 * retired concept, and are already this package's own
 * `checkUnresolvableReferences` (`reader-resolvable-prose.ts`) — shipping
 * both under two check names would double-report the identical match. This
 * module is deliberately the narrower half of that file's original scan.
 *
 * Content copied verbatim from `retired-vocabulary.test.ts`'s `RETIRED`
 * (minus its citation members), `EXEMPT`, and the non-citation entries of
 * `PATTERN_EXEMPT`, never re-derived — this module's whole purpose is
 * giving that list a CheckSpec adapter, not re-litigating it. Every pattern
 * here is POSIX-ERE-safe (no `\d`/`\w`/`\s`, no lookaheads) by the same
 * discipline `reader-resolvable-prose.ts` documents, so `grep -E` (the
 * vitest suite) and native `RegExp` (this evaluator) agree on every match.
 *
 * Zero I/O: every input (file paths + contents) is read by the adapter and
 * passed in, same charter as `reader-resolvable-prose.ts`.
 */

export type VocabSourceFile = { path: string; content: string }

export type VocabFinding = {
  file: string
  line: number
  pattern: string
  message: string
}

import {
  PLAN_ON_DISK_PATTERNS,
  RETIRED_GLOBAL_EXEMPTIONS,
  RETIRED_PATTERN_EXEMPTIONS,
  rulesForGroup,
  TRANCHE_MODEL_FILE
} from './prose-rules'

const retiredRules = rulesForGroup('retired-vocabulary')

export { PLAN_ON_DISK_PATTERNS, TRANCHE_MODEL_FILE }

/** The retired mechanisms this scan bans as claims of current-ness — see the module header for what is deliberately NOT here. */
export const RETIRED_PATTERNS: readonly string[] = retiredRules.map((rule) => rule.patterns.repository as string)

/** Paths where a retired-vocabulary mention is legitimate: frozen archives and historical records. Substring match, same as the vitest suite's own `EXEMPT`. */
export const RETIRED_EXEMPT_SUBSTRINGS: readonly string[] = RETIRED_GLOBAL_EXEMPTIONS

/** Per-pattern exemptions on top of `RETIRED_EXEMPT_SUBSTRINGS`; the data lives in the shared rule module. */
export const PATTERN_EXEMPT: Readonly<Record<string, readonly string[]>> = RETIRED_PATTERN_EXEMPTIONS

function lineNumbers(content: string, pattern: RegExp): number[] {
  const out: number[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i] ?? '')) out.push(i + 1)
  }
  return out
}

/**
 * Sweeps `files` for `RETIRED_PATTERNS`, skipping any file whose path
 * contains a `RETIRED_EXEMPT_SUBSTRINGS` entry, or that pattern's own
 * `PATTERN_EXEMPT` entry. Matching is per-line, case-sensitive — the same
 * semantics `grep -E` (with no `-i`) gives the vitest suite this was
 * extracted from.
 */
export function scanRetiredVocabulary(files: readonly VocabSourceFile[]): VocabFinding[] {
  const findings: VocabFinding[] = []
  for (const file of files) {
    if (RETIRED_EXEMPT_SUBSTRINGS.some((e) => file.path.includes(e))) continue
    for (const pattern of RETIRED_PATTERNS) {
      const patternExempt = PATTERN_EXEMPT[pattern] ?? []
      if (patternExempt.some((e) => file.path.includes(e))) continue
      const re = new RegExp(pattern)
      for (const line of lineNumbers(file.content, re)) {
        findings.push({
          file: file.path,
          line,
          pattern,
          message: `claims a retired AEG mechanism is still live (matches /${pattern}/)`
        })
      }
    }
  }
  return findings
}
