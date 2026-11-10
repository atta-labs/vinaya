import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..', '..', '..')

/** The runtime names an entry exports, read in a fresh process that also reports anything the import printed. */
function importEntry(file: string): { names: string[]; stdout: string } {
  const script = `const m = await import(${JSON.stringify(join(repoRoot, file))}); process.stderr.write(JSON.stringify(Object.keys(m).sort()))`
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', cwd: repoRoot })
  expect(run.status).toBe(0)
  return { names: JSON.parse(run.stderr) as string[], stdout: run.stdout }
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
    expect(entry.stdout).toBe('')
  })

  test('the harness entry exports exactly the resolver and the loader and prints nothing on import', () => {
    const entry = importEntry('harness/kernel/public-api.ts')
    expect(entry.names).toEqual(['loadProcess', 'resolveRepo'])
    expect(entry.stdout).toBe('')
  })

  test('the process entry values keep their behaviour', async () => {
    const entry = await import('../../../harness/processes/vinaya-strict/public-api')
    expect(entry.COMMIT_TYPE_STYLE.test('Feat(cli): A thing')).toBe(true)
    expect(entry.COMMIT_TYPE_STYLE.test('not a commit title')).toBe(false)
  })
})
