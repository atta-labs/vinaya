import { describe, test } from 'bun:test'
import { ENGINE_RUNNERS } from './runners'

// Owner: agent D. The ready-gate test run is cancellable and contained.
// Placeholder: the cases below are owed and land with the fixes they prove.

describe.each(ENGINE_RUNNERS)('%s', () => {
  test.todo('a cancel during the ready-gate run ends every registered process and removes its directories')
  test.todo('a ready gate past its deadline records a timeout instead of hanging')
})
