import { execFileSync } from 'node:child_process'

/**
 * A commit's patch identity against `base`: `git diff origin/<base>...<sha> |
 * git patch-id --stable`. `--stable` is what makes the value comparable
 * across two different commits carrying the same changes — the unstable
 * default folds in context that a rebase or a merge from the base perturbs.
 *
 * The commit is FETCHED first: after a push, the judged head is no longer
 * anything local git has, and diffing against a missing object throws. A
 * throw anywhere here returns `null`, which every caller reads as "cannot
 * answer" and never as "they match" — so a genuinely unreachable commit (a
 * force-push that discarded it) correctly stops counting rather than
 * silently passing.
 *
 * Shared by `check-review-gate.ts` (a verdict binds to a PATCH, not a sha)
 * and `check-evidence-fresh.ts` (the freshness check's own `Head:` binding
 * uses the identical rule, `#497`) — one implementation, not two.
 */
export function patchIdAt(base: string, sha: string): string | null {
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin', sha], { stdio: ['ignore', 'ignore', 'ignore'] })
  } catch {
    // Non-fatal on its own: the object may already be local. The diff below
    // is the real test of whether it is reachable.
  }
  try {
    const diff = execFileSync('git', ['diff', `origin/${base}...${sha}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (diff === '') return null
    const out = execFileSync('git', ['patch-id', '--stable'], {
      input: diff,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim()
    const id = out.split(/\s+/)[0] ?? ''
    return id === '' ? null : id
  } catch {
    return null
  }
}
