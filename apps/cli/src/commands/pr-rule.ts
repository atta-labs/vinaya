import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extractCodeReviewVerdict, extractSecurityReviewVerdict } from '@attalabs/aeg-core'
import { printJson } from '../lib/envelope'
import { countMarkerComments, makeCheckError, postMarkedComment, refuse } from '../lib/forge-write'

const RETRY = 'vinaya pr rule <pr> --file <ruling.md>'

/**
 * `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` treat "no
 * candidate line anywhere in the body" as the ONE case where `danglingNote`
 * carries this exact sentinel text — every other outcome (a clean verdict
 * with `danglingNote: null`, or a candidate line sitting outside the
 * extractor's first-three-line read window) means the file carries verdict
 * grammar somewhere and must be refused. Comparing against the sentinel,
 * rather than trusting `danglingNote === null` alone, is what catches a
 * `VERDICT:` line buried past line 3 — still a whole-body candidate, still
 * disqualifying.
 */
const NO_CODE_REVIEW_CANDIDATE = 'no code-reviewer verdict comment found on this PR'
const NO_SECURITY_CANDIDATE = 'no security-review verdict comment found on this PR'

function refuseIfCastsAVerdict(body: string, filePath: string): void {
  const firstLine = body.split('\n', 1)[0] ?? ''
  if (/^\s*ESCALATE:/.test(firstLine)) {
    refuse([
      makeCheckError(
        'pr-rule-verdict',
        `${filePath}'s first line reads as an escalation (\`ESCALATE:\`) — a ruling is never an escalation.`,
        'Rewrite the file as a plain ruling, or route the escalation through its own channel, then retry.'
      )
    ])
  }

  const codeReview = extractCodeReviewVerdict([body])
  const security = extractSecurityReviewVerdict([body])
  const castsVerdict =
    codeReview.danglingNote !== NO_CODE_REVIEW_CANDIDATE || security.danglingNote !== NO_SECURITY_CANDIDATE
  if (castsVerdict) {
    refuse([
      makeCheckError(
        'pr-rule-verdict',
        `${filePath} carries verdict grammar (a \`VERDICT:\` line) — a ruling comment must never be mistaken for a code-review or security verdict.`,
        'Remove the `VERDICT:` line from the ruling file, then retry.'
      )
    ])
  }
}

function fetchPrCommentBodies(prRef: string): string[] {
  let out: string
  try {
    out = execFileSync('gh', ['pr', 'view', prRef, '--json', 'comments'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    refuse([
      makeCheckError(
        'forge-fetch',
        `Could not fetch PR ${prRef}'s comments (\`gh pr view\`): ${err instanceof Error ? err.message : String(err)}`,
        `Check \`gh auth status\` and network, then re-run \`${RETRY}\`.`
      )
    ])
  }
  try {
    return (JSON.parse(out) as { comments: Array<{ body: string }> }).comments.map((c) => c.body)
  } catch {
    refuse([
      makeCheckError(
        'forge-fetch',
        `Could not parse \`gh pr view ${prRef} --json comments\` output.`,
        `Re-run \`${RETRY}\`.`
      )
    ])
  }
}

export function prRuleCommand(args: string[]): void {
  const json = args.includes('--json')
  const rest = args.filter((a) => a !== '--json')

  const prRef = rest[0]
  if (!prRef || prRef.startsWith('-')) {
    refuse([
      makeCheckError(
        'forge-args',
        '`pr rule` requires the target PR number/URL as the first argument.',
        'Pass the PR number, e.g. `vinaya pr rule 123 --file ruling.md`.'
      )
    ])
  }

  const fileIdx = rest.indexOf('--file')
  const filePath = fileIdx !== -1 ? rest[fileIdx + 1] : undefined
  if (!filePath) {
    refuse([
      makeCheckError(
        'forge-args',
        '`pr rule` requires `--file <ruling.md>`.',
        `Pass \`--file <path>\`, then re-run \`${RETRY}\`.`
      )
    ])
  }

  let body: string
  try {
    body = readFileSync(filePath, 'utf8')
  } catch (err) {
    refuse([
      makeCheckError(
        'forge-args',
        `Could not read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        'Pass a readable `--file <path>`, then retry.'
      )
    ])
  }

  refuseIfCastsAVerdict(body, filePath)

  const prefix = `<!-- aeg:principal:ruling:${prRef}-`
  const k = countMarkerComments(fetchPrCommentBodies(prRef), prefix) + 1
  const marker = `<!-- aeg:principal:ruling:${prRef}-${k} -->`
  const url = postMarkedComment('pr', prRef, marker, body)

  if (json) printJson({ posted: true, url })
  else process.stdout.write(`${url}\n`)
}
