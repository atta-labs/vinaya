import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CORPUS_REL, REFRESH_COMMAND } from '../../../../../apps/cli/scripts/refresh-loop-baseline'

// The read-only loop-baseline guard an opted-in ready or repair publication passes before any expensive work: the
// explicit Test Plan commands and the hook. It judges one contract only — every file the scenario corpus records
// under `baseline.loopSurface` still exists and still has the recorded digest, and each record is well formed — so a
// loop edit whose baseline was not refreshed is named before minutes of local work, instead of after CI. It never
// refreshes anything: a refreshed digest is the Developer's own reviewed change. The complete architecture and history
// gate (`dev-review-engine-architecture-exit.test.ts`) stays authoritative, in CI.

export type ReadyBaselineResult = { ok: true } | { ok: false; reason: string; problems: string[] }

const DIGEST = /^[0-9a-f]{64}$/

/**
 * The guard over `root`'s scenario corpus. A repository without the corpus (every adopter) passes: there is no
 * recorded contract to judge. A corpus that cannot be parsed, or that records no `baseline.loopSurface` list, fails.
 */
export function checkReadyBaseline(root: string): ReadyBaselineResult {
  const corpusPath = join(root, CORPUS_REL)
  if (!existsSync(corpusPath)) return { ok: true }
  const refuse = (problems: string[]): ReadyBaselineResult => ({
    ok: false,
    problems,
    reason: `the recorded loop baseline (${CORPUS_REL}) does not match the loop files: ${problems.join('; ')}. Run \`${REFRESH_COMMAND}\`, review and commit its change, then publish again — no test or Test Plan command ran.`
  })
  let entries: unknown
  try {
    const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as { baseline?: { loopSurface?: unknown } }
    entries = corpus.baseline?.loopSurface
  } catch (error) {
    return refuse([`the corpus is not readable JSON (${error instanceof Error ? error.message : String(error)})`])
  }
  if (!Array.isArray(entries) || entries.length === 0) return refuse(['it records no baseline.loopSurface list'])
  const problems: string[] = []
  for (const [index, entry] of entries.entries()) {
    const { path, sha256 } = (entry ?? {}) as { path?: unknown; sha256?: unknown }
    if (typeof path !== 'string' || path === '' || typeof sha256 !== 'string' || !DIGEST.test(sha256)) {
      problems.push(`entry ${index + 1} is not a { path, sha256 } digest record`)
      continue
    }
    const file = join(root, path)
    if (!existsSync(file)) {
      problems.push(`${path} is missing`)
      continue
    }
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
    if (actual !== sha256) problems.push(`${path} changed`)
  }
  return problems.length === 0 ? { ok: true } : refuse(problems)
}
