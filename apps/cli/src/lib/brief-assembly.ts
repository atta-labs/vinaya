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
  type SurfaceFileFact,
  type Task
} from '@attalabs/aeg-core'
import { parseRationaleDeps } from '@attalabs/aeg-forge-state'
import { createForgeSource } from '@attalabs/vinaya-sources'
import { type EdgeFactsSubset, type EdgeTaskRef, resolveEdge } from '../checks/edge-resolve.js'
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

/**
 * Whether this checkout has enough infra to attempt a brief render at all
 * (Issue #542, O1) — the brief template exists on disk AND the owner/repo
 * resolves (`AEG_REPO`, or a GitHub `origin` remote). `false` means the
 * pre-write brief-render gate (`forge-write.ts`'s `validateRenderedBriefForIssue`)
 * stays DORMANT — never refused — the same dormant-when-infra-absent posture
 * this file's `docOwnersContent`/`sharedPackages` seams already take
 * elsewhere. A real `vinaya` invocation always runs inside a cloned repo
 * that carries this file and a real remote, so this degrades only a rare
 * edge case (an Issue write attempted outside any real checkout, or a test
 * fixture with no repo/template infra of its own), never the normal path —
 * and it is checked BEFORE the render's own staleness/dispatch-readiness/
 * missing-section checks run, so a real checkout still gets the full,
 * fail-closed gate O1 requires.
 */
export function canRenderBriefFromHere(): boolean {
  return existsSync(TEMPLATE_PATH) && resolveRepo() !== null
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
 * `consumersOf(pkg)` built from the live workspace dependency graph — the
 * exact enumeration both `assembleAndRenderBrief*` functions already build
 * inline, exported (Issue #542, O1) so `forge-write.ts`'s pre-write
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

/**
 * A not-yet-created (or not-yet-written) Issue has no real number to compare
 * against a cutover-by-Issue-number rule (`checkIssueObjectives`,
 * `checkBlastRadiusScope`'s O4, `checkDocsWithinSurface`,
 * `checkRationaleSurfaceCoverage`) — this sentinel forces every such
 * comparison unambiguously past every cutover, the same fail-closed posture
 * those rules already take for `issueNumber === null` (task 17, Issue #542,
 * O1): never a guess that a draft might be old enough to skip a rule.
 */
export const DRAFT_ISSUE_SENTINEL = Number.MAX_SAFE_INTEGER

/**
 * `assembleAndRenderBriefForIssue`'s pre-write escape hatch (Issue #542,
 * O1) — the drafted title/body/labels a forge write is ABOUT to send, so the
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
 * a backlog Issue with no tranche (O1) — `<n>` names
 * the Issue itself, never a tranche+task-id pair. Every section is filled
 * from the Issue's own `## Objectives`/`## Surface`/`## Parts`/
 * `## Test plan`/`## Stop conditions` and its "Dependency rationale" field
 * (`parseRationaleDeps`, edges optional per O2), the same pure parsers
 * `assembleAndRenderBrief` already uses — never a second grammar. Refuses
 * (rather than rendering) when the Issue carries a `vinaya/tranche:*` label:
 * that Issue has a real tranche home and belongs on the tranche path, not
 * this one.
 *
 * `override` (Issue #542, O1), when given, skips `fetchIssueForBrief`
 * entirely and renders from the SUPPLIED title/body/labels instead of a live
 * forge read — the pre-write validation path (`forge-write.ts`'s
 * `validateRenderedBriefForIssue`) needs to grade the bytes a write is about
 * to send, not what is on the forge before it lands. `issueNumber` may be
 * `DRAFT_ISSUE_SENTINEL` for an `issue create` still in flight (no real
 * number exists yet); every other caller passes the real one.
 */
export async function assembleAndRenderBriefForIssue(
  issueNumber: number,
  override?: DraftIssueOverride
): Promise<AssembleAndRenderBriefResult> {
  const repo = resolveRepo()
  if (!repo) {
    return {
      ok: false,
      missing: ['could not resolve owner/repo (set AEG_REPO=owner/repo, or confirm `git remote get-url origin`).']
    }
  }

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
  const parts: IssuePart[] = partsResult.ok ? partsResult.value : []
  const testPlan: IssueTestPlan = testPlanResult.ok
    ? testPlanResult.value
    : { kind: 'commands', lines: [], principal: [] }
  const stopConditions: string[] = stopConditionsResult.ok ? stopConditionsResult.value : []

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
    dispatchReady: gate.ready,
    dispatchBlockers: gate.blockers,
    surfaceFiles,
    consumersOf,
    docOwnersContent: existsSync(DOC_OWNERS_PATH) ? readFileSync(DOC_OWNERS_PATH, 'utf8') : null,
    sourceRevision: headSha
  }

  const template = readFileSync(TEMPLATE_PATH, 'utf8')
  const result = renderBrief(facts, template)
  return result.ok ? { ok: true, brief: result.brief, issue: issueNumber } : { ok: false, missing: result.missing }
}
