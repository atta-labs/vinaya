/**
 * What made Harbor practice trials of the `vinaya` agent reward `0` or fail
 * before grading, proved with no Docker and no model:
 *
 *  - step one's trace reader drops Claude Code's harness-internal tools, so
 *    the real traces of `vinaya-trial-traces.json` grade on their neutral
 *    capabilities alone, and a web fetch fails as an ungranted `read_web`;
 *  - the reviewer suite rebuilds every git-sourced patch to its pinned digest
 *    in a depth-1, blob-less clone, the case repository a task image holds;
 *  - a task image installs the Vinaya CLI's dependencies at build, and the
 *    agent's install step only checks the archive's digest;
 *  - a `change` trial's Developer is told what the review loop tells it, and
 *    a pull request is recorded only when the Developer opened one.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishingInstructionLine } from '../../src/lib/dev-review-loop'
import { type GradingSpec, gradeTrial, measureChange, splitRecord } from '../../src/lib/dev-review-eval/harbor-grade'
import {
  ARCHIVE_DIGEST_PATH,
  ARCHIVE_FILE,
  CHANGE_CASE_INSTALL,
  REPOSITORY_ROOT,
  taskFiles,
  VINAYA_HOME
} from '../../src/lib/dev-review-eval/harbor-tasks'
import { type HarborCaseFile, runHarborTrial } from '../../src/lib/dev-review-eval/harbor-trial'
import type { NeutralCase } from '../../src/lib/dev-review-eval/neutral-case'
import {
  CLAUDE_HARNESS_INTERNAL_TOOLS,
  layerGTrace,
  layerGTraceOf,
  PRODUCTION_VINAYA_PROCESS_STEPS,
  type VinayaProcessSteps
} from '../../src/lib/dev-review-eval/step-one'
import { renderCase, type VinayaTrialRecord } from '../../src/lib/dev-review-eval/vinaya-renderer'
import { claudeDevToolName } from '../../src/lib/task-tools/dev-tools-registration'
import type { DevToolContext } from '../../src/lib/task-tools/dev-tools-server'
import { DEV_TOOL_NAMES } from '../../src/lib/task-tools/tool-catalog'
import { stripVinayaEnv } from '../lib/process-fixture'
import { loadCaseFile as loadDeveloperCaseFile } from './developer-capability-suite'
import { developmentCases, type GenericSuiteKey, referenceEntry } from './generic-suites'
import { GENERIC_SUITE_IDS } from './recut-generic-cases'
import { loadDevelopment, patchBytes, type ReviewCase } from './reviewer-quality-suite'
import { loadCaseFile as loadCitationCaseFile } from './source-citation-suite'
import { claudeTrace } from './tool-selection-suite'
import { KNOWN_BAD_VARIANTS, referenceRecord } from './vinaya-trial-records'

const FIXTURE = join(import.meta.dir, 'fixtures', 'harbor-jobs', 'vinaya-trial-traces.json')
const AGENT_FILE = join(REPOSITORY_ROOT, 'apps/cli/src/lib/dev-review-eval/vinaya_harbor_agent.py')

const temporary: string[] = []
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

// Removing the clones outlasts the default hook budget.
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
}, 120_000)

function run(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    env: stripVinayaEnv(options.env ?? process.env),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 300_000,
    killSignal: 'SIGKILL'
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function git(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  const result = run('git', args, { cwd, ...(env === undefined ? {} : { env }) })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

/** A Claude Code `stream-json` transcript calling `tools` in order, each traced name as Claude Code names it. */
function claudeTranscript(tools: readonly string[]): string[] {
  return tools.map((tool, i) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: `call-${i}`,
            name:
              tool === 'shell'
                ? 'Bash'
                : DEV_TOOL_NAMES.includes(tool) || tool === 'read_source'
                  ? claudeDevToolName(tool)
                  : tool,
            input: tool === 'shell' ? { command: 'true' } : {}
          }
        ]
      }
    })
  )
}

/** Each fixture trial's kind, the case of that kind it ran on, and the capabilities it used that its case does not grant. */
const TRIALS = [
  { kind: 'change', key: 'developer', caseId: 'pr-1003', ungranted: [] },
  // The reviewer ran two shell commands, and a review case grants only `read_file`: a genuine agent result.
  { kind: 'review', key: 'codeReviewer', caseId: 'code-contract', ungranted: ['run_commands'] },
  { kind: 'answer', key: 'sourceCitation', caseId: 'dev-correct-citation', ungranted: [] }
] as const satisfies readonly {
  kind: NeutralCase['kind']
  key: GenericSuiteKey
  caseId: string
  ungranted: readonly string[]
}[]

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  schemaVersion: 1
  trials: { kind: NeutralCase['kind']; trace: string[] }[]
}

