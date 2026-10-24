import { describe, expect, it } from 'bun:test'
import corpus from '../fixtures/dev-review-engine-scenarios.json'
import { SCENARIO_DRIVERS as STANDALONE } from './dev-review-current-loop-adapter.js'
import { ENGINE_SCENARIO_DRIVERS as ENGINE } from './dev-review-engine-loop-adapter.js'

describe('standalone and Engine Log replay', () => {
  it('replays every corpus scenario through both runners without an event difference', async () => {
    for (const scenario of corpus.scenarios) {
      const standalone = await STANDALONE[scenario.id]!()
      for (const agent of ['claude', 'codex'] as const) {
        const engine = await ENGINE[scenario.id]!(agent)
        expect(engine.events, `${scenario.id} (${agent})`).toEqual(standalone.events)
      }
    }
  }, 180_000)
})
