// Environment detection for `vinaya init` / `eject`: git repo, gh auth, and
// the git-hook host directory. Plus the gh-backed LabelGateway. All external
// calls go through array-form execFile (no shell) so nothing is interpolated
// into a command line.

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type HookDir, TRACKED_HOOK_DIR } from './artifacts.js'
import type { ManagedManifest } from './config.js'
import { blockStripLeavesEmpty, type LabelGateway, resolveManagedBlockPath, stripBlockFromContent } from './ops.js'

const execFileAsync = promisify(execFile)

export type RepoInfo = { repoRoot: string; owner: string; repo: string }

export async function detectGitRepo(): Promise<RepoInfo | null> {
  try {
    const { stdout: root } = await execFileAsync('git', ['rev-parse', '--show-toplevel'])
    const repoRoot = root.trim()
    let owner = ''
    let repo = ''
    try {
      const { stdout: url } = await execFileAsync('git', ['remote', 'get-url', 'origin'])
      const m = url.trim().match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/)
      if (m) {
        owner = m[1] ?? ''
        repo = m[2] ?? ''
      }
    } catch {
      // no origin remote — owner/repo stay blank; init still works locally.
    }
    return { repoRoot, owner, repo }
  } catch {
    return null
  }
}

export async function checkGhAuth(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['auth', 'status'])
    return true
  } catch {
    return false
  }
}

export type GhAuthStatus = { authenticated: boolean; detail: string }

/**
 * Richer than `checkGhAuth`: captures `gh auth status`'s own text (host,
 * account, token scopes) for doctor's environment report. `gh` writes this to
 * stderr, not stdout. Read-only — never mutates auth state.
 */
export async function ghAuthStatus(): Promise<GhAuthStatus> {
  try {
    const { stderr, stdout } = await execFileAsync('gh', ['auth', 'status'])
    return { authenticated: true, detail: (stderr || stdout).trim() }
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr
    return { authenticated: false, detail: stderr?.trim() || 'gh is not authenticated' }
  }
}

export type BranchProtectionState = boolean | null | 'plan-required'

/**
 * Classifies `gh api .../branches/main/protection`'s failure stderr — pulled
 * out of `branchProtectionConfigured` so the three known shapes (404, the
 * GitHub-Pro-required 403, everything else) are unit-testable without
 * shelling to a real `gh`. `gh` exits non-zero for all three; only the first
 * two are known, real answers — anything else (auth/network failure) is
 * genuinely unknown. Found live: a PRIVATE repo without a paid plan gets a
 * 403 ("Upgrade to GitHub Pro or make this repository public to enable this
 * feature") which used to fall into the generic unknown bucket and print
 * as "could not be determined" in the same doctor run that had just
 * reported gh as authenticated and the remote as present. Only the specific
 * plan-required 403 gets its own state — a bare `\b403\b` match would also
 * swallow a real permissions failure and misreport it as "unprotected"'s
 * sibling rather than "unknown".
 */
export function classifyBranchProtectionError(stderr: string): BranchProtectionState {
  if (/\b404\b/.test(stderr)) return false
  if (/\b403\b/.test(stderr) && /upgrade to github pro|make this repository public/i.test(stderr)) {
    return 'plan-required'
  }
  return null
}

/**
 * Report-only read of the main branch's protection state — never applied,
 * never mutated. `null` means the state could not be determined for an
 * unknown reason (no auth, no remote, an unrecognized permission gap);
 * `'plan-required'` means it's a KNOWN reason — a private repo without a
 * paid GitHub plan cannot query this API at all — doctor reports that
 * honestly rather than folding it into the generic unknown case.
 */
export async function branchProtectionConfigured(owner: string, repo: string): Promise<BranchProtectionState> {
  if (!owner || !repo) return null
  try {
    await execFileAsync('gh', ['api', `repos/${owner}/${repo}/branches/main/protection`])
    return true
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? ''
    return classifyBranchProtectionError(stderr)
  }
}

/**
 * The hook names git actually invokes (githooks(5)). Anything else in
 * `.git/hooks` — an editor backup, a stray `husky.sh`, a subdirectory — never
 * fires and must not flip the install to the legacy layout or block a
 * migration with a false "active raw hook" refusal.
 */
const KNOWN_GIT_HOOKS = new Set([
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'fsmonitor-watchman',
  'p4-changelist',
  'p4-prepare-changelist',
  'p4-post-changelist',
  'p4-pre-submit',
  'post-index-change'
])

/**
 * Hook files git would actually RUN from the repo's real hooks directory
 * (resolved through `resolveManagedBlockPath`, so a linked worktree probes
 * the shared common dir, not its gitdir-pointer file): a known githooks(5)
 * name, a regular file, executable — git's own firing conditions. These are
 * hooks that fire today; routing `core.hooksPath` elsewhere would silently
 * disable every one of them.
 */
