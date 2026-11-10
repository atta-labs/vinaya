import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { spawnSyncBudgeted, stripVinayaEnv } from '../../../harness/kernel/conformance/unit/process-fixture'

const repoRoot = join(import.meta.dir, '..', '..', '..')

const MARKER = 'EXPORTED-NAMES:'

/** The runtime names an entry exports, read in a fresh process; `printed` is everything the import itself wrote to stdout or stderr. */
function importEntry(file: string): { names: string[]; printed: string } {
  const script = `const m = await import(${JSON.stringify(join(repoRoot, file))}); console.log('${MARKER}' + JSON.stringify(Object.keys(m).sort()))`
  const run = spawnSyncBudgeted(process.execPath, ['-e', script], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: stripVinayaEnv()
  })
  expect(run.status).toBe(0)
  const lines = run.stdout.split('\n').filter((line) => line !== '')
  const marked = lines.filter((line) => line.startsWith(MARKER))
  expect(marked).toHaveLength(1)
  const printed = [...lines.filter((line) => !line.startsWith(MARKER)), run.stderr].join('')
  return { names: JSON.parse((marked[0] as string).slice(MARKER.length)) as string[], printed }
}

describe('the library entries', () => {
  test('the process entry exports exactly its four values and prints nothing on import', () => {
    const entry = importEntry('harness/processes/vinaya-strict/public-api.ts')
    expect(entry.names).toEqual([
      'COMMIT_TYPE_STYLE',
      'checkLocalAnchorCoverage',
      'evaluateVocabularyCitation',
      'scanRetiredVocabulary'
    ])
    expect(entry.printed).toBe('')
  })

  test('the harness entry exports exactly the resolver and the loader and prints nothing on import', () => {
    const entry = importEntry('harness/kernel/public-api.ts')
    expect(entry.names).toEqual(['loadProcess', 'resolveRepo'])
    expect(entry.printed).toBe('')
  })

  test('the process entry values keep their behaviour', async () => {
    const entry = await import('../../../harness/processes/vinaya-strict/public-api')
    expect(entry.COMMIT_TYPE_STYLE.test('Feat(cli): A thing')).toBe(true)
    expect(entry.COMMIT_TYPE_STYLE.test('not a commit title')).toBe(false)
  })
})
