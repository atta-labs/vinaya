import { suiteMean, type BootstrapMethod } from './estimators'

export const STEP_ONE_SUITES = [
  'developer-capability.l5',
  'code-reviewer-quality.l5',
  'security-reviewer-quality.l5'
] as const
export const STEP_ONE_ADAPTERS = ['claude-code', 'codex'] as const

export type StepOneSuite = (typeof STEP_ONE_SUITES)[number]
export type StepOneAdapter = (typeof STEP_ONE_ADAPTERS)[number]
export type StepOneRefusalCode = 'held_out_forbidden' | 'engine_forbidden' | 'empty_development_split' | 'invalid_input'
export type StepOneRefusal = { code: StepOneRefusalCode; detail: string }

export interface StepOneUsage {
  wallTimeMs: number
  inputTokens: number
  outputTokens: number
  subscriptionQuota: number | null
  estimatedCostUsd: number
}

export interface StepOneTrialResult {
  success: boolean
  usage: StepOneUsage
}

export interface StepOneSuiteInput {
  suite: StepOneSuite
  taskIds: readonly string[]
}

export interface StepOneOptions {
  split: 'development' | 'held-out'
  backend: 'standalone' | 'engine'
  trialsPerTask: number
  bootstrap: { method: BootstrapMethod; seed: number; resamples: number; confidence: number }
}

export interface StepOneResult {
  kind: 'development-standalone-step-one'
  split: 'development'
  backend: 'standalone'
  trialsPerTask: number
  runs: Array<{
    suite: StepOneSuite
    adapter: StepOneAdapter
    taskCount: number
    tasks: Array<{ taskId: string; successes: number; trials: number }>
    mean: number
    interval: { lower: number; upper: number }
    usage: StepOneUsage
  }>
}

export type StepOneOutcome = { ok: true; value: StepOneResult } | { ok: false; refusal: StepOneRefusal }
export type StepOneExecutor = (input: {
  suite: StepOneSuite
  adapter: StepOneAdapter
  taskId: string
  attempt: number
}) => Promise<StepOneTrialResult>

const refusal = (code: StepOneRefusalCode, detail: string): StepOneOutcome => ({ ok: false, refusal: { code, detail } })

/**
 * Runs milestone step one only. The split and backend checks precede every
 * access to suite inputs, so a refused invocation cannot open held-out data.
 */
export async function runStepOne(
  options: StepOneOptions,
  loadDevelopmentSuites: () => readonly StepOneSuiteInput[],
  execute: StepOneExecutor
): Promise<StepOneOutcome> {
  if (options.split !== 'development') return refusal('held_out_forbidden', 'step one may read only development splits')
  if (options.backend !== 'standalone')
    return refusal('engine_forbidden', 'step one runs only on the standalone backend')
  if (!Number.isInteger(options.trialsPerTask) || options.trialsPerTask < 1)
    return refusal('invalid_input', 'trialsPerTask must be a positive integer')

  const suites = loadDevelopmentSuites()
  const runs: StepOneResult['runs'] = []
  for (const suite of STEP_ONE_SUITES) {
    const input = suites.find((entry) => entry.suite === suite)
    if (input === undefined || input.taskIds.length === 0)
      return refusal('empty_development_split', `${suite} has no reconstructable development task`)
    for (const adapter of STEP_ONE_ADAPTERS) {
      const tasks: Array<{ taskId: string; successes: number; trials: number }> = []
      const usage: StepOneUsage = {
        wallTimeMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        subscriptionQuota: 0,
        estimatedCostUsd: 0
      }
      for (const taskId of input.taskIds) {
        let successes = 0
        for (let attempt = 1; attempt <= options.trialsPerTask; attempt++) {
          const trial = await execute({ suite, adapter, taskId, attempt })
          if (trial.success) successes++
          usage.wallTimeMs += trial.usage.wallTimeMs
          usage.inputTokens += trial.usage.inputTokens
          usage.outputTokens += trial.usage.outputTokens
          usage.estimatedCostUsd += trial.usage.estimatedCostUsd
          usage.subscriptionQuota =
            usage.subscriptionQuota === null || trial.usage.subscriptionQuota === null
              ? null
              : usage.subscriptionQuota + trial.usage.subscriptionQuota
        }
        tasks.push({ taskId, successes, trials: options.trialsPerTask })
      }
      const estimate = suiteMean(tasks, options.bootstrap)
      if (!estimate.ok) return refusal('invalid_input', estimate.refusal.detail)
      runs.push({
        suite,
        adapter,
        taskCount: tasks.length,
        tasks,
        mean: estimate.value.mean,
        interval: estimate.value.interval,
        usage
      })
    }
  }
  return {
    ok: true,
    value: {
      kind: 'development-standalone-step-one',
      split: 'development',
      backend: 'standalone',
      trialsPerTask: options.trialsPerTask,
      runs
    }
  }
}