export function activeRawHooks(repoRoot: string): string[] {
  const dir = resolveManagedBlockPath(repoRoot, '.git/hooks')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter((f) => {
      if (!KNOWN_GIT_HOOKS.has(f)) return false
      try {
        const st = statSync(join(dir, f))
        return st.isFile() && (st.mode & 0o111) !== 0
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

/**
 * `activeRawHooks` minus hosts that are entirely vinaya's own — a stale
 * legacy host whose only content is the marker-delimited managed block named
 * after the hook (upgrade's residue sweep deletes exactly these). What
 * remains is the set arming `core.hooksPath` would genuinely disable; both
 * `upgrade`'s already-migrated arm guard and `doctor`'s inert-clone message
 * read THIS list, from one implementation, so the two cannot drift apart.
 */
export function foreignRawHooks(repoRoot: string): string[] {
  return activeRawHooks(repoRoot).filter((f) => {
    const abs = resolveManagedBlockPath(repoRoot, `.git/hooks/${f}`)
    try {
      const stripped = stripBlockFromContent(readFileSync(abs, 'utf-8'), f, 'hash')
      return stripped === null || !blockStripLeavesEmpty(stripped)
    } catch {
      return true
    }
  })
}

/**
 * Locked default (full-spec decision A): prefer `.husky/` if the repo already
 * uses it. Never add husky as a dependency. A custom `core.hooksPath` is the
 * escalation case the command handles separately.
 *
 * Otherwise the default is the TRACKED `.vinaya/hooks` directory (routed via
 * `core.hooksPath`): raw `.git/hooks` is never versioned, so a `.git/hooks`
 * install silently gives every fresh clone ZERO ring-0 enforcement
 * (atta-labs/attalabs#927). Tracked hooks travel with the repo; the one
 * per-clone residue is arming `git config core.hooksPath .vinaya/hooks`,
 * which `doctor` reports whenever it is missing.
 *
 * Exception: a repo whose `.git/hooks` already holds active raw hooks stays
 * on `.git/hooks` (append-a-managed-block, today's shape) — pointing
 * `core.hooksPath` away from them would silently disable the adopter's own
 * hooks, which violates the never-clobber contract in spirit. `doctor` warns
 * about the clone gap on that shape instead.
 */
export function resolveHookDir(repoRoot: string): HookDir {
  if (existsSync(join(repoRoot, '.husky'))) return '.husky'
  if (activeRawHooks(repoRoot).length > 0) return '.git/hooks'
  return TRACKED_HOOK_DIR
}

/**
 * Which hook directory a prior install actually used — read from the
 * recorded manifest rather than re-detecting. A `.git/hooks`-based install's
 * stubs are never tracked by git, so on a fresh clone `.husky` may be absent
 * too (never created there in the first place) while the manifest still
 * names `.git/hooks/*`; a fresh `resolveHookDir` guess would silently check
 * the wrong path. Falls back to `fallback` only when the manifest carries no
 * hook block at all (e.g. this repo predates hooks being recorded).
 */
export function hookDirFromManifest(manifest: ManagedManifest, fallback: HookDir): HookDir {
  const block = manifest.blocks.find(
    (b) => b.path.startsWith('.husky/') || b.path.startsWith('.git/hooks/') || b.path.startsWith(`${TRACKED_HOOK_DIR}/`)
  )
  if (block?.path.startsWith('.husky/')) return '.husky'
  if (block?.path.startsWith(`${TRACKED_HOOK_DIR}/`)) return TRACKED_HOOK_DIR
  if (block?.path.startsWith('.git/hooks/')) return '.git/hooks'
  return fallback
}

/**
 * The raw `core.hooksPath` value for this repo, or null when unset (or not a
 * git repo). Read-only.
 */
export async function readCoreHooksPath(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'config', '--get', 'core.hooksPath'])
    const v = stdout.trim()
    return v.length > 0 ? v : null
  } catch {
    return null
  }
}

/**
 * Arm the tracked-hooks routing: `git config core.hooksPath .vinaya/hooks`.
 * Written WITHOUT `--worktree`, so it lands in the shared common config and
 * covers every linked worktree of this clone at once; the value is relative,
 * so git resolves it against each working tree's own (tracked, therefore
 * present) copy. This is the one thing git cannot version — every fresh clone
 * runs it once, and `doctor` names the exact command until it has been run.
 */
export async function setCoreHooksPath(repoRoot: string, dir: string): Promise<void> {
  await execFileAsync('git', ['-C', repoRoot, 'config', 'core.hooksPath', dir])
}

/** Inverse of `setCoreHooksPath` — used by eject. `--unset` of an absent key
 *  exits non-zero; that is the already-clean case, not a failure. */
export async function unsetCoreHooksPath(repoRoot: string): Promise<void> {
  try {
    await execFileAsync('git', ['-C', repoRoot, 'config', '--unset', 'core.hooksPath'])
  } catch {
    // already unset — nothing to do.
  }
}

/** True when the repo routes hooks somewhere non-standard we must not guess at. */
export async function customHooksPath(repoRoot: string): Promise<string | null> {
  const v = await readCoreHooksPath(repoRoot)
  if (!v) return null
  // `.husky/_` is husky's own managed dir; `.vinaya/hooks` is vinaya's own
  // tracked dir — neither is a custom path we must refuse.
  if (v === '.husky' || v === '.husky/_' || v === TRACKED_HOOK_DIR) return null
  return v
}

/** gh-backed labels. Offline/test callers inject their own LabelGateway. */
export function ghLabelGateway(repoRoot: string): LabelGateway {
  return {
    async exists(name: string): Promise<boolean> {
      try {
        const { stdout } = await execFileAsync('gh', ['label', 'list', '--json', 'name'], { cwd: repoRoot })
        const names: Array<{ name: string }> = JSON.parse(stdout)
        return names.some((l) => l.name === name)
      } catch {
        // If we cannot enumerate, treat as absent and let create fail loudly
        // rather than silently skipping.
        return false
      }
    },
    async create(name: string, color: string, description: string): Promise<void> {
      await execFileAsync('gh', ['label', 'create', name, '--color', color, '--description', description], {
        cwd: repoRoot
      })
    }
  }
}
