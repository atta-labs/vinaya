/**
 * The product predicate behind "required enforcement controls are active
 * before an unattended dispatch starts". A control is one mechanism that
 * enforces a rule on the work — the repository's local gate, an agent's own
 * settings and hook scripts. The predicate is provider-neutral: it only knows
 * a control's name, whether it is active, why not, and the remedy. Each
 * control is proven by its own adapter below or in `dispatch.ts`; the doctor's
 * ring-0 verdict and the dispatch readiness both read the local-gate adapter
 * from `local-gate-control.ts`, so the two can never disagree.
 *
 * Every adapter is local and cheap: it reads routing, existence, readability
 * and the executable bit, never runs what it proves, never calls the forge.
 */
import { accessSync, constants, readFileSync, statSync } from 'node:fs'

export type EnforcementControl = {
  /** Stable name of the control, quoted in the refusal. */
  control: string
  active: boolean
  /** Why the control is inactive; empty when active. */
  detail: string
  /** What to do about it; empty when active. */
  remedy: string
}

export type EnforcementControlsReport = {
  active: boolean
  controls: EnforcementControl[]
}

/** The one predicate: active only when every control is. */
export function enforcementControlsActive(controls: readonly EnforcementControl[]): EnforcementControlsReport {
  return { active: controls.every((c) => c.active), controls: [...controls] }
}

/** The refusal text: each inactive control, its detail and its remedy. */
export function describeInactiveControls(report: EnforcementControlsReport): string {
  return report.controls
    .filter((c) => !c.active)
    .map((c) => `enforcement control '${c.control}' is inactive: ${c.detail} Remedy: ${c.remedy}`)
    .join('\n')
}

const activeControl = (control: string): EnforcementControl => ({ control, active: true, detail: '', remedy: '' })
const inactiveControl = (control: string, detail: string, remedy: string): EnforcementControl => ({
  control,
  active: false,
  detail,
  remedy
})

function isReadableFile(path: string): boolean {
  try {
    accessSync(path, constants.R_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Every script path a hooks block names as `bun "<path>"`. */
function hookScriptPaths(config: unknown): string[] {
  const out: string[] = []
  const hooks = (config as { hooks?: Record<string, unknown> } | null)?.hooks
  if (typeof hooks !== 'object' || hooks === null) return out
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      const entries = (group as { hooks?: unknown }).hooks
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        const command = (entry as { command?: unknown }).command
        const match = typeof command === 'string' ? /"([^"]+)"/.exec(command) : null
        if (match?.[1]) out.push(match[1])
      }
    }
  }
  return out
}

/**
 * An agent adapter's per-dispatch controls: the settings or hooks file it
 * wrote for this dispatch exists and parses, and every hook script that file
 * names exists and is readable by the process that will run it. `null`
 * `configPath` means the adapter failed to write the file at all.
 */
export function agentHookControl(control: string, configPath: string | null, label: string): EnforcementControl {
  const remedy = 'Check that the runtime directory is writable and has free space, then re-run the dispatch.'
  if (configPath === null) {
    return inactiveControl(control, `the ${label} for this dispatch could not be written.`, remedy)
  }
  if (!isReadableFile(configPath)) {
    return inactiveControl(control, `the ${label} at ${configPath} is missing or unreadable.`, remedy)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return inactiveControl(control, `the ${label} at ${configPath} is not valid JSON.`, remedy)
  }
  const unreadable = hookScriptPaths(parsed).filter((p) => !isReadableFile(p))
  if (unreadable.length > 0) {
    return inactiveControl(
      control,
      `the ${label} names hook script(s) that are missing or unreadable: ${unreadable.join(', ')}.`,
      remedy
    )
  }
  return activeControl(control)
}

export const CLAUDE_SETTINGS_CONTROL = 'claude-settings-and-hooks'
export const CODEX_HOOKS_CONTROL = 'codex-hooks'

/** The control for the agent being dispatched; other agents carry none here. */
export function agentDispatchControls(
  agent: string,
  paths: { claudeSettingsPath: string | null; codexHooksPath: string | null }
): EnforcementControl[] {
  if (agent === 'claude') {
    return [agentHookControl(CLAUDE_SETTINGS_CONTROL, paths.claudeSettingsPath, 'Claude Code settings file')]
  }
  if (agent === 'codex') return [agentHookControl(CODEX_HOOKS_CONTROL, paths.codexHooksPath, 'Codex hooks file')]
  return []
}

/**
 * The pre-spawn refusal text for an unattended dispatch whose agent adapter
 * control is inactive, `null` when every control is active. An attended
 * dispatch carries no adapter control, so it never refuses here.
 */
export function agentControlsRefusal(
  agent: string,
  unattended: boolean,
  paths: { claudeSettingsPath: string | null; codexHooksPath: string | null }
): string | null {
  const result = enforcementControlsActive(unattended ? agentDispatchControls(agent, paths) : [])
  return result.active ? null : describeInactiveControls(result)
}