function referenceFor(key: GenericSuiteKey, caseId: string) {
  const c = developmentCases(key).find((entry) => entry.id === caseId)
  if (c === undefined) throw new Error(`no development case ${caseId}`)
  const developer = c.kind === 'change' ? loadDeveloperCaseFile().cases.find((p) => p.id === caseId) : undefined
  const entry = referenceEntry(key, c, developer)
  const rendered = renderCase(c)
  if (!rendered.ok) throw new Error(`${caseId} does not render`)
  const spec: GradingSpec = { schemaVersion: 1, suite: GENERIC_SUITE_IDS[key], case: c, testFiles: [] }
  return { entry, spec, record: referenceRecord(entry, rendered.input) }
}

async function grade(spec: GradingSpec, record: VinayaTrialRecord) {
  const { agent, measured } = splitRecord(record)
  return gradeTrial(spec, agent, measured)
}

describe('the real trial traces, read through step one', () => {
  it('holds one trace per case kind, tool names alone', () => {
    expect(fixture.schemaVersion).toBe(1)
    expect(fixture.trials.map((trial) => trial.kind)).toEqual(TRIALS.map((trial) => trial.kind))
    for (const trial of fixture.trials) {
      expect(Object.keys(trial).sort()).toEqual(['kind', 'trace'])
      for (const tool of trial.trace) expect(tool).toMatch(/^[A-Za-z_]+$/)
    }
  })

  for (const { kind, key, caseId, ungranted } of TRIALS) {
    it(`grades a ${kind} reference carrying the real ${kind} trace on its neutral capabilities alone`, async () => {
      const real = fixture.trials.find((trial) => trial.kind === kind)?.trace ?? []
      // The real trace carries Claude Code's own harness tools, which made the capability outcome invalid.
      expect(real.some((tool) => CLAUDE_HARNESS_INTERNAL_TOOLS.includes(tool))).toBe(true)
      const { entry, spec, record } = referenceFor(key, caseId)
      const trace = await layerGTraceOf('claude-code', claudeTranscript(real))
      expect(trace.map((call) => call.tool)).toEqual(
        real.filter((tool) => !CLAUDE_HARNESS_INTERNAL_TOOLS.includes(tool))
      )
      const withTrace: VinayaTrialRecord = { ...record, trace: trace.map((call) => ({ tool: call.tool })) }

      const graded = await grade(spec, withTrace)
      expect(graded.reason).toBeNull()
      for (const [id, verdict] of Object.entries(graded.verdicts)) {
        if (id === 'generic-capabilities-granted' && ungranted.length > 0) {
          expect(verdict.verdict).toBe('fail')
          expect(verdict.reason).toBe(ungranted.map((used) => `capability ${used} was not granted`).join('; '))
        } else {
          expect({ id, ...verdict }).toEqual({ id, verdict: 'pass' })
        }
      }
      expect(graded.reward).toBe(ungranted.length === 0 ? 1 : 0)

      // A web fetch is an ungranted `read_web`, never an invalid capability outcome.
      const fetched = await layerGTraceOf('claude-code', claudeTranscript([...real, 'WebFetch']))
      const web = await grade(spec, { ...record, trace: fetched.map((call) => ({ tool: call.tool })) })
      expect(web.reason).toBeNull()
      expect(web.reward).toBe(0)
      expect(web.verdicts['generic-capabilities-granted']?.verdict).toBe('fail')
      expect(web.verdicts['generic-capabilities-granted']?.reason).toContain('capability read_web was not granted')
      expect(web.verdicts['generic-capabilities-granted']?.reason).not.toContain('invalid')

      let planted = 0
      for (const variant of KNOWN_BAD_VARIANTS) {
        const bad = variant.plant(withTrace, entry)
        if (bad === null) continue
        planted++
        const badGrade = await grade(spec, bad)
        expect(badGrade.reward).toBe(0)
        expect(badGrade.verdicts[variant.graderId]?.verdict).toBe('fail')
      }
      expect(planted).toBeGreaterThan(0)
    })
  }

  it("leaves the layer-P Claude reader's calls whole, and a Codex trace unchanged", async () => {
    const lines = claudeTranscript(['ToolSearch', 'Read', 'TodoWrite', 'StructuredOutput'])
    expect(claudeTrace(lines).map((call) => call.tool)).toEqual(['ToolSearch', 'Read', 'TodoWrite', 'StructuredOutput'])
    expect((await layerGTraceOf('claude-code', lines)).map((call) => call.tool)).toEqual(['Read'])
    const codex = [{ tool: 'StructuredOutput', args: {} }]
    expect(layerGTrace('codex', codex)).toEqual(codex)
  })
})

