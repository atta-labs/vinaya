/**
 * The checks-side resolver — a pure function, no I/O, no `@attalabs/aeg-core`
 * import (mirrors `contract.ts`'s own "pure contract" discipline).
 *
 * AUTHORITATIVE as of the execution flip: `vinaya check --plan` /
 * `--plan --json` and `vinaya check`'s real execution both resolve through
 * this one function, so what the plan prints IS what runs. The classification
 * logic below (`resolveChecks`, `isValidNamespacedKey`) is unchanged by that
 * flip — only its consumers moved. See the Configuration architecture
 * chapter, `apps/vinaya/specs/vinaya-spec.md`.
 */
import type { CheckEntry } from '../lib/config'
import type { CheckSpec } from './contract'

export type ResolutionState = 'default' | 'overridden' | 'additive'

export type ResolvedCheck = {
  name: string
  state: ResolutionState
  source: 'core' | 'config'
  spec: CheckSpec
}

export type ResolverFailure = {
  key: string
  reason: string
}

export type ResolveResult = {
  resolved: ResolvedCheck[]
  failures: ResolverFailure[]
}

const NAMESPACE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/
const RESERVED_PREFIX = 'vinaya'

/**
 * Exactly one `/`, both segments non-empty and matching `[a-z0-9][a-z0-9-]*`,
 * with `vinaya` reserved as an exact segment match (`vinaya/x` rejected,
 * `vinayatools/x` fine — a startsWith check would wrongly reject the latter).
 */
export function isValidNamespacedKey(key: string): boolean {
  const parts = key.split('/')
  if (parts.length !== 2) return false
  const [prefix, rest] = parts
  if (!prefix || !rest) return false
  if (!NAMESPACE_SEGMENT.test(prefix) || !NAMESPACE_SEGMENT.test(rest)) return false
  if (prefix === RESERVED_PREFIX) return false
  return true
}

/**
 * `resolved = core_registry ⊕ overridden-by-exact-key-match ⊕
 * additive-by-namespace-grammar`. Uniqueness among `core`'s own names is
 * guaranteed by `registry.ts` (15 distinct names) — not re-checked here.
 *
 * Render order is core order, then config's own key-iteration order for
 * additive entries — stable for deterministic table/JSON rendering. This is
 * distinct from "order-independent" classification (spec chapter, Resolution
 * algorithm section): which state a key resolves to never depends on
 * config-file key order, but render order legitimately follows file order.
 */
export function resolveChecks(core: CheckSpec[], configChecks: Record<string, CheckEntry> | undefined): ResolveResult {
  const resolved: ResolvedCheck[] = core.map((spec) => ({ name: spec.name, state: 'default', source: 'core', spec }))
  const failures: ResolverFailure[] = []

  if (!configChecks) return { resolved, failures }

  const indexByName = new Map(resolved.map((entry, index) => [entry.name, index]))

  for (const [key, entry] of Object.entries(configChecks)) {
    const coreIndex = indexByName.get(key)
    if (coreIndex !== undefined) {
      resolved[coreIndex] = {
        name: key,
        state: 'overridden',
        source: 'config',
        spec: { name: key, ...entry }
      }
      continue
    }
    if (isValidNamespacedKey(key)) {
      resolved.push({ name: key, state: 'additive', source: 'config', spec: { name: key, ...entry } })
      continue
    }
    failures.push({ key, reason: 'bare key has no "/" and matches no core check id' })
  }

  return { resolved, failures }
}

/**
 * Shared message builders for the two classification classes. Before the
 * execution flip these were `vinaya check`'s own grace-period warnings
 * ("...starting next minor"); the flip demoted them from check output to
 * `vinaya doctor`'s permanent diagnostics and retargeted the wording at the
 * behavior that is now live. They stay HERE, next to the predicates that
 * produce them, so a diagnostic can never describe a classification the
 * resolver no longer makes.
 *
 * A rejected config is refused whole (FAIL_CLOSED, `commands/check.ts`), so
 * `vinaya doctor` is the only surface left that can explain WHY — deleting
 * these would leave a refused config undiagnosable.
 */
export function overriddenReplacesCoreDiagnostic(name: string): string {
  return `check "${name}" shares its name with a core check — it REPLACES that core check. The core check does not run.`
}

/**
 * Names the rename requirement in full, because a prefix alone is NOT always
 * enough: the namespaced form is `<yourname>/<id>` with BOTH segments
 * matching `[a-z0-9][a-z0-9-]*`, so a bare name that already breaks that
 * grammar (`my_check`, `QALint`) still breaks it after prefixing and needs a
 * real rename.
 */
export function bareKeyRejectedDiagnostic(key: string): string {
  return `check "${key}" has no namespace and matches no core check — it is REJECTED, and \`vinaya check\` refuses the whole run rather than executing a partial ruleset. Rename it to "<yourname>/<id>", both segments matching [a-z0-9][a-z0-9-]* — prefixing alone is not enough when the bare name itself breaks that grammar ("my_check", "QALint" need a real rename, not just a prefix).`
}
