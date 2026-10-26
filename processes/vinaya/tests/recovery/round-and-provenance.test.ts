import { describe, test } from 'bun:test'
import { ENGINE_RUNNERS } from './runners'

// Owner: agent A. The execution round as checkpoint authority, and the agent in checkpoint provenance.
// Placeholder: the cases below are owed and land with the fixes they prove.

describe.each(ENGINE_RUNNERS)('%s', () => {
  test.todo('a driver restart at each round interruption point resumes with no replayed input version')
  test.todo('a crash between each pair of persistence writes leaves no double increment and no repeated effect')
  test.todo('a crash after pending writes and before the next full checkpoint resumes at the right round')
  test.todo('a resume with a different agent is refused and changes nothing')
  test.todo('a checkpoint with no recorded agent is refused with a fresh-start instruction')
})
