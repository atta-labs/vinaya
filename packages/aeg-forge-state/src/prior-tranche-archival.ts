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

import type { Tranche } from '@attalabs/aeg-types'
import { deriveTrancheFromForge } from './derive-from-forge'
import { indexTrancheMilestonesAsync, type MilestoneFacts } from './fetch-milestone'
import { fetchTrancheIssuesAsync } from './list-tasks'
import type { RepoRef } from './resolve-repo'

/** One entry per project a task names: its first active, all-Issues-closed prior tranche, or none. */
export type PriorTrancheArchivalFact = {
  project: string
  /** null when this project has no prior tranche at all — the gate passes trivially for it. */
  priorTrancheSlug: string | null
  archived: boolean
}

/**
 * The forge reads `resolvePriorTrancheArchival` makes — injectable so a test
 * can fail one. A read that cannot answer rejects (or, for `openIssues`, may
 * resolve `null`); neither is ever treated as an empty answer.
 */
export type PriorTrancheArchivalDeps = {
  activeTrancheSlugs: (excludeSlug: string, repo: RepoRef) => Promise<string[]>
  deriveTranche: (slug: string, repo: RepoRef) => Promise<Tranche>
  openIssues: (slug: string, repo: RepoRef) => Promise<Array<{ number: number }> | null>
}

/**
 * The default reads. The active list comes from the async Milestone index; its
 * per-slug facts are handed to `deriveTrancheFromForge` as `known`, so no
 * derivation re-fetches the Milestone list.
 */
export function defaultPriorTrancheArchivalDeps(): PriorTrancheArchivalDeps {
  let facts = new Map<string, MilestoneFacts>()
  return {
    activeTrancheSlugs: async (excludeSlug, repo) => {
      const index = await indexTrancheMilestonesAsync(repo.owner, repo.repo)
      facts = index.facts
      return index.active.map((m) => m.slug).filter((slug) => slug !== excludeSlug)
    },
    deriveTranche: (slug, repo) => deriveTrancheFromForge(repo.owner, repo.repo, slug, facts.get(slug)),
    openIssues: async (slug, repo) =>
      (await fetchTrancheIssuesAsync(repo.owner, repo.repo, slug))
        .filter((issue) => issue.state === 'OPEN')
        .map((issue) => ({ number: issue.number }))
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? 'failed') : String(err)
}

/**
 * The prior-tranche archival facts, and whether any of them could not be
 * read. `facts` holds one entry per project whose answer is known: the first
 * active, all-Issues-closed prior tranche found, or a null-slug pass-through
 * when none is found. A project whose tranche derivation or open-Issues query
 * failed for a candidate has no entry — its fact is unknown, so it never reads
 * as an unarchived prior tranche — and a failed active-tranche read leaves no
 * entry at all. `infraFailure` names every failed read as a `severity:infra`
 * blocker. With no projects there is nothing to resolve and nothing is read.
 */
export async function resolvePriorTrancheArchival(
  projects: string[],
  excludeSlug: string,
  repo: RepoRef,
  deps: PriorTrancheArchivalDeps = defaultPriorTrancheArchivalDeps()
): Promise<{ facts: PriorTrancheArchivalFact[]; infraFailure: string | null }> {
  if (projects.length === 0) return { facts: [], infraFailure: null }

  let candidates: string[]
  try {
    candidates = await deps.activeTrancheSlugs(excludeSlug, repo)
  } catch (err) {
    return {
      facts: [],
      infraFailure: `severity:infra — could not read the active tranches (${reason(err)}); whether a prior tranche is archived is unknown.`
    }
  }

  const facts: PriorTrancheArchivalFact[] = []
  const unreadable: string[] = []
  const derived = new Map<string, Promise<Tranche>>()
  const derive = (slug: string): Promise<Tranche> => {
    let p = derived.get(slug)
    if (!p) {
      p = deps.deriveTranche(slug, repo)
      derived.set(slug, p)
    }
    return p
  }

  for (const project of projects) {
    let found: PriorTrancheArchivalFact | null = null
    let unknown = false
    for (const slug of candidates) {
      let candidateTranche: Tranche
      try {
        candidateTranche = await derive(slug)
      } catch {
        unknown = true
        unreadable.push(`the tasks of tranche \`${slug}\` (project \`${project}\`)`)
        break
      }
      if (!candidateTranche.tasks.some((t) => t.projects.includes(project))) continue

      let openIssues: Array<{ number: number }> | null
      try {
        openIssues = await deps.openIssues(slug, repo)
      } catch {
        openIssues = null
      }
      if (openIssues === null) {
        unknown = true
        unreadable.push(`the open Issues of tranche \`${slug}\` (project \`${project}\`)`)
        break
      }
      if (openIssues.length === 0) {
        found = { project, priorTrancheSlug: slug, archived: false }
        break
      }
    }
    if (!unknown) facts.push(found ?? { project, priorTrancheSlug: null, archived: false })
  }

  return {
    facts,
    infraFailure:
      unreadable.length === 0
        ? null
        : `severity:infra — could not read ${unreadable.join(', ')}; whether a prior tranche is archived is unknown.`
  }
}
