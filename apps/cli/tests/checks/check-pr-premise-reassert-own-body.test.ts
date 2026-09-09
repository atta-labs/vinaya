import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { reassertPrBodyPremise } from '../../src/checks/bin/check-pr-premise-reassert'

/**
 * The own-PR fixture rule (`aeg-root/enforcement.md`): a pull request that
 * adds a check reading a PR body ships a test running that check over THAT
 * PR's own body — the one input a synthetic fixture the author also wrote
 * can never exercise, because the author's fixture agrees with the author's
 * mental model by construction (round 1 review, PR #473; precedent:
 * `packages/aeg-core/src/test-plan-gate.test.ts`'s "a real PR's own body
 * (task 12, #387)").
 *
 * `pr-body-473.md` is PR #473's own live body, captured verbatim with
 * `gh pr view 473 --json body -q .body` — the machine-emitted
 * `AEG:EVIDENCE`/`AEG:TOKENS` blocks, the real `AEG:PREMISE` pins this task
 * shipped, and the frozen brief pasted below in its `<details>` block
 * included. That last part is load-bearing the same way it was for the
 * precedent: the pasted reference brief's own `#### Premise pins` section
 * carries a DIFFERENT premise block (three `sha256` pins against files this
 * PR does not touch the same way), so a check reading anything but the
 * anchored `AEG:PREMISE` section would grade the wrong pins.
 *
 * Captured as a point-in-time snapshot, not kept in sync with this PR's own
 * future edits — same as the precedent's `pr-body-393.md`, itself captured
 * from an already-resolved PR rather than tracked live. Its job is to prove
 * `reassertPrBodyPremise` handles one real, fully-shaped forge body; it is
 * not an assertion about PR #473's current state, which moves on every push
 * this fixture does not.
 *
 * Runs with the REAL default file reader (rooted at the actual repo root
 * via `git rev-parse --show-toplevel`, not `process.cwd()`) rather than a
 * fixture map — a synthetic reader would just be a second hand-written
 * mental model layered on top of the captured body, defeating the point of
 * exercising the real check against real on-disk content. Rooting via `git`
 * rather than `process.cwd()` keeps this independent of which directory the
 * test runner happens to invoke `bun test` from (this repo's own `apps/cli`
 * package script runs it from `apps/cli/`, not the repo root).
 */
describe("reassertPrBodyPremise — a real PR's own body (round 1 review, PR #473)", () => {
  const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const LIVE = readFileSync(join(import.meta.dir, '..', 'fixtures', 'pr-body-473.md'), 'utf8')

  function realFileReader(path: string): string | null {
    try {
      return readFileSync(join(REPO_ROOT, path), 'utf8')
    } catch {
      return null
    }
  }

  it('PASSes the verbatim live body — its real AEG:PREMISE pins still hold against the current tree', () => {
    const result = reassertPrBodyPremise(LIVE, realFileReader)
    expect(result).not.toBeNull()
    expect(result?.pass).toBe(true)
    expect(result?.errors).toHaveLength(0)
  })

  it('reads the premise from the anchored AEG:PREMISE section, not the different one pasted below it', () => {
    // The reference copy of the brief in the `<details>` block carries its
    // own, different `Premise:` block (three `sha256` pins). If the check
    // read those too, they'd very likely fail (that copy's pin on
    // `packages/aeg-core/bin/open-pr.ts` describes a file this task's real
    // diff never touches the way the brief originally assumed) and this
    // body would never pass.
    expect(LIVE).toContain('<!-- AEG:PREMISE:START -->')
    expect(LIVE).toContain('#### Premise pins')
    const result = reassertPrBodyPremise(LIVE, realFileReader)
    expect(result?.pass).toBe(true)
  })

  it('FAILs once a real pin is falsified, naming it — proves the pass above is not vacuous', () => {
    const falsified = LIVE.replace(
      "- apps/cli/src/checks/registry.ts contains: name: 'pr-premise-reassert'",
      '- apps/cli/src/checks/registry.ts contains: this literal string was never written'
    )
    expect(falsified).not.toBe(LIVE)
    const result = reassertPrBodyPremise(falsified, realFileReader)
    expect(result?.pass).toBe(false)
    expect(result?.errors[0]?.message).toContain('apps/cli/src/checks/registry.ts')
  })
})
