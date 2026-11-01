import { describe, expect, test } from 'bun:test'
import { createLogTranslator, recordingActions, type LogEventInput, type LogProducers } from './translate'

const mark = (event: string): LogEventInput => ({ kind: 'test', event })

function recorder(producers: LogProducers) {
  const emitted: LogEventInput[] = []
  const translator = createLogTranslator(producers, (event) => emitted.push(event))
  return { translator, emitted }
}

describe('the log translator', () => {
  test('hands each lifecycle event to its producer and emits what comes back, in order', () => {
    const { translator, emitted } = recorder({
      nodeStarted: ({ nodeId }) => [mark(`start:${nodeId}`), mark('after-start')],
      nodeCompleted: ({ nodeId }) => [mark(`complete:${nodeId}`)],
      nodeFailed: ({ nodeId, error }) => [mark(`failed:${nodeId}:${error}`)]
    })
    translator.onEvent({ type: 'node:start', nodeId: 'a', runId: 'r' })
    translator.onEvent({ type: 'node:streaming', nodeId: 'a', runId: 'r', content: 'x' })
    translator.onEvent({ type: 'node:complete', nodeId: 'a', runId: 'r' })
    translator.onEvent({ type: 'node:start', nodeId: 'b', runId: 'r' })
    translator.onEvent({ type: 'node:failed', nodeId: 'b', runId: 'r', error: 'boom' })
    expect(emitted.map((event) => event.event)).toEqual([
      'start:a',
      'after-start',
      'complete:a',
      'start:b',
      'after-start',
      'failed:b:boom'
    ])
    expect(translator.produced).toEqual(emitted)
  })

  test('counts how often a node has started, across legs', () => {
    const attempts: number[] = []
    const { translator } = recorder({
      nodeStarted: ({ attempt }) => {
        attempts.push(attempt)
        return []
      }
    })
    translator.beginLeg()
    translator.onEvent({ type: 'node:start', nodeId: 'a', runId: 'r' })
    translator.onEvent({ type: 'node:start', nodeId: 'b', runId: 'r' })
    translator.onEvent({ type: 'node:start', nodeId: 'a', runId: 'r' })
    translator.beginLeg({ resumed: true })
    translator.onEvent({ type: 'node:start', nodeId: 'a', runId: 'r' })
    expect(attempts).toEqual([1, 1, 2, 3])
  })

  test('tells legStarted whether the leg continues a halted run', () => {
    const seen: boolean[] = []
    const { translator } = recorder({
      legStarted: ({ resumed }) => {
        seen.push(resumed)
        return []
      }
    })
    translator.beginLeg()
    translator.beginLeg({ resumed: true })
    expect(seen).toEqual([false, true])
  })

  test('a producer reads the result a step recorded before it completed', async () => {
    const { translator, emitted } = recorder({
      nodeCompleted: ({ nodeId, steps }) => [{ kind: 'test', event: 'done', output: steps[nodeId]?.stdout }]
    })
    const actions = recordingActions({ run: () => ({ exitCode: 0, stdout: 'hello' }) }, translator)
    await actions.run?.({ nodeId: 'step', action: 'run', results: {} })
    translator.onEvent({ type: 'node:complete', nodeId: 'step', runId: 'r' })
    expect(emitted).toEqual([{ kind: 'test', event: 'done', output: 'hello' }])
  })

  test('an action that throws still records the output it attached to its error', async () => {
    const failure = Object.assign(new Error('refused'), { stdout: 'partial' })
    const { translator, emitted } = recorder({
      nodeFailed: ({ nodeId, steps }) => [{ kind: 'test', event: 'failed', ...steps[nodeId] }]
    })
    const actions = recordingActions(
      {
        run: () => {
          throw failure
        },
        plain: () => {
          throw new Error('no output')
        }
      },
      translator
    )
    await expect(actions.run?.({ nodeId: 'step', action: 'run', results: {} })).rejects.toBe(failure)
    await expect(actions.plain?.({ nodeId: 'other', action: 'plain', results: {} })).rejects.toThrow('no output')
    translator.onEvent({ type: 'node:failed', nodeId: 'step', runId: 'r', error: 'refused' })
    translator.onEvent({ type: 'node:failed', nodeId: 'other', runId: 'r', error: 'no output' })
    expect(emitted).toEqual([
      { kind: 'test', event: 'failed', exitCode: 1, stdout: 'partial', stderr: 'refused' },
      { kind: 'test', event: 'failed', exitCode: 1, stdout: '', stderr: 'no output' }
    ])
  })

  test('the run end sees the outcome, the cancel flag, and checkpoint results only where nothing was recorded', () => {
    const seen: unknown[] = []
    const { translator } = recorder({
      runEnded: (context) => {
        seen.push(context)
        return [mark('ended')]
      }
    })
    translator.recordStep('kept', { exitCode: 0, stdout: 'recorded', stderr: '' })
    translator.endLeg(
      {
        reason: 'completed',
        checkpoint: {
          results: { kept: { exitCode: 9, stdout: 'checkpoint' }, filled: { exitCode: 2, stdout: 'from checkpoint' } }
        }
      },
      { cancelled: true }
    )
    expect(seen).toEqual([
      {
        outcome: expect.objectContaining({ reason: 'completed' }),
        cancelled: true,
        steps: {
          kept: { exitCode: 0, stdout: 'recorded', stderr: '' },
          filled: { exitCode: 2, stdout: 'from checkpoint', stderr: '' }
        }
      }
    ])
  })

  test('a producer that is absent emits nothing', () => {
    const { translator, emitted } = recorder({})
    translator.beginLeg()
    translator.onEvent({ type: 'node:start', nodeId: 'a', runId: 'r' })
    translator.onEvent({ type: 'node:complete', nodeId: 'a', runId: 'r' })
    translator.endLeg({ reason: 'completed' })
    expect(emitted).toEqual([])
  })
})
