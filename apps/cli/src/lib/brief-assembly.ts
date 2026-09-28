/**
 * Brief assembly — the forge/tree shim over `@attalabs/aeg-core`'s pure
 * `renderBrief`, extracted out of `commands/brief.ts` so a
 * second caller (`dispatchTask`) can render the exact same brief without a
 * second copy of this assembly. `briefRenderCommand`
 * itself is now argv-parsing plus this one call — see that file.
 *
 * Dispatch-gate assembly mirrors `checks/bin/check-dispatch-readiness.ts`
 * (same `resolveEdge`/`fetchForgeFacts`/`checkDispatchReadiness` composition)
 * rather than a fourth copy of that logic — `edge-resolve.ts`'s own doc
 * comment already records three such copies disagreeing before consolidation.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildConsumersOf,
  checkDispatchReadiness,
  checkIssueRationale,
  checkPremisesHold,
  extractBoundaryFilePaths,
  fetchForgeFacts,
  fetchOpenIssuesByLabel,
  objectivesOf,
  parseIssueDocumentation,
  parseIssueParts,
  parseIssuePremises,
  parseIssueStopConditions,
  parseIssueSurface,
  parseIssueTestPlan,
  parseRationaleFields,
  type PackageManifest,
  renderBrief,
  trancheLabel,
  type BriefFacts,
  type DispatchBlocker,
  type DispatchConflictsWithFact,
  type DispatchDependsOnFact,
  type DispatchGateInput,
  type DispatchPriorTrancheFact,
  type IssueDocumentation,
  type IssuePart,
  type IssueSurface,
  type IssueTestPlan,
  type LocalGateCommands,
  type SurfaceFileFact,
  type Task
} from '@attalabs/aeg-core'
import { parseRationaleDeps } from '@attalabs/aeg-forge-state'
import { createForgeSource } from '@attalabs/vinaya-sources'
import { type EdgeFactsSubset, type EdgeTaskRef, resolveEdge } from '../checks/edge-resolve.js'
import { loadConfig, loadTrustAnchorConfig, resolveGateCutovers, resolvePrincipalAllowlist } from './config.js'
import { briefCliInvocation } from './own-version.js'
import { packageRoot } from './package-root.js'
import { detectVendoredVinaya } from './self-host.js'

const DOC_OWNERS_PATH = '.vinaya/doc-owners'
/** The workspace member that owns the unabridged gate derivations a brief may name, and the name it must declare for this repository to be the one that owns them. */
const AEG_CORE_DIR = 'packages/aeg-core'
const AEG_CORE_PACKAGE_NAME = '@attalabs/aeg-core'
const WORKSPACE_TEMPLATE_PATH = 'aeg-root/templates/brief-template.md'
const PACKAGE_ROOT = packageRoot(import.meta.url)
const PACKAGED_TEMPLATE_PATH = join(PACKAGE_ROOT, 'aeg-root', 'templates', 'brief-template.md')
const TEMPLATE_PATH = existsSync(PACKAGED_TEMPLATE_PATH)
  ? PACKAGED_TEMPLATE_PATH
  : join(PACKAGE_ROOT, '..', '..', 'aeg-root', 'templates', 'brief-template.md')

/**
 * The two command facts every rendered brief needs about the repository it is
 * rendered for: how that repository invokes the CLI, and which unabridged
 * gate derivations it ships itself. Both are `renderBrief` inputs rather than
 * anything it detects — that module reads no filesystem — and both are
 * derived here, once, for the two `assembleAndRenderBrief*` entry points.
 *
 * The invocation reuses `briefCliInvocation`, i.e. the SAME vendored-CLI
 * detection the generated hooks and workflows make their own choice with, so a
 * brief and a hook in one repository never disagree about how the CLI is
 * reached.
 *
 * A local gate program is named only when this repository is identified, by
 * PACKAGE NAME, as one that owns that derivation: the CLI itself is vendored
 * here (`detectVendoredVinaya`, which matches on `@attalabs/vinaya`), the
 * `packages/aeg-core` member declares `@attalabs/aeg-core`, and the bin file
 * is present. The file's presence alone is deliberately not enough — a brief
 * names these to a Developer as commands to run with `bun`, and directory
 * shape is not identity: any repository (a fork, a single contributed commit)
 * carrying a file at that path would otherwise have it named as this
 * package's own derivation. `self-host.ts`'s `resolveAuthorRepoSourceEntry`
 * added the same package-name check to the same class of inference after a
 * security review, and this surface must not reintroduce the shape-only form.
 * A repository that identifies as neither gets `null` and a brief naming only
 * the shipped checks, which is exactly right for it.
 */
export function repoBriefCommandFacts(repoRoot: string): {
  cliInvocation: string
  localGateCommands: LocalGateCommands
} {
  const vendored = detectVendoredVinaya(repoRoot)
  const aegCoreName = readJson(join(repoRoot, AEG_CORE_DIR, 'package.json')).name
  const ownsAegCore = vendored !== null && typeof aegCoreName === 'string' && aegCoreName === AEG_CORE_PACKAGE_NAME
  const program = (rel: string): string | null => (ownsAegCore && existsSync(join(repoRoot, rel)) ? `bun ${rel}` : null)
  return {
    cliInvocation: briefCliInvocation(vendored, repoRoot),
    localGateCommands: {
      dispatchReadiness: program(`${AEG_CORE_DIR}/bin/verify-dispatch.ts`),
      docCoverage: program(`${AEG_CORE_DIR}/bin/verify-docs.ts`)
    }
  }
}

/** This checkout's git toplevel — the anchor every path in `repoBriefCommandFacts` resolves against. Falls back to the process cwd when `git` cannot answer, the same degradation `git()` itself takes. */
function repoRootOrCwd(): string {
  return git(['rev-parse', '--show-toplevel']) || process.cwd()
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/** Same shape `checks/bin/check-dispatch-readiness.ts` uses — kept local rather than a fourth copy of `resolveEdge`'s own two prior consolidations. */
function resolveRepo(): { owner: string; repo: string } | null {
  const fromEnv = process.env.AEG_REPO
  if (fromEnv) {
    const m = fromEnv.match(/^([^/]+)\/(.+)$/)
    if (m?.[1] && m[2]) return { owner: m[1], repo: m[2] }
  }
  const url = git(['remote', 'get-url', 'origin'])
  const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/)
  if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] }
  const https = url.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/)
  if (https?.[1] && https[2]) return { owner: https[1], repo: https[2] }
  return null
}

