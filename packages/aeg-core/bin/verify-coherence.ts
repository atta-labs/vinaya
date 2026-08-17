#!/usr/bin/env bun

/**
 * verify-coherence — deterministic plan↔forge coherence oracle.
 *
 * Detects governance-state drift between tranche topology files (plan) and
 * the forge (GitHub Issue state / PR merge events). Zero LLM calls. Stateless
 * — every run is a fresh read; no persistent store.
 *
 *. Sibling to verify-docs.ts.
 *
 * This is a thin I/O shim — forge fetches, filesystem reads, and CLI arg/
 * format/exit handling only. The pure check evaluators (A1/A2/A3, T1/T2/T3,
 * D1, L1/L2/L3, checkClosesN) live in `../src/coherence-checks.ts`.
 *
 * Usage:
 *   bun packages/aeg-core/bin/verify-coherence.ts                   # JSON + human output
 *   bun packages/aeg-core/bin/verify-coherence.ts --json            # JSON only
 *   bun packages/aeg-core/bin/verify-coherence.ts --human           # human-readable only
 *   bun packages/aeg-core/bin/verify-coherence.ts --closes-n        # Closes #N gate (CI — reads BRANCH + PR_BODY env)
 *   GITHUB_TOKEN='' bun packages/aeg-core/bin/verify-coherence.ts   # test no-token path
 *
 * CWD-independent by design: chdir's to the repo root immediately below, since
 * this script is also spawned as a subprocess (apps/vinaya/web's
 * /api/coherence route) without an explicit cwd — every relative path in this
 * file (DOC_OWNERS_PATH, aeg-root/, etc.) must resolve correctly regardless of
 * the invoking process's own working directory.
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fetchProvenance,
  fetchTaskIssueRefs,
  fetchTrancheIssuesAsync,
  indexTrancheMilestonesAsync,
  issueMilestonesFromIssues,
  resolveGithubToken,
  resolveRepo,
  trancheFromIssues
} from '@attalabs/aeg-forge-state'
import type { GhIssue, TrancheMilestoneIndex } from '@attalabs/aeg-forge-state'
import type { Tranche } from '@attalabs/aeg-types'
import {
  checkA1,
  checkA2,
  checkA3,
  checkClosesN,
  checkD1,
  checkL1,
  checkL2,
  checkL3,
  checkL4,
  checkL5,
  checkManifestValidity,
  checkR1,
  checkT1,
  checkT2,
  checkT3,
  DOC_OWNERS_PATH,
  extractClosesReferences,
  fetchForgeFacts,
  fetchOpenIssuesByLabel,
  parseRegistry,
  parseTranche,
  R1_GRANDFATHERED_ISSUES,
  scopeT2ToPlanPr,
  touchesAnyTopology
} from '../src/index'
import type { CheckResult, ForgeFacts, TrancheFile, TaskEntry } from '../src/index'

const REPO_ROOT = join(import.meta.dirname, '../../..')
process.chdir(REPO_ROOT)

/**
 * The registry's project names — the authority R1's project-registry half
 * resolves `Project:` against. Read here because `../src` is pure; absent ⇒
 * `[]`, which leaves that half dormant (a single-project repo has no registry
 * by design).
 */
function readRegisteredProjectNames(): string[] {
  const abs = join(REPO_ROOT, '.vinaya/projects.md')
  if (!existsSync(abs)) return []
  return parseRegistry(readFileSync(abs, 'utf8')).map((p) => p.name)
}

/**
 * Implemented by T2; delegates to verify-docs.ts helpers.
 *
 * M1 (hard-fail): dangling in-repo pointer in doc-owners.
 * M2 (info/advisory): malformed glob syntax (extremely rare with our simple grammar).
 * M3 (hard-fail): duplicate glob in doc-owners.
 */
function checkM1M2M3(): CheckResult[] {
  const results: CheckResult[] = []

  // M1 / M2 / M3 — manifest validity
  const docOwnersAbs = join(REPO_ROOT, DOC_OWNERS_PATH)
  const docOwnersContent = existsSync(docOwnersAbs) ? readFileSync(docOwnersAbs, 'utf8') : null

  const { m1Errors, m2Notes, m3Errors } = checkManifestValidity(docOwnersContent, existsSync)

  results.push({
    check: 'M1',
    status: m1Errors.length > 0 ? 'fail' : 'pass',
    failures: m1Errors.map((reason) => ({ tranche: 'doc-owners', reason }))
  })
  results.push({
    check: 'M2',
    status: 'info',
    failures: [],
    note: m2Notes.length > 0 ? m2Notes.join(' | ') : 'All globs syntactically valid.'
  })
  results.push({
    check: 'M3',
    status: m3Errors.length > 0 ? 'fail' : 'pass',
    failures: m3Errors.map((reason) => ({ tranche: 'doc-owners', reason }))
  })

  return results
}

// ---------- forge I/O helpers -------------------------------------------------
// `fetchProvenance` and `fetchOpenIssuesByLabel` moved to Studio's forge lib
// (task 28, #372 bundled finding) so Studio's server components can share the
// single implementation without this CLI's top-level `process.chdir` side
// effect. Re-exported here so existing importers (verify-coherence.test.ts)
// keep working unchanged.
export { fetchProvenance }

// ---------- tranche file loader --------------------------------------------

const TRANCHES_RELDIR = 'aeg-root/tranches'
const COMPLETED_RELDIR = 'aeg-root/tranches/completed'

