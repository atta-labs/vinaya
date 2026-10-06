/**
 * The product predicate behind "required enforcement controls are active
 * before an unattended dispatch starts". A control is one mechanism that
 * enforces a rule on the work — the repository's local gate, an agent's own
 * settings and hook scripts. The predicate is provider-neutral: it only knows
 * a control's name, whether it is active, why not, and the remedy. Each
 * control is proven by its own adapter below or in `dispatch.ts`; the doctor's
 * ring-0 verdict and the dispatch readiness both read the local-gate adapter
 * from here, so the two can never disagree.
 *
 * Every adapter is local and cheap: it reads routing, existence, readability
 * and the executable bit, never runs what it proves, never calls the forge.
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { hookDirFromManifest, resolveHookDir } from './detect.js'
import { type HookDir, TRACKED_HOOK_DIR } from './init-hook-paths.js'
import { resolveManagedBlockPath } from './ops.js'

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

export const LOCAL_GATE_CONTROL = 'local-gate'

/** The hooks the local gate must run: the commit-time and push-time gates. */
export const REQUIRED_LOCAL_GATE_HOOKS = ['pre-commit', 'pre-push'] as const

function isExecutableFile(path: string): boolean {
  try {
    const st = statSync(path)
    return st.isFile() && (st.mode & 0o111) !== 0
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const normalizeRouting = (value: string): string => value.replace(/\/+$/, '')

/**
 * The local gate: git's routing reaches a directory that exists, and the
 * required hooks exist there and are executable. For a repository whose hooks
 * are tracked, the routing must be exactly the tracked directory; for the
 * legacy per-clone shape, git's own hooks directory is the one that runs.
 * The remedy for a routing that is unset or wrong keeps the doctor's wording.
 */
export function localGateControl(repoRoot: string, hookDir: HookDir, value: string | null): EnforcementControl {
  // The adopter's own hook manager owns per-clone wiring; nothing to prove.
  if (hookDir === '.husky') return activeControl(LOCAL_GATE_CONTROL)
  let dirAbs: string
  let where: string
  if (hookDir === TRACKED_HOOK_DIR) {
    if (value === null || normalizeRouting(value) !== TRACKED_HOOK_DIR) {
      return inactiveControl(
        LOCAL_GATE_CONTROL,
        `ring 0 is INERT in this working copy — hooks are tracked at ${TRACKED_HOOK_DIR} but core.hooksPath is ` +
          `${value ? `set to '${value}'` : 'not set'} (git config is never cloned).`,
        `Run \`git config core.hooksPath ${TRACKED_HOOK_DIR}\` once per clone (or \`vinaya upgrade\`) to arm them.`
      )
    }
    dirAbs = join(repoRoot, TRACKED_HOOK_DIR)
    where = TRACKED_HOOK_DIR
    if (!isDirectory(dirAbs)) {
      return inactiveControl(
        LOCAL_GATE_CONTROL,
        `core.hooksPath routes git at '${value}', a directory that does not exist, so no hook runs.`,
        `Restore ${TRACKED_HOOK_DIR}/ from git (\`git checkout -- ${TRACKED_HOOK_DIR}\`) or run \`vinaya upgrade\`.`
      )
    }
  } else {
    dirAbs =
      value === null
        ? resolveManagedBlockPath(repoRoot, '.git/hooks')
        : isAbsolute(value)
          ? value
          : join(repoRoot, value)
    where = value ?? '.git/hooks'
    if (!isDirectory(dirAbs)) {
      return inactiveControl(
        LOCAL_GATE_CONTROL,
        `git's hooks directory '${where}' does not exist, so no hook runs.`,
        'Run `vinaya upgrade` to install the hooks.'
      )
    }
  }
  const missing = REQUIRED_LOCAL_GATE_HOOKS.filter((h) => !existsSync(join(dirAbs, h)))
  const notExecutable = REQUIRED_LOCAL_GATE_HOOKS.filter(
    (h) => existsSync(join(dirAbs, h)) && !isExecutableFile(join(dirAbs, h))
  )
  if (missing.length === 0 && notExecutable.length === 0) return activeControl(LOCAL_GATE_CONTROL)
  const parts = [
    ...(missing.length > 0 ? [`missing: ${missing.map((h) => `${where}/${h}`).join(', ')}`] : []),
    ...(notExecutable.length > 0 ? [`not executable: ${notExecutable.map((h) => `${where}/${h}`).join(', ')}`] : [])
  ]
  return inactiveControl(
    LOCAL_GATE_CONTROL,
    `required hooks are not runnable (${parts.join('; ')}), so git skips them.`,
    missing.length > 0
      ? 'Run `vinaya upgrade` to restore the hooks, then `chmod +x` them.'
      : `Run \`chmod +x ${notExecutable.map((h) => `${where}/${h}`).join(' ')}\`.`
  )
}

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
 * Which hook directory this repository's install uses — the recorded manifest
 * when `vinaya.config.json` carries one, else the detected default. The
 * doctor derives it the same way, so both ask `localGateControl` the same
 * question.
 */
export function installedHookDir(repoRoot: string): HookDir {
  const detected = resolveHookDir(repoRoot)
  try {
    const raw = JSON.parse(readFileSync(join(repoRoot, 'vinaya.config.json'), 'utf8')) as {
      managed?: Parameters<typeof hookDirFromManifest>[0]
    }
    return raw.managed ? hookDirFromManifest(raw.managed, detected) : detected
  } catch {
    return detected
  }
}

/** `core.hooksPath` read synchronously, `null` when unset — the dispatch-side twin of `readCoreHooksPath`. */
function readCoreHooksPathSync(repoRoot: string): string | null {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'config', '--get', 'core.hooksPath'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/** The local gate as the dispatch readiness proves it, from the real repository. */
export function realLocalGateControl(repoRoot: string): EnforcementControl {
  return localGateControl(repoRoot, installedHookDir(repoRoot), readCoreHooksPathSync(repoRoot))
}
