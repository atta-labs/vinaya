/**
 * The Vinaya branch-to-Issue reader every Log sink the product builds is
 * given as its `resolveBranchIssue` dependency: which task a checked-out
 * branch names, and which Issue the forge says that task is. It lives with
 * the process because the branch shapes and the task-Issue title rule are the
 * process's task model; the sink (`harness/kernel/log/log-sink.ts`) knows only
 * that its resolver answers an Issue number or `null`.
 * `log-sink-factory.ts` beside this file binds it into each sink.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveTaskIssueRef } from '../../tools/task-contract/forge/list-tasks'
import { LOG_CONTEXT_LOOKUP_DEADLINE_MS } from '../../../../kernel/log/log-sink.js'

const execFileAsync = promisify(execFile)

/**
 * The two branch shapes this doctrine addresses a task by — `task/issue-<n>`
 * for a tranche-less backlog Issue, `task/<tranche>/<n>` for a tranche task
 * (`harness/processes/vinaya-strict/loops/dev-review/run-control/task-status.ts`'s `branchForRef`, the same two shapes
 * `developerBranchFor` derives). Pure: a branch name in, a claim about what
 * it names out — no I/O, so the shape rule itself is testable without a
 * checkout or a forge.
 */
export type TaskBranchRef = { kind: 'issue'; issue: number } | { kind: 'tranche'; tranche: string; taskId: string }

/** Only these characters may reach `gh`'s argv as a label segment — a branch name is not a trusted value, and a tranche slug is always this shape. */
const TRANCHE_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function taskRefFromBranch(branch: string): TaskBranchRef | null {
  const backlog = /^task\/issue-(\d+)$/.exec(branch)
  if (backlog) {
    // A branch name is a value a role types, not a bounded number: ~310
    // digits parse to `Infinity` and 20 digits to a non-integer float, and
    // `LogEventSchema`'s `subject.issue: z.number().int()` refuses both —
    // which drops the WHOLE event, for every event this process logs, since
    // the resolved value is cached. So an unbounded parse here would let a
    // branch name silence a process's entire audit trail. The environment
    // path guards exactly this on the same field (`issueFromTask`'s
    // `Number.isInteger`, `envelope.ts`); this is that guard, on this path.
    const issue = Number(backlog[1])
    return Number.isSafeInteger(issue) && issue > 0 ? { kind: 'issue', issue } : null
  }
  const tranche = /^task\/([^/]+)\/([^/]+)$/.exec(branch)
  if (tranche && TRANCHE_SLUG_PATTERN.test(tranche[1] ?? '')) {
    return { kind: 'tranche', tranche: tranche[1] as string, taskId: tranche[2] as string }
  }
  return null
}

/** Generous, not a bound — the same limit `task-status.ts` reads open task Issues with; one tranche has never held more. */
const TRANCHE_ISSUE_LIST_LIMIT = 200

/**
 * The Issue a `task/<tranche>/<n>` branch names, read from the forge the one
 * way this doctrine derives it anywhere else: the `vinaya/tranche:<slug>`
 * label plus the `[<slug>] <n> — …` title, parsed by the SAME
 * `resolveTaskIssueRef` the task list and the task tools already share
 * rather than a second, drifting copy of the title rule here. `--state all`,
 * not `open`: a branch stays checked out after its Issue closes, and an
 * event emitted there still belongs to that task.
 *
 * Run IN the sink's own working directory, never the process's: `gh`
 * resolves which repository to ask from the git remote of the directory it
 * runs in, and a sink configured with a `cwd` of its own (the shape the loop
 * harness and the log fixtures use) must not read one checkout's branch and
 * another checkout's Issues.
 */
async function issueForTrancheTask(
  tranche: string,
  taskId: string,
  cwd: string,
  repo: string | null
): Promise<number | null> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(
      'gh',
      [
        'issue',
        'list',
        '--state',
        'all',
        '--label',
        `vinaya/tranche:${tranche}`,
        '--json',
        'number,title,labels',
        '--limit',
        String(TRANCHE_ISSUE_LIST_LIMIT),
        // From the already-resolved repository, never the directory's remote
        // — the same reason `confirmBacklogIssue` passes it.
        ...(repo === null ? [] : ['--repo', repo])
      ],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        // The child dies WITH the deadline, not just the promise the caller
        // is waiting on: `withDeadline` answers `null` at the call site, but
        // a hanging, proxied or unauthenticated `gh` left running holds the
        // event loop open and delays this process's own exit long past it —
        // on the pre-push-hook path, the very path this feature exists for
        // (round 3 security review, LOW).
        timeout: LOG_CONTEXT_LOOKUP_DEADLINE_MS,
        killSignal: 'SIGKILL'
      }
    ))
  } catch {
    return null
  }
  let issues: Array<{ number: number; title: string; labels: Array<{ name: string }> }>
  try {
    issues = JSON.parse(stdout)
  } catch {
    return null
  }
  for (const issue of issues) {
    const ref = resolveTaskIssueRef(
      issue.title,
      issue.labels.map((l) => l.name)
    )
    if (ref && ref.trancheSlug === tranche && ref.taskId === taskId) return issue.number
  }
  return null
}

