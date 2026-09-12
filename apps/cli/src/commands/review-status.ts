import { execFileSync } from 'node:child_process'
import { deriveReviewStatus, renderReviewStatus } from '@attalabs/aeg-core'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from '../lib/config'
import { reviewPolicy } from '../lib/dev-review-loop/developer-dispatch.js'

/**
 * `vinaya review status <pr>` — the review loop's own state, printed.
 *
 * Two PRs of this tranche took six and four review rounds, and every extra
 * round traced back to a sentence somebody wrote instead of a command
 * somebody ran. "Is this loop converging?" and "am I behind `main`?" were two
 * of those sentences. This command answers both by running something:
 *
 *   line 1  `CONTINUE`, or `PAUSE: <reason>[ <id>]`
 *   line 2  `behind main by <n> — merge first` when the branch is behind, or
 *           `behind main: unknown — fetch origin/<base> first` when git
 *           cannot measure the distance at all
 *
 * The decision itself is `deriveReviewStatus` (`@attalabs/aeg-core`, pure) —
 * this shim does only the I/O: one `gh pr view` for the comments, head and
 * base, and one `git rev-list --count`. Verdict comments and their
 * `Judged head:` binding are read through the SAME extractors `review-gate`
 * blocks merges with, so this command can never disagree with the gate.
 *
 * Exit `0` on `CONTINUE` with a branch that is not behind; `1` otherwise —
 * so a script can gate on it without parsing the text.
 */

type PrView = {
  comments: { body: string; author?: { login?: string } | null }[]
  headRefOid: string
  baseRefName: string
}

function fetchPr(prNumber: string): PrView | null {
  try {
    const out = execFileSync('gh', ['pr', 'view', prNumber, '--json', 'comments,headRefOid,baseRefName'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return JSON.parse(out) as PrView
  } catch {
    return null
  }
}

/**
 * How many commits `origin/<base>` carries that this branch does not.
 * `null` — never `0` — when git cannot answer: an unfetched base or a
 * shallow clone is "I don't know", and printing "not behind" for it would be
 * the fail-open direction on the one question this line exists to answer.
 */
function behindBy(base: string): number | null {
  try {
    const out = execFileSync('git', ['rev-list', '--count', `HEAD..origin/${base}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    const n = Number(out)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export async function reviewStatusCommand(args: string[]): Promise<void> {
  const prNumber = args.find((a) => /^\d+$/.test(a))
  if (!prNumber) {
    console.error('Usage: vinaya review status <pr-number>')
    process.exit(2)
  }

  const pr = fetchPr(prNumber)
  if (pr === null) {
    console.error(`Could not read PR #${prNumber} through \`gh pr view\` — check \`gh auth status\` and try again.`)
    process.exit(2)
  }

  const status = deriveReviewStatus({
    comments: pr.comments.map((c) => ({ body: c.body, author: c.author?.login ?? null })),
    headSha: pr.headRefOid,
    principalAllowlist: resolvePrincipalAllowlist(loadTrustAnchorConfig()),
    maxRounds: reviewPolicy().maxRounds
  })

  process.stdout.write(`${renderReviewStatus(status)}\n`)

  const behind = behindBy(pr.baseRefName)
  if (behind === null) {
    // Never silence: "I could not measure" and "you are not behind" are
    // different facts, and printing nothing on this path made an unfetched
    // base look like a clean branch while the command still exited 1 —
    // a bare `CONTINUE` with no reason for the non-zero exit.
    process.stdout.write(`behind main: unknown — fetch origin/${pr.baseRefName} first\n`)
  } else if (behind > 0) {
    process.stdout.write(`behind main by ${behind} — merge first\n`)
  }

  const clean = status.state === 'CONTINUE' && behind === 0
  process.exit(clean ? 0 : 1)
}
