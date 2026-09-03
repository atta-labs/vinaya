/**
 * The review loop's own state, derived (review-convergence-v1 task 8, #381).
 * Pure — no `fs`, no `fetch`, no `process.env`; the CLI shim
 * (`apps/cli/src/commands/review-status.ts`) fetches the PR's comments, head
 * and base through `gh` and hands them here.
 *
 * Why this exists: two PRs of this tranche took six and four review rounds,
 * and every extra round traced to a sentence somebody wrote instead of a
 * command somebody ran. "Is this loop still converging?" was one of those
 * sentences. It is a function now: the four ways a loop stops converging are
 * each a named `PAUSE` reason with the round that produced it, read off the
 * PR's own comments.
 *
 * Every fact here is read through a parser that already exists. Verdict
 * comments and their `Judged head:` binding come from `verdict-extraction.ts`
 * — the same extractors `review-gate.ts` blocks merges with — so this command
 * can never disagree with the gate about which comment cast a verdict or what
 * head it judged. There is no second `Judged head:` regex in this file.
 */

import { extractCodeReviewVerdict, extractSecurityReviewVerdict } from './verdict-extraction'
import { isPrincipal } from './waiver-label'

/**
 * The Developer's per-round comment marker. `roles/developer.md`'s post-open
 * sequence renders it into the one comment headed `Head: <sha>`; every gate
 * that needs to know a Developer round happened reads THIS marker at a fixed
 * position rather than scanning the comment's free text for a phrase.
 */
const DEVELOPER_ROUND_MARKER = /<!--\s*aeg:developer:round-(\d+)\s*-->/i

/**
 * A rendered finding line as `review-post.ts`'s `renderFindingsSection`
 * writes it — `<n>. [SEVERITY] <location> — F<id> <class> <state>: <text>` —
 * read for its id and its re-review state together. The id half deliberately
 * mirrors that renderer's own output rather than inventing a second finding
 * grammar; the state half is what round-over-round convergence is measured
 * from, and no exported parser carries it.
 */
const FINDING_LINE =
  /^\d+\.\s+\[[A-Z]+\]\s+\S+\s+—\s+F(\d+)(?:\s+\S+)?(?:\s+(open|fix-claimed|reproduced|resolved))?:/gm

export type ReviewStatus =
  | { state: 'CONTINUE' }
  | { state: 'PAUSE'; reason: 'reappearance' | 'zero-deaths' | 'stale' | 'max-rounds'; id?: string; round: number }

export type ReviewStatusInput = {
  comments: { body: string; author: string | null }[]
  headSha: string
  principalAllowlist: string[]
  maxRounds: number
}

/**
 * The round number a Developer round comment declares, or `null` when the
 * body carries no marker at all. Fixed-position read: the marker is an HTML
 * comment this repo's own doctrine renders, never a phrase inferred from the
 * comment's prose.
 */
