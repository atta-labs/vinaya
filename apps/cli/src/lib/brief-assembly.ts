/**
 * Brief assembly — the forge/tree shim over `@attalabs/aeg-core`'s pure
 * `renderBrief`, extracted out of `commands/brief.ts` (task 12, #387) so a
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
  extractBoundaryFilePaths,
  fetchForgeFacts,
  fetchOpenIssuesByLabel,
  objectivesOf,
  parseIssueParts,
  parseIssueStopConditions,
  parseIssueSurface,
  parseIssueTestPlan,
  parseRationaleFields,
  type PackageManifest,
  renderBrief,
  trancheLabel,
  type BriefFacts,
  type DispatchConflictsWithFact,
  type DispatchDependsOnFact,
  type DispatchGateInput,
  type DispatchPriorTrancheFact,
  type IssuePart,
  type IssueSurface,
  type IssueTestPlan,
  type SurfaceFileFact
} from '@attalabs/aeg-core'
import { createForgeSource } from '@attalabs/vinaya-sources'
import { resolveEdge } from '../checks/edge-resolve.js'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from './config.js'

const DOC_OWNERS_PATH = '.vinaya/doc-owners'
const TEMPLATE_PATH = 'aeg-root/templates/brief-template.md'

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
 * than rendering from a checkout of unknown freshness (task 4,
 * Issue #483, O1; Stop condition: "The remote default branch cannot be
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
 * (task 4, Issue #483, O1) — the first of the two guarantees:
 * `headSha` must equal the remote default branch's current tip, "compare
 * HEAD to the fetched remote default branch" per the Boundary. `resolveRemote`
 * is injected so this is testable against a fixture repo with no real
 * network dependency. Returns a `missing`-shaped reason, never throws — the
 * caller decides what a non-empty return means.
 */
export function checkStaleAgainstRemote(
  headSha: string,
  resolveRemote: () => { branch: string; sha: string } | null = resolveRemoteDefaultBranch
): string[] {
  const remote = resolveRemote()
  if (!remote) {
    return [
      'the remote default branch could not be resolved (`git ls-remote origin HEAD` failed — offline?) — refusing rather than rendering from a checkout of unknown freshness.'
    ]
  }
  if (headSha !== remote.sha) {
    return [
      `checkout HEAD \`${headSha}\` is behind the remote default branch \`${remote.branch}\` at \`${remote.sha}\` — fetch and update before preparing a brief.`
    ]
  }
  return []
}

/**
 * The second of the two guarantees (task 4, Issue #483, O1): a
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
 * prefix in the Boundary prose (e.g. Issue #447's own "aeg-root/
 * aeg-manual-flow.md, process.md, roles/developer.md"). A token matching
 * zero or more-than-one tracked file is dropped, never guessed — task 5,
 * Issue #447, O3.
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
 * `issue` is the real forge Issue number this brief was rendered from and
 * closes — `task.issue`, resolved below from the tranche's forge-derived
 * task list, never the raw task id a caller passed in as `taskId`. Returned
 * rather than discarded so a caller that only has the task id (`dispatchTask`)
 * can still post to and read from the Issue this brief actually belongs to,
 * instead of reusing the task id as if it were an Issue number (task 5,
 * Issue #447, O1) — live evidence: dispatching task 3 with this field
 * discarded posted its brief on Issue #3, an unrelated merged Issue.
 */
export type AssembleAndRenderBriefResult = { ok: true; brief: string; issue: number } | { ok: false; missing: string[] }

/**
 * **O2 (Issue #502) — names what dispatch looked for.** A bare "not
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
 */
export async function assembleAndRenderBrief(
  trancheSlug: string,
  taskId: string,
  surfaceGlobsOverride?: string[]
): Promise<AssembleAndRenderBriefResult> {
  const repo = resolveRepo()
  if (!repo) {
    return {
      ok: false,
      missing: ['could not resolve owner/repo (set AEG_REPO=owner/repo, or confirm `git remote get-url origin`).']
    }
  }

  // O1 (task 4, Issue #483) — the first of the two guarantees on
  // the instruction version: a frozen brief is rendered from a known tree.
  // Checked here, before any forge read, so a stale checkout never pays for
  // a Tranche/Issue fetch it is about to refuse anyway.
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
  const issueBody = openIssueMatch.body
  const issueRationalePass = checkIssueRationale(issueBody).status !== 'fail'

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
  // level glob is never a file-level change set (task 5, Issue #447, O3).
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
  const parts: IssuePart[] = partsResult.ok ? partsResult.value : []
  const testPlan: IssueTestPlan = testPlanResult.ok
    ? testPlanResult.value
    : { kind: 'commands', lines: [], principal: [] }
  const stopConditions: string[] = stopConditionsResult.ok ? stopConditionsResult.value : []

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
    dispatchReady: gate.ready,
    dispatchBlockers: gate.blockers,
    surfaceFiles,
    consumersOf,
    docOwnersContent: existsSync(DOC_OWNERS_PATH) ? readFileSync(DOC_OWNERS_PATH, 'utf8') : null,
    sourceRevision: headSha
  }

  const template = readFileSync(TEMPLATE_PATH, 'utf8')
  const result = renderBrief(facts, template)
  return result.ok ? { ok: true, brief: result.brief, issue: task.issue } : { ok: false, missing: result.missing }
}
