/**
 * The local-gate adapter of the enforcement-controls predicate: git's hook
 * routing reaches a directory that exists and the required hooks exist there
 * and are executable. Kept apart from `enforcement-controls.ts` so the
 * dispatch module can import the predicate without pulling in repository
 * detection.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { hookDirFromManifest, resolveHookDir } from './detect.js'
import type { EnforcementControl } from './enforcement-controls.js'
import { type HookDir, TRACKED_HOOK_DIR } from './init-hook-paths.js'
import { resolveManagedBlockPath } from './ops.js'

const okControl = (control: string): EnforcementControl => ({ control, active: true, detail: '', remedy: '' })
const notOkControl = (control: string, detail: string, remedy: string): EnforcementControl => ({
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
  if (hookDir === '.husky') return okControl(LOCAL_GATE_CONTROL)
  let dirAbs: string
  let where: string
  if (hookDir === TRACKED_HOOK_DIR) {
    if (value === null || normalizeRouting(value) !== TRACKED_HOOK_DIR) {
      return notOkControl(
        LOCAL_GATE_CONTROL,
        `ring 0 is INERT in this working copy — hooks are tracked at ${TRACKED_HOOK_DIR} but core.hooksPath is ` +
          `${value ? `set to '${value}'` : 'not set'} (git config is never cloned).`,
        `Run \`git config core.hooksPath ${TRACKED_HOOK_DIR}\` once per clone (or \`vinaya upgrade\`) to arm them.`
      )
    }
    dirAbs = join(repoRoot, TRACKED_HOOK_DIR)
    where = TRACKED_HOOK_DIR
    if (!isDirectory(dirAbs)) {
      return notOkControl(
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
      return notOkControl(
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
  if (missing.length === 0 && notExecutable.length === 0) return okControl(LOCAL_GATE_CONTROL)
  const parts = [
    ...(missing.length > 0 ? [`missing: ${missing.map((h) => `${where}/${h}`).join(', ')}`] : []),
    ...(notExecutable.length > 0 ? [`not executable: ${notExecutable.map((h) => `${where}/${h}`).join(', ')}`] : [])
  ]
  return notOkControl(
    LOCAL_GATE_CONTROL,
    `required hooks are not runnable (${parts.join('; ')}), so git skips them.`,
    missing.length > 0
      ? 'Run `vinaya upgrade` to restore the hooks, then `chmod +x` them.'
      : `Run \`chmod +x ${notExecutable.map((h) => `${where}/${h}`).join(' ')}\`.`
  )
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
