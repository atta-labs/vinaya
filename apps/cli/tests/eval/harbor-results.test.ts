import { afterEach, describe, expect, it } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HarborResultsRefused,
  harborResultsMain,
  quarantineAdjudicationDigest,
  readHarborJob
} from '../../src/lib/dev-review-eval/harbor-results'

const fixtures = join(import.meta.dir, 'fixtures', 'harbor-jobs')
const suite = 'code-reviewer-quality-neutral.l5' as const
const bootstrap = { method: 'percentile' as const, seed: 1, resamples: 100, confidence: 0.95 }
/** The inputs that read a job as a one-trial development practice run of the standalone backend on Claude Code. */
const practice = {
  resultKind: 'practice',
  split: 'development',
  backend: 'standalone',
  adapter: 'claude-code',
  trialsPerTask: 1
} as const
const practiceFlags = [
  '--result-kind',
  'practice',
  '--split',
  'development',
  '--backend',
  'standalone',
  '--adapter',
  'claude-code',
  '--trials-per-task',
  '1'
]
const scratch: string[] = []
afterEach(() =>
  scratch.splice(0).forEach((path) => {
    rmSync(path, { recursive: true, force: true })
  })
)

function copyJob(): string {
  const root = mkdtempSync(join(tmpdir(), 'vinaya-harbor-results-'))
  scratch.push(root)
  const job = join(root, 'job')
  cpSync(join(fixtures, 'vinaya'), job, { recursive: true })
  return job
}

function read(jobDirectory = join(fixtures, 'vinaya'), taskRoot: string | undefined = jobDirectory) {
  return readHarborJob({ jobDirectory, taskRoot, suite, ...practice, subscriptionAuth: true, bootstrap })
}

function refusal(job: string, code: HarborResultsRefused['code']) {
  try {
    read(job)
    throw new Error('reader accepted refused fixture')
  } catch (error) {
    expect(error).toBeInstanceOf(HarborResultsRefused)
    expect((error as HarborResultsRefused).code).toBe(code)
  }
}

