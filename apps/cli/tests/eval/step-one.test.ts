import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PRODUCTION_STEP_ONE_RUNTIME,
  runStepOne,
  runStepOneCommand,
  STEP_ONE_SUITES,
  subscriptionQuotaOf
} from '../../src/lib/dev-review-eval/step-one'

const options = {
  split: 'development' as const,
  backend: 'standalone' as const,
  trialsPerTask: 2,
  bootstrap: { method: 'percentile' as const, seed: 7, resamples: 20, confidence: 0.95 }
}
const suites = () => STEP_ONE_SUITES.map((suite) => ({ suite, taskIds: [`${suite}-task`] }))
const usage = { wallTimeMs: 10, inputTokens: 3, outputTokens: 2, subscriptionQuota: 0.1, estimatedCostUsd: 0.01 }

describe('development-only step one', () => {
  it('reads adapter-reported quota telemetry without inventing a missing value', () => {
    expect(subscriptionQuotaOf('claude-code', ['{"rate_limit_info":{"utilization":0.37}}'])).toBe(0.37)
    expect(subscriptionQuotaOf('codex', ['{"rate_limits":{"primary":{"used_percent":42}}}'])).toBe(42)
    expect(subscriptionQuotaOf('codex', ['{"type":"turn.completed"}'])).toBeNull()
  })

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

  it('the executable command loads the real development corpora and dispatches every real task', async () => {
    const loaded = await PRODUCTION_STEP_ONE_RUNTIME.loadDevelopment()
    expect(loaded.suites.map((entry) => [entry.suite, entry.taskIds.length])).toEqual([
      ['developer-capability.l5', 28],
      ['code-reviewer-quality.l5', 11],
      ['security-reviewer-quality.l5', 6]
    ])
    const calls: string[] = []
    const out = join(mkdtempSync(join(tmpdir(), 'step-one-command-')), 'result.json')
    const result = await runStepOneCommand(
      [
        'run',
        '--split',
        'development',
        '--backend',
        'standalone',
        '--trials',
        '1',
        '--bootstrap',
        'percentile',
        '--seed',
        '7',
        '--resamples',
        '20',
        '--confidence',
        '0.95',
        '--input-cost-per-million',
        '1',
        '--output-cost-per-million',
        '2',
        '--out',
        out
      ],
      {
        loadDevelopment: async () => loaded,
        execute: async (input) => {
          calls.push(`${input.suite}:${input.adapter}:${input.taskId}`)
          return { success: true, usage: { ...usage, estimatedCostUsd: 0 } }
        }
      }
    )
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(90)
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(result)
    if (result.ok) expect(result.value.runs.every((run) => run.usage.estimatedCostUsd > 0)).toBe(true)
  })
})
