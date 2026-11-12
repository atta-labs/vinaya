import type { LoopRunContext } from './run-context.js'

import { join } from 'node:path'
import { latestHeldRequestChanges } from './reviewer-dispatch.js'
import { renderDeveloperDoctrineBlock } from './developer-dispatch.js'
import { publishingInstructionLine } from './driver-helpers.js'

import { existsSync } from 'node:fs'

import { commitAndPushPrompt as sharedCommitAndPushPrompt } from '../../actions/live-developer-context.js'
import { unpushedFailureMessage as sharedUnpushedFailureMessage } from './unpushed-work.js'
import { logEvents } from './run-logging.js'
import type { PauseCommentPostResult } from './pause-resume.js'
import { unpushedWorkResumeDetail } from './unpushed-work.js'
import { withRateLimitWait } from './rate-limit-waits.js'
import { postForgeEffectOnce } from './publication.js'

import { LOOP_UNPUSHED_WORK_RESUME_MARKER } from '../../../../tools/legacy-markers'

import { DeveloperStopSignal } from './developer-dispatch.js'
import { reconcileDeveloperResume } from './developer-context.js'
import { dispatchDeveloper } from './developer-turn.js'
import { pollUntil } from './round-assess.js'

/**
 * O11: the task Issue, branch, worktree path,
 * and current remote head — every prompt a RESUMED developer session
 * receives names all four, so a session resumed among many worktrees on
 * the same machine never has to ask which branch is meant (confirmed
 * live: exactly that, with forty stale worktrees present). Never
 * prepended to a genuinely fresh round-1 dispatch — that prompt is the
 * frozen brief itself, opening a brand-new session with no worktree to
 * be confused about yet.
 */
export function resumeContextBlock(c: LoopRunContext): string {
  const { d, branch, task } = c

  let remoteHead: string | null
  try {
    remoteHead = d.resolveHead(branch)
  } catch {
    remoteHead = null
  }
  return [
    `Resuming task Issue #${task}.`,
    `Branch: \`${branch}\``,
    `Worktree: \`${worktreePathForBranch(c)}\``,
    `Remote head: ${remoteHead ?? '(no head on origin)'}`
  ].join('\n')
}

/**
 * O1: one Developer dispatch — the frozen brief/resume prompt, its
 * connection-failure retries and its dispatch-or-escalate assertion. Every
 * publication the turn then needs (commit, push, pull-request open) runs
 * in `dispatchDeveloper`'s own loop below, after this returns, so no poll
 * ever starts against an unpublished branch (`publishDeveloperTurn`).
 */
/**
 * What a Developer session that continues another agent's task is told
 * first: the doctrine, the frozen brief, the pull request, and the review
 * findings still open on the current head — everything a fresh Developer
 * turn is given, since this agent has no session of its own to resume. The
 * turn's own prompt (the rulings, or the findings it answers) follows.
 */