describe('the reviewer suite in a depth-1, blob-less clone', () => {
  it('rebuilds every git-sourced reviewer patch to its pinned digest', () => {
    const mirror = tempDir('harbor-practice-mirror-')
    git(mirror, ['init', '--quiet', '--bare'])
    const objects = join(
      git(REPOSITORY_ROOT, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(),
      'objects'
    )
    writeFileSync(join(mirror, 'objects', 'info', 'alternates'), `${objects}\n`)
    git(mirror, ['config', 'uploadpack.allowFilter', 'true'])
    git(mirror, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])
    const cases: ReviewCase[] = [
      ...loadDevelopment('code-reviewer').cases,
      ...loadDevelopment('security-reviewer').cases
    ].filter((item) => item.patch.source === 'git')
    expect(cases.length).toBe(7)
    for (const item of cases) {
      if (item.patch.source !== 'git') continue
      const clone = join(tempDir('harbor-practice-clone-'), 'app')
      git(REPOSITORY_ROOT, ['init', '--quiet', clone])
      git(clone, ['remote', 'add', 'origin', `file://${mirror}`])
      for (const commit of [item.patch.parentCommit, item.patch.changedCommit])
        git(clone, ['fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', commit])
      expect(git(clone, ['rev-parse', '--is-shallow-repository']).trim()).toBe('true')
      // The reviewer suite reads the case repository through `GIT_DIR`, as a Harbor trial points it.
      const priorGitDir = process.env.GIT_DIR
      process.env.GIT_DIR = join(clone, '.git')
      try {
        // `patchBytes` refuses any patch whose bytes do not hash to the pinned digest.
        expect(patchBytes(item).length).toBeGreaterThan(0)
      } finally {
        if (priorGitDir === undefined) delete process.env.GIT_DIR
        else process.env.GIT_DIR = priorGitDir
      }
    }
  }, 600_000)
})

