import { expect, test } from 'bun:test'
import { readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ATTRIBUTE_NAMES as A } from '../src/contract/catalogue.js'
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
    const path = join(repo.folder, file)
    const document = JSON.parse(readFileSync(path, 'utf8'))
    const attrs = document.resourceLogs[0].scopeLogs[0].logRecords[0].attributes as Array<{
      key: string
      value: { intValue: string }
    }>
    const sequence = attrs.find((attr) => attr.key === A.seq)
    if (!sequence) throw new Error('missing writer sequence')
    sequence.value.intValue = '2'
    writeFileSync(path, JSON.stringify(document) + '\n')
    const child = repo.follow(['--run', 'test-run'])
    const reader = child.stdout.getReader()
    try {
      let output = ''
      const decoder = new TextDecoder()
      const deadline = AbortSignal.timeout(3000)
      const expired = new Promise<never>((_, reject) =>
        deadline.addEventListener('abort', () => reject(new Error('follow did not print')), { once: true })
      )
      while (!output.includes('sequence 1') || !output.includes(line ?? 'missing narration')) {
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

test('task follow includes unstamped writers and sanitizes narration', async () => {
  const repo = fixture()
  try {
    expect(repo.call(['run', 'started', '--run', 'test-run', '--json', '{"work":{"ref":"task-a"}}']).exitCode).toBe(0)
    expect(
      repo.call(['agent', 'sent', '--run', 'test-run', '--json', JSON.stringify({ seat: 'builder\u001b[2J' })]).exitCode
    ).toBe(0)
    symlinkSync(join(repo.cwd, 'log.config.json'), join(repo.folder, 'test-run~linked~000000000000.logs.jsonl'))
    const child = repo.follow(['--task', 'task-a'])
    const reader = child.stdout.getReader()
    try {
      const expired = new Promise<never>((_, reject) =>
        AbortSignal.timeout(3000).addEventListener('abort', () => reject(new Error('follow did not print')))
      )
      let output = ''
      while (!output.includes('Log gap') || !output.includes('Builder [2J is working.')) {
        const chunk = await Promise.race([reader.read(), expired])
        if (chunk.done) throw new Error('follow exited early')
        output += new TextDecoder().decode(chunk.value)
      }
      expect(output).not.toContain('\u001b')
      expect(output.trimEnd().split('\n')).toHaveLength(3)
    } finally {
      child.kill()
      await child.exited
      reader.releaseLock()
    }
  } finally {
    repo.clean()
  }
})