export async function switchedAgentContextBlock(c: LoopRunContext, promptText: string): Promise<string> {
  const { d, root, branch, task } = c

  let doctrine: string | null = null
  try {
    doctrine = d.resolveDeveloperDoctrine ? await d.resolveDeveloperDoctrine() : null
  } catch {
    doctrine = null
  }
  let remoteHead: string | null
  try {
    remoteHead = d.resolveHead(branch)
  } catch {
    remoteHead = null
  }
  const heldFindings = latestHeldRequestChanges(root, task)
  const unaddressed =
    heldFindings !== null && heldFindings.head === remoteHead && !promptText.includes(heldFindings.rendered)
      ? heldFindings.rendered
      : null
  return [
    doctrine ? renderDeveloperDoctrineBlock(doctrine) : null,
    `You are continuing task Issue #${task}${c.prNumber > 0 ? ` on pull request #${c.prNumber}` : ''} from another agent's earlier turns, in a fresh session. Their commits are on the branch and any uncommitted work is still in the worktree — keep both. ${publishingInstructionLine()}`,
    `Frozen brief:\n\n${d.fetchFrozenBrief(task)}`,
    unaddressed ? `Review findings still open on the current head:\n\n${unaddressed}` : null
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n')
}

/** O2/O3: the developer's own worktree convention (`harness/processes/vinaya-strict/executing/developer/doctrine.md`) — `.worktrees/<branch>` under this repo's root. */
export function worktreePathForBranch(c: LoopRunContext): string {
  const { branch } = c

  return join(c.repoRoot, '.worktrees', branch)
}

/** O3: names branch, local head (if the worktree is known), remote head, and pull-request existence — whatever this driver actually observed, however this give-up happened, so a principal reading it knows which step was skipped. */
export function pollGiveUpMessage(c: LoopRunContext, context: string): string {
  const { d, branch } = c

  const localHead = d.readWorktreeHead(worktreePathForBranch(c))
  let remoteHead: string | null
  try {
    remoteHead = d.resolveHead(branch)
  } catch {
    remoteHead = null
  }
  const pr = d.findOpenPrForBranch(branch)
  return [
    `devReviewLoop: ${context}`,
    `branch: ${branch}`,
    `local head: ${localHead ?? `(worktree not found at .worktrees/${branch} — cannot read)`}`,
    `remote head: ${remoteHead ?? '(no head on origin)'}`,
    `pull request: ${pr ? `#${pr.number} open` : 'none open'}`
  ].join('\n')
}

// O4: the Developer never pushes or opens the pull request through a forge
// credential of its own — Claude and Codex alike publish only through the
// driver-run tools (`publish_changes`, `open_pull_request`, …), which run
// IN THE DRIVER, outside the sandbox. These resume prompts ask the
// Developer to (re)do its work and publish it through those same tools.
/**
 * The Principal rulings posted on the task Issue after its newest frozen
 * brief, as the one rulings block a pull-request resume also prompts with
 * — or `null` when there are none. A dispatch made before any pull request
 * exists is continued by a ruling posted on the Issue, so every such
 * prompt carries it.
 */
export function issueRulingsBlock(c: LoopRunContext): string | null {
  const { d, task } = c

  const rulings = d.fetchIssueRulingsAfterBrief(task)
  return rulings.length === 0
    ? null
    : `Principal ruling on this pause:\n\n${rulings.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n`
}

/**
 * A pause raised before any pull request keeps the Developer's unpublished
 * work in the task worktree. The continuation's first prompt names that
 * work, read from the driver's own view of the worktree, so the fresh
 * Developer continues and publishes it instead of failing the brief's
 * clean-status pre-flight on it. `null` when the worktree is missing or
 * holds nothing unpublished.
 */
export function keptWorkNote(c: LoopRunContext): string | null {
  const { d } = c

  const dir = worktreePathForBranch(c)
  if (!existsSync(dir)) return null
  const kept = d.readUnpushedWorkDetail(dir)
  if (kept.dirtyFiles.length === 0 && kept.aheadCount === 0) return null
  return [
    `Kept work: this task's worktree holds work left unpublished by an earlier pause, kept as it is by the driver — dirty file(s): ${kept.dirtyFiles.length > 0 ? kept.dirtyFiles.join(', ') : 'none'}; ${kept.aheadCount} commit(s) ahead of the remote.`,
    "It is this task's own earlier work. Continue it and publish it through `publish_changes`; do not discard it, and do not refuse the task because of it.",
    'Pre-flight item 1 ("Clean status") accepts exactly this kept work: any other uncommitted change still fails it.'
  ].join(' ')
}

export function pushAndOpenPrompt(c: LoopRunContext): string {
  return [
    'Your previous turn left no commit on this branch yet, and no open pull request.',
    issueRulingsBlock(c),
    `Per your role doctrine (\`bun apps/cli/src/index.ts doctrine --role developer --print\`): ${publishingInstructionLine()}`
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n')
}

export function openPrPrompt(c: LoopRunContext): string {
  return [
    'This branch is pushed but has no open pull request yet.',
    issueRulingsBlock(c),
    `Per your role doctrine (\`bun apps/cli/src/index.ts doctrine --role developer --print\`): ${publishingInstructionLine()}`
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n')
}

/** Mid-round unpushed-work resume — distinct from `pushAndOpenPrompt` (round-1 entry, no head at all yet): this branch already has commits on the remote, the developer's LATEST turn just left work the driver could not publish. Names the pre-push hook's own refusal (O4) when one is pending. */
export function commitAndPushPrompt(c: LoopRunContext): string {
  const { publicationState } = c

  return sharedCommitAndPushPrompt(publicationState.lastPushRefusal, publishingInstructionLine())
}

/** The shared `unpushedFailureMessage`, on this loop's own branch. */
export function unpushedFailureMessage(
  c: LoopRunContext,
  head: string,
  unpushed: { dirtyFiles: string[]; aheadCount: number }
): string {
  const { branch } = c

  return sharedUnpushedFailureMessage(branch, head, unpushed)
}

/**
 * A round-2 review MAJOR finding: records the driver's own mid-round
 * resume as a real `dev_review_loop` telemetry event —
 * `unpushed_work_resume` (`schema.ts`) — not only the marked PR comment
 * below, so the resume leaves a durable observation in the Log. This
 * event is deliberately kept exactly as it was — this change moves only
 * where the round HISTORY is read from, never which events the loop
 * emits: the round journal is now rebuilt from the pull request's own
 * principal-authored forge markers (`fetchLoopHistory`), never replayed
 * from this or any other log event. Mid-round, never terminal — flushed
 * immediately anyway, matching every other `logEvents` call site in this
 * file, so the event is durable even if the resumed developer's own turn
 * crashes the process before the round ends.
 */
export async function logUnpushedWorkResume(c: LoopRunContext, roundNum: number, detail: string): Promise<void> {
  const { config, branch } = c

  await logEvents(c, [
    {
      kind: 'dev_review_loop' as const,
      payload: {},
      loop_id: config.loopId,
      event: 'unpushed_work_resume' as const,
      round: roundNum,
      branch: branch,
      detail
    }
  ])
}

/**
 * O1/O3: every pause/escalation
 * comment post site calls THIS, never `postPauseComment`/
 * `postIssuePauseComment` directly followed by its own error handling —
 * both functions already never throw (they retry with backoff, then
 * report the outcome), so there is nothing to catch here; this
 * function's only job is the ONE thing every call site would otherwise
 * duplicate: logging a durable `infrastructure_retry` event whenever
 * `result` shows something notable — a retry genuinely happened
 * (`attempts > 1`), OR the post never landed at all (`posted: false`,
 * regardless of `attempts` — round 5 review, MINOR: a corrupt-record
 * refusal or an epoch-acquisition failure reports `attempts: 1` with
 * `posted: false`, and used to be silently dropped by an `attempts <=
 * 1` check that could not tell that apart from an ordinary first-try
 * success). The truly common case — a boring first-try success,
 * `posted: true` with `attempts` `0` (idempotent no-op) or `1` — is the
 * only one that stays silent, exactly as O3 intends.
 */
export async function logPauseCommentRetryIfNotable(
  c: LoopRunContext,
  roundNum: number,
  result: PauseCommentPostResult
): Promise<void> {
  const { config } = c

  if (result.posted && result.attempts <= 1) return
  await logEvents(c, [
    {
      kind: 'dev_review_loop' as const,
      payload: {},
      loop_id: config.loopId,
      event: 'infrastructure_retry' as const,
      round: roundNum,
      failure_kind: 'pause_comment_post' as const,
      attempts: result.attempts,
      outcome: result.posted ? ('recovered' as const) : ('exhausted' as const)
    }
  ])
}

/** Records the mid-round unpushed-work resume as its own marked, idempotent PR comment — the same `postForgeEffectOnce`/`postMarkedComment` mechanism `postPauseComment` already uses, keyed by round+head so a genuine re-run of the same stall posts only once. */
export async function postUnpushedWorkResumeComment(
  c: LoopRunContext,
  roundNum: number,
  head: string,
  unpushed: { dirtyFiles: string[]; aheadCount: number }
): Promise<void> {
  const { d, root, branch, task } = c

  const detail = unpushedWorkResumeDetail(unpushed)
  const body = [
    `unpushed_work_resume: the developer's last turn on \`${branch}\` ended with unpushed work (${detail}) and no new head on the branch (last known head \`${head}\`).`,
    '',
    'Resumed once, in the foreground, with a commit-and-push instruction.'
  ].join('\n')
  await withRateLimitWait(c, () =>
    postForgeEffectOnce(root, task, `unpushed-work-resume-${roundNum}-${head}`, () =>
      d.postMarkedComment('pr', String(c.prNumber), `<!-- ${LOOP_UNPUSHED_WORK_RESUME_MARKER.current} -->`, body)
    )
  )
}

/**
 * O2/O3/O9: run once, right after the developer's round-1 turn ends and
 * BEFORE any poll for a pull request — the poll never starts against a
 * branch the developer has not pushed (Traps to avoid). Covers both
 * round-1 entries this driver can reach here: a fresh dispatch just
 * ran (`alreadyPushed: false` — the branch may or may not carry task
 * commits beyond the default tip yet) and a crash-recovery re-entry
 * (`alreadyPushed: true` — the branch already exists, no fresh dispatch
 * this call). Resumes the developer AT MOST ONCE (Traps: never resume
 * twice for this) — a still-missing push after that one resume is left to
 * the poll's own bounded timeout rather than a second dispatch.
 */
export async function afterDeveloperTurnBeforePrPoll(c: LoopRunContext, alreadyPushed: boolean): Promise<number> {
  const { d, branch, task } = c

  let remoteHead: string | null
  try {
    remoteHead = d.resolveHead(branch)
  } catch {
    remoteHead = null
  }

  // O3: "no push" is not only a branch with no remote head at all — it is
  // ALSO a branch whose remote head still sits at the default branch's tip,
  // carrying no task commits. That is exactly the state the driver's own
  // round-1 `createTaskWorktree` leaves the branch in BEFORE the first
  // Developer turn (a commit-free ref at `origin/main`'s tip), so a round-1
  // turn that pushes nothing leaves the branch there — never a `null` remote
  // head. We detect it by EQUALITY with `origin/main`'s current tip rather
  // than `gitIsAncestor`: the round-1 entry's own `branchHasTaskCommits` uses
  // `gitIsAncestor(head, origin/main)` and the two want opposite answers for
  // the same head (the entry treats a tip-only head as fresh, this treats it
  // as no-push), so reusing that ancestry test here would couple them. A
  // developer that pushed real work moves the remote head off the tip, so
  // the equality no longer holds and this does not fire. (An `origin/main`
  // that advanced mid-turn with no push leaves the branch at an OLDER tip
  // that no longer equals the current one — the existing PR poll's own
  // bounded timeout still covers that rarer case, exactly as before.)
  const noTaskCommits = remoteHead === null || remoteHead === d.gitRevParseOriginMain()
  if (!alreadyPushed && noTaskCommits) {
    // O9: no push at all yet. A posted refusal/escalation ends the loop
    // now, never entering the pull-request poll.
    const stop = d.fetchDeveloperStop(task)
    if (stop !== null && stop.identity !== c.turnPreStop) throw new DeveloperStopSignal(stop.body)

    // O2/O3: reconcile the prior launch, then resume once, foreground —
    // this single resume's own prompt covers both the missing push and
    // (since it also asks for the open) the common case where the PR was
    // never opened either. `artifactsPresent: false` — no head reached the
    // remote yet.
    reconcileDeveloperResume(c, false)
    await dispatchDeveloper(c, pushAndOpenPrompt(c), c.round, {})
    return await pollUntil(
      () => d.findOpenPrForBranch(branch),
      d.prPollMaxAttempts,
      d.prPollIntervalMs,
      d.sleep,
      () =>
        pollGiveUpMessage(
          c,
          'no open PR appeared within the poll budget after resuming once with the push-and-open instructions.'
        )
    ).then((pr) => pr.number)
  }

  const existingPrNow = d.findOpenPrForBranch(branch)
  if (existingPrNow) return existingPrNow.number

  // Pushed (originally, or by this call's own `alreadyPushed: true`
  // crash-recovery path) but the PR is still missing: reconcile the prior
  // launch, then resume once to open it, then poll. `artifactsPresent:
  // true` — a head is on the remote, the branch itself is real work.
  reconcileDeveloperResume(c, true)
  await dispatchDeveloper(c, openPrPrompt(c), c.round, {})
  return await pollUntil(
    () => d.findOpenPrForBranch(branch),
    d.prPollMaxAttempts,
    d.prPollIntervalMs,
    d.sleep,
    () => pollGiveUpMessage(c, 'no open PR appeared within the poll budget after resuming to open one.')
  ).then((pr) => pr.number)
}
