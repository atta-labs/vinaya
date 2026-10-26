import { describe, test } from 'bun:test'
import { ALL_RUNNERS } from './runners'

// Owner: agent C. Test temp storage on disk with owned cleanup.
// Placeholder: the cases below are owed and land with the fixes they prove.

describe.each(ALL_RUNNERS)('%s', () => {
  test.todo('quota or peak-space exhaustion during a test run is reported, not hidden')
  test.todo('an interrupted cleanup is finished by the next sweep')
  test.todo('an abandoned run directory is swept and a live owner keeps its directory')
})
