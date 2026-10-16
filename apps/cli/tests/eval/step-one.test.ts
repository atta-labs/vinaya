import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnBudgetedAsync, stripVinayaEnv } from '../lib/process-fixture'
import {
  PRODUCTION_STEP_ONE_RUNTIME,
  gradingIsolation,
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
    expect(
      subscriptionQuotaOf('claude-code', [
        '{"rate_limit_info":{"utilization":0.37}}',
        '{"rate_limit_info":{"utilization":0.42}}'
      ])
    ).toBeCloseTo(0.05)
    expect(
      subscriptionQuotaOf('codex', [
        '{"rate_limits":{"primary":{"used_percent":42}}}',
        '{"rate_limits":{"primary":{"used_percent":42}}}'
      ])
    ).toBe(0)
    expect(subscriptionQuotaOf('codex', ['{"rate_limits":{"primary":{"used_percent":42}}}'])).toBeNull()
    expect(subscriptionQuotaOf('codex', ['{"type":"turn.completed"}'])).toBeNull()
  })

  it('builds grading only through Codex sandbox with no network or ambient token environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'step-one-isolation-'))
    const workspace = join(root, 'grading')
    const scratch = join(root, 'scratch')
    mkdirSync(workspace)
    mkdirSync(scratch)
    const isolated = gradingIsolation(workspace)(['bun', 'test', 'planted.test.ts'], workspace, scratch)
    expect(isolated.command).toContain('sandbox')
    expect(isolated.command).toContain('sandbox_workspace_write.network_access=false')
    expect(isolated.command.join(' ')).not.toContain('sandbox-exec')
    expect(isolated.command.join(' ')).not.toContain('bwrap')
    expect(Object.keys(isolated.env).sort()).toEqual(['CODEX_HOME', 'HOME', 'LANG', 'PATH', 'TMPDIR'])
    expect(Object.keys(isolated.env).some((key) => /TOKEN|FORGE|LOG|VENDOR/i.test(key))).toBe(false)
    expect(isolated.command.join(' ')).toContain(workspace)
    expect(isolated.command.join(' ')).toContain(scratch)
  })

  it('denies a graded test file writes outside scratch, network, and ambient tokens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'step-one-sandbox-proof-'))
    const workspace = join(root, 'grading')
    const scratch = join(root, 'scratch')
    mkdirSync(workspace)
    mkdirSync(scratch)
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(
      join(workspace, 'planted.test.ts'),
      `import { expect, test } from 'bun:test'\n` +
        `import { writeFileSync } from 'node:fs'\n` +
        `test('boundary', async () => {\n` +
        `  expect(() => writeFileSync(${JSON.stringify(join(outside, 'escaped'))}, 'no')).toThrow()\n` +
        `  expect(await fetch('https://example.com').then(() => false, () => true)).toBe(true)\n` +
        '  expect(Object.keys(process.env).some((key) => /TOKEN|FORGE|LOG|VENDOR/i.test(key))).toBe(false)\n' +
        '})\n'
    )
    const isolated = gradingIsolation(workspace)(['bun', 'test', 'planted.test.ts'], workspace, scratch)
    const codex = Bun.which('codex')
    expect(codex).not.toBeNull()
    const command = [codex as string, ...isolated.command.slice(3)]
    const run = await spawnBudgetedAsync(
      command,
      { cwd: workspace, env: { ...stripVinayaEnv({}), ...isolated.env } },
      120_000,
      'Codex grading sandbox proof'
    )
    const exitCode = run.status
    const output = `${run.stdout}\n${run.stderr}`
    if (/sandbox_apply: Operation not permitted/.test(output)) {
      expect(exitCode).not.toBe(0)
      return
    }
    expect(exitCode, output).toBe(0)
  }, 120_000)

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
      expect(run.tasks).toEqual([{ taskId: `${run.suite}-task`, successes: 1, trials: 2, unavailable: [] }])
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