describe('the Vinaya CLI installed at image build', () => {
  const citation = loadCitationCaseFile().cases.find((entry) => entry.id === 'dev-correct-citation')
  const answer = developmentCases('sourceCitation').find((entry) => entry.id === 'dev-correct-citation')
  const sources = { key: 'sourceCitation' as const, case: answer as NeutralCase, statement: 'Answer it.', citation }
  const url = (repository: string) => `https://example.invalid/${repository}.git`

  it('unpacks the archive at /opt/vinaya and installs its dependencies at build, recording its digest', () => {
    const archive = new TextEncoder().encode('archive bytes')
    const files = taskFiles(sources, '', url, archive)
    expect(files.get(`environment/${ARCHIVE_FILE}`)?.content).toEqual(archive)
    const dockerfile = String(files.get('environment/Dockerfile')?.content)
    expect(dockerfile).toContain(`\nCOPY ${ARCHIVE_FILE} /harbor/${ARCHIVE_FILE}\n`)
    const install = dockerfile.split('\n').find((line) => line.includes(`tar -xf /harbor/${ARCHIVE_FILE}`)) as string
    expect(install.startsWith('RUN ')).toBe(true)
    expect(install).toContain(`-C ${VINAYA_HOME}`)
    expect(install).toContain(`(cd ${VINAYA_HOME} && ${CHANGE_CASE_INSTALL})`)
    expect(install).toContain(`> ${ARCHIVE_DIGEST_PATH}`)
    expect(VINAYA_HOME).toBe('/opt/vinaya')
  })

  it('builds a task converted without the archive with no Vinaya CLI', () => {
    const files = taskFiles(sources, '', url)
    expect(files.has(`environment/${ARCHIVE_FILE}`)).toBe(false)
    expect(String(files.get('environment/Dockerfile')?.content)).not.toContain(VINAYA_HOME)
    expect(files.has('solution/solve.sh')).toBe(true)
  })

  it("runs no install or network step in the agent's install, and refuses an archive the image did not install", () => {
    const agent = readFileSync(AGENT_FILE, 'utf8')
    expect(agent).not.toContain('bun install')
    expect(agent).not.toMatch(/\b(curl|wget|npm install|git fetch|git clone)\b/)
    const work = tempDir('harbor-practice-agent-')
    const bin = join(work, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho claude-fake\n', { mode: 0o755 })
    const archive = join(work, 'vinaya.tar')
    const recorded = join(work, 'vinaya-archive.sha256')
    const printed = run(
      'python3',
      [
        '-c',
        [
          'import sys, types',
          'from pathlib import PurePosixPath',
          "for name in ['harbor', 'harbor.agents', 'harbor.agents.installed', 'harbor.agents.installed.base', 'harbor.environments', 'harbor.environments.base', 'harbor.models', 'harbor.models.agent', 'harbor.models.agent.context']: sys.modules[name] = types.ModuleType(name)",
          "sys.modules['harbor.agents.installed.base'].BaseInstalledAgent = object",
          "sys.modules['harbor.environments.base'].BaseEnvironment = object",
          "sys.modules['harbor.models.agent.context'].AgentContext = object",
          'sys.path.insert(0, sys.argv[1])',
          'import vinaya_harbor_agent as agent',
          'print(agent.install_command(PurePosixPath(sys.argv[2]), PurePosixPath(sys.argv[3])))'
        ].join('\n'),
        join(REPOSITORY_ROOT, 'apps/cli/src/lib/dev-review-eval'),
        archive,
        recorded
      ],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
    )
    expect(printed.stderr).toBe('')
    const command = printed.stdout.trim()
    expect(command).not.toContain('bun install')
    const install = () =>
      run('sh', ['-c', command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } })

    writeFileSync(archive, 'archive bytes')
    const unconverted = install()
    expect(unconverted.status).not.toBe(0)
    expect(unconverted.stderr).toContain('--archive')

    writeFileSync(recorded, `${'0'.repeat(64)}\n`)
    const differs = install()
    expect(differs.status).not.toBe(0)
    expect(differs.stderr).toContain('differs from the one the task image installed')

    const digest = new Bun.CryptoHasher('sha256').update(readFileSync(archive)).digest('hex')
    writeFileSync(recorded, `${digest}\n`)
    const matches = install()
    expect(matches.stderr).toBe('')
    expect(matches.status).toBe(0)
    expect(matches.stdout).toContain('claude-fake')
  })
})