function isTrancheFile(name: string): boolean {
  return name.endsWith('.md') && name !== 'README.md' && !name.endsWith('.tokens.md')
}

/**
 * PR context for item 5 (aeg-governance-hardening task 24, #364, Part 2;
 *): when set, tranche files THIS PR's own diff touches are read
 * from the PR's head ref (its own proposed content, e.g. a plan PR adding a
 * topology row); every other tranche file — the "repo state" side of
 * every coherence comparison — is read from a freshly-fetched
 * `origin/main`, never from the local checkout's `refs/pull/N/merge`, which
 * GitHub materializes lazily and can lag behind main (confirmed 5+ false-red
 * CI cycles, 2026-07-03/04). `null` (local dev, `--json` audit mode,
 * daily-drift): every file reads from `origin/main`.
 */
export type PrReadContext = { prHeadSha: string; touchedFiles: Set<string> } | null

function gitFetchMainQuiet(): void {
  try {
    // stdio: 'ignore' — this process's own stdout is the JSON report (in
    // --json mode); nothing this shells out to may write to it. `execSync`
    // without an explicit `stdio` already pipes the child's streams into
    // Node/Bun-internal buffers rather than the parent's real fds (verified:
    // this alone doesn't leak), but 'ignore' makes the "never touches our
    // stdout" invariant explicit rather than incidental.
    execSync('git fetch origin main --quiet', { stdio: 'ignore' })
  } catch {
    // best-effort — a fetch failure leaves origin/main at whatever the local
    // checkout already has; downstream reads simply fall back to that state.
  }
}

