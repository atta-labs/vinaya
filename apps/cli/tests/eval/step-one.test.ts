import { describe, expect, it } from 'bun:test'
import { runStepOne, STEP_ONE_SUITES } from '../../src/lib/dev-review-eval/step-one'

const options = {
  split: 'development' as const,
  backend: 'standalone' as const,
  trialsPerTask: 2,
  bootstrap: { method: 'percentile' as const, seed: 7, resamples: 20, confidence: 0.95 }
}
const suites = () => STEP_ONE_SUITES.map((suite) => ({ suite, taskIds: [`${suite}-task`] }))
const usage = { wallTimeMs: 10, inputTokens: 3, outputTokens: 2, subscriptionQuota: 0.1, estimatedCostUsd: 0.01 }

describe('development-only step one', () => {
  it('runs all three suites on both adapters and reports estimates and usage', async () => {
    const calls: string[] = []
    const result = await runStepOne(options, suites, async (input) => {
      calls.push(`${input.suite}:${input.adapter}:${input.taskId}:${input.attempt}`)
      return { success: input.attempt === 1, usage }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.runs).toHaveLength(6)
    expect(calls).toHaveLength(12)
    for (const run of result.value.runs) {
      expect(run).toMatchObject({ taskCount: 1, mean: 0.5, usage: { wallTimeMs: 20, inputTokens: 6, outputTokens: 4 } })
      expect(run.tasks).toEqual([{ taskId: `${run.suite}-task`, successes: 1, trials: 2 }])
    }
  })

  it('refuses held-out and Engine requests before loading any split', async () => {
    let reads = 0
    const load = () => {
      reads++
      return suites()
    }
    const execute = async () => ({ success: true, usage })
    const heldOut = await runStepOne({ ...options, split: 'held-out' }, load, execute)
    const engine = await runStepOne({ ...options, backend: 'engine' }, load, execute)
    expect(heldOut).toEqual({ ok: false, refusal: { code: 'held_out_forbidden', detail: expect.any(String) } })
    expect(engine).toEqual({ ok: false, refusal: { code: 'engine_forbidden', detail: expect.any(String) } })
    expect(reads).toBe(0)
  })
})
