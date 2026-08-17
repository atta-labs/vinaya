import { execFileSync } from 'node:child_process'
import { emitCheckError, type CheckError, type CheckOutcome, type CheckSpec } from '../checks/contract'
import { coreCheckRegistry, runsUnderAll } from '../checks/registry'
import {
  bareKeyRejectedDiagnostic,
  resolveChecks,
  type ResolvedCheck,
  type ResolverFailure,
  type ResolveResult
} from '../checks/resolver'
import { defaultParallelism, runChecks } from '../checks/runner'
import { type ConfigLoadResult, loadConfigChecked } from '../lib/config'
import { printJson } from '../lib/envelope'

// Array-form execFileSync — no shell, so `base` (env-controlled) is passed
// to git as an inert literal argv element, never shell-interpreted.
function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function changedFiles(): string[] {
  const base = process.env.BASE_SHA || 'origin/main'
  let out = git(['diff', '--name-only', `${base}...HEAD`])
  if (!out) out = git(['diff', '--name-only', 'main...HEAD'])
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseParallel(args: string[]): number | undefined {
  for (const a of args) {
    const m = a.match(/^--parallel(?:=(\d+))?$/)
    if (m) return m[1] ? Number(m[1]) : defaultParallelism()
  }
  return undefined
}

type EnvLabel = 'passthrough' | 'optional' | 'literal' | 'anyOf'

type PlanJsonOutput = {
  schema: 1
  checks: Record<
    string,
    {
      state: ResolveResult['resolved'][number]['state']
      source: ResolveResult['resolved'][number]['source']
      env: Record<string, EnvLabel>
      envAnyOf?: Record<string, string[]>
      scope: CheckSpec['scope']
    }
  >
  roles: { available: false; reason: string }
  errors: ResolveResult['failures']
}

function classifyEnvValue(value: true | { optional: true } | { anyOf: string[] } | string): EnvLabel {
  if (value === true) return 'passthrough'
  if (typeof value === 'string') return 'literal'
  if ('anyOf' in value) return 'anyOf'
  return 'optional'
}

/**
 * `--plan --json`'s resolver-failure surface — a top-level `errors` array so
 * a FAIL_CLOSED entry is never dropped from the JSON the way it isn't
 * dropped from the human table. `roles` stays an explicit degraded
 * placeholder: role resolution/registration is task 6's job, not this one.
 */
function renderPlanJson(result: ResolveResult): PlanJsonOutput {
  const checks: PlanJsonOutput['checks'] = {}
  for (const entry of result.resolved) {
    const env: Record<string, EnvLabel> = {}
    let envAnyOf: Record<string, string[]> | undefined
    for (const [key, value] of Object.entries(entry.spec.env ?? {})) {
      env[key] = classifyEnvValue(value)
      if (typeof value === 'object' && value !== null && 'anyOf' in value) {
        envAnyOf ??= {}
        envAnyOf[key] = value.anyOf
      }
    }
    checks[entry.name] = { state: entry.state, source: entry.source, env, envAnyOf, scope: entry.spec.scope }
  }
  return {
    schema: 1,
    checks,
    roles: { available: false, reason: 'role resolution not implemented yet — see task 6' },
    errors: result.failures
  }
}

/**
 * `ENV` cell: bare `NAME` for passthrough, `NAME?` for optional, `NAME|ALT`
 * for an `anyOf` group, `NAME=<redacted>` for a literal — the literal's
 * actual value is never printed, only that it resolves to a fixed string.
 */
function envCellFor(spec: CheckSpec): string {
  const entries = Object.entries(spec.env ?? {})
  if (entries.length === 0) return '—'
  return entries
    .map(([key, value]) => {
      if (value === true) return key
      if (typeof value === 'string') return `${key}=<redacted>`
      if ('anyOf' in value) return value.anyOf.join('|')
      return `${key}?`
    })
    .join(', ')
}

function renderPlanTable(result: ResolveResult): string {
  const header = ['NAME', 'STATE', 'SOURCE', 'ENV']
  const rows = result.resolved.map((entry) => [entry.name, entry.state, entry.source, envCellFor(entry.spec)])
  const failureRows = result.failures.map((f) => [f.key, 'FAILED', '—', f.reason])
  const table = [header, ...rows, ...failureRows]
  const widths = header.map((_, col) => Math.max(...table.map((row) => row[col]?.length ?? 0)))
  return table.map((row) => row.map((cell, col) => (cell ?? '').padEnd(widths[col] ?? 0)).join('  ')).join('\n')
}

/**
 * A resolved set may never carry the same id twice. The resolver's own
 * classification cannot produce one (an exact core-id match replaces in
 * place; an additive key must contain a `/`, which no core id does), so this
 * is a boundary invariant asserted where execution consumes the set, NOT a
 * re-implementation of resolver logic: if the two ever diverge, the run
 * refuses instead of silently running one of the two colliding specs.
 * Reported once per duplicated name, however many times it repeats.
 */
export function duplicateIdFailures(resolved: ResolvedCheck[]): ResolverFailure[] {
  const seen = new Set<string>()
  const reported = new Set<string>()
  const failures: ResolverFailure[] = []
  for (const entry of resolved) {
    if (!seen.has(entry.name)) {
      seen.add(entry.name)
      continue
    }
    if (reported.has(entry.name)) continue
    reported.add(entry.name)
    failures.push({ key: entry.name, reason: 'duplicate check id — two resolved entries claim the same name' })
  }
  return failures
}

const FAIL_CLOSED_RECOVERY =
  'Fix or remove the rejected `checks` entries named above in vinaya.config.json, then re-run `vinaya check`. Until every entry resolves, NO check runs — vinaya refuses the whole run rather than executing a partial ruleset. `vinaya check --plan` prints the same resolution, and `vinaya doctor` carries the permanent diagnostic for each rejected entry.'

function refusal(message: string): CheckError {
  return { schema: 1, check: 'config', severity: 'error', message, agent_recovery_prompt: FAIL_CLOSED_RECOVERY }
}

/**
 * The ONE resolution both `--plan` and real execution read. Sharing it is
 * what makes plan-vs-execution agreement structural rather than a property
 * two code paths have to be kept in sync about.
 *
 * `result` is exactly what `--plan` renders. `refusals` is FAIL_CLOSED's
 * side: the same failures, phrased for the human being refused. They are
 * built HERE rather than by string-matching `result.failures` afterwards,
 * because only here is each failure's provenance still known — a bare key
 * rejected by the resolver gets the resolver's own permanent diagnostic
 * (naming the rename requirement), while a config that failed to load at
 * all, or a duplicate id caught at this boundary, gets its own wording.
 *
 * A `loadConfigChecked()` failure (invalid JSON / schema) resolves core-only
 * plus a synthesized failure naming the config file: `--plan` still renders
 * whatever it can rather than crashing uncaught, and execution reads that
 * same failure as a refusal rather than proceeding as if the config didn't
 * exist.
 */
function resolveForRun(configResult: ConfigLoadResult): { result: ResolveResult; refusals: CheckError[] } {
  const base = configResult.ok
    ? resolveChecks(coreCheckRegistry(), configResult.config?.checks)
    : {
        resolved: resolveChecks(coreCheckRegistry(), undefined).resolved,
        failures: [{ key: configResult.path, reason: `invalid \`checks\` registration — ${configResult.error}` }]
      }

  const duplicates = duplicateIdFailures(base.resolved)
  const refusals: CheckError[] = [
    ...base.failures.map((failure) =>
      configResult.ok
        ? refusal(bareKeyRejectedDiagnostic(failure.key))
        : refusal(`${failure.key}: ${failure.reason} — refusing to run any check.`)
    ),
    ...duplicates.map((failure) => refusal(`${failure.key}: ${failure.reason} — refusing to run any check.`))
  ]

  return { result: { resolved: base.resolved, failures: [...base.failures, ...duplicates] }, refusals }
}

export async function checkCommand(args: string[]): Promise<void> {
  const jsonOutput = args.includes('--json')
  const diffOnly = args.includes('--diff-only')
  const localOnly = args.includes('--local')
  const requestedParallel = parseParallel(args)
  const allRequested = args.includes('--all')
  const planRequested = args.includes('--plan')
  const positional = args.filter((a) => !a.startsWith('--'))
  const requestedName = positional[0]

  const { result, refusals } = resolveForRun(loadConfigChecked())

  if (planRequested) {
    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify(renderPlanJson(result), null, 2)}\n`)
    } else {
      process.stdout.write(`${renderPlanTable(result)}\n`)
    }
    process.exit(result.failures.length > 0 ? 1 : 0)
  }

  if (!allRequested && !requestedName) {
    console.error('Usage: vinaya check <name> | --all | --plan [--json] [--diff-only] [--local] [--parallel[=n]]')
    process.exit(2)
  }

  // FAIL_CLOSED — refuse the whole run before a single check is spawned.
  // Not core-only, not best-effort: a partially-applied ruleset that still
  // prints green is the failure this design exists to prevent.
  if (refusals.length > 0) {
    const outcome: CheckOutcome = {
      name: 'config',
      status: 'error',
      exitCode: null,
      errors: refusals,
      durationMs: 0
    }
    for (const e of refusals) emitCheckError(e)
    if (jsonOutput) {
      printJson({ checks: [outcome] })
    } else {
      process.stdout.write(`✗ ${outcome.name}: refused — no checks ran\n`)
      for (const e of refusals) process.stdout.write(`    ${e.severity}: ${e.message}\n`)
    }
    process.exit(1)
  }

  // The resolved set IS the registry: an entry whose key matched a core id
  // replaced that core spec in place (it no longer runs alongside it), and a
  // namespaced entry was appended. Same `ResolveResult` `--plan` just
  // rendered, so what the plan printed is what runs here.
  const allSpecs: CheckSpec[] = result.resolved.map((entry) => entry.spec)

  // `--all` omits a check whose own workflow already reports it. Running it
  // twice produces a second conclusion nothing can refresh: `review-gate`'s
  // verdicts arrive as PR comments AFTER a push, and only the dedicated
  // `vinaya-review.yml` is re-run when one lands. Naming the check
  // explicitly still runs it — this narrows `--all`, never the check itself.
  const specsToRun = allRequested ? allSpecs.filter(runsUnderAll) : allSpecs.filter((s) => s.name === requestedName)
  if (!allRequested && specsToRun.length === 0) {
    console.error(`Unknown check: ${requestedName}`)
    process.exit(2)
  }

  const changed = diffOnly ? changedFiles() : null

  const outcomes =
    specsToRun.length > 0
      ? await runChecks(specsToRun, {
          parallel: requestedParallel ?? defaultParallelism(),
          diffOnly,
          changedFiles: changed,
          defaultTimeoutMs: 30_000,
          localOnly
        })
      : []

  // Findings go to stderr as the contract's JSON lines regardless of which
  // stdout mode (--json envelope or human summary) is chosen below.
  for (const o of outcomes) {
    for (const e of o.errors) emitCheckError(e)
  }

  if (jsonOutput) {
    printJson({ checks: outcomes })
  } else {
    for (const o of outcomes) {
      const symbol = o.status === 'pass' ? '✓' : o.status === 'skipped' ? '·' : '✗'
      process.stdout.write(`${symbol} ${o.name}: ${o.status} (${Math.round(o.durationMs)}ms)\n`)
      for (const e of o.errors) process.stdout.write(`    ${e.severity}: ${e.message}\n`)
    }
  }

  const failed = outcomes.some((o) => o.status === 'fail' || o.status === 'error' || o.status === 'timeout')
  process.exit(failed ? 1 : 0)
}