function listDirAtRef(ref: string, relDir: string): string[] {
  try {
    return execSync(`git ls-tree --name-only ${ref}:${relDir}`, { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function readFileAtRef(ref: string, relPath: string): string | null {
  try {
    return execSync(`git show ${ref}:${relPath}`, { encoding: 'utf8' })
  } catch {
    return null
  }
}

/**
 * Bounded-concurrency `map`. Every forge fan-out in this file goes through
 * here rather than a bare `Promise.all`: an unbounded fan-out issues one
 * simultaneous `gh` subprocess per tranche, which is precisely the burst
 * shape GitHub's secondary rate limits penalise — turning a slow sweep into a
 * throttled one. Each call is ~0.6-1.9 s of round trip and almost no CPU, so
 * a small window already hides nearly all of the latency; going wider buys
 * little and risks a lot.
 */
const FORGE_FETCH_CONCURRENCY = 4

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

/** One tranche file the sweep must resolve, enumerated before any forge data is fetched for it. */
type TrancheCandidate = {
  slug: string
  archived: boolean
  /** The identity of a candidate — two candidates can share a slug (an archival move). */
  relPath: string
  /** True when THIS PR's own diff touches this path, so its content comes from the PR head, never the forge. */
  fromHead: boolean
  /** The PR head's content for this path: `null` when not head-read, or when the PR deleted/renamed it. */
  headContent: string | null
}

/**
 * Everything one sweep read from the forge: the composed tranche list every
 * check consumes, plus the raw per-slug Issue lists and the Milestone index
 * it was built from.
 *
 * The raw halves are carried out deliberately. L4 (`listIssueMilestonesForSlug`)
 * and L5 (`listActiveTrancheSlugs`) used to re-fetch exactly the data this
 * sweep already holds — measured at 6.9 s and 0.6 s respectively of a 26 s
 * run — because a `Tranche` drops both the Issues' `milestone` field and the
 * Milestone list. Returning them lets those checks derive from the same
 * bytes rather than issue a second identical query.
 */
export type TrancheSweep = {
  files: TrancheFile[]
  /** slug → the `vinaya/tranche:<slug>`-labeled Issues this run fetched; absent for any slug the sweep never needed forge data for. */
  issuesBySlug: Map<string, GhIssue[]>
  /** `null` only when no repo resolves, in which case nothing forge-dependent runs at all. */
  milestones: TrancheMilestoneIndex | null
  /**
   * Tranches the forge could not be read for AND which no topology file could
   * stand in for — so they are absent from `files` entirely.
   *
   * Surfaced rather than swallowed. A tranche missing from the sweep is one
   * every repo-wide check trivially passes, so during a forge outage a
   * silently-narrowed sweep reports green over the very tranches it failed to
   * read. Observed live while re-verifying this change, with GitHub returning
   * intermittent 503s: the run stayed `failed: 0` while its own tranche count
   * fell run to run. `runCoherenceChecks` turns a non-empty list into a
   * `severity:infra` FORGE failure — the same vocabulary the no-token and
   * no-repo paths already use.
   */
  unavailableSlugs: string[]
  /**
   * The Milestone index — the sweep's enumeration authority — could not be
   * read. Reported rather than thrown: `--json` mode's stdout must stay pure,
   * parseable JSON (a CI job pipes it straight to `jq`), so an outage has to
   * arrive as a FORGE failure in the report, not as a stack trace and an empty
   * stdout.
   */
  milestoneIndexFailed: boolean
}

/**
 * Merges the file-parsed topology table onto a forge-derived tranche.
 *
 * `id`/`issue` come from the forge — the golden comparison (Issue #437)
 * confirmed these two fields match the file-parsed topology table exactly for
 * every task that HAS a forge Issue. `dependsOn`/`conflictsWith` are read from
 * the topology table itself (`parseTranche`) and merged in, NOT forge-derived
 * — a deliberate, TEMPORARY narrowing of the original swap: a cohort of
 * grandfathered Issues predates the "Dependency rationale" grammar and carries
 * no forge-parseable dependency data at all, and
 * `parse-rationale-deps.ts`'s cross-tranche-qualified-ref handling has its
 * own real gaps independent of that (fixed one instance on Issue #388, but
 * others may remain). Backfilling/auditing the rest is its own follow-up
 * task, not a blocker for this cutover.
 *
 * A `#TBD` topology row (no Issue cut yet, `issue: null`) has no forge
 * representation at all — forge derivation can only ever list tasks it finds
 * via a labeled Issue, so a row with no Issue is structurally invisible to it.
 * T3 (`tbd-in-active-tranche`) exists specifically to catch these — silently
 * dropping them here would blind the one check whose entire job is to see them
 * (confirmed live: a tranche's real `#TBD` rows vanish from the forge-derived
 * list entirely). So any file task with no forge counterpart is appended
 * as-is, fully file-derived, not merged.
 */
function mergeFileTopology(forgeTranche: Tranche, fileTranche: Tranche | null): Tranche {
  if (fileTranche === null) return forgeTranche

  const forgeTaskIds = new Set(forgeTranche.tasks.map((t) => t.id))
  const fileTaskById = new Map(fileTranche.tasks.map((t) => [t.id, t]))

  const mergedTasks = forgeTranche.tasks.map((t) => {
    const fileTask = fileTaskById.get(t.id)
    // No file-side counterpart (shouldn't normally happen — forge/file ids
    // matched exactly for every real task in the golden comparison) —
    // keep forge's own dependsOn/conflictsWith rather than dropping them.
    if (!fileTask) return t
    return { ...t, dependsOn: fileTask.dependsOn, conflictsWith: fileTask.conflictsWith }
  })

  // File-only tasks (#TBD rows, no Issue to derive from) — appended as-is.
  const fileOnlyTasks = fileTranche.tasks.filter((t) => !forgeTaskIds.has(t.id))

  return { ...forgeTranche, tasks: [...mergedTasks, ...fileOnlyTasks] }
}

/**
 * `onlySlug`: resolve this one tranche and no other. The forge derivation is
 * meaningfully more expensive than the old local-file read (a `gh` round trip
 * per tranche vs a near-instant `git show`), so a caller that only ever needs
 * ONE tranche's data (`--closes-n`, below) must opt out of paying for the
 * rest. `runCoherenceChecks` never passes this — its checks are genuinely
 * repo-wide and need every tranche.
 *
 * Shape of the sweep, and why it is not a loop of self-contained derivations:
 * every tranche is ENUMERATED first (topology files at `origin/main` and/or
 * the PR head, then every Milestone with no file), and only then is forge data
 * fetched — the Milestone index once for the whole run, each slug's labeled
 * Issues exactly once, `FORGE_FETCH_CONCURRENCY` at a time. Deriving per slug
 * through `deriveTrancheFromForge` instead re-pulled the entire Milestone list
 * on every iteration and serialised every Issue query behind the last: 13.5 s
 * of a 26 s run against a 6-Milestone repo, essentially all of it duplication.
 * The derivation itself is unchanged — same Milestone facts, same Issue list,
 * same merge — so the verdict this feeds is identical.
 */
export async function loadTrancheSweep(
  prContext: PrReadContext = null,
  onlySlug?: string,
  baseRef = 'origin/main'
): Promise<TrancheSweep> {
  gitFetchMainQuiet()
  const repo = await resolveRepo()

  // The Milestone index is the sweep's enumeration authority, so its failure
  // must not be fatal by default: the pre-refactor loader reached the forge
  // per tranche inside its own per-tranche derivation helper, which caught and fell back to the
  // topology file, so a transient `gh` failure degraded to a file read rather
  // than killing the run — and the `--closes-n` merge gate depends on that.
  // Degrading silently is only safe while something else can still enumerate
  // tranches; if nothing does, see the guard after compose.
  let milestones: TrancheMilestoneIndex | null = null
  let milestoneIndexFailed = false
  if (repo) {
    try {
      milestones = await indexTrancheMilestonesAsync(repo.owner, repo.repo)
    } catch (err) {
      milestoneIndexFailed = true
      console.warn(
        `[verify-coherence] Milestone index fetch failed — falling back to topology files: ${(err as Error).message}`
      )
    }
  }

  // ---------- enumerate ----------
  // Candidates are keyed by PATH, never by slug. An archival PR (`git mv
  // aeg-root/tranches/x.md aeg-root/tranches/completed/x.md`) legitimately
  // produces TWO candidates for slug `x` — the old path, gone at the head, and
  // the new one carrying the PR's own `Lifecycle: complete` edit. Suppressing
  // the second because the first was already seen dropped the archived entry
  // and kept a stale active one built from `baseRef`, inverting `archived` and
  // reading around the PR head that `PrReadContext` exists to honour.
  const candidates: TrancheCandidate[] = []
  const seenPaths = new Set<string>()

  const addFromDir = (relDir: string, archived: boolean): void => {
    const mainNames = new Set(listDirAtRef(baseRef, relDir))
    const prNames = prContext ? new Set(listDirAtRef(prContext.prHeadSha, relDir)) : new Set<string>()

    for (const name of new Set([...mainNames, ...prNames])) {
      if (!isTrancheFile(name)) continue
      const slug = name.replace(/\.md$/, '')
      if (onlySlug && slug !== onlySlug) continue
      const relPath = `${relDir}/${name}`
      if (seenPaths.has(relPath)) continue
      seenPaths.add(relPath)
      const fromHead = prContext?.touchedFiles.has(relPath) ?? false
      candidates.push({
        slug,
        archived,
        relPath,
        fromHead,
        // Read eagerly: this is a local `git show`, no network, and knowing
        // now whether the head carries content is what lets the forge fetch
        // below be scoped to exactly the slugs that will actually need it.
        headContent: fromHead ? readFileAtRef(prContext!.prHeadSha, relPath) : null
      })
    }
  }

  addFromDir(TRANCHES_RELDIR, false)
  addFromDir(COMPLETED_RELDIR, true)

  // Forge-native tranches with no topology file at all (at the forge-native
  // cutover, a tranche's aeg-root/tranches/*.md was deleted once its
  // Milestone-derived replacement was proven safe) are structurally invisible
  // to the directory listing above — there is no filename for a slug with zero
  // file to ever appear. The fill-in below covers them, and it is keyed on
  // which slugs the candidates actually PRODUCE, not on which were enumerated:
  // a candidate that vanished at the PR head produces nothing, and must still
  // be recoverable from its Milestone.
  const producedSlugs = new Set(candidates.filter((c) => !c.fromHead || c.headContent !== null).map((c) => c.slug))
  const milestoneRefs: Array<{ slug: string; archived: boolean }> = milestones
    ? onlySlug
      ? // Scoped: gated on an explicit Milestone existence check so an
        // unrecognized branch slug (typo, deleted tranche with no Milestone
        // either) still reports "no topology found" rather than silently
        // synthesizing a tranche.
        milestones.facts.has(onlySlug)
        ? [{ slug: onlySlug, archived: false }]
        : []
      : // Unscoped (#515): once no tranche carries a topology file at all, the
        // directory listing finds nothing and every repo-wide check (A1-A3,
        // T1-T3, D1, L1-L4) would silently see zero tranches.
        [
          ...milestones.active.map((r) => ({ slug: r.slug, archived: false })),
          ...milestones.archived.map((r) => ({ slug: r.slug, archived: true }))
        ]
    : []

  // ---------- fetch ----------
  // Exactly the slugs that will consult the forge, bounded. Every other
  // enumeration is already answered from local git.
  const needForge = new Set<string>()
  if (repo && milestones) {
    // A candidate read from the PR head never consults the forge, in either
    // direction: with content at the head that content IS the answer, and
    // without it the candidate produces nothing at all — the compose pass
    // skips it and the fill-in below is what recovers its slug, asking for its
    // own fetch on the line after this one. Keying this on the candidate
    // rather than on the slug is what keeps an archival move (two candidates,
    // one slug, one of them self-sufficient) from paying for a query whose
    // result is then discarded.
    for (const c of candidates) if (!c.fromHead) needForge.add(c.slug)
    for (const { slug } of milestoneRefs) if (!producedSlugs.has(slug)) needForge.add(slug)
  }

  const fetched = await mapWithConcurrency([...needForge], FORGE_FETCH_CONCURRENCY, async (slug) => {
    try {
      return { slug, issues: await fetchTrancheIssuesAsync(repo!.owner, repo!.repo, slug) }
    } catch (err) {
      // Never let one tranche's unavailability crash the whole oracle — the
      // same discipline every forge-dependent check below already applies.
      // The caller falls back to the topology file for this slug.
      console.warn(
        `[verify-coherence] forge derivation failed for tranche "${slug}" — falling back to file read: ${(err as Error).message}`
      )
      return { slug, issues: null }
    }
  })

  const issuesBySlug = new Map<string, GhIssue[]>()
  const failedSlugs = new Set<string>()
  for (const { slug, issues } of fetched) {
    if (issues === null) failedSlugs.add(slug)
    else issuesBySlug.set(slug, issues)
  }

  /** The shared file-plus-forge composition both compose passes below use. */
  const composeFromFile = (slug: string, archived: boolean, relPath: string): TrancheFile | null => {
    const raw = readFileAtRef(baseRef, relPath)
    const fileTranche = raw === null ? null : parseTranche(raw)

    // No repo, no Milestone index, or this slug's forge fetch failed — the
    // topology file is the whole answer (dependsOn/conflictsWith included,
    // #TBD rows included).
    if (!repo || !milestones || failedSlugs.has(slug)) {
      return fileTranche === null ? null : { slug, archived, tranche: fileTranche }
    }

    const forgeTranche = trancheFromIssues(slug, issuesBySlug.get(slug) ?? [], milestones.facts.get(slug))
    return { slug, archived, tranche: mergeFileTopology(forgeTranche, fileTranche) }
  }

  // ---------- compose ----------
  // One ordered pass over the candidates, so the emitted tranche order matches
  // the pre-refactor loader's exactly (directory listing order, active dir then
  // completed dir), then the Milestone fill-in.
  const files: TrancheFile[] = []
  for (const c of candidates) {
    if (c.fromHead) {
      // This PR's own topology diff: its content is the answer, and it has no
      // forge equivalent to derive from.
      if (c.headContent !== null) {
        files.push({ slug: c.slug, archived: c.archived, tranche: parseTranche(c.headContent) })
        continue
      }
      // Deleted or renamed at the head. Contributes nothing itself; a sibling
      // candidate (the rename's destination) or the fill-in below recovers the
      // slug, so a topology move cannot narrow the sweep.
      continue
    }
    const composed = composeFromFile(c.slug, c.archived, c.relPath)
    if (composed !== null) files.push(composed)
  }

  for (const { slug, archived } of milestoneRefs) {
    if (files.some((f) => f.slug === slug)) continue
    const relPath = `${archived ? COMPLETED_RELDIR : TRANCHES_RELDIR}/${slug}.md`
    const composed = composeFromFile(slug, archived, relPath)
    if (composed !== null) files.push(composed)
  }

  // A failed fetch falls back to the topology file; with no file to fall back
  // to — the normal state post-cutover — the tranche is simply absent, and an
  // absent tranche is one every check trivially passes. Record those so the
  // caller reports the coverage gap instead of the sweep quietly shrinking.
  const producedAfterCompose = new Set(files.map((f) => f.slug))
  const unavailableSlugs = [...failedSlugs].filter((slug) => !producedAfterCompose.has(slug))

  return { files, issuesBySlug, milestones, unavailableSlugs, milestoneIndexFailed }
}

/** `loadTrancheSweep`'s composed tranche list, for callers that need nothing else from the sweep. */
export async function loadTrancheFiles(prContext: PrReadContext = null, onlySlug?: string): Promise<TrancheFile[]> {
  return (await loadTrancheSweep(prContext, onlySlug)).files
}

// ---------- main orchestrator ------------------------------------------------

export type RunCoherenceChecksOptions = {
  /** See `PrReadContext` — repo-state reads move to fetched origin/main; the PR's own topology diff still reads from its head ref. */
  prContext?: PrReadContext
  /**
   * T2 relocation: `true` ONLY for a CI run against a plan PR whose
   * own diff touches a tranche topology file — the only PR kind that can
   * cause or cure a T2 gap. Defaults to `false` (info-only, never blocking)
   * for every other context: task-PR CI, local dev, `--json` audit mode,
   * daily-drift — matching the brief's "surfaced never blocking" rule.
   */
  isPlanPr?: boolean
}

export async function runCoherenceChecks(
  options: RunCoherenceChecksOptions = {}
): Promise<{ results: CheckResult[]; forgeUnavailable: boolean }> {
  const { prContext = null, isPlanPr = false } = options
  const sweep = await loadTrancheSweep(prContext)
  const { files } = sweep
  const results: CheckResult[] = []

  // Enumeration failed AND nothing local could stand in: every repo-wide check
  // would run against zero tranches and report clean, which is the exact silent
  // blindness the Milestone fill-in exists to prevent. Refuse the run rather
  // than return a green one — but refuse it as a report, so `--json` stdout
  // stays parseable.
  if (sweep.milestoneIndexFailed && files.length === 0) {
    results.push({
      check: 'FORGE',
      status: 'fail',
      failures: [],
      note: 'severity:infra — the Milestone index could not be read and no topology file was found, so no tranche could be enumerated. No check in this run evaluated anything; re-run once the forge is reachable.'
    })
    results.push(...checkM1M2M3())
    return { results, forgeUnavailable: true }
  }

  // ---------- CI scope detection ----------
  // Parse the PR's tranche from BRANCH (CI) or GITHUB_HEAD_REF (Actions env).
  // Used to scope T3 so a PR against one tranche isn't blocked by legacy
  // #TBD rows in an unrelated one.
  const ciTrancheSlug: string | null = (() => {
    const branch = process.env.BRANCH ?? process.env.GITHUB_HEAD_REF ?? ''
    const m = branch.match(/^task\/([^/]+)\//)
    return m?.[1] ?? null
  })()

  // ---------- base entries (no forge facts yet) ----------

  const allEntries: TaskEntry[] = files.flatMap((f) =>
    f.tranche.tasks.map((t) => ({ trancheSlug: f.slug, archived: f.archived, task: t, facts: undefined }))
  )

  results.push(checkL3(files))

  // ---------- forge-dependent checks ----------

  const repo = await resolveRepo()
  const token = await resolveGithubToken()

  if (!token) {
    // No forge fetch was attempted at all — every tranche is unavailable.
    const allUnavailableSlugs = new Set(files.map((f) => f.slug))
    results.push(checkT3(allEntries, ciTrancheSlug, undefined, allUnavailableSlugs))
    results.push({
      check: 'FORGE',
      status: 'fail',
      failures: [],
      note: 'severity:infra — No GitHub token found (set GITHUB_TOKEN or run `gh auth login`). All forge-dependent checks skipped.'
    })
    results.push(...checkM1M2M3())
    return { results, forgeUnavailable: true }
  }

  if (!repo) {
    // No forge fetch was attempted at all — every tranche is unavailable.
    const allUnavailableSlugs = new Set(files.map((f) => f.slug))
    results.push(checkT3(allEntries, ciTrancheSlug, undefined, allUnavailableSlugs))
    results.push({
      check: 'FORGE',
      status: 'fail',
      failures: [],
      note: 'severity:infra — Could not resolve GitHub repository (set AEG_REPO=owner/repo). All forge-dependent checks skipped.'
    })
    results.push(...checkM1M2M3())
    return { results, forgeUnavailable: true }
  }

  const { owner, repo: repoName } = repo

  // Fetch forge facts for all tranches (A1/A2/A3 share this fetch)
  const snapshotsBySlug = new Map<string, Map<string, ForgeFacts>>()
  let anyForgeUnavailable = false

  const eligible = files
    .map((f) => ({
      f,
      tasks: f.tranche.tasks.filter((t) => t.issue !== null).map((t) => ({ id: t.id, issue: t.issue as number }))
    }))
    .filter(({ tasks }) => tasks.length > 0)

  const snapshotResults = await Promise.all(
    eligible.map(async ({ f, tasks }) => ({
      f,
      snapshot: await fetchForgeFacts({ owner, repo: repoName, tranche: f.slug, tasks })
    }))
  )

  for (const { f, snapshot } of snapshotResults) {
    if (snapshot.unavailable) {
      anyForgeUnavailable = true
    } else {
      snapshotsBySlug.set(f.slug, snapshot.facts)
    }
  }

  // Tranches whose forge snapshot fetch failed entirely — used by T3's
  // forge-unavailable carve-out so a #TBD row isn't silently un-grandfathered
  // just because its tranche's forge data never arrived.
  const forgeUnavailableSlugs = new Set(files.map((f) => f.slug).filter((slug) => !snapshotsBySlug.has(slug)))

  // Build enriched entries with forge facts
  const enrichedEntries: TaskEntry[] = files.flatMap((f) => {
    const factsMap = snapshotsBySlug.get(f.slug)
    return f.tranche.tasks.map((t) => ({
      trancheSlug: f.slug,
      archived: f.archived,
      task: t,
      // undefined when forge unavailable for this tranche OR when issue doesn't exist
      facts: factsMap?.get(t.id)
    }))
  })

  // Build lookup maps
  const issueToEntry = new Map<number, TaskEntry>()
  const taskToEntry = new Map<string, TaskEntry>()
  for (const e of enrichedEntries) {
    if (e.task.issue !== null) issueToEntry.set(e.task.issue, e)
    taskToEntry.set(`${e.trancheSlug}/${e.task.id}`, e)
  }

  // Only run forge checks for entries whose tranche snapshot was available
  const availableEntries = enrichedEntries.filter((e) => snapshotsBySlug.has(e.trancheSlug))

  // A1 / A3 checks
  results.push(checkA1(availableEntries))
  results.push(checkA3(availableEntries))

  // A2 — needs closing PR numbers + comment check (separate batch query)
  const a2Candidates = availableEntries.filter(
    (e) => e.facts?.issueState === 'closed' && e.facts.prState === 'merged' && e.task.issue !== null
  )
  const a2IssueNums = a2Candidates.map((e) => e.task.issue as number)
  const provenanceByIssueNum = await fetchProvenance(a2IssueNums, owner, repoName, token)

  // Convert provenance lookup from issue# to `slug/taskId` key
  const provenanceByKey = new Map<string, boolean>()
  for (const e of a2Candidates) {
    if (e.task.issue === null) continue
    const hasProvenance = provenanceByIssueNum.get(e.task.issue)
    if (hasProvenance !== undefined) {
      provenanceByKey.set(`${e.trancheSlug}/${e.task.id}`, hasProvenance)
    }
  }
  results.push(checkA2(availableEntries, provenanceByKey))

  // T1 check (only when forge available)
  results.push(checkT1(availableEntries))

  // T3 — post-forge so enrichedEntries can be used for pre-cutoff date proxy
  results.push(checkT3(allEntries, ciTrancheSlug, enrichedEntries, forgeUnavailableSlugs))

  // T2 / R1 checks — share one batched label-scoped Issue fetch (number + body + labels).
  // The fetch itself stays repo-wide (all active slugs) so --json/audit mode
  // keeps full coverage; only checkT2's own failure computation is scoped by
  // ciTrancheSlug, mirroring T3.
  const activeSlugs = files.filter((f) => !f.archived).map((f) => f.slug)
  const issuesBySlug = await fetchOpenIssuesByLabel(activeSlugs, owner, repoName, token)

  const openIssueNumsBySlug = new Map<string, number[]>(
    [...issuesBySlug].map(([slug, issues]) => [slug, issues.map((i) => i.number)])
  )

  const topologyIssuesBySlug = new Map<string, Set<number>>()
  for (const f of files) {
    if (f.archived) continue
    const nums = new Set<number>()
    for (const t of f.tranche.tasks) {
      if (t.issue !== null) nums.add(t.issue)
    }
    topologyIssuesBySlug.set(f.slug, nums)
  }
  results.push(scopeT2ToPlanPr(checkT2(openIssueNumsBySlug, topologyIssuesBySlug, ciTrancheSlug), isPlanPr))
  const registeredNames = readRegisteredProjectNames()
  if (registeredNames.length === 0) {
    console.warn(
      "[verify-coherence] no registry rows parsed from `.vinaya/projects.md` (absent, or every row malformed) — R1's project-registry half is dormant."
    )
  }
  results.push(checkR1(issuesBySlug, R1_GRANDFATHERED_ISSUES, registeredNames))

  // D1 check
  results.push(checkD1(availableEntries, issueToEntry, taskToEntry))

  // L1 / L2 checks
  const entriesBySlug = new Map<string, TaskEntry[]>()
  for (const e of availableEntries) {
    const list = entriesBySlug.get(e.trancheSlug) ?? []
    list.push(e)
    entriesBySlug.set(e.trancheSlug, list)
  }
  results.push(checkL1(files, entriesBySlug))
  results.push(checkL2(files, entriesBySlug))

  // L4 — Issue-level Milestone-attachment drift (aeg-review-gate-v1 task 1
  // follow-up). Active = forge Milestone open, the same authority
  // `verify-dispatch.ts`'s Milestone-aware discovery uses — not `!f.archived`
  // (file location), so this never flags a tranche whose file predates
  // the Milestone birth rule but has no live Milestone yet.
  //
  // Both halves read the sweep's own data rather than re-fetching it: the open
  // Milestone list is the index it already pulled, and each slug's
  // Milestone-attachment facts derive from the very Issue list its task
  // derivation used (`gh issue list --json ... milestone` carries the
  // attachment). Re-fetching cost 7.5 s of a 26 s run for bytes already in
  // hand. Same authority, same facts — only the round trips are gone.
  //
  // The index is also the ONLY authority either check has: with it lost,
  // `sweep.milestones` is null, the active list is empty, and both checks read
  // that as "no active tranche has any drift" and report clean. That vacuous
  // green is what the enumeration guard above refuses when the index failure
  // leaves nothing at all to check — but that guard is gated on `files` being
  // empty, so the moment one topology file survives to populate `files` the
  // same outage passes silently here instead. Reachable in any repo that still
  // carries `aeg-root/tranches/completed/*.md`, and on any plan PR that reads
  // its own topology file from the head. It does not even take an outage:
  // `indexTrancheMilestonesAsync` reads through `gh` while A1/A2/A3's snapshots
  // read through octokit, so a `gh auth token` keyring failure alone produces
  // an index-less run with `anyForgeUnavailable` still false. The pre-refactor
  // path could not do this — L4/L5 called `listActiveTrancheSlugs`
  // synchronously and uncaught, so an index failure killed the run rather than
  // passing it. Neither check runs without its authority; the gap is reported.
  if (sweep.milestoneIndexFailed) {
    results.push({
      check: 'FORGE',
      status: 'fail',
      failures: [],
      note: 'severity:infra — the Milestone index could not be read, so L4 and L5 had no active-tranche authority and did not evaluate anything. Tranches resolved from topology files were still checked by everything above. Re-run once the forge is reachable.'
    })
  } else {
    const milestoneActiveSlugs = (sweep.milestones?.active ?? []).map((m) => m.slug)
    // The sweep fetches only the slugs its own composition needed, so a tranche
    // resolved entirely from the PR head (or already present in `files` without
    // consulting the forge) may have no entry here — top up just those, bounded.
    //
    // Deliberately NOT wrapped in a catch that substitutes an empty list: to L4
    // an empty Issue list is indistinguishable from "this tranche has no
    // attachment drift", so swallowing a transient forge failure here would
    // report a clean advisory rather than an unavailable one. The pre-refactor
    // path (`listIssueMilestonesForSlug`, a synchronous uncaught `gh` call)
    // propagated and failed the run; that fail-closed behaviour is preserved.
    const missingIssueSlugs = milestoneActiveSlugs.filter((slug) => !sweep.issuesBySlug.has(slug))
    const toppedUp = await mapWithConcurrency(missingIssueSlugs, FORGE_FETCH_CONCURRENCY, async (slug) => {
      try {
        return { slug, issues: await fetchTrancheIssuesAsync(owner, repoName, slug) }
      } catch {
        return { slug, issues: null }
      }
    })
    const l4UnavailableSlugs: string[] = []
    for (const { slug, issues } of toppedUp) {
      if (issues === null) l4UnavailableSlugs.push(slug)
      else sweep.issuesBySlug.set(slug, issues)
    }

    // A failed top-up is neither swallowed nor thrown. Substituting an empty list
    // would make L4 read "no attachment drift" for a tranche it never saw;
    // throwing would empty this process's stdout, which in `--json` mode must
    // stay parseable JSON for the CI job that pipes it to `jq`. So the tranche is
    // withheld from L4's inputs and the gap is reported below.
    const l4Slugs = milestoneActiveSlugs.filter((slug) => !l4UnavailableSlugs.includes(slug))
    const issueMilestones = l4Slugs.flatMap((slug) =>
      issueMilestonesFromIssues(sweep.issuesBySlug.get(slug) ?? []).map((f) => ({ tranche: slug, ...f }))
    )
    results.push(checkL4(l4Slugs, issueMilestones))
    if (l4UnavailableSlugs.length > 0) {
      results.push({
        check: 'FORGE',
        status: 'fail',
        failures: l4UnavailableSlugs.map((slug) => ({
          tranche: slug,
          reason:
            "Forge read failed while collecting L4's Milestone-attachment facts — L4 did not evaluate this tranche."
        })),
        note: `severity:infra — ${l4UnavailableSlugs.length} tranche(s) were withheld from L4 because their Issue list could not be read. Re-run once the forge is reachable.`
      })
    }

    // L5 — forge-native Milestone-state coherence (Issue #481, drift class #2):
    // an open Milestone whose every task Issue is closed. Advisory analogue of
    // file-based L1 for post-cutover tranches that have no topology file.
    results.push(checkL5(milestoneActiveSlugs, entriesBySlug))
  }

  // N/M stubs
  results.push(...checkM1M2M3())

  // Coverage gap, not a drift finding: these tranches were never read, so every
  // check above passed them by default rather than on evidence. Reported at the
  // same severity as a missing token — the run is not trustworthy, and saying
  // so is the difference between an outage and a false green.
  if (sweep.unavailableSlugs.length > 0) {
    results.push({
      check: 'FORGE',
      status: 'fail',
      failures: sweep.unavailableSlugs.map((slug) => ({
        tranche: slug,
        reason: 'Forge read failed and no topology file exists — this tranche was omitted from every check in this run.'
      })),
      note: `severity:infra — ${sweep.unavailableSlugs.length} tranche(s) could not be read from the forge and had no topology file to fall back to. Their checks did not run; re-run once the forge is reachable.`
    })
    return { results, forgeUnavailable: true }
  }

  // A lost Milestone index counts as forge-unavailable even when every other
  // fetch succeeded: L4 and L5 did not evaluate, and the human-facing banner
  // that says "forge-dependent checks may be incomplete" is exactly true.
  return { results, forgeUnavailable: anyForgeUnavailable || sweep.milestoneIndexFailed }
}

// ---------- output ------------------------------------------------------------

function printHuman(results: CheckResult[], forgeUnavailable: boolean): void {
  if (forgeUnavailable) {
    console.warn('\n⚠  Some tranches had forge data unavailable — forge-dependent checks may be incomplete.\n')
  }

  const failed = results.filter((r) => r.status === 'fail')
  const passed = results.filter((r) => r.status === 'pass')
  const info = results.filter((r) => r.status === 'info')

  console.log(`verify-coherence: ${passed.length} passed, ${failed.length} failed, ${info.length} info\n`)

  for (const r of info) {
    console.log(`  [info] ${r.check}: ${r.note ?? ''}`)
  }

  if (failed.length === 0) {
    console.log('All checks passed.')
    return
  }

  console.error(`\nFAILED CHECKS (${failed.length}):\n`)
  for (const r of failed) {
    if (r.note) {
      console.error(`  ✗ ${r.check}: ${r.note}`)
      continue
    }
    console.error(`  ✗ ${r.check} (${r.failures.length} failure(s)):`)
    for (const f of r.failures) {
      const issueStr = f.issue != null ? ` #${f.issue}` : ''
      const taskStr = f.task ? ` [task ${f.task}]` : ''
      console.error(`      ${f.tranche}${issueStr}${taskStr}: ${f.reason}`)
    }
  }
}

// ---------- CLI entry point --------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2)

  // --closes-n: Closes #N gate for task branches (CI Layer 1).
  // Reads BRANCH and PR_BODY from env. Exits 0 on pass/bypass, 1 on fail.
  if (args.includes('--closes-n')) {
    const branch = process.env.BRANCH ?? ''
    const prBody = process.env.PR_BODY ?? ''
    if (!branch) {
      console.warn('closes-n: BRANCH env var not set — skipping (non-task context).')
      process.exit(0)
    }
    // Scoped load: checkClosesN only ever reads the ONE tranche named in
    // the branch — deriving every other tranche from the forge here would
    // pay the full repo-wide sweep's latency for data this gate never uses.
    const branchTrancheSlug = branch.match(/^task\/([^/]+)\//)?.[1]
    const files = await loadTrancheFiles(null, branchTrancheSlug)

    // Reverse-direction data: resolve every `Closes #N` the body references
    // to its AEG task identity, one batched forge query (not a per-issue
    // loop — see `fetchTaskIssueRefs`'s own doc comment). A non-task branch
    // (no `repo` resolvable, or the forge unreachable) still runs the
    // forward direction below; the reverse check simply has nothing to flag.
    const repo = await resolveRepo()
    const taskIssueRefs = repo
      ? await fetchTaskIssueRefs(repo.owner, repo.repo, [...extractClosesReferences(prBody)])
      : undefined
    const result = checkClosesN(branch, prBody, files, taskIssueRefs)
    if (result.ok) {
      const issueStr = result.expectedIssue ? ` (Closes #${result.expectedIssue} ✓)` : ''
      console.log(`closes-n: branch "${branch}" passes${issueStr}.`)
      process.exit(0)
    }
    console.error(`closes-n FAILED: ${result.message}`)
    process.exit(1)
  }

  const jsonOnly = args.includes('--json')
  const humanOnly = args.includes('--human')

  // PR context for item 5/T2-relocation — set only by the
  // coherence-gate CI job (forge-lifecycle.yml). Absent everywhere else
  // (local dev, daily-drift, manual --json audit runs): every tranche
  // file reads from origin/main and T2 stays info-only (never blocking).
  const prHeadSha = process.env.PR_HEAD_SHA || null
  const touchedFilesRaw = process.env.PR_TOUCHED_FILES ?? ''
  const touchedFiles = new Set(
    touchedFilesRaw
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean)
  )
  const prContext = prHeadSha ? { prHeadSha, touchedFiles } : null
  const isPlanPr = touchesAnyTopology([...touchedFiles])

  const { results, forgeUnavailable } = await runCoherenceChecks({ prContext, isPlanPr })

  const failed = results.filter((r) => r.status === 'fail')
  const passed = results.filter((r) => r.status === 'pass')
  const info = results.filter((r) => r.status === 'info')

  const report = {
    summary: { passed: passed.length, failed: failed.length, info: info.length },
    forgeUnavailable,
    checks: results
  }

  if (!humanOnly) {
    console.log(JSON.stringify(report, null, 2))
  }

  if (!jsonOnly) {
    if (!humanOnly) console.log('') // separator
    printHuman(results, forgeUnavailable)
  }

  process.exit(failed.length > 0 ? 1 : 0)
}
