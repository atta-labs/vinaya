/**
 * The prior-tranche archival resolution — the single implementation of "does a
 * project this task names still have an active prior tranche whose task Issues
 * are all closed?" that the dispatch verifier and both dispatch checks read.
 *
 * Lives in this package, not in `@attalabs/aeg-core`: the resolution performs
 * forge reads and `@attalabs/aeg-core/src` is no-I/O. The dependency runs
 * aeg-core → forge-state, so the fact type lives here and aeg-core aliases it.
 *
 * Every default read is asynchronous and captures its standard error, so a
 * check that calls this never writes a raw `gh` line of its own, and each read
 * carries an explicit repository target.
 */

import type { GhIssue } from './gh'
import { indexTrancheMilestonesAsync } from './fetch-milestone'
import { tasksFromIssues } from './list-tasks'
import type { RepoRef } from './resolve-repo'

/** One entry per project a task names: its first active, all-Issues-closed prior tranche, or none. */
export type PriorTrancheArchivalFact = {
  project: string
  /** null when this project has no prior tranche at all — the gate passes trivially for it. */
  priorTrancheSlug: string | null
  archived: boolean
}

/** One active tranche and every Issue carrying its `vinaya/tranche:<slug>` label. */
export type ActiveTrancheIssues = { slug: string; issues: GhIssue[] }

/**
 * The forge read `resolvePriorTrancheArchival` makes — injectable so a test
 * can fail it or count it. A read that cannot answer rejects; a rejection is
 * never treated as an empty answer.
 */
export type PriorTrancheArchivalDeps = {
  activeTranches: (excludeSlug: string, repo: RepoRef) => Promise<ActiveTrancheIssues[]>
}

/**
 * The default read: the async Milestone index, which lists every tranche
 * label's Issues once to decide which tranches are active, and hands those
 * same lists back so no candidate's label is listed a second time. Each of its
 * reads is made once more when it fails.
 */
export function defaultPriorTrancheArchivalDeps(): PriorTrancheArchivalDeps {
  return {
    activeTranches: async (excludeSlug, repo) => {
      const index = await indexTrancheMilestonesAsync(repo.owner, repo.repo, { retryFailedReads: true })
      return index.active
        .filter((m) => m.slug !== excludeSlug)
        .map((m) => {
          const issues = index.issuesBySlug?.get(m.slug)
          if (!issues) throw new Error(`the Milestone index holds no Issue list for tranche \`${m.slug}\``)
          return { slug: m.slug, issues }
        })
    }
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? 'failed') : String(err)
}

/**
 * The prior-tranche archival facts, and whether they could not be read.
 * `facts` holds one entry per project: the first active, all-Issues-closed
 * prior tranche found, or a null-slug pass-through when none is found. A
 * candidate's tasks and open Issues both come from the one Issue list the
 * active-tranche read returned for it. A failed active-tranche read leaves no
 * entry at all — every fact is unknown, so none reads as an unarchived prior
 * tranche — and `infraFailure` names it as a `severity:infra` blocker. With no
 * projects there is nothing to resolve and nothing is read.
 */
export async function resolvePriorTrancheArchival(
  projects: string[],
  excludeSlug: string,
  repo: RepoRef,
  deps: PriorTrancheArchivalDeps = defaultPriorTrancheArchivalDeps()
): Promise<{ facts: PriorTrancheArchivalFact[]; infraFailure: string | null }> {
  if (projects.length === 0) return { facts: [], infraFailure: null }

  let candidates: ActiveTrancheIssues[]
  try {
    candidates = await deps.activeTranches(excludeSlug, repo)
  } catch (err) {
    return {
      facts: [],
      infraFailure: `severity:infra — could not read the active tranches (${reason(err)}); whether a prior tranche is archived is unknown.`
    }
  }

  const tasksBySlug = new Map(candidates.map((c) => [c.slug, tasksFromIssues(c.issues)]))
  const facts: PriorTrancheArchivalFact[] = []
  for (const project of projects) {
    let found: PriorTrancheArchivalFact | null = null
    for (const { slug, issues } of candidates) {
      if (!(tasksBySlug.get(slug) ?? []).some((t) => t.projects.includes(project))) continue
      if (!issues.some((issue) => issue.state === 'OPEN')) {
        found = { project, priorTrancheSlug: slug, archived: false }
        break
      }
    }
    facts.push(found ?? { project, priorTrancheSlug: null, archived: false })
  }

  return { facts, infraFailure: null }
}
