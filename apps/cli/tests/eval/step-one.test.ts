import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type CloneStaging, git } from '../../src/lib/dev-review-eval/staging'
import type { DevToolContext } from '../../../../harness/kernel/tools/dev-tools-server'
import { DEV_TOOLS_MCP_SERVER_NAME } from '../../../../harness/kernel/tools/dev-tools-names'
import { spawnBudgetedAsync } from '../lib/process-fixture'
import { fixtureDir } from '../lib/test-temp-fixture'
import {
  renderDeveloperDoctrineBlock,
  resolveDeveloperDoctrineText
} from '../../../../harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop/developer-dispatch'
import {
  joinReviewerPromptPieces,
  roleDoctrinePieces
} from '../../../../harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop/reviewer-dispatch'
import { resolveRoleDoctrineText } from '../../../../harness/processes/vinaya-strict/integration/roles/plan'
import type { NeutralCase } from '../../src/lib/dev-review-eval/neutral-case'
import {
  commitInWorkingTree,
  commitTrialInSandbox,
  importTrialBundle,
  NO_DEVELOPMENT,
  openGradingSandbox,
  PRODUCTION_STEP_ONE_RUNTIME,
  PRODUCTION_VINAYA_PROCESS_STEPS,
  rendererVersionOf,
  resolveGradingCodex,
  runStepOne,
  runStepOneCommand,
  selectStepOneSuites,
  STEP_ONE_BACKENDS,
  STEP_ONE_COMPARISON_SUITES,
  STEP_ONE_PRACTICE_SUITES,
  STEP_ONE_SUITE_LAYERS,
  STEP_ONE_SUITES,
  type StepOneCommandContext,
  type StepOneRunSuite,
  stepOneRuntime,
  type TrialDoctrineRole,
  subscriptionQuotaOf,
  TRIAL_COMMIT_SCRIPT,
  trialUsage,
  unavailableReason,
  verifyTrialCommit,
  vinayaProcess,
  type VinayaProcessRequest,
  type VinayaProcessRun,
  type VinayaProcessSteps
} from '../../src/lib/dev-review-eval/step-one'
import { LIVE_SUITE_LAYERS } from '../../src/lib/dev-review-eval/freeze-record'
import {
  HARBOR_TRIAL_BACKENDS,
  type HarborCaseFile,
  type HarborTrialUsage,
  runHarborTrial
} from '../../src/lib/dev-review-eval/harbor-trial'
import {
  ENGINE_DEV_TOOLS_SERVER,
  generatedRoleConfig,
  runEngineRoleStep,
  type SpawnFn
} from '../../src/lib/dev-review-eval/engine-role-step'
import {
  renderCase,
  TOOL_CAPABILITIES,
  VINAYA_RENDERER_VERSION,
  type VinayaTrialRecord
} from '../../src/lib/dev-review-eval/vinaya-renderer'
import { developerReferenceCases, developmentCases, type GenericSuiteKey, referenceEntry } from './generic-suites'
import { KNOWN_BAD_VARIANTS, referenceRecord } from './vinaya-trial-records'
import { expectGradingSandboxDenies, proveGradingSandbox } from './grading-sandbox-proof'
import { answerTurnConfig, readOnlyDeveloperTurn } from './source-citation-suite'
import { claudeTrace, codexTrace } from './tool-selection-suite'

const options = {
  split: 'development' as const,
  backend: 'standalone' as const,
  trialsPerTask: 2,
  bootstrap: {
    method: 'percentile' as const,
    seed: 7,
    resamples: 20,
    confidence: 0.95
  }
}
const ALL_SUITES = Object.keys(STEP_ONE_SUITE_LAYERS) as (keyof typeof STEP_ONE_SUITE_LAYERS)[]
const suites = () => ALL_SUITES.map((suite) => ({ suite, taskIds: [`${suite}-task`] }))
const usage = {
  wallTimeMs: 10,
  inputTokens: 3,
  outputTokens: 2,
  cacheReadTokens: 5,
  cacheCreationTokens: 1,
  subscriptionQuota: 0.1,
  estimatedCostUsd: 0.01
}
/** A fake trial of `suite`, carrying its suite's process layer and renderer version. */
const stamp = (input: { suite: StepOneRunSuite }) => ({
  layer: STEP_ONE_SUITE_LAYERS[input.suite],
  rendererVersion: rendererVersionOf(input.suite)
})

