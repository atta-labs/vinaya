import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CloneStaging, git } from '../../src/lib/dev-review-eval/staging'
import {
  GRADING_CODEX_PACKAGE,
  openGradingSandbox,
  PRODUCTION_STEP_ONE_RUNTIME,
  runStepOne,
  runStepOneCommand,
  STEP_ONE_SUITES,
  subscriptionQuotaOf,
  TRIAL_COMMIT_SCRIPT,
  unavailableReason,
  verifyTrialCommit
} from '../../src/lib/dev-review-eval/step-one'
import { expectGradingSandboxDenies, proveGradingSandbox } from './grading-sandbox-proof'

const options = {
  split: 'development' as const,
  backend: 'standalone' as const,
  trialsPerTask: 2,
  bootstrap: { method: 'percentile' as const, seed: 7, resamples: 20, confidence: 0.95 }
}
const suites = () => STEP_ONE_SUITES.map((suite) => ({ suite, taskIds: [`${suite}-task`] }))
const usage = { wallTimeMs: 10, inputTokens: 3, outputTokens: 2, subscriptionQuota: 0.1, estimatedCostUsd: 0.01 }

describe('development-only step one', () => {
  it('charges a trial the increase between the before and after readings of one window only', () => {
    const claude = (type: string, utilization: number) =>
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: type, utilization } })
    expect(
      subscriptionQuotaOf('claude-code', [
        claude('five_hour', 0.37),
        claude('seven_day', 0.9),
        claude('five_hour', 0.42)
      ])
    ).toBeCloseTo(0.05)
    const codex = (primary: number, secondary: number) =>
      JSON.stringify({
        msg: { rate_limits: { primary: { used_percent: primary }, secondary: { used_percent: secondary } } }
      })
    // The first reading's primary window against the last reading's primary window — never primary against secondary.
    expect(subscriptionQuotaOf('codex', [codex(10, 80), codex(12, 81)])).toBe(2)
    expect(subscriptionQuotaOf('codex', [codex(42, 50), codex(42, 50)])).toBe(0)
  })

  it('records quota unavailable without a reading pair or across a window reset, never inferring one', () => {
    expect(subscriptionQuotaOf('codex', ['{"rate_limits":{"primary":{"used_percent":42}}}'])).toBeNull()
    expect(subscriptionQuotaOf('codex', ['{"type":"turn.completed","usage":{"input_tokens":7}}'])).toBeNull()
    expect(
      subscriptionQuotaOf('codex', [
        '{"rate_limits":{"secondary":{"used_percent":3}}}',
        '{"rate_limits":{"secondary":{"used_percent":9}}}'
      ])
    ).toBeNull()
    expect(
      subscriptionQuotaOf('codex', [
        '{"rate_limits":{"primary":{"used_percent":90}}}',
        '{"rate_limits":{"primary":{"used_percent":1}}}'
      ])
    ).toBeNull()
    expect(
      subscriptionQuotaOf('claude-code', [
        '{"rate_limit_info":{"utilization":0.37}}',
        '{"rate_limit_info":{"utilization":0.42}}'
      ])
    ).toBeNull()
  })

  it('keeps measured quota when another trial has no reading pair, and counts the unavailable trials', async () => {
    let calls = 0
    const result = await runStepOne(options, suites, async () => ({
      success: true,
      usage: { ...usage, subscriptionQuota: calls++ % 2 === 0 ? 0.25 : null }
    }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const run of result.value.runs) {
      expect(run.usage.subscriptionQuota).toBeCloseTo(0.25)
      expect(run.quotaUnavailableTrials).toBe(1)
    }
    const none = await runStepOne(options, suites, async () => ({
      success: true,
      usage: { ...usage, subscriptionQuota: null }
    }))
    if (none.ok) expect(none.value.runs.every((run) => run.usage.subscriptionQuota === null)).toBe(true)
  })

  it('stores an unavailable reason redacted and truncated', () => {
    const token = `ghp_${'a'.repeat(36)}`
    const reason = unavailableReason(
      'Codex grading sandbox unavailable',
      new Error(`leaked ${token} ${'x'.repeat(2000)}`)
    )
    expect(reason).not.toContain(token)
    expect(reason).toContain('<redacted>')
    expect(reason.length).toBeLessThanOrEqual(501)
  })

  it('launches every trial step only through codex sandbox, network off, with a placeholder login and no token', () => {
    const target = realpathSync(mkdtempSync(join(tmpdir(), 'step-one-isolation-')))
    const sandbox = openGradingSandbox()
    try {
      const launched = sandbox.launch(['bun', 'test', 'planted.test.ts'], [target])
      const text = launched.command.join(' ')
      expect(launched.command.slice(1, 4)).toEqual(['x', GRADING_CODEX_PACKAGE, 'sandbox'])
      expect(launched.command).toContain('sandbox_workspace_write.network_access=false')
      expect(launched.command).toContain('sandbox_workspace_write.exclude_slash_tmp=true')
      expect(launched.command).toContain('sandbox_workspace_write.exclude_tmpdir_env_var=true')
      expect(launched.command).toContain(
        `sandbox_workspace_write.writable_roots=${JSON.stringify([sandbox.scratch, target])}`
      )
      expect(text).not.toContain('sandbox-exec')
      expect(text).not.toContain('bwrap')
      expect(Object.keys(launched.env).sort()).toEqual(['CODEX_HOME', 'HOME', 'LANG', 'PATH', 'TMPDIR'])
      expect(launched.env.HOME).toBe(sandbox.scratch)
      expect(launched.env.TMPDIR).toBe(sandbox.scratch)
      expect(launched.env.CODEX_HOME?.startsWith(sandbox.scratch)).toBe(false)
      expect(readFileSync(join(launched.env.CODEX_HOME as string, 'auth.json'), 'utf8')).toBe('{}\n')
    } finally {
      sandbox.dispose()
      rmSync(target, { recursive: true, force: true })
    }
  })

  it.skipIf(Bun.which('codex') === null)(
    'denies a graded test file writes outside scratch, the network, and every planted token',
    async () => {
      expectGradingSandboxDenies(await proveGradingSandbox())
    },
    360_000
  )

  describe('the trial commit the host verifies', () => {
    const repository = () => {
      const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'step-one-commit-')))
      git(workspace, ['init', '--quiet'])
      const commit = (message: string) => {
        git(workspace, [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          'commit',
          '--quiet',
          '--allow-empty',
          '-m',
          message
        ])
        return git(workspace, ['rev-parse', 'HEAD']).trim()
      }
      const base = commit('base')
      const staging = { workspace, gitDir: join(workspace, '.git'), baseCommit: base } as unknown as CloneStaging
      return { workspace, staging, base, commit }
    }

    it('grades the commit an agent already made, its tree clean', () => {
      const { workspace, staging, commit } = repository()
      const head = commit('agent work')
      expect(git(workspace, ['status', '--porcelain'])).toBe('')
      expect(verifyTrialCommit(staging, `noise\ntrial-commit ${head}\n`)).toEqual({ ok: true, commit: head })
      rmSync(workspace, { recursive: true, force: true })
    })

    it('commits only uncommitted work, and reports the commit HEAD names either way', () => {
      const { workspace, staging, commit } = repository()
      const step = () =>
        Bun.spawnSync(['/bin/sh', '-c', TRIAL_COMMIT_SCRIPT, 'commit-trial', 'Eval(developer): trial'], {
          cwd: workspace,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: workspace }
        }).stdout.toString()
      const agentCommit = commit('agent work')
      expect(step()).toBe(`trial-commit ${agentCommit}\n`)
      writeFileSync(join(workspace, 'solution.ts'), 'export {}\n')
      const output = step()
      const committed = verifyTrialCommit(staging, output)
      expect(committed.ok).toBe(true)
      if (committed.ok) expect(committed.commit).not.toBe(agentCommit)
      expect(git(workspace, ['status', '--porcelain'])).toBe('')
      rmSync(workspace, { recursive: true, force: true })
    })

    it('records a trial with no commit ahead of its base unavailable', () => {
      const { workspace, staging, base } = repository()
      expect(verifyTrialCommit(staging, `trial-commit ${base}\n`)).toEqual({
        ok: false,
        reason: 'Developer trial has no commit ahead of its base'
      })
      expect(verifyTrialCommit(staging, 'nothing reported\n').ok).toBe(false)
      expect(verifyTrialCommit(staging, `trial-commit ${'0'.repeat(40)}\n`).ok).toBe(false)
      rmSync(workspace, { recursive: true, force: true })
    })

    it('refuses a trial repository whose configuration includes another file, running none of its hooks', () => {
      const { workspace, staging, commit } = repository()
      const head = commit('agent work')
      const marker = join(workspace, 'hook-ran')
      writeFileSync(join(workspace, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
      git(workspace, ['config', 'core.fsmonitor', `touch ${marker}`])
      expect(verifyTrialCommit(staging, `trial-commit ${head}\n`)).toEqual({ ok: true, commit: head })
      expect(existsSync(marker)).toBe(false)
      writeFileSync(
        join(workspace, '.git', 'config'),
        `${readFileSync(join(workspace, '.git', 'config'), 'utf8')}[includeIf "gitdir:/"]\n\tpath = /elsewhere\n`
      )
      expect(verifyTrialCommit(staging, `trial-commit ${head}\n`).ok).toBe(false)
      rmSync(workspace, { recursive: true, force: true })
    })
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