export function parseDeveloperRoundMarker(body: string): number | null {
  const m = body.match(DEVELOPER_ROUND_MARKER)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

type VerdictComment = { judgedHead: string | null; ids: Map<string, string | null> }

function findingStates(body: string): Map<string, string | null> {
  const out = new Map<string, string | null>()
  for (const m of body.matchAll(FINDING_LINE)) {
    const id = `F${m[1]}`
    const state = m[2] ?? null
    // A round that lists the same id twice keeps the first state it declared;
    // a later id-less repeat must never erase a real `resolved`/`reproduced`.
    if (!out.has(id) || out.get(id) === null) out.set(id, state)
  }
  return out
}

/**
 * A comment counts as a verdict comment when either extractor parses it
 * clean — the same "did this cast a verdict" test the merge gate applies,
 * one body at a time so this function also learns WHICH body won.
 */
function asVerdictComment(body: string): VerdictComment | null {
  const code = extractCodeReviewVerdict([body])
  const security = extractSecurityReviewVerdict([body])
  if (code.danglingNote !== null && security.danglingNote !== null) return null
  return { judgedHead: code.headSha ?? security.headSha, ids: findingStates(body) }
}

type Round = { judgedHead: string | null; ids: Map<string, string | null> }

/**
 * One round per `Judged head:` value, in the order that head was first
 * judged. A code-review verdict and a security verdict cast on the same head
 * are one round, not two — which is why the grouping key is the judged head
 * and not the comment count.
 */
function groupRounds(verdicts: VerdictComment[]): Round[] {
  const rounds: Round[] = []
  for (const v of verdicts) {
    const existing = rounds.find((r) => r.judgedHead === v.judgedHead)
    const target = existing ?? { judgedHead: v.judgedHead, ids: new Map<string, string | null>() }
    if (!existing) rounds.push(target)
    for (const [id, state] of v.ids) {
      if (!target.ids.has(id) || target.ids.get(id) === null) target.ids.set(id, state)
    }
  }
  return rounds
}

/**
 * `CONTINUE` means the loop is still converging; a `PAUSE` names the one
 * reason it is not and the round that produced it. The four reasons are
 * evaluated in the order they are declared on `ReviewStatus`, most specific
 * first: a reappearance names an individual finding, zero-deaths names a
 * round, staleness names the loop's own inactivity, and max-rounds is the
 * count alone. The first that holds is reported — a paused loop needs one
 * actionable reason, not a list.
 */
export function deriveReviewStatus(input: ReviewStatusInput): ReviewStatus {
  const verdicts: VerdictComment[] = []
  let lastVerdictIndex = -1
  input.comments.forEach((c, i) => {
    if (!isPrincipal(c.author, input.principalAllowlist)) return
    const v = asVerdictComment(c.body)
    if (v === null) return
    verdicts.push(v)
    lastVerdictIndex = i
  })
  const rounds = groupRounds(verdicts)
  if (rounds.length === 0) return { state: 'CONTINUE' }

  // reappearance — an id this loop already called `resolved` comes back
  // `reproduced` in the very next round. The loop is re-litigating, not
  // converging.
  for (let i = 1; i < rounds.length; i++) {
    const prior = rounds[i - 1] as Round
    const current = rounds[i] as Round
    for (const [id, state] of current.ids) {
      if (state === 'reproduced' && prior.ids.get(id) === 'resolved') {
        return { state: 'PAUSE', reason: 'reappearance', id, round: i + 1 }
      }
    }
  }

  // zero-deaths — a round that kills nothing it inherited and still raises
  // something new. Round one is excluded structurally: it inherits no ids, so
  // "resolved none of them" is vacuously true there and would pause every
  // loop at its first verdict.
  for (let i = 1; i < rounds.length; i++) {
    const current = rounds[i] as Round
    const priorIds = new Set<string>()
    for (let j = 0; j < i; j++) for (const id of (rounds[j] as Round).ids.keys()) priorIds.add(id)
    if (priorIds.size === 0) continue
    const killedOne = [...current.ids].some(([id, state]) => priorIds.has(id) && state === 'resolved')
    const raisedNew = [...current.ids.keys()].some((id) => !priorIds.has(id))
    if (!killedOne && raisedNew) return { state: 'PAUSE', reason: 'zero-deaths', round: i + 1 }
  }

  // stale — the newest verdict judged a head that is no longer the PR's, and
  // no Developer round comment has landed since it. Nothing is moving: the
  // reviewer is judging a superseded head and the Developer has not answered.
  const newest = rounds[rounds.length - 1] as Round
  const judged = newest.judgedHead
  const boundToHead = judged !== null && (input.headSha.startsWith(judged) || judged.startsWith(input.headSha))
  const developerAnswered = input.comments
    .slice(lastVerdictIndex + 1)
    .some((c) => parseDeveloperRoundMarker(c.body) !== null)
  if (!boundToHead && !developerAnswered) {
    return { state: 'PAUSE', reason: 'stale', round: rounds.length }
  }

  // max-rounds — the count alone. The loop may still be converging; it has
  // simply run long enough that the Principal decides whether it continues.
  if (rounds.length >= input.maxRounds) return { state: 'PAUSE', reason: 'max-rounds', round: rounds.length }

  return { state: 'CONTINUE' }
}

/** The one-line rendering the CLI prints: `CONTINUE`, or `PAUSE: <reason>[ <id>]`. */
export function renderReviewStatus(status: ReviewStatus): string {
  if (status.state === 'CONTINUE') return 'CONTINUE'
  return status.id !== undefined ? `PAUSE: ${status.reason} ${status.id}` : `PAUSE: ${status.reason}`
}
