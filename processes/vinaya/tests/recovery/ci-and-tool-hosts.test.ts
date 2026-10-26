import { describe, test } from 'bun:test'
import { ALL_RUNNERS } from './runners'

// Owner: agent B. An unpushed head never reaches a CI read; dev-tools hosts are replaced only at a dispatch boundary.
// Placeholder: the cases below are owed and land with the fixes they prove.

describe.each(ALL_RUNNERS)('%s', () => {
  test.todo('an unpushed head with a pull request open goes to the Developer with no CI poll')
  test.todo('a remote-read failure stays a read failure')
  test.todo('a dead dev-tools bridge fails a Codex start loudly')
  test.todo('a socket deleted between dispatches is replaced before the next dispatch, for every role')
  test.todo('a socket deleted mid-turn costs one bounded re-dispatch and repeats no effect')
})
