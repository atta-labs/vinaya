/**
 * What made Harbor practice trials of the `vinaya` agent reward `0` or fail
 * before grading, proved with no Docker and no model:
 *
 *  - step one's trace reader drops Claude Code's harness-internal tools, so
 *    the real traces of `vinaya-trial-traces.json` grade reward `1` on their
 *    neutral capabilities alone, and a web fetch fails as an ungranted `read_web`;
 *  - the reviewer suite rebuilds every git-sourced patch to its pinned digest
 *    in a depth-1, blob-less clone, the case repository a task image holds;
 *  - a task image installs the Vinaya CLI's dependencies at build, and the
 *    agent's install step only checks the archive's digest;
 *  - a `change` trial's Developer is told what the review loop tells it, and
 *    a pull request is recorded only when the Developer opened one;
 *  - the verifier runs each hidden test file in a runner of its own and hands
 *    no runner a file that is not a test;
 *  - the image's non-root user owns what the `vinaya` agent's run reads and
 *    writes, and the run names no other path.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishingInstructionLine } from '../../src/lib/dev-review-loop'
import {
  type GradingSpec,
  gradeTrial,
  isTestFile,
  measureChange,
  runHiddenTests,
  splitRecord
} from '../../src/lib/dev-review-eval/harbor-grade'
import {
  ARCHIVE_DIGEST_PATH,
  ARCHIVE_FILE,
  CHANGE_CASE_INSTALL,
  REPOSITORY_ROOT,
  TASK_USER_HOME,
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
import { loadCaseFile as loadDeveloperCaseFile, runTests } from './developer-capability-suite'
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

/** Each fixture trial's kind and the case of that kind it ran on. */
const TRIALS = [
  { kind: 'change', key: 'developer', caseId: 'pr-1003' },
  // The reviewer read the change with two shell commands, which a review case grants as `run_commands`.
  { kind: 'review', key: 'codeReviewer', caseId: 'code-contract' },
  { kind: 'answer', key: 'sourceCitation', caseId: 'dev-correct-citation' }
] as const satisfies readonly { kind: NeutralCase['kind']; key: GenericSuiteKey; caseId: string }[]

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

  for (const { kind, key, caseId } of TRIALS) {
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
        expect({ id, ...verdict }).toEqual({ id, verdict: 'pass' })
      }
      expect(graded.reward).toBe(1)

      // A web fetch is an ungranted `read_web`, never an invalid capability outcome.
      const fetched = await layerGTraceOf('claude-code', claudeTranscript([...real, 'WebFetch']))
      const web = await grade(spec, { ...record, trace: fetched.map((call) => ({ tool: call.tool })) })
      expect(web.reason).toBeNull()
      expect(web.reward).toBe(0)
      expect(web.verdicts['generic-capabilities-granted']?.verdict).toBe('fail')
      expect(web.verdicts['generic-capabilities-granted']?.reason).toContain('capability read_web was not granted')
      expect(web.verdicts['generic-capabilities-granted']?.reason).not.toContain('invalid')

      // A reviewer runs shell commands to read the change, and still never writes it.
      if (kind === 'review') {
        const edited = await layerGTraceOf('claude-code', claudeTranscript([...real, 'Edit']))
        const wrote = await grade(spec, { ...record, trace: edited.map((call) => ({ tool: call.tool })) })
        expect(wrote.reward).toBe(0)
        expect(wrote.verdicts['generic-capabilities-granted']?.reason).toBe('capability write_file was not granted')
      }

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

/** Python lines that stand in for Harbor's modules, so the agent file imports without Harbor installed. */
const HARBOR_STUBS = [
  'import sys, types',
  "for name in ['harbor', 'harbor.agents', 'harbor.agents.installed', 'harbor.agents.installed.base', 'harbor.environments', 'harbor.environments.base', 'harbor.models', 'harbor.models.agent', 'harbor.models.agent.context']: sys.modules[name] = types.ModuleType(name)",
  "sys.modules['harbor.agents.installed.base'].BaseInstalledAgent = object",
  "sys.modules['harbor.environments.base'].BaseEnvironment = object",
  "sys.modules['harbor.models.agent.context'].AgentContext = object"
]

