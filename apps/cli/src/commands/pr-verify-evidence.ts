/**
 * `vinaya pr verify-evidence` — proves the published `AEG:EVIDENCE` region was
 * machine-generated, by regenerating it and comparing.
 *
 * **Deliberately a command, not a check.** `evidence-fresh` is registered in
 * `coreCheckRegistry()`, and `pr report` runs `vinaya check --all --diff-only`;
 * a check that regenerated the block would run the suite containing itself.
 * That recursion is exactly why `evidence-fresh` verifies Group A only and
 * leaves Group B attested. Living outside the registry is what lets this close
 * the gap without reintroducing the recursion.
 *
 * Reads the pull request body from the forge, regenerates a report against the
 * working tree, and compares. Run it from a checkout at the pull request's head
 * — comparing against a different tree reports a difference that is real but
 * uninteresting, so the head is printed for the reader to confirm.
 */

import { execFileSync } from 'node:child_process'
import { buildReport } from './pr-report.js'
import { compareEvidence, extractEvidenceRegion, renderVerdict } from './pr-verify-evidence-logic.js'

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
}

export async function prVerifyEvidenceCommand(args: string[]): Promise<void> {
  const prRef = args.find((a) => !a.startsWith('--'))
  if (!prRef) {
    process.stderr.write('Usage: vinaya pr verify-evidence <pr-number>\n')
    process.exit(2)
  }

  let body: string
  try {
    body = JSON.parse(gh(['pr', 'view', prRef, '--json', 'body'])).body ?? ''
  } catch (err) {
    process.stderr.write(`pr verify-evidence: could not read pull request #${prRef} — ${(err as Error).message}\n`)
    process.exit(1)
    return
  }

  const localHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  process.stderr.write(`[pr verify-evidence] comparing #${prRef} against the working tree at ${localHead}\n`)

  // Regenerating runs the real gates — the same run `pr report --write` would
  // have written. This is the whole point: the comparison is against a real
  // run, never against an assertion about one.
  const fresh = await buildReport()

  const verdict = compareEvidence(extractEvidenceRegion(body), fresh.blockInner, repoRoot())
  process.stdout.write(`${renderVerdict(verdict)}\n`)
  process.exit(verdict.status === 'match' ? 0 : 1)
}
