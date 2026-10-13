import { type ProseCheckGroup, type ProseRulesConfig, resolveProseRules, rulesOfGroup } from '@attalabs/aeg-core'

/**
 * `vinaya check --plan`'s writing-rules section: which rules each prose
 * check runs, read from the same rule set the checks themselves resolve.
 *
 * One rule set, two checks: `reader-resolvable-prose` runs the
 * reader-resolvable group and `retired-vocabulary` runs the retired group.
 * A check replaced by a configured entry (a no-op, or anything else) does
 * not run, so neither does its group — the plan says so instead of listing
 * rules nothing will run.
 */

export const PROSE_CHECK_GROUPS: Readonly<Record<string, ProseCheckGroup>> = {
  'reader-resolvable-prose': 'reader-resolvable',
  'retired-vocabulary': 'retired-vocabulary'
}

export type ProseRulesPlanEntry = {
  group: ProseCheckGroup
  /** False when the check was replaced by a configured entry. */
  runs: boolean
  rules: { id: string; scopes: readonly string[]; custom: boolean }[]
}

export type ProseRulesPlan =
  | { available: true; checks: Record<string, ProseRulesPlanEntry> }
  | { available: false; reason: string }

/**
 * `states` maps each resolved check name to its resolution state; a prose
 * check whose state is `overridden` runs none of its group.
 */
export function buildProseRulesPlan(
  states: ReadonlyMap<string, string>,
  rulesConfig: ProseRulesConfig | undefined
): ProseRulesPlan {
  const set = resolveProseRules(rulesConfig)
  const checks: Record<string, ProseRulesPlanEntry> = {}
  for (const [name, group] of Object.entries(PROSE_CHECK_GROUPS)) {
    const state = states.get(name)
    const runs = state !== undefined && state !== 'overridden'
    checks[name] = {
      group,
      runs,
      rules: runs
        ? rulesOfGroup(set, group).map((rule) => ({ id: rule.id, scopes: rule.scopes, custom: rule.custom }))
        : []
    }
  }
  return { available: true, checks }
}

/** The human-readable section, one block per prose check. */
export function renderProseRulesPlan(plan: ProseRulesPlan): string {
  if (!plan.available) return `prose rules: unavailable — ${plan.reason}`
  const lines = ['PROSE RULES']
  for (const [name, entry] of Object.entries(plan.checks)) {
    if (!entry.runs) {
      lines.push(`${name}: replaced by a configured check — the ${entry.group} group does not run`)
      continue
    }
    lines.push(`${name} (${entry.group} group, ${entry.rules.length} rule(s)):`)
    for (const rule of entry.rules) {
      lines.push(`  ${rule.id}${rule.custom ? ' [custom]' : ''} — ${rule.scopes.join(', ')}`)
    }
  }
  return lines.join('\n')
}

/**
 * The whole `--plan` section in one call: the plan for `--plan --json` and its
 * rendered text. `rulesConfig` is `null` when the configuration did not load.
 */
export function proseRulesPlanSection(
  states: ReadonlyMap<string, string>,
  rulesConfig: ProseRulesConfig | undefined | null
): { plan: ProseRulesPlan; text: string } {
  const plan: ProseRulesPlan =
    rulesConfig === null
      ? { available: false, reason: 'the configuration did not load' }
      : buildProseRulesPlan(states, rulesConfig)
  return { plan, text: renderProseRulesPlan(plan) }
}