/**
 * A branch-named Issue, answered on the forge's terms: `'confirmed'` when the
 * Issue exists in the repository the event will be FILED under, `'denied'`
 * when that repository says it does not, and `'unknown'` when the forge could
 * not be asked at all.
 *
 * The three-way answer is the whole point. A branch name is caller-supplied
 * (a pushed branch, a fork's, a reviewer's checkout), so a number the forge
 * DENIES must never be filed — that is the attribution harm the confirmation
 * exists to prevent. But a `gh` that is missing, unauthenticated, offline or
 * rate-limited has said nothing about the number, and treating its silence as
 * denial would throw away exactly what this fallback is for: a local pre-push
 * run, on a task branch, on a machine with no forge access, whose branch
 * names its task unambiguously (the objective's own words: a `task/issue-<n>`
 * branch gives `<n>`). Silence therefore leaves the branch's own claim
 * standing, and `meta.provenance` stays `'unavailable'` either way — the
 * event never claims the forge agreed.
 *
 * `--repo` is passed from the ALREADY-RESOLVED repository, never left to the
 * directory's git remote: `meta.repo` and the outbox file come from
 * `resolveRepo()`, whose first source is `AEG_REPO`, so asking a different
 * repository would confirm a number in one place and file it in another
 * (round 5 review, MINOR). With no resolved repository to name, `gh`'s own
 * directory-derived default is all there is.
 */
type BacklogConfirmation = 'confirmed' | 'denied' | 'unknown'

async function confirmBacklogIssue(issue: number, cwd: string, repo: string | null): Promise<BacklogConfirmation> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(
      'gh',
      ['issue', 'view', String(issue), '--json', 'number', ...(repo === null ? [] : ['--repo', repo])],
      {
        cwd,
        encoding: 'utf8',
        timeout: LOG_CONTEXT_LOOKUP_DEADLINE_MS,
        killSignal: 'SIGKILL'
      }
    ))
  } catch (err) {
    // `gh` exits non-zero for both "no such Issue" and "I could not ask" —
    // only its own message tells them apart, and only the first is a denial.
    const stderr = typeof (err as { stderr?: unknown }).stderr === 'string' ? (err as { stderr: string }).stderr : ''
    return /could not resolve|not found|no such|does not exist/i.test(stderr) ? 'denied' : 'unknown'
  }
  try {
    return (JSON.parse(stdout) as { number?: unknown }).number === issue ? 'confirmed' : 'denied'
  } catch {
    return 'unknown'
  }
}

/**
 * The Issue the CHECKED-OUT branch names, or `null` when it names none —
 * what fills `subject.issue` for an event whose process carries no
 * `VINAYA_TASK` (the pre-push hook's and CI's own `vinaya check` runs, which
 * is most of what a log server actually holds). `null` is the honest answer
 * for a branch that is not a task branch, a checkout `git` cannot read, and
 * a tranche task whose Issue the forge will not name — never a guessed
 * number.
 *
 * Called at most ONCE per process per working-directory-and-repository pair
 * (memoised in `branchIssueByCwd`, `null` included) and only when an event's
 * own `VINAYA_TASK` is absent, so a process that
 * already knows its task makes no forge call at all; the one call it can
 * make is bounded by `LOG_CONTEXT_LOOKUP_DEADLINE_MS` at the call site, so a
 * slow or unauthenticated `gh` delays no event past that deadline and drops
 * none. Async throughout (`execFileAsync`, never `execFileSync`) — the same
 * no-synchronous-spawn rule the sink's shared context already holds
 * (`tests/lib/log-sink-no-sync-spawn.test.ts`).
 */
export async function resolveBranchIssue(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  repo: string | null = null
): Promise<number | null> {
  let branch: string
  try {
    branch = (
      await execFileAsync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
        // Same rule as the `gh` read below: the child dies with the
        // deadline rather than outliving the answer.
        timeout: LOG_CONTEXT_LOOKUP_DEADLINE_MS,
        killSignal: 'SIGKILL'
      })
    ).stdout.trim()
  } catch {
    return null
  }
  // A CI job triggered by a pull request checks out the merge commit in
  // DETACHED HEAD, where `rev-parse --abbrev-ref HEAD` answers the literal
  // string `HEAD` and no branch is checked out at all — so CI, named
  // alongside the pre-push hook as the reason this fallback exists, would
  // record `issue: null` forever without this line. The head ref the CI
  // system itself reports for the pull request is the branch that checkout
  // came from (`GITHUB_HEAD_REF`, set on a `pull_request` event and empty on
  // every other), and it goes through the IDENTICAL shape rules and the
  // identical verification below. It is not a stronger claim than a local
  // branch name — both are caller-supplied, both leave
  // `meta.provenance: 'unavailable'` — it is the same claim, read where git
  // cannot make it.
  const named = branch === 'HEAD' ? (env.GITHUB_HEAD_REF ?? '') : branch
  const ref = taskRefFromBranch(named)
  if (ref === null) return null
  if (ref.kind === 'tranche') return await issueForTrancheTask(ref.tranche, ref.taskId, cwd, repo)
  // `'unknown'` keeps the branch's own number: see `confirmBacklogIssue`.
  return (await confirmBacklogIssue(ref.issue, cwd, repo)) === 'denied' ? null : ref.issue
}
