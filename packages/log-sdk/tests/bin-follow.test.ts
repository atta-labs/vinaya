import { expect, test } from 'bun:test'
import { readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { narrate } from '../src/narration/narrate.js'
import { fixture } from './bin-fixture.js'

test('follow narrates local records and gaps even with a server destination configured', async () => {
  const repo = fixture({ otlp: { url: 'http://127.0.0.1:1' } })
  try {
    expect(repo.call(['agent', 'sent', '--run', 'test-run', '--json', '{"seat":"custom-reviewer"}']).exitCode).toBe(0)
    const file = readdirSync(repo.folder)[0]
    if (file === undefined) throw new Error('missing log file')
    const { records } = await repo.read()
    const line = narrate(records[0])?.text
    expect(line).toContain('Custom-reviewer')
    renameSync(join(repo.folder, file), join(repo.folder, file.replace('000000000000', '000000000001')))
    const child = repo.follow(['--run', 'test-run'])
    const reader = child.stdout.getReader()
    try {
      let output = ''
      const decoder = new TextDecoder()
      const deadline = AbortSignal.timeout(3000)
      const expired = new Promise<never>((_, reject) =>
        deadline.addEventListener('abort', () => reject(new Error('follow did not print')), { once: true })
      )
      while (!output.includes('Log gap') || !output.includes(line ?? 'missing narration')) {
        const chunk = await Promise.race([reader.read(), expired])
        if (chunk.done) throw new Error('follow exited early')
        output += decoder.decode(chunk.value, { stream: true })
      }
      expect(output.trimEnd().split('\n')).toHaveLength(2)
    } finally {
      child.kill()
      await child.exited
      reader.releaseLock()
    }
  } finally {
    repo.clean()
  }
})