describe('development-only step one', () => {
  it('charges a trial the increase between the before and after readings of one window only', () => {
    const claude = (type: string, utilization: number) =>
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { rateLimitType: type, utilization }
      })
    expect(
      subscriptionQuotaOf('claude-code', [
        claude('five_hour', 0.37),
        claude('seven_day', 0.9),
        claude('five_hour', 0.42)
      ])
    ).toBeCloseTo(0.05)
    const codex = (primary: number, secondary: number) =>
      JSON.stringify({
        msg: {
          rate_limits: {
            primary: { used_percent: primary },
            secondary: { used_percent: secondary }
          }
        }
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
    const result = await runStepOne(options, suites, async (input) => ({
      success: true,
      ...stamp(input),
      usage: { ...usage, subscriptionQuota: calls++ % 2 === 0 ? 0.25 : null }
    }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const run of result.value.runs) {
      expect(run.usage.subscriptionQuota).toBeCloseTo(0.25)
      expect(run.quotaUnavailableTrials).toBe(1)
    }
    const none = await runStepOne(options, suites, async (input) => ({
      success: true,
      ...stamp(input),
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
    const target = realpathSync(fixtureDir('step-one-isolation-'))
    const sandbox = openGradingSandbox()
    try {
      const launched = sandbox.launch(['bun', 'test', 'planted.test.ts'], [target])
      const text = launched.command.join(' ')
      expect(launched.command[0]?.startsWith('/')).toBe(true)
      expect(launched.command[0]?.startsWith(sandbox.scratch)).toBe(false)
      expect(launched.command[1]).toBe('sandbox')
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

  it('never launches a fake codex planted in the writable scratch bunx cache', async () => {
    const sandbox = openGradingSandbox()
    const target = realpathSync(fixtureDir('step-one-fake-codex-target-'))
    try {
      const marker = join(sandbox.scratch, 'fake-codex-ran')
      const fake = join(sandbox.scratch, '.bun', 'install', 'cache', 'codex')
      mkdirSync(join(sandbox.scratch, '.bun', 'install', 'cache'), { recursive: true })
      writeFileSync(fake, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
      const launched = sandbox.launch(['/usr/bin/true'], [target])
      expect(realpathSync(launched.command[0] as string)).not.toBe(realpathSync(fake))
      expect(launched.command[0]?.startsWith(sandbox.scratch)).toBe(false)
      await spawnBudgetedAsync(launched.command, { cwd: target, env: launched.env }, 60_000, 'pinned grading codex')
      expect(existsSync(marker)).toBe(false)
    } finally {
      sandbox.dispose()
      rmSync(target, { recursive: true, force: true })
    }
  }, 120_000)

  it('never resolves the host grading executable through PATH', () => {
    const root = realpathSync(fixtureDir('step-one-fake-path-'))
    const tool = join(root, 'tool')
    const marker = join(root, 'fake-codex-ran')
    const fake = join(root, 'codex')
    writeFileSync(fake, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
    const originalPath = process.env.PATH
    try {
      process.env.PATH = `${root}:${originalPath ?? ''}`
      const resolved = resolveGradingCodex(tool)
      expect(resolved).not.toBe(realpathSync(fake))
      expect(resolved.startsWith(realpathSync(tool))).toBe(true)
      expect(existsSync(marker)).toBe(false)
    } finally {
      process.env.PATH = originalPath
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it.skipIf(Bun.which('codex') === null)(
    'denies a graded test file writes outside scratch, the network, and every planted token',
    async () => {
      expectGradingSandboxDenies(await proveGradingSandbox())
    },
    360_000
  )

  describe('the trial commit the host verifies', () => {
    const repository = () => {
      const workspace = realpathSync(fixtureDir('step-one-commit-'))
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
      const staging = {
        workspace,
        gitDir: join(workspace, '.git'),
        baseCommit: base
      } as unknown as CloneStaging
      return { workspace, staging, base, commit }
    }

    it('grades the commit an agent already made, its tree clean', () => {
      const { workspace, staging, commit } = repository()
      const head = commit('agent work')
      expect(git(workspace, ['status', '--porcelain'])).toBe('')
      expect(verifyTrialCommit(staging, `noise\ntrial-commit ${head}\n`)).toEqual({ ok: true, commit: head })
      rmSync(workspace, { recursive: true, force: true })
    })

    it('commits only uncommitted work, and reports the commit HEAD names either way', async () => {
      const { workspace, staging, base, commit } = repository()
      const bundle = `${workspace}.bundle`
      const step = async () =>
        (
          await spawnBudgetedAsync(
            ['/bin/sh', '-c', TRIAL_COMMIT_SCRIPT, 'commit-trial', 'Eval(developer): trial', bundle, base],
            {
              cwd: workspace,
              env: {
                PATH: process.env.PATH ?? '/usr/bin:/bin',
                HOME: workspace
              }
            }
          )
        ).stdout
      const agentCommit = commit('agent work')
      expect(await step()).toBe(`trial-commit ${agentCommit}\n`)
      writeFileSync(join(workspace, 'solution.ts'), 'export {}\n')
      const output = await step()
      const committed = verifyTrialCommit(staging, output)
      expect(committed.ok).toBe(true)
      if (committed.ok) expect(committed.commit).not.toBe(agentCommit)
      expect(git(workspace, ['status', '--porcelain'])).toBe('')
      rmSync(bundle, { force: true })
      rmSync(workspace, { recursive: true, force: true })
    })

    it('records a trial with no commit ahead of its base unavailable', () => {
      const { workspace, staging, base } = repository()
      expect(verifyTrialCommit(staging, `trial-commit ${base}\n`)).toEqual({
        ok: false,
        reason: 'Developer trial has no commit ahead of its base'
      })
      expect(verifyTrialCommit(staging, 'nothing reported\n').ok).toBe(false)
      expect(verifyTrialCommit(staging, `trial-commit ${'0'.repeat(40)}\n`).ok).toBe(true)
      rmSync(workspace, { recursive: true, force: true })
    })

    it('imports only a sandbox-produced bundle into a fresh repository and runs none of the trial hooks', async () => {
      const { workspace, staging, commit } = repository()
      const head = commit('agent work')
      const marker = join(workspace, 'hook-ran')
      writeFileSync(join(workspace, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
      git(workspace, ['config', 'core.fsmonitor', `touch ${marker}`])
      const bundle = join(workspace, 'trial.bundle')
      const output = (
        await spawnBudgetedAsync(
          ['/bin/sh', '-c', TRIAL_COMMIT_SCRIPT, 'commit-trial', 'Eval(developer): trial', bundle, staging.baseCommit],
          {
            cwd: workspace,
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: workspace }
          }
        )
      ).stdout
      expect(verifyTrialCommit(staging, output)).toEqual({
        ok: true,
        commit: head
      })
      const parent = realpathSync(fixtureDir('step-one-import-'))
      const imported = importTrialBundle({
        repository: workspace,
        baseCommit: staging.baseCommit,
        reportedCommit: head,
        bundlePath: bundle,
        parentDirectory: parent
      })
      expect(git(imported, ['rev-parse', 'HEAD']).trim()).toBe(head)
      expect(existsSync(marker)).toBe(false)
      rmSync(parent, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    })

    it.skipIf(Bun.which('codex') === null)(
      'never invokes a partial-clone ssh command when the trial deletes its base object',
      async () => {
        const { workspace, staging, commit } = repository()
        commit('agent work')
        const outside = realpathSync(fixtureDir('step-one-attack-'))
        const marker = join(outside, 'ssh-ran')
        git(workspace, ['config', 'remote.origin.promisor', 'true'])
        git(workspace, ['config', 'extensions.partialClone', 'origin'])
        git(workspace, ['config', 'remote.origin.url', 'ssh://invalid/repository'])
        git(workspace, ['config', 'core.sshCommand', `/usr/bin/touch ${marker}`])
        const object = join(workspace, '.git', 'objects', staging.baseCommit.slice(0, 2), staging.baseCommit.slice(2))
        rmSync(object, { force: true })
        const sandbox = openGradingSandbox()
        try {
          let result: 'graded' | 'unavailable' = 'graded'
          try {
            const output = await commitTrialInSandbox(sandbox, staging, 'Eval(developer): attack')
            const parsed = verifyTrialCommit(staging, output)
            if (!parsed.ok) result = 'unavailable'
          } catch {
            result = 'unavailable'
          }
          expect(['graded', 'unavailable']).toContain(result)
          expect(existsSync(marker)).toBe(false)
        } finally {
          sandbox.dispose()
          rmSync(outside, { recursive: true, force: true })
          rmSync(workspace, { recursive: true, force: true })
        }
      },
      360_000
    )
  })

  it('runs all three suites on both adapters and reports estimates and usage', async () => {
    const calls: string[] = []
    const result = await runStepOne(options, suites, async (input) => {
      calls.push(`${input.suite}:${input.adapter}:${input.taskId}:${input.attempt}`)
      return { success: input.attempt === 1, ...stamp(input), usage }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.runs).toHaveLength(6)
    expect(calls).toHaveLength(12)
    for (const run of result.value.runs) {
      expect(run).toMatchObject({
        taskCount: 1,
        mean: 0.5,
        usage: { wallTimeMs: 20, inputTokens: 6, outputTokens: 4, cacheReadTokens: 10, cacheCreationTokens: 2 }
      })
      expect(run.tasks).toEqual([
        {
          taskId: `${run.suite}-task`,
          successes: 1,
          trials: 2,
          unavailable: []
        }
      ])
    }
  })

  it('refuses held-out and Engine requests before loading any split', async () => {
    let reads = 0
    const load = () => {
      reads++
      return suites()
    }
    const execute = async (input: { suite: StepOneRunSuite }) => ({ success: true, ...stamp(input), usage })
    const heldOut = await runStepOne({ ...options, split: 'held-out' }, load, execute)
    const engine = await runStepOne({ ...options, backend: 'engine' }, load, execute)
    expect(heldOut).toEqual({
      ok: false,
      refusal: { code: 'held_out_forbidden', detail: expect.any(String) }
    })
    expect(engine).toEqual({
      ok: false,
      refusal: { code: 'engine_forbidden', detail: expect.any(String) }
    })
    expect(reads).toBe(0)
    // A Harbor container trial takes the Engine backend; a host-side step-one run still never does.
    expect(STEP_ONE_BACKENDS).toEqual(['standalone', 'engine'])
    expect(HARBOR_TRIAL_BACKENDS).toEqual(STEP_ONE_BACKENDS)
  })

  it('declares each suite at the process layer the module registry gives it', () => {
    for (const suite of ALL_SUITES) {
      expect({ suite, layer: STEP_ONE_SUITE_LAYERS[suite] }).toEqual({ suite, layer: LIVE_SUITE_LAYERS[suite] })
    }
    for (const suite of [...STEP_ONE_COMPARISON_SUITES, ...STEP_ONE_PRACTICE_SUITES]) {
      expect(STEP_ONE_SUITE_LAYERS[suite]).toBe('G')
    }
  })

  it('compares the backends on the layer-G developer and reviewer suites only', async () => {
    const calls = new Set<string>()
    const result = await runStepOne({ ...options, purpose: 'comparison' }, suites, async (input) => {
      calls.add(input.suite)
      return { success: true, ...stamp(input), usage }
    })
    expect(result.ok && result.value.purpose).toBe('comparison')
    expect([...calls]).toEqual([
      'developer-capability-neutral.l5',
      'code-reviewer-quality-neutral.l5',
      'security-reviewer-quality-neutral.l5'
    ])
  })

  it('refuses a layer-P suite, or a practice-only one, named as comparison evidence, before loading any split', async () => {
    let reads = 0
    const load = () => {
      reads++
      return suites()
    }
    const execute = async (input: { suite: StepOneRunSuite }) => ({ success: true, ...stamp(input), usage })
    for (const suite of STEP_ONE_SUITES) {
      const refused = await runStepOne({ ...options, purpose: 'comparison', suites: [suite] }, load, execute)
      expect(refused).toEqual({ ok: false, refusal: { code: 'layer_p_comparison', detail: expect.any(String) } })
    }
    const mixed = await runStepOne(
      { ...options, purpose: 'comparison', suites: ['developer-capability-neutral.l5', 'developer-capability.l5'] },
      load,
      execute
    )
    expect(mixed.ok || mixed.refusal.code).toBe('layer_p_comparison')
    const citation = await runStepOne(
      { ...options, purpose: 'comparison', suites: ['source-delivery-neutral.l5'] },
      load,
      execute
    )
    expect(citation.ok || citation.refusal.code).toBe('comparison_forbidden')
    expect(selectStepOneSuites('comparison', ['source-delivery.l5'], 1)).toEqual({
      ok: false,
      refusal: { code: 'invalid_input', detail: 'source-delivery.l5 is not a step-one suite' }
    })
    expect(reads).toBe(0)
  })

  it('admits the layer-G source-citation suite for development-only runs and a one-trial practice run', async () => {
    const execute = async (input: { suite: StepOneRunSuite }) => ({ success: true, ...stamp(input), usage })
    const practice = await runStepOne(
      { ...options, trialsPerTask: 1, purpose: 'practice', suites: ['source-delivery-neutral.l5'] },
      suites,
      execute
    )
    expect(practice.ok).toBe(true)
    if (practice.ok) {
      expect(practice.value.purpose).toBe('practice')
      expect(practice.value.runs.map((run) => [run.suite, run.trialsPerTask])).toEqual([
        ['source-delivery-neutral.l5', 1],
        ['source-delivery-neutral.l5', 1]
      ])
    }
    const development = await runStepOne({ ...options, suites: ['source-delivery-neutral.l5'] }, suites, execute)
    expect(development.ok && development.value.purpose).toBe('development-only')
    const twoTrials = await runStepOne(
      { ...options, purpose: 'practice', suites: ['source-delivery-neutral.l5'] },
      suites,
      execute
    )
    expect(twoTrials.ok || twoTrials.refusal.code).toBe('invalid_input')
  })

  describe('a layer-G trial run live through the Vinaya process, on fake process runs', () => {
    const developerCases = developerReferenceCases('development')
    const loading = PRODUCTION_STEP_ONE_RUNTIME.loadDevelopment()
    const contextOf = async (): Promise<StepOneCommandContext> => ({
      repository: '.',
      developerBriefs: new Map(),
      models: {},
      timeoutMs: 1,
      loaded: await loading
    })
    /** One development case of each kind, by its suite. */
    const KINDS: { suite: StepOneRunSuite; key: GenericSuiteKey; kind: NeutralCase['kind'] }[] = [
      { suite: 'developer-capability-neutral.l5', key: 'developer', kind: 'change' },
      { suite: 'code-reviewer-quality-neutral.l5', key: 'codeReviewer', kind: 'review' },
      { suite: 'source-delivery-neutral.l5', key: 'sourceCitation', kind: 'answer' }
    ]
    const caseOf = async (suite: StepOneRunSuite, kind: NeutralCase['kind']) => {
      const cases = (await loading).neutralCases[suite as keyof Awaited<typeof loading>['neutralCases']] ?? []
      // A case some known-bad variant applies to beyond the ungranted call, so each kind plants a defect of its own.
      const chosen = cases.find((c) => (c.kind === 'review' ? !c.adjudication.clean : c.deliveredDocuments.length > 0))
      if (chosen === undefined || chosen.kind !== kind) throw new Error(`${suite} has no ${kind} case to run`)
      return chosen
    }
    const trial = (suite: StepOneRunSuite, taskId: string) => ({ suite, adapter: 'codex' as const, taskId, attempt: 1 })
    const ran = (record: VinayaTrialRecord): VinayaProcessRun => ({ ok: true, record, usage })

    for (const { suite, key, kind } of KINDS) {
      it(`counts a ${kind} case's reference record a success and each known-bad variant of it a failure`, async () => {
        const c = await caseOf(suite, kind)
        const entry = referenceEntry(
          key,
          c,
          developerCases.find((p) => p.id === c.id)
        )
        const requests: VinayaProcessRequest[] = []
        const runWith = async (plant: (reference: VinayaTrialRecord) => VinayaTrialRecord) =>
          stepOneRuntime(async (request) => {
            requests.push(request)
            return ran(plant(referenceRecord(entry, request.input)))
          }).execute(trial(suite, c.id), await contextOf())

        const reference = await runWith((record) => record)
        expect(reference).toEqual({ success: true, layer: 'G', rendererVersion: VINAYA_RENDERER_VERSION, usage })
        // The run is handed the case's own rendering, never another brief.
        const rendered = renderCase(c)
        expect(rendered.ok && requests[0]?.input).toEqual(rendered.ok ? rendered.input : false)
        expect(requests[0]?.neutralCase.id).toBe(c.id)

        let planted = 0
        for (const variant of KNOWN_BAD_VARIANTS) {
          if (variant.plant(referenceRecord(entry, requests[0]?.input as never), entry) === null) continue
          planted++
          const bad = await runWith((record) => variant.plant(record, entry) as VinayaTrialRecord)
          expect({ variant: variant.name, success: bad.success, unavailable: bad.unavailableReason }).toEqual({
            variant: variant.name,
            success: false,
            unavailable: undefined
          })
        }
        expect(planted).toBeGreaterThan(1)
      })
    }

    it('records a trial unavailable when the renderer refuses its case, without running it', async () => {
      const c = await caseOf('developer-capability-neutral.l5', 'change')
      const unexpressible = { ...c, taskStatement: `${c.taskStatement}\nA second line.` }
      let runs = 0
      const result = await stepOneRuntime(async () => {
        runs++
        throw new Error('never run')
      }).execute(trial('developer-capability-neutral.l5', c.id), {
        ...(await contextOf()),
        loaded: { ...(await loading), neutralCases: { 'developer-capability-neutral.l5': [unexpressible] } }
      })
      expect(runs).toBe(0)
      expect(result.success).toBe(false)
      expect(result.unavailableReason).toContain('unexpressible at taskStatement')
      expect(result.layer).toBe('G')
    })

    it('records a trial unavailable when its record is from another renderer version, or its run fails', async () => {
      const c = await caseOf('code-reviewer-quality-neutral.l5', 'review')
      const entry = referenceEntry('codeReviewer', c)
      const stale = await stepOneRuntime(async (request) =>
        ran({ ...referenceRecord(entry, request.input), rendererVersion: '1:another' })
      ).execute(trial('code-reviewer-quality-neutral.l5', c.id), await contextOf())
      expect(stale.success).toBe(false)
      expect(stale.unavailableReason).toContain('stale_renderer at rendererVersion')
      const failed = await stepOneRuntime(async () => {
        throw new Error('the adapter exited 1')
      }).execute(trial('code-reviewer-quality-neutral.l5', c.id), await contextOf())
      expect(failed.success).toBe(false)
      expect(failed.unavailableReason).toContain('the adapter exited 1')
    })

    it('no longer throws for a layer-G suite, and still refuses a task its suite does not hold', async () => {
      for (const suite of [...STEP_ONE_COMPARISON_SUITES, ...STEP_ONE_PRACTICE_SUITES]) {
        await expect(
          PRODUCTION_STEP_ONE_RUNTIME.execute(
            { suite, adapter: 'codex', taskId: 'any', attempt: 1 },
            { ...(await contextOf()), loaded: NO_DEVELOPMENT }
          )
        ).rejects.toThrow(`unknown ${suite} task any`)
      }
    })
  })

  it("carries each run's process layer and renderer version beside its usage", async () => {
    const result = await runStepOne(options, suites, async (input) => ({ success: true, ...stamp(input), usage }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const run of result.value.runs) {
      expect({ suite: run.suite, layer: run.layer, rendererVersion: run.rendererVersion }).toEqual({
        suite: run.suite,
        layer: STEP_ONE_SUITE_LAYERS[run.suite],
        rendererVersion: STEP_ONE_SUITE_LAYERS[run.suite] === 'G' ? VINAYA_RENDERER_VERSION : ''
      })
    }
  })

  describe('a practice run selecting adapters and cases', () => {
    const practice = { ...options, trialsPerTask: 1, purpose: 'practice' as const }
    const threeTasks = () => ALL_SUITES.map((suite) => ({ suite, taskIds: ['a', 'b', 'c'] }))

    it('runs only the selected adapter and the first n cases in pinned order, or the named ones', async () => {
      const calls: string[] = []
      const execute = async (input: { suite: StepOneRunSuite; adapter: string; taskId: string }) => {
        calls.push(`${input.suite}:${input.adapter}:${input.taskId}`)
        return { success: true, ...stamp(input), usage }
      }
      const suitesRun = ['developer-capability-neutral.l5', 'developer-capability.l5']
      const counted = await runStepOne(
        { ...practice, suites: suitesRun, adapters: ['claude-code'], cases: { count: 2 } },
        threeTasks,
        execute
      )
      expect(counted.ok).toBe(true)
      expect(calls).toEqual([
        'developer-capability-neutral.l5:claude-code:a',
        'developer-capability-neutral.l5:claude-code:b',
        'developer-capability.l5:claude-code:a',
        'developer-capability.l5:claude-code:b'
      ])
      calls.length = 0
      const named = await runStepOne(
        { ...practice, suites: ['source-delivery-neutral.l5'], adapters: ['codex'], cases: { ids: ['c', 'a'] } },
        threeTasks,
        execute
      )
      expect(named.ok && named.value.runs.map((run) => [run.adapter, run.taskCount])).toEqual([['codex', 2]])
      expect(calls).toEqual(['source-delivery-neutral.l5:codex:a', 'source-delivery-neutral.l5:codex:c'])
      calls.length = 0
      const both = await runStepOne({ ...practice, suites: ['source-delivery-neutral.l5'] }, threeTasks, execute)
      expect(both.ok && both.value.runs.map((run) => run.adapter)).toEqual(['claude-code', 'codex'])
    })

    it('refuses a case selection on a development-only or comparison run, before loading any split', async () => {
      let reads = 0
      const load = () => {
        reads++
        return threeTasks()
      }
      const execute = async (input: { suite: StepOneRunSuite }) => ({ success: true, ...stamp(input), usage })
      for (const purpose of ['development-only', 'comparison'] as const) {
        for (const cases of [{ count: 1 }, { ids: ['a'] }]) {
          const refused = await runStepOne(
            { ...options, purpose, suites: ['developer-capability-neutral.l5'], cases },
            load,
            execute
          )
          expect(refused).toEqual({
            ok: false,
            refusal: { code: 'case_selection_forbidden', detail: expect.any(String) }
          })
        }
      }
      expect(reads).toBe(0)
    })

    it('refuses an unknown adapter and a count below 1 before loading, and a case outside the split before any trial', async () => {
      let reads = 0
      let trials = 0
      const load = () => {
        reads++
        return threeTasks()
      }
      const execute = async (input: { suite: StepOneRunSuite }) => {
        trials++
        return { success: true, ...stamp(input), usage }
      }
      for (const request of [
        { adapters: ['gemini'] },
        { adapters: [] },
        { cases: { count: 0 } },
        { cases: { count: 1.5 } }
      ]) {
        const refused = await runStepOne({ ...practice, ...request }, load, execute)
        expect(refused.ok || refused.refusal.code).toBe('invalid_input')
      }
      expect(reads).toBe(0)
      const outside = await runStepOne(
        {
          ...practice,
          suites: ['developer-capability.l5', 'source-delivery-neutral.l5'],
          cases: { ids: ['a', 'held-out-id'] }
        },
        load,
        execute
      )
      expect(outside).toEqual({
        ok: false,
        refusal: { code: 'invalid_input', detail: 'held-out-id is not a development case of developer-capability.l5' }
      })
      expect(trials).toBe(0)
    })

    it('takes the selections as --adapter and --cases flags of the step-one command', async () => {
      const loaded = await PRODUCTION_STEP_ONE_RUNTIME.loadDevelopment()
      let loads = 0
      const calls: string[] = []
      const runtime = {
        loadDevelopment: async () => {
          loads++
          return loaded
        },
        execute: async (input: { suite: StepOneRunSuite; adapter: string; taskId: string }) => {
          calls.push(`${input.suite}:${input.adapter}:${input.taskId}`)
          return { success: true, ...stamp(input), usage }
        }
      }
      const common = [
        '--trials',
        '1',
        '--bootstrap',
        'percentile',
        '--seed',
        '1',
        '--resamples',
        '20',
        '--confidence',
        '0.95'
      ]
      const prices = ['--input-cost-per-million', '0', '--output-cost-per-million', '0']
      const out = join(fixtureDir('step-one-selection-'), 'result.json')
      const run = (...flags: string[]) =>
        runStepOneCommand(
          ['run', '--split', 'development', '--backend', 'standalone', ...flags, ...common, ...prices, '--out', out],
          runtime
        )
      const refused = await run(
        '--purpose',
        'development-only',
        '--suite',
        'developer-capability-neutral.l5',
        '--cases',
        '1'
      )
      expect(refused.ok || refused.refusal.code).toBe('case_selection_forbidden')
      expect(loads).toBe(0)
      const counted = await run(
        '--purpose',
        'practice',
        '--suite',
        'developer-capability-neutral.l5',
        '--adapter',
        'codex',
        '--cases',
        '1'
      )
      expect(counted.ok).toBe(true)
      expect(calls).toEqual(['developer-capability-neutral.l5:codex:pr-987'])
      calls.length = 0
      const named = await run(
        '--purpose',
        'practice',
        '--suite',
        'code-reviewer-quality-neutral.l5',
        '--adapter',
        'claude-code',
        '--cases',
        'code-clean,code-logic'
      )
      expect(named.ok).toBe(true)
      expect(calls).toEqual([
        'code-reviewer-quality-neutral.l5:claude-code:code-logic',
        'code-reviewer-quality-neutral.l5:claude-code:code-clean'
      ])
      expect(loads).toBe(2)
    })
  })

  it('the executable command loads the real development corpora and dispatches every real task', async () => {
    const loaded = await PRODUCTION_STEP_ONE_RUNTIME.loadDevelopment()
    expect(loaded.suites.map((entry) => [entry.suite, entry.taskIds.length])).toEqual([
      ['developer-capability.l5', 28],
      ['code-reviewer-quality.l5', 11],
      ['security-reviewer-quality.l5', 6],
      ['developer-capability-neutral.l5', 28],
      ['code-reviewer-quality-neutral.l5', 6],
      ['security-reviewer-quality-neutral.l5', 6],
      ['source-delivery-neutral.l5', 7]
    ])
    const calls: string[] = []
    const out = join(fixtureDir('step-one-command-'), 'result.json')
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
          return { success: true, ...stamp(input), usage: { ...usage, estimatedCostUsd: 0 } }
        }
      }
    )
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(90)
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(result)
    if (result.ok) expect(result.value.runs.every((run) => run.usage.estimatedCostUsd > 0)).toBe(true)

    // The same command requests a one-trial practice run of the layer-G source-citation suite.
    const practice: string[] = []
    const practiceArgs = ['run', '--split', 'development', '--backend', 'standalone', '--purpose', 'practice']
    const rest = [
      '--trials',
      '1',
      '--bootstrap',
      'percentile',
      '--seed',
      '7',
      '--resamples',
      '20',
      '--confidence',
      '0.95'
    ]
    const requested = await runStepOneCommand(
      [
        ...practiceArgs,
        '--suite',
        'source-delivery-neutral.l5',
        ...rest,
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
          practice.push(`${input.suite}:${input.adapter}:${input.taskId}`)
          return { success: true, ...stamp(input), usage }
        }
      }
    )
    expect(requested.ok && requested.value.purpose).toBe('practice')
    expect(practice).toHaveLength(14)
  })
})

describe('container mode: a layer-G trial in a container that is its own sandbox, on fake process runs', () => {
  const loading = PRODUCTION_STEP_ONE_RUNTIME.loadDevelopment()
  const SKIPPED_IN_CONTAINER = [
    'stageTrial',
    'hiddenInputs',
    'testContamination',
    'openGradingSandbox',
    'warmPackageCache',
    'sandbox.run',
    'commitTrialInSandbox',
    'importTrialBundle',
    'prepareGradingCopy',
    'gradeInSandbox'
  ]
  const tempDir = (prefix: string) => realpathSync(fixtureDir(prefix))
  const commitAll = (dir: string, message: string) => {
    git(dir, ['add', '-A'])
    git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', message])
    return git(dir, ['rev-parse', 'HEAD']).trim()
  }
  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
  /** The doctrine the fake Vinaya under test resolves for `role`. */
  const fakeDoctrine = (role: TrialDoctrineRole) => `## Short version\n\nThe ${role} role's fake doctrine.\n\n---\n`
  /** The doctrine role a suite's trial gives its agent. */
  const doctrineRoleOf = (suite: StepOneRunSuite): TrialDoctrineRole =>
    suite === 'code-reviewer-quality-neutral.l5'
      ? 'reviewer'
      : suite === 'security-reviewer-quality-neutral.l5'
        ? 'security'
        : 'developer'
  /** The doctrine block the review loop itself renders for `role` from `text`, with the loop's own renderers. */
  const loopDoctrineBlock = (role: TrialDoctrineRole, text: string) =>
    role === 'developer' ? renderDeveloperDoctrineBlock(text) : joinReviewerPromptPieces(roleDoctrinePieces(role, text))

  /** The same fake process run for both modes: the role's transcript, and for a Developer its change and publication. */
  const fakeRun = (kind: NeutralCase['kind'], world: { context: DevToolContext } | null) => {
    const items =
      kind === 'change'
        ? [
            { id: 'c1', type: 'command_execution', command: 'bun run typecheck' },
            {
              id: 'm1',
              type: 'mcp_tool_call',
              server: DEV_TOOLS_MCP_SERVER_NAME,
              tool: 'publish_changes',
              arguments: { header: 'Feat(cli): Add the solution' }
            },
            {
              id: 'm2',
              type: 'mcp_tool_call',
              server: DEV_TOOLS_MCP_SERVER_NAME,
              tool: 'open_pull_request',
              arguments: { title: 't' }
            }
          ]
        : [{ id: 'c1', type: 'command_execution', command: 'git diff' }]
    return {
      lines: items.map((item) => JSON.stringify({ type: 'item.completed', item })),
      async act(cwd: string, issue: number) {
        if (kind !== 'change' || world === null) return
        writeFileSync(join(cwd, 'solution.ts'), 'export const solved = true\n')
        await world.context.publishChanges('Feat(cli): Add the solution')
        await world.context.openPullRequest('t', `Closes #${issue}\n\nThe change.`)
      }
    }
  }

  /** Every step as a recording fake; the fake stage clones the source repository, and the fake import hands that clone back. */
  function recordingSteps(
    kind: NeutralCase['kind'],
    issue: number,
    doctrine: (role: TrialDoctrineRole) => Promise<string | null> = async (role) => fakeDoctrine(role)
  ) {
    const calls: string[] = []
    const doctrineRoles: TrialDoctrineRole[] = []
    const dispatched: Array<{ cwd: string | undefined; containerMode: boolean | undefined }> = []
    const prompts: string[] = []
    const turns: Array<{ workspace: string; claudeEnv: NodeJS.ProcessEnv | undefined }> = []
    let world: { context: DevToolContext } | null = null
    let lastStaged: string | null = null
    const scratch = tempDir('step-one-fake-sandbox-')
    const steps: VinayaProcessSteps = {
      ...PRODUCTION_VINAYA_PROCESS_STEPS,
      dispatch: async (_role, _agent, prompt, opts) => {
        calls.push('dispatch')
        prompts.push(prompt)
        dispatched.push({ cwd: opts.cwd, containerMode: opts.containerMode })
        const run = fakeRun(kind, world)
        await run.act(opts.cwd as string, issue)
        for (const line of run.lines) opts.observeStdoutLine?.(line)
        return {
          exitCode: 0,
          durationMs: 5,
          usage: { input: 3, output: 2 },
          cacheUsage: { read: 2, creation: 0 },
          resumeId: 's',
          timedOut: false,
          ...(kind === 'review'
            ? { reviewOutput: { raw: { reviewResult: { verdict: 'approve' } } } }
            : { turnOutput: { raw: { turnResult: { status: 'completed' } } } })
        } as never
      },
      readOnlyTurn: async (_adapter, _dir, workspace, _bridge, _schema, options) => {
        calls.push('readOnlyTurn')
        turns.push({ workspace, claudeEnv: options.claudeEnv })
        return async (prompt: string) => {
          prompts.push(prompt)
          return `${fakeRun(kind, null).lines.join('\n')}\n`
        }
      },
      startToolHost: async (opts) => {
        calls.push('startToolHost')
        world = { context: opts.context }
        return { socketPath: opts.socketPath, close: async () => {} }
      },
      stageTrial: (request) => {
        calls.push('stageTrial')
        const root = tempDir('step-one-fake-stage-')
        const workspace = join(root, 'workspace')
        if (request.mode === 'clone') git(root, ['clone', '--quiet', request.sourceRepository, workspace])
        else mkdirSync(workspace)
        lastStaged = workspace
        return {
          kind: request.mode,
          trialId: request.trialId,
          baseCommit: request.baseCommit,
          workspace,
          gitDir: join(workspace, '.git'),
          root: { path: root }
        } as never
      },
      hiddenInputs: () => {
        calls.push('hiddenInputs')
        return { failToPassTests: {}, referenceSolution: {}, pinnedPassToPassTests: {} }
      },
      testContamination: () => {
        calls.push('testContamination')
        return { clean: true, findings: [] } as never
      },
      openGradingSandbox: () => {
        calls.push('openGradingSandbox')
        return {
          scratch,
          launch: () => ({ command: [], env: {} }),
          run: async () => {
            calls.push('sandbox.run')
            return ''
          },
          dispose: () => {}
        }
      },
      warmPackageCache: async () => {
        calls.push('warmPackageCache')
      },
      commitTrialInSandbox: async (_sandbox, staging, message) => {
        calls.push('commitTrialInSandbox')
        return `trial-commit ${commitAll(staging.workspace, message)}\n`
      },
      importTrialBundle: () => {
        calls.push('importTrialBundle')
        return lastStaged as string
      },
      prepareGradingCopy: () => {
        calls.push('prepareGradingCopy')
        return { path: tempDir('step-one-fake-grading-') } as never
      },
      gradeInSandbox: async () => {
        calls.push('gradeInSandbox')
        return []
      },
      resolveRoleDoctrine: async (role) => {
        doctrineRoles.push(role)
        return doctrine(role)
      }
    }
    return { steps, calls, dispatched, prompts, turns, doctrineRoles }
  }

  const caseOf = async (suite: StepOneRunSuite, kind: NeutralCase['kind']) => {
    const cases = (await loading).neutralCases[suite as keyof Awaited<typeof loading>['neutralCases']] ?? []
    const chosen = cases.find((c) => c.kind === kind && (c.kind !== 'change' || c.deliveredDocuments.length > 0))
    if (chosen === undefined) throw new Error(`${suite} has no ${kind} case`)
    return chosen
  }

  /**
   * A source repository whose base commit holds the change case's delivered
   * documents as the real repository holds them at the case's base, so the
   * fake host stage clones it and a container working tree checks it out.
   */
  async function changeFixture(c: NeutralCase) {
    const loaded = await loading
    const item = loaded.developerCases.find((entry) => entry.id === c.id)
    if (item === undefined) throw new Error(`${c.id} has no layer-P case`)
    const rendered = renderCase(c)
    if (!rendered.ok) throw new Error('the change case does not render')
    const source = tempDir('step-one-fake-source-')
    git(source, ['init', '--quiet'])
    for (const document of rendered.input.sources) {
      const path = join(source, document.sourceId)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, git('.', ['show', `${item.baseCommit}:${document.sourceId}`]))
    }
    const base = commitAll(source, 'base')
    return {
      base,
      source,
      loaded: {
        ...loaded,
        developerCases: loaded.developerCases.map((entry) =>
          entry.id === c.id ? { ...entry, baseCommit: base } : entry
        )
      },
      issue: item.pullRequest
    }
  }

  const KINDS: { suite: StepOneRunSuite; kind: NeutralCase['kind'] }[] = [
    { suite: 'developer-capability-neutral.l5', kind: 'change' },
    { suite: 'code-reviewer-quality-neutral.l5', kind: 'review' },
    { suite: 'source-delivery-neutral.l5', kind: 'answer' }
  ]

  for (const { suite, kind } of KINDS) {
    it(`a ${kind} case records what the host records, in the given tree, and calls none of the skipped steps`, async () => {
      const c = await caseOf(suite, kind)
      const rendered = renderCase(c)
      if (!rendered.ok) throw new Error('the case does not render')
      const fixture = kind === 'change' ? await changeFixture(c) : null
      const issue = fixture?.issue ?? 1
      const request = {
        trial: { suite, adapter: 'codex' as const, taskId: c.id, attempt: 1 },
        neutralCase: c,
        input: rendered.input
      }
      const context: StepOneCommandContext = {
        repository: fixture?.source ?? '.',
        developerBriefs: new Map(),
        models: {},
        timeoutMs: 1000,
        loaded: fixture?.loaded ?? (await loading)
      }

      const host = recordingSteps(kind, issue)
      const onHost = await vinayaProcess(host.steps)(request, context)

      const tree = tempDir('step-one-container-app-')
      if (fixture !== null) git(tree, ['clone', '--quiet', fixture.source, '.'])
      const recordPath = join(tempDir('step-one-container-record-'), 'record.json')
      const inContainer = recordingSteps(kind, issue)
      const contained = await vinayaProcess(inContainer.steps)(request, {
        ...context,
        container: { workingTree: tree, recordPath }
      })

      expect(onHost.ok).toBe(true)
      expect(contained.ok).toBe(true)
      if (!onHost.ok || !contained.ok) return
      // Every agent-produced field equals the host's for the same fake run.
      const agentFields = (record: VinayaTrialRecord) => ({
        rendererVersion: record.rendererVersion,
        input: record.input,
        doctrineDigest: record.doctrineDigest,
        pullRequestBody: record.pullRequest?.body ?? null,
        checks: record.checks,
        reviews: record.reviews,
        readyForMerge: record.readyForMerge,
        developerTurnResult: record.developerTurnResult,
        receipts: record.receipts,
        trace: record.trace,
        effects: record.effects
      })
      expect(agentFields(contained.record)).toEqual(agentFields(onHost.record))
      // The verifier fills these two.
      expect(contained.record.hiddenTests).toBeNull()
      expect(contained.record.measuredChange).toBeNull()
      // The written record also names the backend the role ran on, standalone when the container names none.
      expect(JSON.parse(readFileSync(recordPath, 'utf8'))).toEqual({ ...contained.record, backend: 'standalone' })
      expect(inContainer.calls.filter((call) => SKIPPED_IN_CONTAINER.includes(call))).toEqual([])

      if (kind === 'answer') {
        expect(inContainer.turns.map((turn) => turn.workspace)).toEqual([tree])
        expect(host.turns[0]?.workspace).not.toBe(tree)
        expect(inContainer.calls).toEqual(['startToolHost', 'readOnlyTurn'])
        expect(host.calls).toEqual(['startToolHost', 'readOnlyTurn'])
        return
      }
      expect(inContainer.dispatched).toEqual([{ cwd: tree, containerMode: true }])
      expect(host.dispatched[0]?.cwd).not.toBe(tree)
      expect(host.dispatched[0]?.containerMode).toBeUndefined()
      if (kind === 'review') {
        expect(contained.record).toEqual(onHost.record)
        expect(host.calls).toEqual(['stageTrial', 'testContamination', 'dispatch'])
        expect(inContainer.calls).toEqual(['dispatch'])
        return
      }
      // A change case: the role's commit lands on the tree's HEAD, and the tree's diff against the base is its work.
      // The prompt names the issue the trial's world is created with, on the host and in the container alike.
      for (const prompt of [...host.prompts, ...inContainer.prompts]) expect(prompt).toContain(`Closes #${issue}`)
      expect(issue).not.toBe(1)
      // Codex counts its cached input inside `input_tokens`; the trial's usage keeps it apart.
      expect(onHost.usage).toMatchObject({
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 2,
        cacheCreationTokens: 0
      })
      expect(onHost.record.pullRequest?.body).toContain(`Closes #${issue}`)
      expect(onHost.record.effects?.map((effect) => effect.kind)).toEqual(['publish_changes', 'open_pull_request'])
      const head = git(tree, ['rev-parse', 'HEAD']).trim()
      expect(head).not.toBe(fixture?.base)
      expect(git(tree, ['diff', '--name-only', fixture?.base as string, head]).trim()).toBe('solution.ts')
      expect(contained.record.pullRequest?.headSha).toBe(head)
      expect(contained.record.pullRequest?.baseSha).toBe(fixture?.base)
      expect(onHost.record.measuredChange?.changedPaths).toEqual(['solution.ts'])
      expect(onHost.record.hiddenTests?.revision).toBe(onHost.record.measuredChange?.head)
      expect(inContainer.calls).toEqual(['startToolHost', 'dispatch'])
      // Outside container mode the same fakes record every step as today.
      expect(host.calls).toEqual([
        'hiddenInputs',
        'stageTrial',
        'testContamination',
        'openGradingSandbox',
        'warmPackageCache',
        'sandbox.run',
        'startToolHost',
        'dispatch',
        'commitTrialInSandbox',
        'importTrialBundle',
        'prepareGradingCopy',
        'sandbox.run',
        'gradeInSandbox'
      ])
    }, 60_000)
  }

  it('authenticates a Claude answer turn in container mode from the subscription token alone, never an API key', async () => {
    const c = await caseOf('source-delivery-neutral.l5', 'answer')
    const rendered = renderCase(c)
    if (!rendered.ok) throw new Error('the case does not render')
    const request = {
      trial: {
        suite: 'source-delivery-neutral.l5' as const,
        adapter: 'claude-code' as const,
        taskId: c.id,
        attempt: 1
      },
      neutralCase: c,
      input: rendered.input
    }
    const context: StepOneCommandContext = {
      repository: '.',
      developerBriefs: new Map(),
      models: {},
      timeoutMs: 1000,
      loaded: await loading
    }
    const saved = { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, key: process.env.ANTHROPIC_API_KEY }
    try {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'subscription-token-fixture'
      process.env.ANTHROPIC_API_KEY = 'api-key-fixture'
      const container = {
        workingTree: tempDir('step-one-container-app-'),
        recordPath: join(tempDir('step-one-container-record-'), 'record.json')
      }
      const inContainer = recordingSteps('answer', 1)
      await vinayaProcess(inContainer.steps)(request, { ...context, container })
      const env = inContainer.turns[0]?.claudeEnv ?? {}
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('subscription-token-fixture')
      expect(env.CLAUDE_FORCE_OAUTH).toBe('1')
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      // On the host the token is never read: the turn keeps its stripped parent environment.
      const host = recordingSteps('answer', 1)
      await vinayaProcess(host.steps)(request, context)
      expect(host.turns[0]?.claudeEnv).toBeUndefined()
      // Without the token, container mode refuses rather than reaching for another login.
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      await expect(
        vinayaProcess(recordingSteps('answer', 1).steps)(request, { ...context, container })
      ).rejects.toThrow('CLAUDE_CODE_OAUTH_TOKEN')
    } finally {
      for (const [name, value] of [
        ['CLAUDE_CODE_OAUTH_TOKEN', saved.token],
        ['ANTHROPIC_API_KEY', saved.key]
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('commits a container trial on the working tree HEAD, and refuses a trial with no commit ahead of its base', () => {
    const tree = tempDir('step-one-container-commit-')
    git(tree, ['init', '--quiet'])
    const base = commitAll(tree, 'base')
    expect(commitInWorkingTree(tree, 'Eval(developer): nothing', base)).toEqual({
      ok: false,
      reason: 'Developer trial has no commit ahead of its base'
    })
    writeFileSync(join(tree, 'work.ts'), 'export {}\n')
    const committed = commitInWorkingTree(tree, 'Eval(developer): work', base)
    expect(committed).toEqual({ ok: true, commit: git(tree, ['rev-parse', 'HEAD']).trim() })
    expect(git(tree, ['status', '--porcelain'])).toBe('')
  })

  it('takes container mode as two flags given together, and runs no layer-P suite in it', async () => {
    const args = (...extra: string[]) => [
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
      '1',
      '--resamples',
      '20',
      '--confidence',
      '0.95',
      '--input-cost-per-million',
      '0',
      '--output-cost-per-million',
      '0',
      ...extra
    ]
    await expect(runStepOneCommand(args('--container-tree', '/app'))).rejects.toThrow('given together')
    const context: StepOneCommandContext = {
      repository: '.',
      developerBriefs: new Map(),
      models: {},
      timeoutMs: 1,
      loaded: await loading,
      container: { workingTree: '/app', recordPath: '/app/record.json' }
    }
    await expect(
      PRODUCTION_STEP_ONE_RUNTIME.execute(
        { suite: 'developer-capability.l5', adapter: 'codex', taskId: 'any', attempt: 1 },
        context
      )
    ).rejects.toThrow('container mode runs no layer-P suite')
  })

  it('refuses a loop case on the host and in a container on both backends, before any step runs', async () => {
    const [loop] = developmentCases('wholeLoop')
    if (loop === undefined || loop.kind !== 'loop') throw new Error('no loop case')
    const rendered = renderCase(loop)
    if (!rendered.ok) throw new Error('the loop case does not render')
    const request = {
      trial: {
        suite: 'developer-capability-neutral.l5' as const,
        adapter: 'codex' as const,
        taskId: loop.id,
        attempt: 1
      },
      neutralCase: loop,
      input: rendered.input
    }
    const context: StepOneCommandContext = {
      repository: '.',
      developerBriefs: new Map(),
      models: {},
      timeoutMs: 1000,
      loaded: await loading
    }
    const recordPath = join(tempDir('step-one-loop-record-'), 'record.json')
    const placements = [
      undefined,
      ...STEP_ONE_BACKENDS.map((backend) => ({ workingTree: tempDir('step-one-loop-app-'), recordPath, backend }))
    ]
    for (const container of placements) {
      const recording = recordingSteps('loop', 1)
      await expect(
        vinayaProcess(recording.steps)(request, { ...context, ...(container === undefined ? {} : { container }) })
      ).rejects.toThrow('step one runs no loop case')
      expect(recording.calls).toEqual([])
    }
    expect(existsSync(recordPath)).toBe(false)
  })

  describe('every role trial gives its agent the role doctrine the review loop gives it', () => {
    const DOCTRINE_KINDS: { suite: StepOneRunSuite; kind: NeutralCase['kind'] }[] = [
      { suite: 'developer-capability-neutral.l5', kind: 'change' },
      { suite: 'code-reviewer-quality-neutral.l5', kind: 'review' },
      { suite: 'security-reviewer-quality-neutral.l5', kind: 'review' },
      { suite: 'source-delivery-neutral.l5', kind: 'answer' }
    ]

    /** One trial of `suite`'s `kind` case on `adapter`, in a container working tree or on the host. */
    async function doctrineTrial(
      suite: StepOneRunSuite,
      kind: NeutralCase['kind'],
      adapter: 'claude-code' | 'codex',
      where: 'host' | 'container',
      doctrine?: (role: TrialDoctrineRole) => Promise<string | null>,
      tree: string = tempDir('step-one-doctrine-app-')
    ) {
      const c = await caseOf(suite, kind)
      const rendered = renderCase(c)
      if (!rendered.ok) throw new Error('the case does not render')
      const fixture = kind === 'change' ? await changeFixture(c) : null
      if (fixture !== null && where === 'container') git(tree, ['clone', '--quiet', fixture.source, '.'])
      const recording = recordingSteps(kind, fixture?.issue ?? 1, doctrine)
      // A container Claude turn authenticates from the subscription token alone.
      const priorToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-subscription-token'
      try {
        const ran = await vinayaProcess(recording.steps)(
          { trial: { suite, adapter, taskId: c.id, attempt: 1 }, neutralCase: c, input: rendered.input },
          {
            repository: fixture?.source ?? '.',
            developerBriefs: new Map(),
            models: {},
            timeoutMs: 1000,
            loaded: fixture?.loaded ?? (await loading),
            ...(where === 'container'
              ? {
                  container: {
                    workingTree: tree,
                    recordPath: join(tempDir('step-one-doctrine-record-'), 'record.json')
                  }
                }
              : {})
          }
        )
        return { ran, recording, brief: rendered.input.brief }
      } finally {
        if (priorToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = priorToken
      }
    }

    for (const { suite, kind } of DOCTRINE_KINDS) {
      const role = doctrineRoleOf(suite)
      for (const adapter of ['claude-code', 'codex'] as const) {
        for (const where of ['host', 'container'] as const) {
          it(`a ${suite} ${kind} trial on ${adapter} (${where}) starts its prompt with the loop's ${role} doctrine block, before the brief, and records its digest`, async () => {
            const { ran, recording, brief } = await doctrineTrial(suite, kind, adapter, where)
            expect(ran.ok).toBe(true)
            if (!ran.ok) return
            const block = loopDoctrineBlock(role, fakeDoctrine(role))
            expect(recording.doctrineRoles).toEqual([role])
            expect(recording.prompts).toHaveLength(1)
            const prompt = recording.prompts[0] as string
            // Byte for byte the loop's own rendering, then the brief.
            expect(prompt.slice(0, block.length)).toBe(block)
            expect(prompt.startsWith(`${block}\n\n${brief}`)).toBe(true)
            expect(ran.record.doctrineDigest).toBe(sha256(block))
          }, 60_000)
        }
      }

      it(`a ${suite} ${kind} trial whose ${role} doctrine does not resolve is unavailable, naming the role, and dispatches nothing`, async () => {
        for (const resolved of [null, '  \n']) {
          const { ran, recording } = await doctrineTrial(suite, kind, 'codex', 'container', async () => resolved)
          expect(ran.ok).toBe(false)
          if (ran.ok) return
          expect(ran.unavailableReason).toContain(`no ${role} doctrine resolves from the Vinaya under test`)
          expect(recording.prompts).toEqual([])
          expect(recording.calls).toEqual([])
        }
      }, 60_000)
    }

    it("reads the doctrine from the Vinaya under test, never the trial's working tree", async () => {
      // A working tree that is a git repository with its own older doctrine, as a case's `/app` is.
      const tree = tempDir('step-one-doctrine-stale-app-')
      git(tree, ['init', '--quiet'])
      for (const file of [
        'harness/processes/vinaya-strict/executing/developer/doctrine.md',
        'harness/processes/vinaya-strict/executing/code-reviewer/doctrine.md',
        'harness/processes/vinaya-strict/executing/developer/reference.md'
      ]) {
        mkdirSync(dirname(join(tree, file)), { recursive: true })
        writeFileSync(join(tree, file), '## Short version\n\nSTALE-TREE-DOCTRINE\n')
      }
      mkdirSync(join(tree, 'harness/processes/vinaya-strict/doctrine/skills/vinaya'), { recursive: true })
      writeFileSync(
        join(tree, 'harness/processes/vinaya-strict/doctrine/skills/vinaya/SKILL.md'),
        'STALE-TREE-DOCTRINE\n'
      )
      commitAll(tree, 'stale doctrine')
      const production = PRODUCTION_VINAYA_PROCESS_STEPS.resolveRoleDoctrine
      for (const [suite, kind, role] of [
        ['code-reviewer-quality-neutral.l5', 'review', 'reviewer'],
        ['source-delivery-neutral.l5', 'answer', 'developer']
      ] as const) {
        const { ran, recording } = await doctrineTrial(suite, kind, 'claude-code', 'container', production, tree)
        expect(ran.ok).toBe(true)
        if (!ran.ok) return
        const expected =
          role === 'developer' ? await resolveDeveloperDoctrineText() : await resolveRoleDoctrineText(role)
        if (expected === null) throw new Error(`the repository's ${role} doctrine does not resolve`)
        const block = loopDoctrineBlock(role, expected)
        expect(recording.prompts[0]?.startsWith(block)).toBe(true)
        expect(recording.prompts[0]).not.toContain('STALE-TREE-DOCTRINE')
        expect(ran.record.doctrineDigest).toBe(sha256(block))
      }
    }, 60_000)
  })

  it('runs an answer case on the standalone backend only', async () => {
    const c = await caseOf('source-delivery-neutral.l5', 'answer')
    const rendered = renderCase(c)
    if (!rendered.ok) throw new Error('the case does not render')
    const recording = recordingSteps('answer', 1)
    await expect(
      vinayaProcess(recording.steps)(
        {
          trial: { suite: 'source-delivery-neutral.l5', adapter: 'codex', taskId: c.id, attempt: 1 },
          neutralCase: c,
          input: rendered.input
        },
        {
          repository: '.',
          developerBriefs: new Map(),
          models: {},
          timeoutMs: 1000,
          loaded: await loading,
          container: {
            workingTree: tempDir('step-one-answer-engine-app-'),
            recordPath: join(tempDir('step-one-answer-engine-record-'), 'record.json'),
            backend: 'engine'
          }
        }
      )
    ).rejects.toThrow('an answer case runs only on the standalone backend')
    expect(recording.calls).toEqual([])
  })

  describe('a trial that times out or crashes', () => {
    /**
     * A Claude Code session cut off before its closing `result` event: three
     * assistant events, the first two one message streamed as two content
     * blocks, each carrying that message's usage.
     */
    const cutOffStream = [
      { type: 'system', subtype: 'init', session_id: 'cut-off' },
      {
        type: 'assistant',
        message: {
          id: 'msg-1',
          content: [{ type: 'text', text: 'Reading.' }],
          usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 }
        }
      },
      {
        type: 'assistant',
        message: {
          id: 'msg-1',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }],
          usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 }
        }
      },
      {
        type: 'assistant',
        message: {
          id: 'msg-2',
          content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'bun test' } }],
          usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 110, cache_creation_input_tokens: 0 }
        }
      }
    ].map((event) => JSON.stringify(event))
    const CUT_OFF_TOKENS = { inputTokens: 15, outputTokens: 7, cacheReadTokens: 210, cacheCreationTokens: 7 }

    /** The case file of a change case for the trial entry, its tree a clone of the case's fixture repository. */
    async function changeTrialFiles() {
      const c = await caseOf('developer-capability-neutral.l5', 'change')
      const fixture = await changeFixture(c)
      const tree = tempDir('step-one-timeout-app-')
      git(tree, ['clone', '--quiet', fixture.source, '.'])
      const work = tempDir('step-one-timeout-files-')
      const casePath = join(work, 'case.json')
      const file: HarborCaseFile = {
        schemaVersion: 1,
        suite: 'developer-capability-neutral.l5',
        case: c,
        counterpart: { kind: 'change', id: c.id, pullRequest: fixture.issue }
      }
      writeFileSync(casePath, JSON.stringify(file))
      return {
        c,
        fixture,
        tree,
        casePath,
        recordPath: join(work, 'agent', 'vinaya-trial-record.json'),
        usagePath: join(work, 'agent', 'vinaya-usage.json'),
        streamPath: join(work, 'agent', 'vinaya-trial.txt')
      }
    }

    it('keeps each stream line in the stream file as it arrives, and sums its usage from each assistant message', async () => {
      const c = await caseOf('developer-capability-neutral.l5', 'change')
      const rendered = renderCase(c)
      if (!rendered.ok) throw new Error('the case does not render')
      const fixture = await changeFixture(c)
      const tree = tempDir('step-one-stream-app-')
      git(tree, ['clone', '--quiet', fixture.source, '.'])
      const streamPath = join(tempDir('step-one-stream-agent-'), 'vinaya-trial.txt')
      writeFileSync(streamPath, '')
      const keptOnArrival: number[] = []
      const recording = recordingSteps('change', fixture.issue)
      const run = await vinayaProcess({
        ...recording.steps,
        dispatch: async (_role, _agent, _prompt, opts) => {
          for (const line of cutOffStream) {
            opts.observeStdoutLine?.(line)
            keptOnArrival.push(readFileSync(streamPath, 'utf8').split('\n').filter(Boolean).length)
          }
          // The dispatch's own limit stopped the agent: no `result` event, so the handle has no usage.
          return {
            exitCode: 1,
            durationMs: 9,
            usage: null,
            resumeId: null,
            timedOut: true,
            failureReason: 'timeout',
            turnOutput: { raw: null }
          } as never
        }
      })(
        {
          trial: { suite: 'developer-capability-neutral.l5', adapter: 'claude-code', taskId: c.id, attempt: 1 },
          neutralCase: c,
          input: rendered.input
        },
        {
          repository: fixture.source,
          developerBriefs: new Map(),
          models: {},
          timeoutMs: 1000,
          loaded: fixture.loaded,
          container: {
            workingTree: tree,
            recordPath: join(tempDir('step-one-stream-record-'), 'record.json'),
            streamPath
          }
        }
      )
      expect(keptOnArrival).toEqual([1, 2, 3, 4])
      expect(readFileSync(streamPath, 'utf8')).toBe(`${cutOffStream.join('\n')}\n`)
      expect(run.usage).toMatchObject({ ...CUT_OFF_TOKENS, wallTimeMs: 9 })
    }, 60_000)

    it("records a completed Claude Code session's `result` usage, and its message sum only once it is cut off before that event", () => {
      /**
       * A completed Claude Code session's stream-json lines: each assistant event
       * carries the output tokens counted at the start of its message, and only
       * the closing `result` event the session's real output total.
       */
      const assistant = (id: string, content: unknown[], usage: Record<string, number>) => ({
        type: 'assistant',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content,
          stop_reason: null,
          stop_sequence: null,
          usage: { ...usage, service_tier: 'standard' }
        },
        parent_tool_use_id: null,
        session_id: 'completed'
      })
      const completedStream = [
        { type: 'system', subtype: 'init', session_id: 'completed', model: 'claude-opus-5-5' },
        assistant('msg_01', [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: 'a.ts' } }], {
          input_tokens: 6,
          cache_creation_input_tokens: 1200,
          cache_read_input_tokens: 18000,
          output_tokens: 8
        }),
        {
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'ok' }] },
          session_id: 'completed'
        },
        assistant('msg_02', [{ type: 'text', text: 'Done.' }], {
          input_tokens: 4,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 19200,
          output_tokens: 3
        }),
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 61234,
          num_turns: 2,
          result: 'Done.',
          session_id: 'completed',
          total_cost_usd: 0.42,
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 1500,
            cache_read_input_tokens: 37200,
            output_tokens: 4168,
            server_tool_use: { web_search_requests: 0 },
            service_tier: 'standard'
          }
        }
      ].map((event) => JSON.stringify(event))
      expect(trialUsage('claude-code', null, completedStream)).toMatchObject({
        inputTokens: 10,
        outputTokens: 4168,
        cacheReadTokens: 37200,
        cacheCreationTokens: 1500
      })
      // Two invocations in one stream, one `result` event each: their totals summed.
      expect(trialUsage('claude-code', null, [...completedStream, ...completedStream]).outputTokens).toBe(8336)
      // The same session cut off before its `result` event: the message sum, an undercount of its output tokens.
      expect(trialUsage('claude-code', null, completedStream.slice(0, -1))).toMatchObject({
        inputTokens: 10,
        outputTokens: 11,
        cacheReadTokens: 37200,
        cacheCreationTokens: 1500
      })
      expect(trialUsage('claude-code', null, cutOffStream)).toMatchObject(CUT_OFF_TOKENS)
    })

    it('stops the role at the trial limit and reports the trial timed out, with its stream and summed usage', async () => {
      const files = await changeTrialFiles()
      let stopped = 0
      let release: () => void = () => {}
      const outcome = await runHarborTrial(
        {
          casePath: files.casePath,
          tree: files.tree,
          recordPath: files.recordPath,
          usagePath: files.usagePath,
          backend: 'standalone',
          adapter: 'claude-code',
          model: 'claude-test-model',
          timeoutMs: 200,
          streamPath: files.streamPath,
          stopRole: () => {
            stopped++
            release()
          }
        },
        {
          ...recordingSteps('change', files.fixture.issue).steps,
          dispatch: async (_role, _agent, _prompt, opts) => {
            for (const line of cutOffStream) opts.observeStdoutLine?.(line)
            // The agent works until the trial stops it.
            await new Promise<void>((resolve) => {
              release = resolve
            })
            return {
              exitCode: 1,
              durationMs: 200,
              usage: null,
              resumeId: null,
              timedOut: false,
              failureReason: 'signal',
              turnOutput: { raw: null }
            } as never
          }
        }
      )
      expect(stopped).toBe(1)
      expect(outcome.timedOut).toBe(true)
      const usage = JSON.parse(readFileSync(files.usagePath, 'utf8')) as HarborTrialUsage
      expect(usage).toMatchObject({ ...CUT_OFF_TOKENS, timedOut: true })
      expect(readFileSync(files.streamPath, 'utf8')).toBe(`${cutOffStream.join('\n')}\n`)
    }, 60_000)

    it('writes the usage from the stream when the run throws', async () => {
      const files = await changeTrialFiles()
      const outcome = await runHarborTrial(
        {
          casePath: files.casePath,
          tree: files.tree,
          recordPath: files.recordPath,
          usagePath: files.usagePath,
          backend: 'standalone',
          adapter: 'claude-code',
          model: 'claude-test-model',
          timeoutMs: 60_000
        },
        {
          ...recordingSteps('change', files.fixture.issue).steps,
          dispatch: async (_role, _agent, _prompt, opts) => {
            for (const line of cutOffStream) opts.observeStdoutLine?.(line)
            throw new Error('the agent process crashed')
          }
        }
      )
      expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining('the agent process crashed') })
      expect(outcome.timedOut).toBeUndefined()
      // With no stream path named, the stream file sits beside the record.
      expect(readFileSync(files.streamPath, 'utf8')).toBe(`${cutOffStream.join('\n')}\n`)
      const usage = JSON.parse(readFileSync(files.usagePath, 'utf8')) as HarborTrialUsage
      expect(usage).toMatchObject({ ...CUT_OFF_TOKENS, timedOut: false })
      expect(usage.wallTimeMs).toBeGreaterThanOrEqual(0)
    }, 60_000)

    it('reports an Engine role step its limit stopped as timed out, with usage from its stream', async () => {
      const tree = tempDir('step-one-engine-timeout-app-')
      git(tree, ['init', '--quiet'])
      commitAll(tree, 'base')
      const priorToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-subscription-token'
      const observed: string[] = []
      // A stub agent that streams a cut-off session and runs until the executor kills it.
      const spawnFn = (() => {
        const stdout = new EventEmitter()
        const lifecycle = new EventEmitter()
        return {
          stdin: {
            write: () => {},
            end: () => {
              setTimeout(() => {
                for (const line of cutOffStream) stdout.emit('data', `${line}\n`)
              }, 0)
            }
          },
          stdout: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => stdout.on(event, listener) },
          stderr: { on: () => {} },
          on: (event: string, listener: (...args: unknown[]) => void) => lifecycle.on(event, listener),
          kill: () => {
            setTimeout(() => lifecycle.emit('close', null), 0)
          }
        }
      }) as unknown as SpawnFn
      try {
        const handle = await runEngineRoleStep({
          role: 'developer',
          adapter: 'claude-code',
          prompt: 'Do the task.',
          workingTree: tree,
          scratch: tempDir('step-one-engine-timeout-scratch-'),
          model: 'claude-test-model',
          timeoutMs: 300,
          outputSchema: { type: 'object' },
          devToolsBridge: { command: 'true', args: [] },
          spawnFn,
          observeStdoutLine: (line) => observed.push(line)
        })
        expect(handle.timedOut).toBe(true)
        expect(handle.failureReason).toBe('timeout')
        expect(handle.usage).toEqual({ input: 15, output: 7 })
        expect(handle.cacheUsage).toEqual({ read: 210, creation: 7 })
        expect(observed).toEqual(cutOffStream)
      } finally {
        if (priorToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = priorToken
      }
    }, 60_000)
  })
})