describe("a change trial's publishing instruction and its pull request", () => {
  it('imports the review loop’s one publishing instruction, defined once at module level', () => {
    const loop = readFileSync(join(REPOSITORY_ROOT, 'apps/cli/src/lib/dev-review-loop.ts'), 'utf8')
    expect(loop.match(/function publishingInstructionLine\(/g)?.length).toBe(1)
    expect(loop).toContain('\nexport function publishingInstructionLine(): string {\n')
    expect(loop.match(/publishingInstructionLine\(\)/g)?.length).toBeGreaterThan(1)
    const stepOne = readFileSync(join(REPOSITORY_ROOT, 'apps/cli/src/lib/dev-review-eval/step-one.ts'), 'utf8')
    expect(stepOne).toContain("import { publishingInstructionLine } from '../dev-review-loop'")
    expect(stepOne).not.toContain(publishingInstructionLine())
  })

  const caseId = 'pr-1003'
  const c = developmentCases('developer').find((entry) => entry.id === caseId) as Extract<
    NeutralCase,
    { kind: 'change' }
  >
  const developer = loadDeveloperCaseFile().cases.find((entry) => entry.id === caseId)

  /** A working tree of this repository at the case's base commit, as a task image's `/app` holds it. */
  function treeAtBase(): string {
    const common = git(REPOSITORY_ROOT, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
    const tree = join(tempDir('harbor-practice-tree-'), 'app')
    git(REPOSITORY_ROOT, ['clone', '--quiet', '--shared', '--no-checkout', common, tree])
    git(tree, ['checkout', '--quiet', '--detach', c.baseRevision])
    return tree
  }

  function fakeDeveloper(opensPullRequest: boolean, prompts: string[]): VinayaProcessSteps {
    let world: { context: DevToolContext } | null = null
    const transcript = claudeTranscript([
      'ToolSearch',
      'shell',
      'Write',
      'publish_changes',
      ...(opensPullRequest ? ['open_pull_request'] : []),
      'StructuredOutput'
    ])
    return {
      ...PRODUCTION_VINAYA_PROCESS_STEPS,
      dispatch: async (_role, _agent, prompt, opts) => {
        prompts.push(prompt)
        if (world !== null) {
          writeFileSync(join(opts.cwd as string, 'apps/cli/src/lib/harbor-fake.ts'), 'export const fake = true\n')
          await world.context.publishChanges('Feat(cli): Add it')
          if (opensPullRequest) await world.context.openPullRequest('t', 'Closes #1\n\nThe change.')
        }
        for (const line of transcript) opts.observeStdoutLine?.(line)
        return {
          exitCode: 0,
          durationMs: 5,
          usage: { input: 3, output: 2 },
          resumeId: 's',
          timedOut: false,
          turnOutput: { raw: { turnResult: { status: 'completed' } } }
        } as never
      },
      startToolHost: async (opts) => {
        world = { context: opts.context }
        return { socketPath: opts.socketPath, close: async () => {} }
      }
    }
  }

  async function containerTrial(opensPullRequest: boolean) {
    if (developer === undefined) throw new Error(`no layer-P case ${caseId}`)
    const tree = treeAtBase()
    const work = tempDir('harbor-practice-trial-')
    const casePath = join(work, 'case.json')
    const file: HarborCaseFile = {
      schemaVersion: 1,
      suite: 'developer-capability-neutral.l5',
      case: c,
      counterpart: { kind: 'change', id: developer.id, pullRequest: developer.pullRequest }
    }
    writeFileSync(casePath, JSON.stringify(file))
    const recordPath = join(work, 'agent', 'vinaya-trial-record.json')
    const prompts: string[] = []
    const outcome = await runHarborTrial(
      {
        casePath,
        tree,
        recordPath,
        usagePath: join(work, 'agent', 'vinaya-usage.json'),
        backend: 'standalone',
        adapter: 'claude-code',
        model: 'claude-test-model',
        timeoutMs: 1000
      },
      fakeDeveloper(opensPullRequest, prompts)
    )
    expect(outcome).toEqual({ ok: true })
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as VinayaTrialRecord
    const measured = { measuredChange: measureChange(tree, c.baseRevision), hiddenTests: null }
    const spec: GradingSpec = { schemaVersion: 1, suite: GENERIC_SUITE_IDS.developer, case: c, testFiles: [] }
    return { tree, record, prompts, grade: await gradeTrial(spec, record, measured) }
  }

  it('ends the Developer prompt with the loop’s instruction, and records no pull request the Developer did not open', async () => {
    const { record, prompts, grade } = await containerTrial(false)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain(publishingInstructionLine())
    expect(prompts[0]?.endsWith(`When your work is ready, ${publishingInstructionLine()}`)).toBe(true)
    expect(record.pullRequest).toBeNull()
    // The trace leaves out Claude Code's harness tools; the published change is still one effect.
    expect(record.trace).toEqual([{ tool: 'shell' }, { tool: 'Write' }, { tool: 'publish_changes' }])
    expect(record.effects?.map((effect) => effect.kind)).toEqual(['publish_changes'])
    expect(grade.reason).toBeNull()
    expect(grade.reward).toBe(0)
    expect(grade.verdicts['generic-change-bound']?.verdict).toBe('fail')
    expect(grade.verdicts['generic-change-bound']?.reason).toContain('O-change is absent')
  }, 120_000)

  it('records the pull request the Developer opened, bound to its commit, and grades it', async () => {
    const { tree, record, prompts, grade } = await containerTrial(true)
    expect(prompts[0]?.endsWith(`When your work is ready, ${publishingInstructionLine()}`)).toBe(true)
    const head = git(tree, ['rev-parse', 'HEAD']).trim()
    expect(head).not.toBe(c.baseRevision)
    expect(record.pullRequest?.headSha).toBe(head)
    expect(record.pullRequest?.baseSha).toBe(c.baseRevision)
    expect(record.pullRequest?.diffDigest).toBe(measureChange(tree, c.baseRevision).patchDigest)
    expect(record.trace?.map((call) => call.tool)).toEqual(['shell', 'Write', 'publish_changes', 'open_pull_request'])
    expect(grade.reason).toBeNull()
    expect(grade.verdicts['generic-change-bound']?.verdict).toBe('pass')
  }, 120_000)
})
