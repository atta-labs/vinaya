import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { emitCheckError, type CheckError, type CheckOutcome, type CheckSpec } from '../checks/contract'
import { coreCheckRegistry, runsUnderAll } from '../checks/registry'
import {
  bareKeyRejectedDiagnostic,
  overriddenReplacesCoreDiagnostic,
  resolveChecks,
  type ResolvedCheck,
  type ResolverFailure,
  type ResolveResult
} from '../checks/resolver'
import { defaultParallelism, runChecks } from '../checks/runner'
import { type ConfigLoadResult, configPath, loadConfigChecked } from '../lib/config'
import { printJson } from '../lib/envelope'
import { buildRolePlan, type RolePlan } from '../roles/plan'
import type { RoleResolutionState } from '../roles/resolver'

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
  roles:
    | {
        available: true
        resolved: Record<
          string,
          {
            state: RoleResolutionState
            source: 'core' | 'config'
            rendersAs: string
            title: string
            gating: 'core' | 'inert'
          }
        >
        errors: Array<{ key: string; reason: string }>
      }
    | { available: false; reason: string }
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
 * dropped from the human table. `roles` is the resolved role registry
 * (`available: true`) once a doctrine source resolves, or an explicit
 * degraded placeholder naming why it couldn't (`available: false`) — see
 * `../roles/plan.ts`.
 */
