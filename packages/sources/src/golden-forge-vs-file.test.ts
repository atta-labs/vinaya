import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseTranche } from '@attalabs/aeg-core'
import { describe, expect, it } from 'bun:test'

/**
 * Golden comparison (brief §1 Context point 3, §9 Part C1): originally
 * proved the forge-backed and file-backed StateSource designs produce
 * equivalent `Tranche` shapes for the same real tranche (attalabs'
 * `aeg-forge-state-v1`), by `git show`-ing a pinned attalabs commit and
 * comparing it against a live `deriveTrancheFromForge(...)` call against
 * attalabs' own forge.
 *
 * Neither half of that comparison can run in this repo without
 * reintroducing an attalabs dependency (vinaya-extraction-v1 task 3):
 *   - the pinned commit SHA does not exist after `git filter-repo` rewrote
 *     every hash, and the file's directory (`aeg-root/iterations/`) is
 *     retired vocabulary;
 *   - `deriveTrancheFromForge` (`@attalabs/aeg-forge-state`) has no
 *     fixture-injection seam — it always does a real `owner`/`repo`/`slug`
 *     GitHub Milestone+Issues lookup, see its own doc comment — and this
 *     repo's own forge has no comparable real tranche yet (no
 *     `vinaya/tranche:*`-labeled Issues exist in `atta-labs/vinaya` at the
 *     time of this task). Adding a fixture seam to `deriveTrancheFromForge`
 *     is an engine-behaviour change out of this task's surface; pointing
 *     this test back at attalabs' forge would reintroduce exactly the
 *     dependency this task exists to remove.
 *
 * What's kept: `parseTranche`'s coverage against a real-shaped tranche file
 * — the topology table, per-task rationale blocks, and the backlog section
 * — pinned against a committed fixture this repo owns
 * (`fixtures/golden-tranche-snapshot.md`) instead of attalabs' history.
 *
 * What's dropped: the forge-derivation half of the golden comparison. This
 * is a real coverage gap, not a silent skip — flagged here (loud `it.skip`,
 * not a hidden `describe.skipIf`) and in the PR body as a finding: this test
 * can be restored in full once `atta-labs/vinaya` has its own real
 * forge-tracked tranche to derive from.
 */

const FIXTURE_PATH = fileURLToPath(new URL('fixtures/golden-tranche-snapshot.md', import.meta.url))

describe('golden comparison — aeg-forge-state-v1 (forge half dropped, see file doc comment)', () => {
  it('parseTranche reads a real-shaped tranche file: topology, rationale blocks, backlog', () => {
    const fileContent = readFileSync(FIXTURE_PATH, 'utf-8')
    const tranche = parseTranche(fileContent)

    expect(tranche.name).toBe('golden-snapshot-example')
    expect(tranche.lifecycle).toBe('complete')
    expect(tranche.goal).toContain('parseTranche')
    expect(tranche.tasks).toHaveLength(2)
    expect(tranche.tasks[0]).toMatchObject({ id: '1', issue: 1, dependsOn: [] })
    expect(tranche.tasks[1]).toMatchObject({ id: '2', issue: 2, dependsOn: ['1'] })
    expect(tranche.tasks[0]?.rationaleMarkdown).toContain('Boundary')
    expect(tranche.backlog).toHaveLength(1)
  })

  it.skip(
    'forge-derived half of the golden comparison — no fixture seam in deriveTrancheFromForge, ' +
      'and no comparable real tranche in this repo’s own forge yet (see file doc comment)',
    () => {}
  )
})