/**
 * Whether this checkout has enough infra to attempt a brief render at all —
 * the brief template exists on disk AND the owner/repo resolves
 * (`AEG_REPO`, or a GitHub `origin` remote). `false` means the pre-write
 * brief-render gate (`forge-write.ts`'s `validateRenderedBriefForIssue`)
 * stays DORMANT — never refused — the same dormant-when-infra-absent posture
 * this file's `docOwnersContent`/`sharedPackages` seams already take
 * elsewhere. A real `vinaya` invocation always runs inside a cloned repo
 * that carries this file and a real remote, so this degrades only a rare
 * edge case (an Issue write attempted outside any real checkout, or a test
 * fixture with no repo/template infra of its own), never the normal path —
 * and it is checked BEFORE the render's own staleness/dispatch-readiness/
 * missing-section checks run, so a real checkout still gets the full,
 * fail-closed gate this pre-write validation requires.
 */
export function canRenderBriefFromHere(): boolean {
  return existsSync(WORKSPACE_TEMPLATE_PATH) && resolveRepo() !== null
}

async function resolveToken(): Promise<string | null> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  try {
    return (
      execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
    )
  } catch {
    return null
  }
}

/** `git ls-files -- <glob>`, one call per glob so an empty result names ITS OWN glob, not the whole batch. */
export function expandGlob(glob: string): string[] {
  const out = git(['ls-files', '--', glob])
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * `git ls-remote --symref origin HEAD` — the remote's default branch name
 * and the sha it currently points at, in one network round trip that
 * touches no local ref (no `git fetch`). `null` when the remote cannot be
 * reached (offline) — `assembleAndRenderBrief` refuses preparation rather
 * than rendering from a checkout of unknown freshness (Stop condition:
 * "The remote default branch cannot be
 * resolved — refuse preparation").
 */
export function resolveRemoteDefaultBranch(cwd?: string): { branch: string; sha: string } | null {
  let out: string
  try {
    out = execFileSync('git', ['ls-remote', '--symref', 'origin', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return null
  }
  const lines = out.split('\n')
  const symrefLine = lines.find((l) => l.startsWith('ref:'))
  const shaLine = lines.find((l) => !l.startsWith('ref:') && /\tHEAD$/.test(l))
  const branch = symrefLine ? /^ref:\s*refs\/heads\/(\S+)/.exec(symrefLine)?.[1] : undefined
  const sha = shaLine?.split('\t')[0]
  return branch && sha ? { branch, sha } : null
}

/**
 * A frozen brief always states the revision its facts were read at
 * — the first of the two guarantees:
 * `headSha` must equal the remote default branch's current tip, "compare
 * HEAD to the fetched remote default branch" per the Boundary. `resolveRemote`
 * is injected so this is testable against a fixture repo with no real
 * network dependency. Returns a `missing`-shaped reason, never throws — the
 * caller decides what a non-empty return means.
 */
/**
 * The refusal both the fast-forward step and the staleness check share when
 * the remote cannot be reached — refusing rather than rendering from a
 * checkout of unknown freshness (O3: "when the remote cannot be reached,
 * preparation refuses as today"). One string so the two never drift.
 */
const OFFLINE_REFUSAL =
  'the remote default branch could not be resolved (`git ls-remote origin HEAD` failed — offline?) — refusing rather than rendering from a checkout of unknown freshness.'

export function checkStaleAgainstRemote(
  headSha: string,
  resolveRemote: () => { branch: string; sha: string } | null = resolveRemoteDefaultBranch
): string[] {
  const remote = resolveRemote()
  if (!remote) {
    return [OFFLINE_REFUSAL]
  }
  if (headSha !== remote.sha) {
    return [
      `checkout HEAD \`${headSha}\` is behind the remote default branch \`${remote.branch}\` at \`${remote.sha}\` — fetch and update before preparing a brief.`
    ]
  }
  return []
}

/**
 * O1/O2/O3 — the fast-forward step both brief-preparation callers run BEFORE
 * `checkStaleAgainstRemote`. Every merged pull request moves the remote
 * default branch, and an Operator (no shell) was then blocked at the next
 * start until a person ran `git pull` by hand — four times on 2026-09-27/28.
 * A checkout that is on the default branch, carries no uncommitted change to a
 * tracked file, and is strictly BEHIND the remote tip can be advanced to it
 * with no loss, so this fast-forwards it (`git merge --ff-only`, after a
 * `git fetch` of the default branch — never a reset, rebase, or checkout) and
 * preparation continues (O1).
 *
 * It moves NOTHING when any of the three unsafe cases holds, naming which one
 * it found and the exact command that clears it (O2): a checkout on ANOTHER
 * branch (or a detached HEAD), one with UNCOMMITTED changes to tracked files
 * (untracked files never block — Traps to avoid), or one carrying LOCAL
 * COMMITS the remote does not have (ahead, or diverged — never discarded).
 * When the remote cannot be reached it refuses exactly as the staleness check
 * does (O3).
 *
 * `cwd`/`resolveRemote` are injected so this is testable against a fixture
 * repo with a local remote and no network — the same discipline
 * `checkStaleAgainstRemote`'s own tests use. The one-line move report (O1) is
 * written to stderr here so a captured brief on stdout is never contaminated,
 * and the `{from,to}` is returned too so a test can assert the move without
 * capturing a stream. A checkout already at the tip is a `noop` (nothing to
 * move; the staleness check that follows confirms it, and the unchanged
 * `checkDirtyPinnedFiles` still guards a dirty pinned file there as before).
 */
export type FastForwardOutcome =
  | { kind: 'noop' }
  | { kind: 'moved'; from: string; to: string }
  | { kind: 'refused'; reason: string }

export function fastForwardToRemoteIfSafe(
  cwd?: string,
  resolveRemote: () => { branch: string; sha: string } | null = () => resolveRemoteDefaultBranch(cwd)
): FastForwardOutcome {
  const run = (args: string[]): { ok: true; out: string } | { ok: false } => {
    try {
      return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
    } catch {
      return { ok: false }
    }
  }

  const remote = resolveRemote()
  if (!remote) return { kind: 'refused', reason: OFFLINE_REFUSAL }

  const headRes = run(['rev-parse', 'HEAD'])
  const headSha = headRes.ok ? headRes.out.trim() : ''
  // Already at the remote tip — nothing to fast-forward.
  if (headSha && headSha === remote.sha) return { kind: 'noop' }

  // Unsafe case 1 — on another branch (or a detached HEAD): preparation
  // fast-forwards only a checkout sitting on the default branch.
  const branchRes = run(['symbolic-ref', '--short', '-q', 'HEAD'])
  const currentBranch = branchRes.ok ? branchRes.out.trim() : ''
  if (currentBranch !== remote.branch) {
    const where = currentBranch ? `branch \`${currentBranch}\`` : 'a detached HEAD'
    return {
      kind: 'refused',
      reason:
        `checkout is on ${where}, not the remote default branch \`${remote.branch}\` — ` +
        `preparation fast-forwards only a checkout on the default branch; switch to it first: \`git switch ${remote.branch}\`.`
    }
  }

  // Unsafe case 2 — uncommitted changes to tracked files. `--untracked-files=no`
  // so an operator's scratch file never blocks (Traps to avoid). Never `.trim()`
  // the porcelain blob before slicing: its status codes occupy the first two
  // columns, and trimming would shift every line (the lesson `checkDirtyPinnedFiles`
  // records).
  const statusRes = run(['status', '--porcelain', '--untracked-files=no'])
  if (statusRes.ok && statusRes.out.trim().length > 0) {
    const dirty = statusRes.out
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
    return {
      kind: 'refused',
      reason:
        `checkout carries uncommitted changes to tracked file(s): ${dirty.join(', ')} — ` +
        'preparation never discards them; commit or stash them first: `git stash`.'
    }
  }

  // Bring the remote default branch's objects local — this updates FETCH_HEAD
  // and the remote-tracking ref only, never HEAD or the working tree, so
  // "move nothing until every unsafe case is cleared" still holds. A fetch that
  // fails after `ls-remote` already succeeded is a transient loss of the
  // remote: refuse as offline (O3).
  const fetchRes = run(['fetch', 'origin', remote.branch])
  if (!fetchRes.ok) return { kind: 'refused', reason: OFFLINE_REFUSAL }

  // Unsafe case 3 — HEAD is not an ancestor of the remote tip: the checkout
  // carries local commit(s) the remote does not have (ahead, or diverged), and
  // a fast-forward would either be impossible or silently drop them.
  const isAncestor = run(['merge-base', '--is-ancestor', headSha, remote.sha])
  if (!isAncestor.ok) {
    return {
      kind: 'refused',
      reason:
        `checkout has local commit(s) the remote default branch \`${remote.branch}\` does not have — ` +
        'preparation never discards them; push or integrate them first: `git push`.'
    }
  }

  // Safe: on the default branch, clean, and strictly behind — fast-forward to
  // the remote tip and continue.
  const merge = run(['merge', '--ff-only', remote.sha])
  if (!merge.ok) {
    return {
      kind: 'refused',
      reason:
        `fast-forward to the remote default branch \`${remote.branch}\` at \`${remote.sha}\` failed — ` +
        'update the checkout by hand first: `git pull --ff-only`.'
    }
  }
  process.stderr.write(
    `fast-forwarded checkout on \`${remote.branch}\` from \`${headSha}\` to \`${remote.sha}\` before preparing the brief.\n`
  )
  return { kind: 'moved', from: headSha, to: remote.sha }
}

/**
 * The second of the two guarantees: a
 * checkout can equal the remote default branch's tip and still carry
 * uncommitted edits to a file the brief pins — exactly the case that froze a
 * wrong tier and a forbidden file in a prior task (Traps to avoid). Scoped
 * to `pinnedPaths` only — `git status --porcelain -- <pinnedPaths>` — so an
 * operator's unrelated scratch file never blocks preparation.
 */
export function checkDirtyPinnedFiles(pinnedPaths: string[], cwd?: string): string[] {
  if (pinnedPaths.length === 0) return []
  let out: string
  try {
    // Never `.trim()` the raw output: porcelain's status codes occupy the
    // FIRST two columns (e.g. ` M pinned.md`), and trimming the whole blob
    // would eat that leading space, shifting every line's slice and
    // clipping a character off the real filename — found live writing this
    // test.
    out = execFileSync('git', ['status', '--porcelain', '--', ...pinnedPaths], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    return [
      `could not check working-tree status for the brief's pinned files: ${err instanceof Error ? err.message : String(err)}`
    ]
  }
  if (!out.trim()) return []
  const dirty = out
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
  return [
    `checkout carries uncommitted changes to pinned file(s): ${dirty.join(', ')} — commit or discard them before preparing a brief.`
  ]
}

/**
 * Resolves each `extractBoundaryFilePaths` token to a real tracked path
 * against `allTrackedFiles` (a `git ls-files` snapshot, injected rather than
 * read here so this stays testable without a real repo) — an exact match, or
 * a UNIQUE suffix match for a bare filename elided from a shared directory
 * prefix in the Boundary prose (e.g. a real brief's own "aeg-root/
 * aeg-manual-flow.md, process.md, roles/developer.md"). A token matching
 * zero or more-than-one tracked file is dropped, never guessed.
 */
export function resolveBoundaryPaths(tokens: string[], allTrackedFiles: string[]): string[] {
  const trackedSet = new Set(allTrackedFiles)
  const resolved = new Set<string>()
  for (const token of tokens) {
    if (trackedSet.has(token)) {
      resolved.add(token)
      continue
    }
    const suffix = `/${token}`
    const suffixMatches = allTrackedFiles.filter((f) => f.endsWith(suffix))
    if (suffixMatches.length === 1) resolved.add(suffixMatches[0] as string)
  }
  return [...resolved]
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function readManifest(dir: string): PackageManifest | null {
  const manifest = readJson(join(dir, 'package.json'))
  return Object.keys(manifest).length === 0 ? null : (manifest as PackageManifest)
}

/** `apps/cli`/`packages/aeg-core` → that workspace member's own `package.json` `name` field, or `null` outside any workspace member — never a directory path, per `SurfaceFileFact.packageName`'s own contract. */
export function packageNameForPath(path: string): string | null {
  const m = /^((?:packages|apps)\/[^/]+)\//.exec(path)
  if (!m) return null
  const manifest = readJson(join(m[1] as string, 'package.json'))
  return typeof manifest.name === 'string' ? manifest.name : null
}

function workspaceGlobs(): string[] {
  const root = readJson('package.json')
  return Array.isArray(root.workspaces) ? (root.workspaces as string[]) : []
}

/**
 * `consumersOf(pkg)` built from the live workspace dependency graph — the
 * exact enumeration both `assembleAndRenderBrief*` functions already build
 * inline, exported so `forge-write.ts`'s pre-write
 * `checkBriefSections` call uses the SAME consumer enumeration
 * `checkConsumerTests` grades a dispatched brief against, rather than a
 * second, independently-derived one.
 */
export function buildWorkspaceConsumersOf(): (pkg: string) => string[] {
  return buildConsumersOf(workspaceGlobs(), listDirs, readManifest)
}

/**
 * `issue` is the real forge Issue number this brief was rendered from and
 * closes — `task.issue`, resolved below from the tranche's forge-derived
 * task list, never the raw task id a caller passed in as `taskId`. Returned
 * rather than discarded so a caller that only has the task id (`dispatchTask`)
 * can still post to and read from the Issue this brief actually belongs to,
 * instead of reusing the task id as if it were an Issue number — live
 * evidence: dispatching a real task with this field discarded posted its
 * brief on an unrelated, already-merged Issue that happened to share its number.
 *
 * `dispatchBlockerDetails`, on the `ok: false` branch, is the dispatch
 * gate's own classified verdict (`checkDispatchReadiness`'s
 * `blockerDetails`) at the moment `renderBrief` ran — `undefined` when the
 * render never reached that point (an earlier refusal: unresolved repo,
 * stale checkout, task not found, …), `[]` when it ran and found nothing to
 * block on. Additive: `dispatchTask`/`prepareTask` (`dispatch-task.ts`)
 * never read it and keep refusing on a plain `ok: false` exactly as before
 * (dispatch's own posture is unchanged). It exists so a caller that DOES
 * need to tell a dependency/conflict finding apart from every other render
 * gap (the Issue write gate, `forge-write.ts`'s
 * `validateRenderedBriefForIssue`) can, without re-deriving the dispatch
 * gate's own classification a second time.
 */
/**
 * One repository-relative path as a given revision holds it — `null` when that
 * revision has no such file. Read with `git show`, never off the working tree:
 * by the time the dispatch premise check runs, `checkStaleAgainstRemote` has
 * already established that `HEAD` IS the remote default branch's tip, so the
 * commit's bytes are the default branch's bytes and an uncommitted local edit
 * can neither satisfy a premise nor break one. `git()` cannot serve here —
 * it trims, and a premise's literal may sit in leading or trailing whitespace.
 */
export function readFileAtRevision(rev: string, path: string, cwd?: string): string | null {
  try {
    return execFileSync('git', ['show', `${rev}:${path}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return null
  }
}

/**
 * Which of an Issue's premises a brief preparation asserts.
 *
 * `'all'` — a real dispatch (O3). Every premise is asserted, deferred ones
 * included: an `after #<n>:` premise is unchecked when the Issue is cut
 * precisely because the task that makes it true has not merged yet, so
 * dispatch is the first moment it can be asserted at all.
 *
 * `'due-now'` — the pre-write render `issue create`/`issue edit` runs to grade
 * the bytes it is about to send (`forge-write.ts`'s
 * `validateRenderedBriefForIssue`). That render happens at PLAN time, where a
 * deferred premise is not true yet by construction, so asserting it would
 * refuse the very write the deferral exists to allow — O2, and the exact
 * bypass round 2's review found: the plan-time gate filtered deferred
 * premises out and then this same write re-checked them, unfiltered, through
 * the render path. The two now agree, because a plan-time render asks for the
 * same subset `checkIssuePremises` asks for.
 */
export type PremiseScope = 'all' | 'due-now'

/**
 * **O3 — an Issue's premises, re-checked against the default branch before a
 * brief is rendered.** One refusal line per premise that does not hold,
 * naming it; empty when they all do. `scope` decides which premises are
 * asserted at all — see `PremiseScope`; a plan-time render passes `'due-now'`,
 * a dispatch `'all'`.
 *
 * An unprefixed premise true when the Issue was cut can have been falsified by
 * any merge since, so it is asserted under BOTH scopes. The predicate and the
 * refusal wording are `@attalabs/aeg-core`'s (`checkPremisesHold`), the same
 * ones `issue create`/`issue edit` apply, so the two moments can never
 * disagree about what a premise means.
 *
 * `readAt` is injected for testing against a fixture repository; the default
 * reads the real revision.
 */
export function dispatchPremiseRefusals(
  issueBody: string,
  rev: string,
  scope: PremiseScope = 'all',
  readAt: (rev: string, path: string) => string | null = readFileAtRevision
): string[] {
  const parsed = parseIssuePremises(issueBody)
  if (!parsed.ok) return parsed.errors.map((e) => `Premises: ${e}`)
  const asserted = parsed.value
    .map((premise, index) => ({ premise, index }))
    .filter(({ premise }) => scope === 'all' || premise.afterIssue === null)
  return checkPremisesHold(asserted, (path) => readAt(rev, path))
}

export type AssembleAndRenderBriefResult =
  | { ok: true; brief: string; issue: number }
  | { ok: false; missing: string[]; dispatchBlockerDetails?: DispatchBlocker[] }

/**
 * **O2 — names what dispatch looked for.** A bare "not
 * present in the forge-derived task list" message leaves the operator
 * guessing whether the Issue was never cut, mislabeled, or the title doesn't
 * match — this names the exact title form `vinaya task dispatch` expects,
 * the label it queried, and how many open Issues actually carry that label,
 * so the three causes (no Issue yet, wrong label, wrong title) are
 * distinguishable from the message alone rather than requiring a second
 * `gh issue list` by hand.
 */
export function taskNotFoundMessage(trancheSlug: string, taskId: string, openIssueCount: number): string {
  return (
    `task "${taskId}" is not present in tranche "${trancheSlug}"'s forge-derived task list — ` +
    `looked for an open Issue titled \`[${trancheSlug}] ${taskId} —\` carrying label ` +
    `\`${trancheLabel(trancheSlug)}\`; ${openIssueCount} open Issue(s) carry that label.`
  )
}

/**
 * Renders the twelve-section brief for `<tranche> <n>` from the forge and the
 * tree — the exact assembly `vinaya brief render` has always run, callable
 * without an argv/stdout shell around it. `surfaceGlobsOverride`, when given,
 * is the `--surfaces` flag's expanded glob list (brief.ts's own caller);
 * omitted, the Issue's own `## Surface` `in:` list is used instead — the only
 * shape a non-interactive caller like `dispatchTask` can supply, since there
 * is no operator present to type a `--surfaces` flag. An empty `in:` list
 * (no `## Surface` section at all) is not specially handled here: it flows
 * through as zero globs, and `renderBrief`'s own missing-fact check already
 * refuses on `facts.surface.in.length === 0`, naming the Surface section —
 * the same refusal a `--surfaces`-less `brief render` call would produce.
 *
 * `bodyOverride`, when given, replaces the live forge Issue body used for
 * every section this renders (Objectives/Surface/Parts/Test plan/Stop
 * conditions/rationale) — the pre-write validation path (`forge-write.ts`'s
 * `validateRenderedBriefForIssue`) needs to grade the bytes a tranche-labeled
 * `issue edit`/`issue objectives edit` is ABOUT to send, not what is on the
 * forge before it lands. `task`/`dependsOn`/`conflictsWith` still come from
 * the tranche's own forge-derived task list, unaffected by a body edit — the
 * same source `assembleAndRenderBrief` always reads those from.
 */
export async function assembleAndRenderBrief(
  trancheSlug: string,
  taskId: string,
  surfaceGlobsOverride?: string[],
  bodyOverride?: string,
  premiseScope: PremiseScope = 'all'
): Promise<AssembleAndRenderBriefResult> {
  const repo = resolveRepo()
  if (!repo) {
    return {
      ok: false,
      missing: ['could not resolve owner/repo (set AEG_REPO=owner/repo, or confirm `git remote get-url origin`).']
    }
  }

  // O1/O2/O3 — a clean default-branch checkout that is only behind is
  // fast-forwarded to the remote tip first, so a merge moving the remote
  // default branch never blocks the next start; the three unsafe cases and an
  // unreachable remote refuse (`fastForwardToRemoteIfSafe`, the one function
  // both brief-preparation callers run before the staleness check). Done here,
  // before any forge read, so a refused checkout never pays for a Tranche/Issue
  // fetch it is about to refuse anyway.
  const fastForward = fastForwardToRemoteIfSafe()
  if (fastForward.kind === 'refused') return { ok: false, missing: [fastForward.reason] }

  // Read HEAD *after* the fast-forward, so the staleness backstop below and the
  // frozen brief's own `sourceRevision` reflect the tip actually rendered from.
  const headSha = git(['rev-parse', 'HEAD'])
  const staleness = checkStaleAgainstRemote(headSha)
  if (staleness.length > 0) return { ok: false, missing: staleness }

  const source = createForgeSource({ owner: repo.owner, repo: repo.repo })
  let tranche: Awaited<ReturnType<typeof source.getTranche>>
  try {
    tranche = await source.getTranche(trancheSlug)
  } catch (err) {
    return {
      ok: false,
      missing: [
        `could not derive tranche "${trancheSlug}" from the forge: ${err instanceof Error ? err.message : String(err)}`
      ]
    }
  }
  const task = tranche.tasks.find((t) => t.id === taskId)

  // Fetched here, before the not-found return below, so O2's enriched
  // message can name how many open Issues actually carry the tranche label
  // — the same fetch `openIssueMatch` below needs regardless.
  const token = (await resolveToken()) ?? ''
  const openIssuesBySlug = await fetchOpenIssuesByLabel([trancheSlug], repo.owner, repo.repo, token)
  const openIssues = openIssuesBySlug.get(trancheSlug) ?? []

  if (!task) {
    return {
      ok: false,
      missing: [taskNotFoundMessage(trancheSlug, taskId, openIssues.length)]
    }
  }

  const openIssueMatch = task.issue !== null ? openIssues.find((i) => i.number === task.issue) : undefined

  if (task.issue === null) {
    return { ok: false, missing: [`task "${taskId}" has no Issue (#TBD or blank) — not renderable until one is cut.`] }
  }
  if (!openIssueMatch) {
    return {
      ok: false,
      missing: [
        `Issue #${task.issue} for task "${taskId}" could not be read (closed, or not labeled \`vinaya/tranche:${trancheSlug}\`) — a brief renders only from an open, labeled task Issue.`
      ]
    }
  }
  const issueBody = bodyOverride ?? openIssueMatch.body
  const issueRationalePass = checkIssueRationale(issueBody).status !== 'fail'

  // O3 — the Issue's own premises, re-asserted against the default branch
  // before anything is rendered from them. `premiseScope` is what keeps a
  // plan-time render out of O2's way: it defaults to a dispatch's `'all'`, and
  // the pre-write validation path passes `'due-now'`.
  const premiseRefusals = dispatchPremiseRefusals(issueBody, headSha, premiseScope)
  if (premiseRefusals.length > 0) return { ok: false, missing: premiseRefusals }

  const taskRefs = tranche.tasks.map((t) => ({ id: t.id, issue: t.issue }))
  const snapshot = await fetchForgeFacts({ owner: repo.owner, repo: repo.repo, tranche: trancheSlug, tasks: taskRefs })
  const taskById = new Map(tranche.tasks.map((t) => [t.id, t]))

  const dependsOn: DispatchDependsOnFact[] = await Promise.all(
    task.dependsOn.map(async (dep) => {
      const r = await resolveEdge(dep, taskById, snapshot.facts, repo)
      return {
        id: dep,
        issue: r.issue,
        merged: r.merged,
        resolved: r.resolved,
        issueState: r.issueState,
        stateReason: r.stateReason,
        closedByActor: r.closedByActor
      }
    })
  )
  const conflictsWith: DispatchConflictsWithFact[] = await Promise.all(
    task.conflictsWith.map(async (c) => {
      const r = await resolveEdge(c, taskById, snapshot.facts, repo)
      return { id: c, issue: r.issue, openOrInFlight: r.open }
    })
  )
  const priorTrancheArchival: DispatchPriorTrancheFact[] = []

  const gateInput: DispatchGateInput = {
    trancheSlug,
    task,
    issue: { number: task.issue, state: 'open' },
    issueRationalePass,
    dependsOn,
    conflictsWith,
    priorTask: null,
    priorTrancheArchival,
    principalAllowlist: resolvePrincipalAllowlist(loadTrustAnchorConfig())
  }
  const gate = checkDispatchReadiness(gateInput)

  const surfaceResult = parseIssueSurface(issueBody)
  const surface: IssueSurface = surfaceResult.ok ? surfaceResult.value : { in: [], out: [] }
  const rationale = parseRationaleFields(issueBody)

  // Every declared Surface glob must still resolve to at least one real
  // tracked file — a sanity check on the Issue's own `## Surface` `in:`
  // list, catching a typo'd/empty directory — but the MATCHES themselves are
  // no longer what §4's file list is built from (see below): a directory-
  // level glob is never a file-level change set.
  const globs = surfaceGlobsOverride ?? surface.in
  for (const glob of globs) {
    if (expandGlob(glob).length === 0) {
      return { ok: false, missing: [`--surfaces glob "${glob}" matched no tracked file.`] }
    }
  }

  // §4's Create/Modify file list and premise pins are the files the
  // Boundary rationale field actually names — the only per-task source
  // precise enough to produce a brief a developer can act on, since a
  // directory-level Surface glob can only ever name a whole directory.
  const allTrackedFiles = git(['ls-files'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const boundaryTokens = extractBoundaryFilePaths(rationale.boundary ?? '')
  const surfaceFiles: SurfaceFileFact[] = resolveBoundaryPaths(boundaryTokens, allTrackedFiles)
    .sort()
    .map((path) => ({ path, sha256: sha256OfFile(path), packageName: packageNameForPath(path) }))

  // O1 — the second of the two guarantees: HEAD can equal the remote
  // default branch's tip and the tree can still be dirty on a file the
  // brief pins. Scoped to `surfaceFiles`' own paths, never the whole tree
  // (Traps to avoid: an unrelated scratch file must never block).
  const dirtiness = checkDirtyPinnedFiles(surfaceFiles.map((f) => f.path))
  if (dirtiness.length > 0) return { ok: false, missing: dirtiness }

  const workspaces = workspaceGlobs()
  const consumersOf = buildConsumersOf(workspaces, listDirs, readManifest)

  const partsResult = parseIssueParts(issueBody)
  const testPlanResult = parseIssueTestPlan(issueBody)
  const stopConditionsResult = parseIssueStopConditions(issueBody)
  const documentationResult = parseIssueDocumentation(issueBody)

  // A whole-suite Test plan line (a bare `bun test`, a
  // directory argument, any `bunx turbo test` form, `vitest run` on a
  // package) must refuse here, naming the offending line, rather than
  // falling through to `renderBrief`'s generic absent-section message: an
  // empty fallback discards `testPlanResult.errors`, which is where the
  // offending line actually lives.
  if (!testPlanResult.ok) return { ok: false, missing: testPlanResult.errors }

  const parts: IssuePart[] = partsResult.ok ? partsResult.value : []
  const testPlan: IssueTestPlan = testPlanResult.value
  const stopConditions: string[] = stopConditionsResult.ok ? stopConditionsResult.value : []
  const documentation: IssueDocumentation = documentationResult.ok
    ? documentationResult.value
    : { kind: 'sources', sources: [] }

  const facts: BriefFacts = {
    trancheSlug,
    taskId,
    title: task.title,
    issue: task.issue,
    projects: task.projects,
    dependsOn: task.dependsOn,
    conflictsWith: task.conflictsWith,
    rationale,
    objectives: (() => {
      const parsed = objectivesOf(issueBody)
      return parsed.ok ? parsed.objectives : []
    })(),
    surface,
    parts,
    testPlan,
    stopConditions,
    documentation,
    premises: (() => {
      const parsed = parseIssuePremises(issueBody)
      return parsed.ok ? parsed.value : []
    })(),
    // An absent `gateCutovers` key resolves to no cutover, so the renderer's
    // missing-`## Objectives`/`## Documentation` refusal grandfathers exactly
    // the class the Issue gate does (O1); this repo restates its own (O2).
    cutovers: resolveGateCutovers(loadConfig()),
    dispatchReady: gate.ready,
    dispatchBlockers: gate.blockers,
    surfaceFiles,
    consumersOf,
    docOwnersContent: existsSync(DOC_OWNERS_PATH) ? readFileSync(DOC_OWNERS_PATH, 'utf8') : null,
    sourceRevision: headSha,
    ...repoBriefCommandFacts(repoRootOrCwd())
  }

  const template = readFileSync(TEMPLATE_PATH, 'utf8')
  const result = renderBrief(facts, template)
  return result.ok
    ? { ok: true, brief: result.brief, issue: task.issue }
    : { ok: false, missing: result.missing, dispatchBlockerDetails: gate.blockerDetails }
}

/**
 * The tranche task id already carrying `issueNumber`, or `null` when the
 * tranche cannot be derived or no task in its forge-derived list carries
 * this Issue number yet — the pre-write render/validate gate's own way of
 * telling an ordinary edit of an existing tranche-attached task Issue (this
 * lookup succeeds; render it) apart from a brand-new `issue create` still in
 * flight (no real Issue number exists yet to look up — genuinely circular,
 * left dormant the same way it always was).
 */
export async function resolveTrancheTaskId(trancheSlug: string, issueNumber: number): Promise<string | null> {
  const repo = resolveRepo()
  if (!repo) return null
  try {
    const source = createForgeSource({ owner: repo.owner, repo: repo.repo })
    const tranche = await source.getTranche(trancheSlug)
    return tranche.tasks.find((t) => t.issue === issueNumber)?.id ?? null
  } catch {
    return null
  }
}

/**
 * A not-yet-created (or not-yet-written) Issue has no real number to compare
 * against a cutover-by-Issue-number rule (`checkIssueObjectives`,
 * `checkBlastRadiusScope`'s O4, `checkDocsWithinSurface`,
 * `checkRationaleSurfaceCoverage`) — this sentinel forces every such
 * comparison unambiguously past every cutover, the same fail-closed posture
 * those rules already take for `issueNumber === null`: never a guess that a
 * draft might be old enough to skip a rule.
 */
export const DRAFT_ISSUE_SENTINEL = Number.MAX_SAFE_INTEGER

/**
 * `assembleAndRenderBriefForIssue`'s pre-write escape hatch — the drafted
 * title/body/labels a forge write is ABOUT to send, so the
 * brief renders from the bytes the write will produce rather than
 * `fetchIssueForBrief`'s live (pre-edit) read of what is on the forge NOW.
 * Given, the function skips the fetch entirely and treats the draft as
 * `OPEN` (a draft has no state yet — nothing to check against `found.state`
 * for a create/edit still in flight).
 */
export type DraftIssueOverride = { title: string; body: string; labels: string[] }

type IssueForBrief = { title: string; body: string; labels: string[]; state: 'OPEN' | 'CLOSED' }

function fetchIssueForBrief(issueNumber: number): IssueForBrief | null {
  try {
    const out = execFileSync('gh', ['issue', 'view', String(issueNumber), '--json', 'title,body,labels,state'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const parsed = JSON.parse(out) as {
      title: string
      body: string
      labels: { name: string }[]
      state: 'OPEN' | 'CLOSED'
    }
    return {
      title: parsed.title,
      body: parsed.body ?? '',
      labels: parsed.labels.map((l) => l.name),
      state: parsed.state
    }
  } catch {
    return null
  }
}

/** The header's `**Project(s):**`/`**Project:**` field — the one BriefFacts.projects source a backlog Issue has, since it carries no tranche topology row to read `Project(s)` off of. `[]` when absent (the same absent-sentinel convention every other BriefFacts list field already uses). */
function extractProjectField(body: string): string[] {
  const headerEnd = body.search(/\n##\s/)
  const header = headerEnd === -1 ? body : body.slice(0, headerEnd)
  const m = /^\*{0,2}Project(?:\(s\))?\*{0,2}\s*:\s*(.+)$/im.exec(header)
  if (!m) return []
  return (m[1] as string)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Renders the same twelve-section brief as `assembleAndRenderBrief`, but for
 * a backlog Issue with no tranche — `<n>` names
 * the Issue itself, never a tranche+task-id pair. Every section is filled
 * from the Issue's own `## Objectives`/`## Surface`/`## Parts`/
 * `## Test plan`/`## Stop conditions` and its "Dependency rationale" field
 * (`parseRationaleDeps`, edges optional), the same pure parsers
 * `assembleAndRenderBrief` already uses — never a second grammar. Refuses
 * (rather than rendering) when the Issue carries a `vinaya/tranche:*` label:
 * that Issue has a real tranche home and belongs on the tranche path, not
 * this one.
 *
 * `override`, when given, skips `fetchIssueForBrief`
 * entirely and renders from the SUPPLIED title/body/labels instead of a live
 * forge read — the pre-write validation path (`forge-write.ts`'s
 * `validateRenderedBriefForIssue`) needs to grade the bytes a write is about
 * to send, not what is on the forge before it lands. `issueNumber` may be
 * `DRAFT_ISSUE_SENTINEL` for an `issue create` still in flight (no real
 * number exists yet); every other caller passes the real one.
 */
export async function assembleAndRenderBriefForIssue(
  issueNumber: number,
  override?: DraftIssueOverride,
  premiseScope: PremiseScope = 'all'
): Promise<AssembleAndRenderBriefResult> {
  const repo = resolveRepo()
  if (!repo) {
    return {
      ok: false,
      missing: ['could not resolve owner/repo (set AEG_REPO=owner/repo, or confirm `git remote get-url origin`).']
    }
  }

  // O1/O2/O3 — the same fast-forward-before-staleness step the tranche path
  // runs (see `assembleAndRenderBrief`): both brief-preparation callers of the
  // staleness check share this one function.
  const fastForward = fastForwardToRemoteIfSafe()
  if (fastForward.kind === 'refused') return { ok: false, missing: [fastForward.reason] }

  const headSha = git(['rev-parse', 'HEAD'])
  const staleness = checkStaleAgainstRemote(headSha)
  if (staleness.length > 0) return { ok: false, missing: staleness }

  const found: IssueForBrief | null = override
    ? { title: override.title, body: override.body, labels: override.labels, state: 'OPEN' }
    : fetchIssueForBrief(issueNumber)
  if (!found) {
    return { ok: false, missing: [`could not fetch Issue #${issueNumber} (\`gh issue view\`).`] }
  }
  if (found.labels.some((l) => l.startsWith('vinaya/tranche:'))) {
    return {
      ok: false,
      missing: [
        `Issue #${issueNumber} carries a \`vinaya/tranche:*\` label — it belongs to a tranche and renders via \`vinaya task brief <tranche> <n>\`, not the tranche-less backlog path.`
      ]
    }
  }
  if (!override && found.state !== 'OPEN') {
    return { ok: false, missing: [`Issue #${issueNumber} is not open (state: ${found.state}) — not renderable.`] }
  }
  const issueBody = found.body
  const issueRationalePass = checkIssueRationale(issueBody).status !== 'fail'

  // O3 — the same premise re-assertion the tranche path runs, on the one
  // shared function and under the same scope rule; a backlog Issue's premises
  // are premises too, and a backlog Issue's plan-time render is exactly where
  // round 2's review found the deferred-premise double-check.
  const premiseRefusals = dispatchPremiseRefusals(issueBody, headSha, premiseScope)
  if (premiseRefusals.length > 0) return { ok: false, missing: premiseRefusals }

  const { dependsOn: dependsOnIds, conflictsWith: conflictsWithIds } = parseRationaleDeps(issueBody)
  const task: Task = {
    id: String(issueNumber),
    title: found.title,
    issue: issueNumber,
    projects: extractProjectField(issueBody),
    dependsOn: dependsOnIds,
    conflictsWith: conflictsWithIds,
    rationaleMarkdown: ''
  }

  // No same-tranche siblings to resolve a bare id against — a backlog Issue's
  // own edges resolve only through `resolveEdge`'s `#NNN`/slug-qualified
  // paths (O2: "optional on such an Issue and enforced when present").
  const taskById = new Map<string, EdgeTaskRef>()
  const factsByTaskId = new Map<string, EdgeFactsSubset>()
  const dependsOn: DispatchDependsOnFact[] = await Promise.all(
    task.dependsOn.map(async (dep) => {
      const r = await resolveEdge(dep, taskById, factsByTaskId, repo)
      return {
        id: dep,
        issue: r.issue,
        merged: r.merged,
        resolved: r.resolved,
        issueState: r.issueState,
        stateReason: r.stateReason,
        closedByActor: r.closedByActor
      }
    })
  )
  const conflictsWith: DispatchConflictsWithFact[] = await Promise.all(
    task.conflictsWith.map(async (c) => {
      const r = await resolveEdge(c, taskById, factsByTaskId, repo)
      return { id: c, issue: r.issue, openOrInFlight: r.open }
    })
  )
  const priorTrancheArchival: DispatchPriorTrancheFact[] = []

  const gateInput: DispatchGateInput = {
    trancheSlug: `issue-${issueNumber}`,
    task,
    issue: { number: issueNumber, state: 'open' },
    issueRationalePass,
    dependsOn,
    conflictsWith,
    priorTask: null,
    priorTrancheArchival,
    principalAllowlist: resolvePrincipalAllowlist(loadTrustAnchorConfig())
  }
  const gate = checkDispatchReadiness(gateInput)

  const surfaceResult = parseIssueSurface(issueBody)
  const surface: IssueSurface = surfaceResult.ok ? surfaceResult.value : { in: [], out: [] }
  const rationale = parseRationaleFields(issueBody)

  const globs = surface.in
  for (const glob of globs) {
    if (expandGlob(glob).length === 0) {
      return { ok: false, missing: [`--surfaces glob "${glob}" matched no tracked file.`] }
    }
  }

  const allTrackedFiles = git(['ls-files'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const boundaryTokens = extractBoundaryFilePaths(rationale.boundary ?? '')
  const surfaceFiles: SurfaceFileFact[] = resolveBoundaryPaths(boundaryTokens, allTrackedFiles)
    .sort()
    .map((path) => ({ path, sha256: sha256OfFile(path), packageName: packageNameForPath(path) }))

  const dirtiness = checkDirtyPinnedFiles(surfaceFiles.map((f) => f.path))
  if (dirtiness.length > 0) return { ok: false, missing: dirtiness }

  const workspaces = workspaceGlobs()
  const consumersOf = buildConsumersOf(workspaces, listDirs, readManifest)

  const partsResult = parseIssueParts(issueBody)
  const testPlanResult = parseIssueTestPlan(issueBody)
  const stopConditionsResult = parseIssueStopConditions(issueBody)
  const documentationResult = parseIssueDocumentation(issueBody)

  // See the matching comment in `assembleAndRenderBrief`
  // above: a whole-suite refusal must name the offending line, which an
  // empty fallback into `renderBrief`'s generic path would discard.
  if (!testPlanResult.ok) return { ok: false, missing: testPlanResult.errors }

  const parts: IssuePart[] = partsResult.ok ? partsResult.value : []
  const testPlan: IssueTestPlan = testPlanResult.value
  const stopConditions: string[] = stopConditionsResult.ok ? stopConditionsResult.value : []
  const documentation: IssueDocumentation = documentationResult.ok
    ? documentationResult.value
    : { kind: 'sources', sources: [] }

  const facts: BriefFacts = {
    trancheSlug: null,
    taskId: String(issueNumber),
    title: task.title,
    issue: issueNumber,
    projects: task.projects,
    dependsOn: task.dependsOn,
    conflictsWith: task.conflictsWith,
    rationale,
    objectives: (() => {
      const parsed = objectivesOf(issueBody)
      return parsed.ok ? parsed.objectives : []
    })(),
    surface,
    parts,
    testPlan,
    stopConditions,
    documentation,
    premises: (() => {
      const parsed = parseIssuePremises(issueBody)
      return parsed.ok ? parsed.value : []
    })(),
    // See the tranche-task facts above — absent `gateCutovers` → no cutover (O1).
    cutovers: resolveGateCutovers(loadConfig()),
    dispatchReady: gate.ready,
    dispatchBlockers: gate.blockers,
    surfaceFiles,
    consumersOf,
    docOwnersContent: existsSync(DOC_OWNERS_PATH) ? readFileSync(DOC_OWNERS_PATH, 'utf8') : null,
    sourceRevision: headSha,
    ...repoBriefCommandFacts(repoRootOrCwd())
  }

  const template = readFileSync(TEMPLATE_PATH, 'utf8')
  const result = renderBrief(facts, template)
  return result.ok
    ? { ok: true, brief: result.brief, issue: issueNumber }
    : { ok: false, missing: result.missing, dispatchBlockerDetails: gate.blockerDetails }
}