describe('Harbor job results', () => {
  it('maps success, failure, error, metadata, usage, wall time, and the practice run', () => {
    const output = read()
    expect(output.trials.success?.[0]?.success).toBe(true)
    expect(output.trials.failure?.[0]?.success).toBe(false)
    expect(output.trials.failure?.[0]?.unavailableReason).toBeUndefined()
    expect(output.trials.error?.[0]).toMatchObject({
      success: false,
      unavailableReason: 'RuntimeError: agent exited before grading'
    })
    expect(output.result).toMatchObject({ purpose: 'practice', trialsPerTask: 1 })
    expect(output.result.runs[0]).toMatchObject({
      suite,
      layer: 'G',
      rendererVersion: 'fixture-renderer-v1',
      backend: 'standalone',
      adapter: 'claude-code',
      agent: 'vinaya',
      model: 'claude-opus-5-5',
      auth: 'subscription',
      evidence: 'never',
      taskCount: 3,
      mean: 1 / 3
    })
    expect(output.result.runs[0]?.usage).toMatchObject({
      wallTimeMs: 180_000,
      inputTokens: 300,
      outputTokens: 50,
      estimatedCostUsd: 0.03
    })
    expect(output.result.runs[0]?.usage.subscriptionQuota).toBeCloseTo(0.3)
  })

  /** The fixture job with its `failure` task quarantined, its task.toml's metadata extended by `lines`. */
  function quarantinedJob(edit: (lines: string[]) => string[] = (lines) => lines): string {
    const job = copyJob()
    const quarantine = {
      taskId: 'failure',
      cause: 'environment' as const,
      reason: 'Its hidden tests run only on another platform.',
      reasonVersion: 1
    }
    const path = join(job, 'tasks', 'failure', 'task.toml')
    const lines = edit([
      `quarantine_adjudication_digest = "${quarantineAdjudicationDigest(quarantine)}"`,
      `quarantine_cause = "${quarantine.cause}"`,
      `quarantine_reason = "${quarantine.reason}"`,
      `quarantine_reason_version = ${quarantine.reasonVersion}`
    ])
    writeFileSync(path, readFileSync(path, 'utf8').replace('harbor_version', `${lines.join('\n')}\nharbor_version`))
    return job
  }

  it('reports a quarantined task under quarantined, with its tally, and estimates over the other tasks', () => {
    const plain = read()
    const output = read(quarantinedJob())
    const run = output.result.runs[0]
    expect(run?.quarantined).toEqual([
      {
        quarantine: {
          taskId: 'failure',
          cause: 'environment',
          reason: 'Its hidden tests run only on another platform.',
          reasonVersion: 1,
          adjudicationDigest: quarantineAdjudicationDigest({
            taskId: 'failure',
            cause: 'environment',
            reason: 'Its hidden tests run only on another platform.',
            reasonVersion: 1
          })
        },
        tally: { taskId: 'failure', successes: 0, trials: 1, unavailable: [] }
      }
    ])
    expect(run?.tasks.map((task) => task.taskId)).toEqual(['error', 'success'])
    expect(run?.taskCount).toBe(2)
    expect(run?.mean).toBe(1 / 2)
    // A quarantined trial's usage still counts.
    expect(run?.usage).toEqual(plain.result.runs[0]?.usage as NonNullable<typeof run>['usage'])
    expect(output.trials.failure?.[0]?.success).toBe(false)
    expect(plain.result.runs[0]?.quarantined).toEqual([])
  })

  it('refuses a quarantine with a stale adjudication digest or only part of its fields', () => {
    refusal(
      quarantinedJob((lines) => lines.map((line) => line.replace('another platform', 'one platform'))),
      'invalid_input'
    )
    refusal(
      quarantinedJob((lines) => lines.slice(1)),
      'missing_task_metadata'
    )
  })

  it('refuses the original Claude Code job', () => refusal(join(fixtures, 'claude-code-job'), 'unsupported_agent'))

  it('compares an import path only when the job config carries one', () => {
    const job = copyJob()
    const path = join(job, 'config.json')
    const config = JSON.parse(readFileSync(path, 'utf8'))
    config.agents[0].import_path = 'vinaya_harbor_agent:VinayaAgent'
    writeFileSync(path, JSON.stringify(config))
    refusal(job, 'invalid_input')
  })

  it('retains the native Harbor job and trial structures in both agent fixtures', () => {
    for (const [jobName, trialNames] of [
      ['vinaya', ['success__trial', 'failure__trial', 'error__trial']],
      ['claude-code-job', ['success__trial']]
    ] as const) {
      const job = join(fixtures, jobName)
      const config = JSON.parse(readFileSync(join(job, 'config.json'), 'utf8'))
      expect(config.tasks.every((task: any) => Object.keys(task).length === 1 && typeof task.path === 'string')).toBe(
        true
      )
      const lock = JSON.parse(readFileSync(join(job, 'lock.json'), 'utf8'))
      expect(lock.trials).toHaveLength(trialNames.length)
      const taskDigests = new Set<string>()
      for (const trialName of trialNames) {
        const result = JSON.parse(readFileSync(join(job, trialName, 'result.json'), 'utf8'))
        const locked = lock.trials.find((trial: any) => trial.task.name === result.task_name)
        expect(result.task_checksum).toBe(locked?.task.digest)
        taskDigests.add(result.task_checksum)
        expect(Object.keys(result)).toEqual(
          expect.arrayContaining([
            'id',
            'task_name',
            'trial_name',
            'trial_uri',
            'task_id',
            'task_checksum',
            'config',
            'agent_info',
            'verifier_result',
            'exception_info',
            'started_at',
            'finished_at'
          ])
        )
        expect(Object.keys(result.config)).toEqual(expect.arrayContaining(['task', 'agent', 'environment', 'verifier']))
        expect(result.config.task).toEqual({ path: `tasks/${result.task_name}` })
        expect(readFileSync(join(job, trialName, 'verifier', 'reward.txt'), 'utf8')).toBeDefined()
      }
      expect(taskDigests.size).toBe(trialNames.length)
    }
  })

  it('returns an early errored trial unavailable when no usage file was written', () => {
    const job = copyJob()
    expect(read(job).trials.error?.[0]).toMatchObject({
      success: false,
      unavailableReason: 'RuntimeError: agent exited before grading',
      usage: { inputTokens: 0, outputTokens: 0, subscriptionQuota: null, estimatedCostUsd: 0 }
    })
  })

  it('resolves a native relative task path from Harbor’s original working directory', () => {
    const job = copyJob()
    const root = join(job, '..', 'harbor-working-directory')
    cpSync(join(job, 'tasks'), join(root, 'tasks'), { recursive: true })
    const task = join(root, 'tasks', suite, 'success')
    cpSync(join(job, 'tasks', 'success'), task, { recursive: true })
    for (const file of ['config.json', 'lock.json']) {
      const path = join(job, 'success__trial', file)
      const record = JSON.parse(readFileSync(path, 'utf8'))
      record.task.path = `tasks/${suite}/success`
      writeFileSync(path, JSON.stringify(record))
    }
    const jobLockPath = join(job, 'lock.json')
    const jobLock = JSON.parse(readFileSync(jobLockPath, 'utf8'))
    jobLock.trials[0].task.path = `tasks/${suite}/success`
    writeFileSync(jobLockPath, JSON.stringify(jobLock))
    const resultPath = join(job, 'success__trial', 'result.json')
    const result = JSON.parse(readFileSync(resultPath, 'utf8'))
    result.task_id.path = `tasks/${suite}/success`
    writeFileSync(resultPath, JSON.stringify(result))
    rmSync(join(job, 'tasks', 'success'), { recursive: true })
    expect(read(job, root).trials.success?.[0]?.success).toBe(true)
  })

  it('defaults relative native task paths to the reader process working directory, not the job directory', () => {
    const job = copyJob()
    expect(() => readHarborJob({ jobDirectory: job, suite, ...practice, subscriptionAuth: true, bootstrap })).toThrow(
      HarborResultsRefused
    )
    expect(read(job, job).trials.success?.[0]?.success).toBe(true)
  })

  it('refuses another Harbor version', () => {
    const job = copyJob()
    const path = join(job, 'lock.json')
    const lock = JSON.parse(readFileSync(path, 'utf8'))
    lock.harbor.version = '0.23.0'
    writeFileSync(path, JSON.stringify(lock))
    refusal(job, 'unsupported_harbor_version')
  })

  it('refuses more than one trial per task', () => {
    const job = copyJob()
    cpSync(join(job, 'success__trial'), join(job, 'success__second'), { recursive: true })
    refusal(job, 'wrong_trial_count')
  })

  describe('the declared result', () => {
    const freezeTrials = JSON.parse(readFileSync(join(import.meta.dir, 'freeze-record.json'), 'utf8'))
      .trialsPerTask as number

    /** A copy of the fixture job with `count` trials of each task, each its own trial directory and lock entry. */
    function jobWithTrials(count: number, only?: string): string {
      const job = copyJob()
      const lockPath = join(job, 'lock.json')
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
      for (const task of ['success', 'failure', 'error']) {
        if (only !== undefined && task !== only) continue
        for (let attempt = 2; attempt <= count; attempt++) {
          const name = `${task}__trial${attempt}`
          cpSync(join(job, `${task}__trial`), join(job, name), { recursive: true })
          for (const file of ['config.json', 'result.json']) {
            const path = join(job, name, file)
            writeFileSync(path, readFileSync(path, 'utf8').replaceAll(`"${task}__trial"`, `"${name}"`))
          }
          lock.trials.push(lock.trials.find((trial: any) => trial.task.name === task))
        }
      }
      writeFileSync(lockPath, JSON.stringify(lock))
      return job
    }

    function printed(job: string, flags: string[]): any {
      const out = join(job, '..', 'report.json')
      expect(
        harborResultsMain([
          job,
          '--suite',
          suite,
          '--subscription-auth',
          ...flags,
          '--bootstrap',
          'percentile',
          '--seed',
          '1',
          '--resamples',
          '100',
          '--confidence',
          '0.95',
          '--task-root',
          job,
          '--out',
          out
        ])
      ).toBe(0)
      return JSON.parse(readFileSync(out, 'utf8'))
    }

    function refusedWith(options: Partial<Parameters<typeof readHarborJob>[0]>, job: string, message: RegExp) {
      expect(() =>
        readHarborJob({
          jobDirectory: job,
          taskRoot: job,
          suite,
          ...practice,
          subscriptionAuth: true,
          bootstrap,
          ...options
        })
      ).toThrow(expect.objectContaining({ code: 'wrong_trial_count', message: expect.stringMatching(message) }))
    }

    it('prints one recorded job as each split, backend, adapter and trials per task it is given', () => {
      const job = jobWithTrials(freezeTrials)
      for (const [split, backend, adapter] of [
        ['held-out', 'standalone', 'claude-code'],
        ['held-out', 'engine', 'codex'],
        ['development', 'engine', 'claude-code'],
        ['development', 'standalone', 'codex']
      ] as const) {
        const report = printed(job, [
          '--result-kind',
          'scored',
          '--split',
          split,
          '--backend',
          backend,
          '--adapter',
          adapter,
          '--trials-per-task',
          String(freezeTrials)
        ])
        expect(report).toMatchObject({ purpose: 'scored', split, backend, trialsPerTask: freezeTrials })
        const run = report.runs[0]
        expect(run).toMatchObject({ suite, split, backend, adapter, trialsPerTask: freezeTrials, taskCount: 3 })
        expect(run.evidence).toBeUndefined()
        expect(run.tasks.map((task: any) => [task.taskId, task.successes, task.trials])).toEqual([
          ['error', 0, freezeTrials],
          ['failure', 0, freezeTrials],
          ['success', freezeTrials, freezeTrials]
        ])
      }
      expect(printed(copyJob(), practiceFlags)).toMatchObject({
        purpose: 'practice',
        split: 'development',
        backend: 'standalone',
        trialsPerTask: 1,
        runs: [{ adapter: 'claude-code', trialsPerTask: 1, evidence: 'never' }]
      })
    })

    it('refuses a job whose trial count is not one per task for a practice run, naming both counts', () => {
      refusedWith({}, jobWithTrials(freezeTrials), new RegExp(`${freezeTrials} trials .* expects exactly 1$`))
      refusedWith({ trialsPerTask: freezeTrials }, copyJob(), /a practice run carries exactly 1 trial per task/)
    })

    it("refuses a job whose trial count is not the freeze record's on every task for a scored result", () => {
      const scored = {
        resultKind: 'scored',
        split: 'held-out',
        trialsPerTask: freezeTrials,
        freezeTrialsPerTask: freezeTrials
      } as const
      refusedWith(scored, copyJob(), new RegExp(`1 trials .* expects exactly ${freezeTrials}$`))
      refusedWith(scored, jobWithTrials(freezeTrials, 'success'), new RegExp(`expects exactly ${freezeTrials}$`))
    })

    it("refuses a scored read whose trials per task differ from the committed freeze record's", () => {
      const job = jobWithTrials(2)
      refusedWith(
        { resultKind: 'scored', split: 'held-out', trialsPerTask: 2, freezeTrialsPerTask: freezeTrials },
        job,
        new RegExp(`freeze record's ${freezeTrials} trials per task, not 2`)
      )
      const flags = ['--result-kind', 'scored', '--split', 'held-out', '--backend', 'standalone', '--adapter', 'codex']
      const main = (more: string[]): [number, string] => {
        const errors: string[] = []
        const write = process.stderr.write
        process.stderr.write = ((chunk: string) => errors.push(chunk) > 0) as typeof process.stderr.write
        try {
          const args = [job, '--suite', suite, '--subscription-auth', ...flags, ...more]
          return [harborResultsMain([...args, '--bootstrap', 'percentile', '--task-root', job]), errors.join('')]
        } finally {
          process.stderr.write = write
        }
      }
      // The committed freeze record's trials per task bind a scored read.
      expect(main(['--trials-per-task', '2'])).toEqual([
        2,
        `wrong_trial_count: a scored result carries the freeze record's ${freezeTrials} trials per task, not 2\n`
      ])
      // No declared input is inferred: a read missing one is refused.
      expect(main([])[1]).toContain('--trials-per-task are required')
    })
  })

  it('refuses an incomplete job instead of reporting a biased practice mean', () => {
    const job = copyJob()
    rmSync(join(job, 'failure__trial'), { recursive: true })
    refusal(job, 'invalid_input')
  })

  it('binds the trial lock task digest to the job lock and ignores the result task checksum', () => {
    const job = copyJob()
    const resultPath = join(job, 'success__trial', 'result.json')
    const result = JSON.parse(readFileSync(resultPath, 'utf8'))
    result.task_checksum = '055bdbe8453e2a2e913d13878e71c234680129607c86c0d9a909adc12b871277'
    writeFileSync(resultPath, JSON.stringify(result))
    expect(read(job).trials.success?.[0]?.success).toBe(true)
    const lockPath = join(job, 'success__trial', 'lock.json')
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    lock.task.digest = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    writeFileSync(lockPath, JSON.stringify(lock))
    refusal(job, 'invalid_input')
  })

  it('refuses a trial whose agent or model differs from the job identity', () => {
    for (const [file, mutate] of [
      ['config.json', (record: any) => (record.agent.model_name = 'different-model')],
      ['config.json', (record: any) => (record.agent.name = 'vinaya')],
      ['lock.json', (record: any) => (record.agent.name = 'different-agent')],
      ['lock.json', (record: any) => (record.agent.model_name = 'different-model')],
      ['result.json', (record: any) => (record.agent_info.model_info.name = 'different-model')]
    ] as const) {
      const job = copyJob()
      const path = join(job, 'success__trial', file)
      const record = JSON.parse(readFileSync(path, 'utf8'))
      mutate(record)
      writeFileSync(path, JSON.stringify(record))
      refusal(job, 'invalid_input')
    }
  })

  it('refuses an absolute locked task path outside the declared task root', () => {
    const job = copyJob()
    const outsideTask = join(job, '..', 'outside-task')
    cpSync(join(job, 'tasks', 'success'), outsideTask, { recursive: true })
    const path = join(job, 'lock.json')
    const lock = JSON.parse(readFileSync(path, 'utf8'))
    lock.trials[0].task.path = outsideTask
    writeFileSync(path, JSON.stringify(lock))
    for (const file of ['config.json', 'lock.json', 'result.json']) {
      const trialPath = join(job, 'success__trial', file)
      const record = JSON.parse(readFileSync(trialPath, 'utf8'))
      if (file === 'result.json') record.task_id.path = outsideTask
      else record.task.path = outsideTask
      writeFileSync(trialPath, JSON.stringify(record))
    }
    refusal(job, 'missing_task_metadata')
  })

  it('accepts an absolute task path inside the declared task root', () => {
    const job = copyJob()
    const absoluteTask = join(job, 'tasks', 'success')
    const jobLockPath = join(job, 'lock.json')
    const jobLock = JSON.parse(readFileSync(jobLockPath, 'utf8'))
    jobLock.trials[0].task.path = absoluteTask
    writeFileSync(jobLockPath, JSON.stringify(jobLock))
    for (const file of ['config.json', 'lock.json', 'result.json']) {
      const path = join(job, 'success__trial', file)
      const record = JSON.parse(readFileSync(path, 'utf8'))
      if (file === 'result.json') record.task_id.path = absoluteTask
      else record.task.path = absoluteTask
      writeFileSync(path, JSON.stringify(record))
    }
    expect(read(job).trials.success?.[0]?.success).toBe(true)
  })

  it('refuses trials from more than one suite', () => {
    const job = copyJob()
    const path = join(job, 'tasks', 'error', 'task.toml')
    writeFileSync(path, readFileSync(path, 'utf8').replace(suite, 'security-reviewer-quality-neutral.l5'))
    refusal(job, 'mixed_suites')
  })

  it('refuses a task without converter task metadata', () => {
    const job = copyJob()
    rmSync(join(job, 'tasks', 'error', 'task.toml'))
    refusal(job, 'missing_task_metadata')
  })

  it('prints the expected report byte for byte and writes an optional output file', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'vinaya-harbor-report-')), 'report.json')
    scratch.push(join(out, '..'))
    expect(
      harborResultsMain([
        join(fixtures, 'vinaya'),
        '--suite',
        suite,
        '--subscription-auth',
        ...practiceFlags,
        '--bootstrap',
        'percentile',
        '--seed',
        '1',
        '--resamples',
        '100',
        '--confidence',
        '0.95',
        '--task-root',
        join(fixtures, 'vinaya'),
        '--out',
        out
      ])
    ).toBe(0)
    expect(readFileSync(out)).toEqual(readFileSync(join(fixtures, 'expected-report.txt')))
  })

  describe('a real Harbor 0.24.0 job of the vinaya agent', () => {
    const realJob = join(fixtures, 'vinaya-real-0.24')
    const realSuite = 'code-reviewer-quality-neutral.l5@1'
    const main = (job: string) =>
      harborResultsMain([
        job,
        '--suite',
        realSuite,
        '--subscription-auth',
        ...practiceFlags,
        '--bootstrap',
        'percentile',
        '--seed',
        '1',
        '--resamples',
        '100',
        '--confidence',
        '0.95',
        '--task-root',
        job
      ])
    function copyRealJob(): string {
      const root = mkdtempSync(join(tmpdir(), 'vinaya-harbor-real-'))
      scratch.push(root)
      const job = join(root, 'job')
      cpSync(realJob, job, { recursive: true })
      return job
    }
    function mutateTrialLock(mutate: (lock: any) => void): string {
      const job = copyRealJob()
      const path = join(job, 'code-clean__9Zd3QD4', 'lock.json')
      const lock = JSON.parse(readFileSync(path, 'utf8'))
      mutate(lock)
      writeFileSync(path, JSON.stringify(lock))
      return job
    }

    it('reads with exit 0 under the suite id its task.toml carries and its task root', () => {
      const out: string[] = []
      const write = process.stdout.write
      process.stdout.write = ((chunk: string) => out.push(chunk) > 0) as typeof process.stdout.write
      try {
        expect(main(realJob)).toBe(0)
      } finally {
        process.stdout.write = write
      }
      const report = JSON.parse(out.join(''))
      expect(report.runs[0]).toMatchObject({ suite: realSuite, agent: 'vinaya', model: 'claude-opus-5-5', mean: 1 })
      expect(report.runs[0].tasks.map((task: any) => task.taskId)).toEqual(['code-clean', 'code-contract'])
      // Its usage files predate the cache fields, so both read as 0.
      expect(report.runs[0].usage).toMatchObject({ cacheReadTokens: 0, cacheCreationTokens: 0 })
    })

    it('reports the cache tokens a usage file carries, per trial and summed', () => {
      const job = copyRealJob()
      const cache: Record<string, { cacheReadTokens: number; cacheCreationTokens: number }> = {
        'code-clean__9Zd3QD4': { cacheReadTokens: 41_000, cacheCreationTokens: 3_200 },
        'code-contract__h3AQcdj': { cacheReadTokens: 52_500, cacheCreationTokens: 1_100 }
      }
      for (const [trial, fields] of Object.entries(cache)) {
        const path = join(job, trial, 'agent', 'vinaya-usage.json')
        writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...fields }))
      }
      const output = readHarborJob({
        jobDirectory: job,
        taskRoot: job,
        suite: realSuite as any,
        ...practice,
        subscriptionAuth: true,
        bootstrap
      })
      expect(output.trials['code-clean']?.[0]?.usage).toMatchObject({
        cacheReadTokens: 41_000,
        cacheCreationTokens: 3_200
      })
      expect(output.trials['code-contract']?.[0]?.usage).toMatchObject({
        cacheReadTokens: 52_500,
        cacheCreationTokens: 1_100
      })
      expect(output.result.runs[0]?.usage).toMatchObject({ cacheReadTokens: 93_500, cacheCreationTokens: 4_300 })
    })

    it('refuses a trial lock whose agent name differs from the job lock', () => {
      const job = mutateTrialLock((lock) => (lock.agent.name = 'vinaya'))
      expect(main(job)).toBe(2)
      expect(() =>
        readHarborJob({
          jobDirectory: job,
          taskRoot: job,
          suite: realSuite as any,
          ...practice,
          subscriptionAuth: true,
          bootstrap
        })
      ).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    })

    it('refuses a trial lock whose task digest differs from the job lock', () => {
      const job = mutateTrialLock(
        (lock) => (lock.task.digest = 'sha256:4c99c99db5edadf74d8ea7c79405b86c1ab9834ddb24f94a411916bc60cf3c90')
      )
      expect(main(job)).toBe(2)
      expect(() =>
        readHarborJob({
          jobDirectory: job,
          taskRoot: job,
          suite: realSuite as any,
          ...practice,
          subscriptionAuth: true,
          bootstrap
        })
      ).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    })
  })

  it('contains none of the forbidden feasibility-job material', () => {
    const files: string[] = []
    const visit = (directory: string) => {
      for (const entry of new Bun.Glob('**/*').scanSync({ cwd: directory, onlyFiles: true })) files.push(entry)
    }
    visit(fixtures)
    const body = files.map((path) => readFileSync(join(fixtures, path), 'utf8')).join('\n')
    expect(body).not.toMatch(/\/Users\//)
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)
    expect(body).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)
    expect(body).not.toMatch(/mcp/i)
    expect(files.some((path) => /trajectory|session/i.test(path))).toBe(false)
  })
})