describe('the capabilities a case grants decide what its trial agent is offered, on both adapters', () => {
  const tempDir = (prefix: string) => realpathSync(fixtureDir(prefix))
  const bridge = { command: 'true', args: [] }
  const schema = { type: 'object' }
  const effective = (config: { files: Record<string, string> }) =>
    JSON.parse(config.files['effective-capabilities.json'] as string) as Record<string, string>
  const undelivered = developmentCases('sourceCitation').find((c) => c.id === 'dev-undelivered-source') as NeutralCase

  it('an answer case granting only read_file offers no shell beyond reading, no write and no web tool', () => {
    expect(undelivered.grantedCapabilities).toEqual(['read_file'])
    for (const adapter of ['claude-code', 'codex'] as const) {
      const dir = tempDir(`answer-config-${adapter}-`)
      // A Codex home with no staged login: nothing to copy.
      const priorCodexHome = process.env.CODEX_HOME
      process.env.CODEX_HOME = tempDir('answer-config-no-login-')
      let config: ReturnType<typeof answerTurnConfig>
      try {
        config = answerTurnConfig(adapter, dir, tempDir('answer-workspace-'), bridge, schema, {
          timeoutSec: 5,
          grantedCapabilities: undelivered.grantedCapabilities
        })
      } finally {
        if (priorCodexHome === undefined) delete process.env.CODEX_HOME
        else process.env.CODEX_HOME = priorCodexHome
      }
      expect(effective(config)).toMatchObject({
        read_files: 'allow',
        run_commands: 'deny',
        write_files: 'deny',
        web_fetch: 'deny',
        web_search: 'deny',
        spawn_agent: 'deny'
      })
      // The generated files are on disk where the launch names them.
      for (const path of Object.keys(config.files)) expect(existsSync(join(dir, 'generated', path))).toBe(true)
      // No driver-run tool the case does not grant is named anywhere in the agent's configuration.
      expect(Object.values(config.files).join('\n')).not.toContain('publish_changes')
    }
  })

  it('launches the generated configuration with the prompt on stdin, resumes it, and traces fetch_documentation as read_document', async () => {
    const stubs = tempDir('answer-stub-bin-')
    const log = join(stubs, 'calls.jsonl')
    const streams = {
      claude: [
        { type: 'system', subtype: 'init', session_id: 'stub-session' },
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 't1',
                name: `mcp__${ENGINE_DEV_TOOLS_SERVER}__fetch_documentation`,
                input: { url: 'https://docs.example.test/retries' }
              }
            ]
          }
        },
        { type: 'result', subtype: 'success', session_id: 'stub-session', structured_output: { turnResult: {} } }
      ],
      codex: [
        { type: 'thread.started', thread_id: 'stub-thread' },
        {
          type: 'item.completed',
          item: {
            id: 'm1',
            type: 'mcp_tool_call',
            server: ENGINE_DEV_TOOLS_SERVER,
            tool: 'fetch_documentation',
            arguments: { url: 'https://docs.example.test/retries' },
            status: 'completed'
          }
        }
      ]
    }
    for (const [name, lines] of Object.entries(streams)) {
      const stream = lines.map((line) => JSON.stringify(line)).join('\n')
      writeFileSync(
        join(stubs, name),
        [
          '#!/usr/bin/env bun',
          "import { appendFileSync } from 'node:fs'",
          `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin: await Bun.stdin.text() }) + '\\n')`,
          `process.stdout.write(${JSON.stringify(`${stream}\n`)})`,
          ''
        ].join('\n'),
        { mode: 0o755 }
      )
    }
    const priorPath = process.env.PATH
    const priorCodexHome = process.env.CODEX_HOME
    const login = tempDir('answer-codex-login-')
    writeFileSync(join(login, 'auth.json'), '{"stub":true}\n')
    process.env.PATH = `${stubs}:${priorPath ?? ''}`
    process.env.CODEX_HOME = login
    try {
      for (const adapter of ['claude-code', 'codex'] as const) {
        const dir = tempDir(`answer-turn-${adapter}-`)
        const workspace = tempDir('answer-turn-workspace-')
        const options = { timeoutSec: 30, grantedCapabilities: ['read_document'] }
        const turn = readOnlyDeveloperTurn(adapter, dir, workspace, bridge, schema, options)
        const first = await turn('Cite the delivered source.', null)
        const second = await turn('Continue.', 'session-1')
        const generated = JSON.parse(readFileSync(join(dir, 'generated', 'effective-capabilities.json'), 'utf8'))
        expect(generated).toMatchObject({ read_files: 'deny', run_commands: 'deny', write_files: 'deny' })
        const calls = readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { argv: string[]; stdin: string })
          .slice(-2)
        // The generated launch and its resume form, each with the prompt on stdin.
        const expected = answerTurnConfig(adapter, dir, workspace, bridge, schema, options)
        expect(calls[0]?.argv).toEqual(expected.launch.slice(1))
        expect(calls[0]?.stdin).toBe('Cite the delivered source.')
        expect(calls[1]?.argv).toEqual(
          (expected.resumeLaunch ?? []).slice(1).map((arg) => (arg === '<session-id>' ? 'session-1' : arg))
        )
        expect(calls[1]?.stdin).toBe('Continue.')
        // The staged Codex login is copied into the generated Codex home.
        if (adapter === 'codex')
          expect(readFileSync(join(dir, 'generated', 'auth.json'), 'utf8')).toBe('{"stub":true}\n')
        for (const stdout of [first, second]) {
          const lines = stdout.split('\n').filter(Boolean)
          const trace = adapter === 'claude-code' ? claudeTrace(lines) : codexTrace(lines)
          expect(trace.map((call) => call.tool)).toEqual(['fetch_documentation'])
          expect(trace.map((call) => TOOL_CAPABILITIES[call.tool])).toEqual(['read_document'])
        }
        expect(first).not.toContain(ENGINE_DEV_TOOLS_SERVER)
        expect(first).toContain(DEV_TOOLS_MCP_SERVER_NAME)
      }
    } finally {
      process.env.PATH = priorPath
      if (priorCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = priorCodexHome
    }
  }, 60_000)

  it("an Engine role step's generated settings deny a capability its case does not grant", () => {
    const request = (adapter: 'claude-code' | 'codex', grantedCapabilities?: readonly string[]) => ({
      role: 'developer' as const,
      adapter,
      workingTree: tempDir('engine-narrow-tree-'),
      scratch: tempDir('engine-narrow-scratch-'),
      outputSchema: schema,
      devToolsBridge: bridge,
      ...(grantedCapabilities === undefined ? {} : { grantedCapabilities })
    })
    for (const adapter of ['claude-code', 'codex'] as const) {
      const own = generatedRoleConfig(request(adapter), tempDir('engine-narrow-own-'))
      expect(effective(own)).toMatchObject({ write_files: 'allow', web_fetch: 'allow', spawn_agent: 'allow' })
      const narrowed = generatedRoleConfig(
        request(adapter, ['read_file', 'run_commands', 'read_document']),
        tempDir('engine-narrow-case-')
      )
      expect(effective(narrowed)).toMatchObject({
        read_files: 'allow',
        run_commands: 'allow',
        write_files: 'deny',
        web_fetch: 'deny',
        web_search: 'deny',
        spawn_agent: 'deny'
      })
      expect(Object.values(own.files).join('\n')).toContain('publish_changes')
      expect(Object.values(narrowed.files).join('\n')).not.toContain('publish_changes')
      expect(Object.values(narrowed.files).join('\n')).toContain('fetch_documentation')
    }
  })
})