function renderPlanJson(result: ResolveResult, rolePlan: RolePlan): PlanJsonOutput {
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

  const roles: PlanJsonOutput['roles'] = rolePlan.available
    ? {
        available: true,
        resolved: Object.fromEntries(
          rolePlan.resolved.map((r) => [
            r.name,
            {
              state: r.state,
              source: r.source,
              rendersAs: r.renderId,
              title: r.contract.title,
              gating: r.inertToGating ? ('inert' as const) : ('core' as const)
            }
          ])
        ),
        errors: rolePlan.failures
      }
    : { available: false, reason: rolePlan.reason }

  return {
    schema: 1,
    checks,
    roles,
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
 * The roles half of `--plan`'s human table — a `RENDERS AS` column, because
 * the registry key (`NAME`) an entry is addressed by and the role id it
 * actually renders as are different identifiers once an additive role is
 * involved (`acme/qa-lead` registers as that whole key, renders as
 * `qa-lead`). `GATING` names whether the resolved role participates in core
 * enforcement (`core`, every `default`/`overridden` entry) or is
 * documentation-only (`inert`, every `additive` entry — no core `ACTIONS`
 * wiring exists for a render id core doctrine never declared).
 */
function renderRolesTable(rolePlan: RolePlan): string {
  if (!rolePlan.available) return `roles: unavailable — ${rolePlan.reason}`
  const header = ['NAME', 'STATE', 'SOURCE', 'RENDERS AS', 'GATING']
  const rows = rolePlan.resolved.map((r) => [r.name, r.state, r.source, r.renderId, r.inertToGating ? 'inert' : 'core'])
  const failureRows = rolePlan.failures.map((f) => [f.key, 'FAILED', '—', '—', f.reason])
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

/**
 * Substitution notices for the REAL run — one `warning` finding per
 * `overridden` entry, announcing on the enforcing surface that a core check
 * was replaced and did not run.
 *
 * This is deliberately NOT the pre-flip grace-period warning coming back:
 * that one predicted a future minor ("will replace…"), this one reports
 * what this very run did. It exists because the flip made substitution
 * load-bearing while removing the only signal of it from the surface CI
 * shows — `vinaya-checks.yml` runs `check --all --diff-only` and tees that
 * to the step summary; no generated workflow runs `doctor` or `--plan`,
 * so without this a substituted gate reads `✓ <core-id>: pass`,
 * byte-indistinguishable from the real gate (security pass, PR #120,
 * finding 2). Detection is the doctrine's declared backstop for a
 * config-authored gate substitution, so it has to live where the gate runs.
 *
 * `severity: 'warning'`, never `error`: an override is a supported,
 * documented extension point, and this must not change any exit code.
 */
function substitutionNotices(resolved: ResolvedCheck[]): CheckError[] {
  return resolved
    .filter((entry) => entry.state === 'overridden')
    .map((entry) => ({
      schema: 1 as const,
      check: 'config',
      severity: 'warning' as const,
      message: overriddenReplacesCoreDiagnostic(entry.name),
      agent_recovery_prompt: `If replacing the core check "${entry.name}" was intended, nothing to do — this is a notice, not a failure. If it was not, remove or rename that \`checks\` entry in vinaya.config.json so the core check runs again.`
    }))
}

export async function checkCommand(args: string[]): Promise<void> {
  const jsonOutput = args.includes('--json')
  const diffOnly = args.includes('--diff-only')
  const localOnly = args.includes('--local')
  const skipFull = args.includes('--skip-full')
  const requestedParallel = parseParallel(args)
  const allRequested = args.includes('--all')
  const planRequested = args.includes('--plan')
  const positional = args.filter((a) => !a.startsWith('--'))
  const requestedName = positional[0]

  const configResult = loadConfigChecked()
  const { result, refusals } = resolveForRun(configResult)

  if (planRequested) {
    const configFilePath = configResult.ok ? configPath() : configResult.path
    const rolePlan = await buildRolePlan(
      configFilePath ? dirname(configFilePath) : null,
      configResult.ok ? configResult.config?.roles : undefined
    )
    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify(renderPlanJson(result, rolePlan), null, 2)}\n`)
    } else {
      process.stdout.write(`${renderPlanTable(result)}\n\n${renderRolesTable(rolePlan)}\n`)
    }
    const roleFailureCount = rolePlan.available ? rolePlan.failures.length : 0
    process.exitCode = result.failures.length > 0 || roleFailureCount > 0 ? 1 : 0
    return
  }

  if (!allRequested && !requestedName) {
    console.error(
      'Usage: vinaya check <name> | --all | --plan [--json] [--diff-only] [--local] [--skip-full] [--parallel[=n]]'
    )
    process.exitCode = 2
    return
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
    process.exitCode = 1
    return
  }

  // The resolved set IS the registry: an entry whose key matched a core id
  // replaced that core spec in place (it no longer runs alongside it), and a
  // namespaced entry was appended. Same `ResolveResult` `--plan` just
  // rendered, so what the plan printed is what runs here.
  const allSpecs: CheckSpec[] = result.resolved.map((entry) => entry.spec)

  // Announce every substitution BEFORE the run, on the surface the run
  // itself is read from — see `substitutionNotices`.
  const notices = substitutionNotices(result.resolved)
  for (const notice of notices) emitCheckError(notice)
  if (!jsonOutput) {
    for (const notice of notices) process.stdout.write(`⚠ ${notice.message}\n`)
  }

  // `--all` omits a check whose own workflow already reports it. Running it
  // twice produces a second conclusion nothing can refresh: `review-gate`'s
  // verdicts arrive as PR comments AFTER a push, and only the dedicated
  // `vinaya-review.yml` is re-run when one lands. Naming the check
  // explicitly still runs it — this narrows `--all`, never the check itself.
  const specsToRun = allRequested ? allSpecs.filter(runsUnderAll) : allSpecs.filter((s) => s.name === requestedName)
  if (!allRequested && specsToRun.length === 0) {
    console.error(`Unknown check: ${requestedName}`)
    process.exitCode = 2
    return
  }

  const changed = diffOnly ? changedFiles() : null

  const outcomes =
    specsToRun.length > 0
      ? await runChecks(specsToRun, {
          parallel: requestedParallel ?? defaultParallelism(),
          diffOnly,
          changedFiles: changed,
          defaultTimeoutMs: 30_000,
          localOnly,
          skipFull
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
      const statusText = o.skipReason ? `${o.status} (${o.skipReason})` : o.status
      process.stdout.write(`${symbol} ${o.name}: ${statusText} (${Math.round(o.durationMs)}ms)\n`)
      for (const e of o.errors) process.stdout.write(`    ${e.severity}: ${e.message}\n`)
    }
  }

  const failed = outcomes.some((o) => o.status === 'fail' || o.status === 'error' || o.status === 'timeout')
  process.exitCode = failed ? 1 : 0
}