describe('the Harbor Codex subscription login', () => {
  it('feeds login only on stdin, cleans its bootstrap file, and runs with the tester Codex home alone', () => {
    const work = tempDir('harbor-codex-login-')
    const bin = join(work, 'bin')
    mkdirSync(bin)
    const audit = join(work, 'login.json')
    writeFileSync(
      join(bin, 'codex'),
      [
        '#!/usr/bin/env python3',
        'import json, os, sys',
        'from pathlib import Path',
        `Path(${JSON.stringify(audit)}).write_text(json.dumps({"argv": sys.argv[1:], "stdin": sys.stdin.read(), "env": dict(os.environ)}))`,
        'Path(os.environ["CODEX_HOME"], "auth.json").write_text("staged session")',
        ''
      ].join('\n'),
      { mode: 0o755 }
    )
    const printed = run(
      'python3',
      [
        '-c',
        [
          ...HARBOR_STUBS,
          'import asyncio, json, os, shutil, subprocess',
          'from pathlib import Path, PurePosixPath',
          'sys.path.insert(0, sys.argv[1])',
          'import vinaya_harbor_agent as module',
          'work = Path(sys.argv[2])',
          'module.CODEX_HOME = PurePosixPath(str(work / "home" / ".codex"))',
          'module.install_command = lambda: "true"',
          'agent = object.__new__(module.VinayaAgent)',
          'agent._adapter = "codex"',
          'agent._archive = work / "archive.tar"',
          'agent._archive.write_text("archive")',
          'agent.model_name = "codex-test-model"',
          'agent.environment_logs_dir = PurePosixPath("/logs/agent")',
          'calls, uploads = [], []',
          'class Environment:',
          '    async def upload_file(self, source, target):',
          '        if target == str(module.ARCHIVE_IN_CONTAINER): return',
          '        target = target.replace("/tmp/vinaya-codex-login-", str(work / "login-"))',
          '        uploads.append({"path": target, "mode": source.stat().st_mode & 0o777})',
          '        shutil.copyfile(source, target)',
          'async def root(environment, command, env=None, timeout_sec=None):',
          '    calls.append({"kind": "root", "command": command, "env": env})',
          '    command = command.replace("/tmp/vinaya-codex-login-", str(work / "login-"))',
          '    if command.startswith("chown "): return',
          '    result = subprocess.run(["sh", "-c", command], env={"PATH": os.environ["PATH"]}, capture_output=True)',
          '    if result.returncode: raise RuntimeError("container command failed")',
          'async def run_agent(environment, command, env=None):',
          '    calls.append({"kind": "agent", "command": command, "env": env})',
          'agent.exec_as_root = root',
          'agent.exec_as_agent = run_agent',
          'async def trial():',
          '    environment = Environment()',
          '    await agent.install(environment)',
          '    await agent.run("instruction", environment, None)',
          'asyncio.run(trial())',
          'print(json.dumps({"calls": calls, "uploads": uploads, "home": str(module.CODEX_HOME)}))'
        ].join('\n'),
        join(REPOSITORY_ROOT, 'apps/cli/src/lib/dev-review-eval'),
        work
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          PYTHONDONTWRITEBYTECODE: '1',
          CODEX_ACCESS_TOKEN: 'fake-subscription-token',
          OPENAI_API_KEY: 'never-forward',
          ANTHROPIC_API_KEY: 'never-forward',
          OTHER_API_KEY: 'never-forward'
        }
      }
    )
    expect(printed.stderr).toBe('')
    expect(printed.status).toBe(0)
    const result = JSON.parse(printed.stdout) as {
      calls: { kind: string; command: string; env: Record<string, string> | null }[]
      uploads: { path: string; mode: number }[]
      home: string
    }
    const login = JSON.parse(readFileSync(audit, 'utf8')) as {
      argv: string[]
      stdin: string
      env: Record<string, string>
    }
    expect(login.argv).toEqual(['login', '--with-access-token'])
    expect(login.stdin).toBe('fake-subscription-token')
    expect(login.env.CODEX_HOME).toBe(result.home)
    expect(login.env.CODEX_ACCESS_TOKEN).toBeUndefined()
    expect(Object.keys(login.env).some((key) => key.endsWith('API_KEY'))).toBe(false)
    expect(result.uploads).toHaveLength(1)
    for (const upload of result.uploads) {
      expect(upload.mode).toBe(0o600)
      expect(run('test', ['-e', upload.path]).status).not.toBe(0)
    }
    expect(result.calls.some((call) => call.command === `chown -R tester:tester ${result.home}`)).toBe(true)
    const agentCall = result.calls.find((call) => call.kind === 'agent')
    expect(agentCall?.command).toContain('--backend standalone --adapter codex --model codex-test-model')
    expect(agentCall?.env).toEqual({ HOME: TASK_USER_HOME, CODEX_HOME: result.home })
    for (const call of result.calls) {
      expect(call.command).not.toContain('fake-subscription-token')
      expect(call.env ?? {}).not.toHaveProperty('CODEX_ACCESS_TOKEN')
      expect(Object.keys(call.env ?? {}).some((key) => key.endsWith('API_KEY'))).toBe(false)
    }
  })

  it('refuses a missing Codex login before container access and rejects login or API-key agent-env flags', () => {
    const work = tempDir('harbor-codex-refused-')
    const printed = run(
      'python3',
      [
        '-c',
        [
          ...HARBOR_STUBS,
          'class Base:',
          '    def __init__(self, logs_dir, **kwargs): self.extra_env = kwargs.get("extra_env", {})',
          'sys.modules["harbor.agents.installed.base"].BaseInstalledAgent = Base',
          'import asyncio, json, os',
          'from pathlib import Path',
          'sys.path.insert(0, sys.argv[1])',
          'import vinaya_harbor_agent as module',
          'work = Path(sys.argv[2])',
          'archive = work / "archive.tar"',
          'archive.write_text("archive")',
          'os.environ.pop("CODEX_ACCESS_TOKEN", None)',
          'agent = module.VinayaAgent(work, archive=str(archive), adapter="codex")',
          'errors = []',
          'try: asyncio.run(agent.install(None))',
          'except RuntimeError as error: errors.append(str(error))',
          'for adapter in ("claude-code", "codex"):',
          '    for name in (*module.LOGIN_ENV, "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OTHER_API_KEY"):',
          '        try: module.VinayaAgent(work, archive=str(archive), adapter=adapter, extra_env={name: "secret"})',
          '        except ValueError: pass',
          '        else: raise AssertionError("accepted credential agent-env flag")',
          'print(json.dumps(errors))'
        ].join('\n'),
        join(REPOSITORY_ROOT, 'apps/cli/src/lib/dev-review-eval'),
        work
      ],
      {
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', OPENAI_API_KEY: 'not-a-login' }
      }
    )
    expect(printed.stderr).toBe('')
    expect(printed.status).toBe(0)
    const errors = JSON.parse(printed.stdout) as string[]
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('no Codex subscription login')
    expect(errors[0]).toContain('CODEX_ACCESS_TOKEN')
  })
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
    const probe = dockerfile.split('\n').find((line) => line.includes('checkLinuxCodexSandboxTools')) as string
    expect(probe).toContain(`RUN cd ${VINAYA_HOME} && bun -e `)
    expect(probe).toContain('from "./apps/cli/src/lib/worker-boundary.ts"')
    expect(probe).toContain('const tools = checkLinuxCodexSandboxTools()')
    expect(probe).toContain('if (!tools.available) throw new Error(')
    expect(dockerfile.indexOf(probe)).toBeGreaterThan(dockerfile.indexOf(install))
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
          ...HARBOR_STUBS,
          'from pathlib import PurePosixPath',
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

  it('gives the non-root user the Vinaya CLI after its install, and the case, the tree and the logs', () => {
    const lines = String(
      taskFiles(sources, '', url, new TextEncoder().encode('a')).get('environment/Dockerfile')?.content
    )
      .trimEnd()
      .split('\n')
    const install = lines.findIndex((line) => line.includes(`tar -xf /harbor/${ARCHIVE_FILE}`))
    const owned = lines.findIndex((line) => line.includes('chown -R tester:tester'))
    expect(install).toBeGreaterThan(-1)
    expect(owned).toBeGreaterThan(install)
    expect(lines[owned]).toContain(`chown -R tester:tester /app /case /logs ${VINAYA_HOME}`)
    expect(lines[owned]).toContain('mkdir -p /logs/agent /logs/verifier')
    expect(lines.slice(owned + 1)).toEqual([
      `ENV HOME=${TASK_USER_HOME}`,
      'USER tester',
      'ENV GIT_NO_LAZY_FETCH=1',
      'WORKDIR /app'
    ])
  })

  it("runs the agent as the image's user, in its home, naming only paths that user owns", () => {
    const printed = run(
      'python3',
      [
        '-c',
        [
          ...HARBOR_STUBS,
          'import asyncio, json, os',
          'from pathlib import PurePosixPath',
          'sys.path.insert(0, sys.argv[1])',
          'import vinaya_harbor_agent as module',
          'agent = object.__new__(module.VinayaAgent)',
          "agent.model_name = 'claude-test-model'",
          "agent.environment_logs_dir = PurePosixPath('/logs/agent')",
          'calls = []',
          'async def exec_as_agent(environment, command, env=None): calls.append({"command": command, "env": env})',
          'agent.exec_as_agent = exec_as_agent',
          "os.environ['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-token'",
          'asyncio.run(agent.run("instruction", None, None))',
          'print(json.dumps(calls))'
        ].join('\n'),
        join(REPOSITORY_ROOT, 'apps/cli/src/lib/dev-review-eval')
      ],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
    )
    expect(printed.stderr).toBe('')
    const calls = JSON.parse(printed.stdout) as { command: string; env: Record<string, string> }[]
    expect(calls).toHaveLength(1)
    const [call] = calls as [{ command: string; env: Record<string, string> }]
    expect(call.env.HOME).toBe(TASK_USER_HOME)
    // Every absolute path the command names is one the user owns: the CLI, the case, the tree and the agent logs.
    const owned = [VINAYA_HOME, '/case', '/app', '/logs/agent']
    const paths = [...call.command.matchAll(/(?<![\w.])\/[\w./-]+/g)].map((m) => m[0])
    expect(paths.length).toBeGreaterThan(0)
    for (const path of paths) expect(owned.some((dir) => path === dir || path.startsWith(`${dir}/`))).toBe(true)
    expect(call.command).toContain(`cd ${VINAYA_HOME} && bun apps/cli/src/lib/dev-review-eval/harbor-trial.ts`)
    expect(call.command).toContain('--case /case/case.json --tree /app')
    expect(call.command).toContain('--record /logs/agent/vinaya-trial-record.json')
    expect(call.command).toContain('--usage /logs/agent/vinaya-usage.json')
  })
})

