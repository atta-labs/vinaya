import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ATTRIBUTE_NAMES as A } from '../src/contract/catalogue.js'
import { fixture } from './bin-fixture.js'

test('each separate start and end writes one whole span with the original identity and time', async () => {
  const repo = fixture()
  try {
    const pairs = [
      ['run started', 'run ended', {}, {}, 'invoke_workflow'],
      ['round started', 'round ended', { number: 2 }, { round: 2 }, 'vinaya.round 2'],
      ['agent sent', 'agent returned', { seat: 'developer' }, {}, 'invoke_agent developer'],
      ['agent sent', 'agent failed', { seat: 'reviewer' }, { errorType: 'timeout' }, 'invoke_agent reviewer'],
      ['agent step-started', 'agent step-ended', { tool: 'Bash' }, {}, 'execute_tool Bash'],
      ['run paused', 'run resumed', { why: 'approval' }, { by: 'person' }, 'vinaya.pause'],
      [
        'person asked',
        'person answered',
        { kind: 'strategy', key: 'question' },
        { by: 'principal' },
        'vinaya.person strategy'
      ]
    ] as const
    const startTime = 1_700_000_000_000
    for (const [index, [start, end, startFields, endFields, spanName]] of pairs.entries()) {
      const run = 'run-' + index
      const call = (command: string, fields: object) =>
        repo.call([...command.split(' '), '--run', run, '--json', JSON.stringify(fields)])
      const absent = call(end, endFields)
      expect(absent.exitCode).toBe(1)
      expect(absent.stderr.toString()).toContain('missing start')
      expect((await repo.read(run)).records).toEqual([])
      expect(call(start, { ...startFields, startTime }).exitCode).toBe(0)
      expect(call(end, { ...endFields, endTime: startTime + 100 }).exitCode).toBe(0)
      const { records } = await repo.read(run)
      expect(records).toHaveLength(2)
      const started = records.find((r) => r.kind === 'started')
      const span = records.find((r) => r.kind === 'span')
      expect(span?.name).toBe(spanName)
      expect(span?.spanId).toBe(started?.spanId)
      expect(span?.startTime).toBe(started?.time)
      expect(span?.time).toBe(String(BigInt(startTime + 100) * 1_000_000n))
      expect(span?.writerId).not.toBe(started?.writerId)
      if (end === 'agent failed') {
        const file = readdirSync(repo.folder).find(
          (name) => name.startsWith(run + '~') && name.endsWith('.traces.jsonl')
        )
        if (!file) throw new Error('missing traces file')
        expect(
          JSON.parse(readFileSync(join(repo.folder, file), 'utf8')).resourceSpans[0].scopeSpans[0].spans[0].status.code
        ).toBe(2)
      }
    }
  } finally {
    repo.clean()
  }
})

test('checks spans take both times in one command', async () => {
  const repo = fixture()
  try {
    const result = repo.call([
      'checks',
      'local',
      '--run',
      'test-run',
      '--json',
      '{"passed":true,"startTime":1700000000000,"endTime":1700000000100}'
    ])
    expect(result.exitCode).toBe(0)
    const { records } = await repo.read()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      kind: 'span',
      name: 'vinaya.checks local',
      startTime: '1700000000000000000',
      time: '1700000000100000000'
    })
  } finally {
    repo.clean()
  }
})

test('agent usage joins the completed span from a separate invocation', async () => {
  const repo = fixture()
  try {
    expect(repo.call(['agent', 'sent', '--run', 'test-run', '--json', '{"seat":"developer"}']).exitCode).toBe(0)
    expect(
      repo.call(['usage', 'recorded', '--run', 'test-run', '--json', '{"inputTokens":20,"outputTokens":8}']).exitCode
    ).toBe(0)
    expect(repo.call(['agent', 'returned', '--run', 'test-run', '--json', '{}']).exitCode).toBe(0)
    const { records } = await repo.read()
    expect(records).toHaveLength(3)
    const usage = records.find((r) => r.name === 'vinaya.usage.recorded')
    expect(usage?.seq).toBe(1)
    expect(new Set(records.map((r) => r.writerId)).size).toBe(3)
    expect(records.find((r) => r.kind === 'span')?.attributes).toMatchObject({
      [A.usageInputTokens]: 20,
      [A.usageOutputTokens]: 8
    })
  } finally {
    repo.clean()
  }
})