describe("the verifier's hidden-test runs", () => {
  it('names a test file by .test., _test_, .spec. or _spec_ in its path', () => {
    for (const path of ['a/b.test.ts', 'a/b_test_x.py', 'a/b.spec.ts', 'a/b_spec_x.rb'])
      expect(isTestFile(path)).toBe(true)
    for (const path of ['tests/ci-shards/shard-1.txt', 'tests/helpers/world.ts', 'tests/fixtures/x.json'])
      expect(isTestFile(path)).toBe(false)
  })

  it('runs each test file in a runner of its own and hands no runner a non-test file', async () => {
    const tree = tempDir('harbor-practice-hidden-')
    const tests = tempDir('harbor-practice-hidden-tests-')
    // Each test file refuses a marker its own process left, then leaves one: in one runner the second file fails.
    const marker = "join(import.meta.dir, 'marker-' + process.pid)"
    const testFile = (name: string) =>
      [
        "import { expect, test } from 'bun:test'",
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        `test(${JSON.stringify(name)}, () => {`,
        `  expect(readFileSync(join(import.meta.dir, 'notes.txt'), 'utf8')).toBe('read by the tests\\n')`,
        `  expect(existsSync(${marker})).toBe(false)`,
        `  writeFileSync(${marker}, 'x')`,
        '})',
        ''
      ].join('\n')
    const files: Record<string, string> = {
      'tests/a.test.ts': testFile('first leaves a marker'),
      'tests/b.test.ts': testFile('second finds no marker'),
      'tests/notes.txt': 'read by the tests\n'
    }
    writeFileSync(join(tree, 'package.json'), '{ "name": "hidden-fixture", "private": true }\n')
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(tests, 'hidden', 'tests'), { recursive: true })
      writeFileSync(join(tests, 'hidden', path), content)
    }
    git(tree, ['init', '--quiet'])
    git(tree, ['add', '-A'])
    git(tree, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'base'])
    const c = developmentCases('developer').find((entry) => entry.id === 'pr-1003') as Extract<
      NeutralCase,
      { kind: 'change' }
    >
    const spec: GradingSpec = {
      schemaVersion: 1,
      suite: GENERIC_SUITE_IDS.developer,
      case: {
        ...c,
        hiddenTests: [
          { path: 'tests/a.test.ts', name: 'first leaves a marker', expectation: 'fail-to-pass' },
          { path: 'tests/b.test.ts', name: 'second finds no marker', expectation: 'fail-to-pass' }
        ]
      },
      testFiles: Object.keys(files).sort()
    }
    const measured = await runHiddenTests(tree, tests, spec, 120_000)
    expect(measured.revision).toBe(git(tree, ['rev-parse', 'HEAD']).trim())
    expect(measured.results).toEqual([
      { path: 'tests/a.test.ts', name: 'first leaves a marker', result: 'pass' },
      { path: 'tests/b.test.ts', name: 'second finds no marker', result: 'pass' }
    ])
    // The non-test file is written into the tree, where the tests read it.
    expect(readFileSync(join(tree, 'tests/notes.txt'), 'utf8')).toBe('read by the tests\n')
    // The same two files in one runner: the second finds the first's marker.
    const together = await runTests(tree, ['tests/a.test.ts', 'tests/b.test.ts'], 120_000)
    expect(together.map((r) => r.outcome).sort()).toEqual(['fail', 'pass'])
  }, 300_000)
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
          // The world's own issue number, as the change trial's prompt names it.
          const issue = /Closes #(\d+)/.exec(prompt)?.[1]
          if (opensPullRequest) await world.context.openPullRequest('t', `Closes #${issue}\n\nThe change.`)
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
