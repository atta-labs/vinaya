/**
 * The Harbor task converter, the bundled grade and oracle script, and the
 * in-container trial entry, with no Docker and no model: every development
 * case of the four layer-`G` suites converts into a folder of the required
 * shape, twice byte for byte; the clone script builds each case repository
 * from a local mirror with the excluded files absent; the reference outcome,
 * split into what the agent records and what the verifier measures, rewards
 * `1` and each known-bad variant `0`; the trial entry records an agent part
 * on a fake process run; and the held-out path refuses without its approval.
 */
import { fixtureDir } from '../lib/test-temp-fixture'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, relative } from 'node:path'
import {
  gradeTrial,
  type GradingSpec,
  HIDDEN_TEST_STDERR_FILE,
  HIDDEN_TEST_STDOUT_FILE,
  measureChange,
  type OracleSpec,
  oracleAgentPart,
  runHiddenTests,
  runnerOutputLog,
  splitRecord,
  underNode,
  writeGrade
} from '../../src/lib/dev-review-eval/harbor-grade'
import { QUARANTINE_METADATA, quarantineAdjudicationDigest } from '../../src/lib/dev-review-eval/harbor-results'
import {
  AGENT_ALLOWED_HOSTS,
  AGENT_TIMEOUT_SEC,
  CHANGE_CASE_INSTALL,
  CLAUDE_BIN_DIRECTORY,
  CLAUDE_CODE_PACKAGE,
  CODEX_ALLOWED_HOSTS,
  type ConvertedSuite,
  convertHarborTasks,
  HARBOR_QUARANTINE_PATH,
  HARBOR_SUITE_KEYS,
  HARBOR_VERSION,
  HarborTasksRefused,
  harborTasksCommand,
  isExcludedPath,
  loadHarborQuarantine,
  PREPARE_REPOSITORY_SCRIPT,
  REPOSITORY_ROOT,
  suiteName,
  TEST_SCRIPT,
  TRIAL_TIMEOUT_ENV,
  TRIAL_TIMEOUT_SEC,
  writeArchive
} from '../../src/lib/dev-review-eval/harbor-tasks'
import { EventEmitter } from 'node:events'
import type { SpawnFn } from '@atta/executor-agent-spawn'
import { ENGINE_DEV_TOOLS_SERVER } from '../../src/lib/dev-review-eval/engine-role-step'
import {
  HARBOR_TRIAL_BACKENDS,
  type HarborCaseFile,
  harborTrialCommand,
  runHarborTrial
} from '../../src/lib/dev-review-eval/harbor-trial'
import type { NeutralCase } from '../../src/lib/dev-review-eval/neutral-case'
import {
  type ContainerTrialRecord,
  GRADING_CODEX_PACKAGE,
  PRODUCTION_VINAYA_PROCESS_STEPS,
  type StepOneBackend,
  type VinayaProcessSteps
} from '../../src/lib/dev-review-eval/step-one'
import { renderCase, VINAYA_RENDERER_VERSION } from '../../src/lib/dev-review-eval/vinaya-renderer'
import { stripVinayaEnv } from '../lib/process-fixture'
import { DERIVED_FILE_DIGESTS, HELD_OUT_IDS } from './generic-suites'
import { DEV_TOOLS_MCP_SERVER_NAME } from '../../src/lib/task-tools/dev-tools-names'
import type { DevToolContext } from '../../src/lib/task-tools/dev-tools-server'
import { developmentCases } from './generic-suites'
import { KNOWN_BAD_VARIANTS, referenceRecord } from './vinaya-trial-records'

const REQUIRED_FILES = [
  'task.toml',
  'instruction.md',
  'environment/Dockerfile',
  'environment/case.json',
  'tests/test.sh',
  'tests/grade.js',
  'solution/solve.sh'
]

const temporary: string[] = []
const tempDir = (prefix: string) => {
  const dir = fixtureDir(prefix)
  temporary.push(dir)
  return dir
}

function run(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    env: stripVinayaEnv(options.env ?? process.env),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    // A clone of the case repository or an archive of the whole tree, killed if it hangs.
    timeout: 300_000,
    killSignal: 'SIGKILL'
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function git(cwd: string, args: readonly string[]): string {
  const result = run('git', args, { cwd })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

/** Every file under `root`, by relative path. */
function walk(root: string, at = root): string[] {
  return readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
    const path = join(at, entry.name)
    return entry.isDirectory() ? walk(root, path) : [relative(root, path)]
  })
}

const readJson = <T>(path: string) => JSON.parse(readFileSync(path, 'utf8')) as T

let first: string
let second: string
let summary: ConvertedSuite[]
const refusals: string[] = []

beforeAll(async () => {
  first = tempDir('harbor-tasks-first-')
  second = tempDir('harbor-tasks-second-')
  const quiet = () => {}
  summary = await convertHarborTasks({ out: first, print: quiet, warn: (line) => refusals.push(line) })
  await convertHarborTasks({ out: second, print: quiet, warn: quiet })
}, 300_000)

// Removing every converted tree and every clone outlasts the default hook budget.
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
}, 120_000)

/** Every converted case folder, with its suite and case. */
function folders(): { suite: string; dir: string; caseFile: HarborCaseFile }[] {
  return summary.flatMap((suite) =>
    suite.converted.map((id) => {
      const dir = join(first, suite.suite, id)
      return { suite: suite.suite, dir, caseFile: readJson<HarborCaseFile>(join(dir, 'environment/case.json')) }
    })
  )
}

describe('the converter', () => {
  it('converts every development case of the four suites, listing any refused case, and converts them all', () => {
    expect(summary.map((s) => s.suite)).toEqual(HARBOR_SUITE_KEYS.map(suiteName))
    for (const [i, key] of HARBOR_SUITE_KEYS.entries()) {
      const development = developmentCases(key)
      const result = summary[i] as ConvertedSuite
      expect(result.converted.length + result.refused.length).toBe(development.length)
      expect(result.converted.length).toBe(development.length)
      expect(readdirSync(join(first, result.suite)).sort()).toEqual([...result.converted].sort())
    }
    expect(refusals).toEqual([])
  })

  it('writes the required files, keeps every hidden test under tests/, and names Harbor 0.24.0', () => {
    for (const { dir, caseFile } of folders()) {
      const files = walk(dir)
      for (const required of REQUIRED_FILES) expect(files).toContain(required)
      const toml = Bun.TOML.parse(readFileSync(join(dir, 'task.toml'), 'utf8')) as {
        metadata: Record<string, string>
      }
      expect(toml.metadata.harbor_version).toBe(HARBOR_VERSION)
      expect(toml.metadata.vinaya_renderer_version).toBe(VINAYA_RENDERER_VERSION)
      // No hidden test file's bytes, and no reference file's, appear in what the role sees.
      const hidden = files.filter((file) => file.startsWith('tests/hidden/') || file.startsWith('solution/files/'))
      const visible = files.filter((file) => !file.startsWith('tests/') && !file.startsWith('solution/'))
      expect(
        visible.every((file) => file.startsWith('environment/') || ['task.toml', 'instruction.md'].includes(file))
      ).toBe(true)
      const visibleBytes = visible.map((file) => readFileSync(join(dir, file)))
      for (const file of hidden) {
        const bytes = readFileSync(join(dir, file))
        if (bytes.length < 64) continue
        expect(visibleBytes.some((seen) => seen.includes(bytes))).toBe(false)
      }
      // The case file carries only the counterpart fields a container run reads.
      const counterpart = caseFile.counterpart as Record<string, unknown>
      const allowed = {
        change: ['id', 'kind', 'pullRequest'],
        review: ['baseCommit', 'id', 'kind', 'patch', 'role'],
        answer: ['case', 'kind']
      }
      expect(Object.keys(counterpart).sort()).toEqual(allowed[caseFile.counterpart.kind])
    }
  })

  it("writes each case's task statement, its Interface block included, as its instruction", () => {
    const developer = folders().filter(({ suite }) => suite === suiteName('developer'))
    expect(developer.length).toBeGreaterThan(0)
    expect(developer.some(({ caseFile }) => caseFile.case.taskStatement.includes(' Interface: '))).toBe(true)
    for (const { dir, caseFile } of folders()) {
      expect({ id: caseFile.case.id, instruction: readFileSync(join(dir, 'instruction.md'), 'utf8') }).toEqual({
        id: caseFile.case.id,
        instruction: `${caseFile.case.taskStatement}\n`
      })
    }
  })

  it('writes a byte-identical tree, file modes included, on a second run', () => {
    const files = walk(first).sort()
    expect(walk(second).sort()).toEqual(files)
    for (const file of files) {
      const a = join(first, file)
      const b = join(second, file)
      expect(statSync(b).mode).toBe(statSync(a).mode)
      expect(readFileSync(b).equals(readFileSync(a))).toBe(true)
    }
    const scripts = files.filter((file) => file.endsWith('/grade.js') || file.endsWith('/oracle.js'))
    const reference = readFileSync(join(first, scripts[0] as string))
    for (const file of scripts) expect(readFileSync(join(first, file)).equals(reference)).toBe(true)
  })

  it('lets the agent phase reach only the Anthropic API, and gives the verifier no network', () => {
    for (const { dir } of folders()) {
      const text = readFileSync(join(dir, 'task.toml'), 'utf8')
      const toml = Bun.TOML.parse(text) as Record<string, { network_mode?: string; allowed_hosts?: string[] }>
      expect(toml.agent?.network_mode).toBe('allowlist')
      expect(toml.agent?.allowed_hosts).toEqual([...AGENT_ALLOWED_HOSTS])
      expect(AGENT_ALLOWED_HOSTS).toEqual(['api.anthropic.com'])
      expect(toml.verifier?.network_mode).toBe('no-network')
      for (const section of Object.values(toml)) {
        for (const host of section?.allowed_hosts ?? []) expect(host).not.toMatch(/github\.com|codeload/)
      }
    }
  })

  it('passes the trial a limit 300 seconds below the agent limit, read in the container from the task environment', () => {
    for (const { dir } of folders()) {
      const toml = Bun.TOML.parse(readFileSync(join(dir, 'task.toml'), 'utf8')) as {
        agent: { timeout_sec: number }
        environment: { env: Record<string, string> }
      }
      expect(toml.agent.timeout_sec).toBe(AGENT_TIMEOUT_SEC)
      expect(toml.environment.env[TRIAL_TIMEOUT_ENV]).toBe(String(AGENT_TIMEOUT_SEC - 300))
    }
    expect(TRIAL_TIMEOUT_SEC).toBe(AGENT_TIMEOUT_SEC - 300)
    // The agent's run command names the variable for the container's shell; the Python process never reads it.
    const printed = run(
      'python3',
      [
        '-c',
        [
          'import sys, types',
          "for name in ['harbor', 'harbor.agents', 'harbor.agents.installed', 'harbor.agents.installed.base', 'harbor.environments', 'harbor.environments.base', 'harbor.models', 'harbor.models.agent', 'harbor.models.agent.context']: sys.modules[name] = types.ModuleType(name)",
          "sys.modules['harbor.agents.installed.base'].BaseInstalledAgent = object",
          "sys.modules['harbor.environments.base'].BaseEnvironment = object",
          "sys.modules['harbor.models.agent.context'].AgentContext = object",
          'import asyncio, json, os',
          'from pathlib import PurePosixPath',
          'sys.path.insert(0, sys.argv[1])',
          'import vinaya_harbor_agent as module',
          'agent = object.__new__(module.VinayaAgent)',
          'agent.model_name = "claude-test-model"',
          'agent.environment_logs_dir = PurePosixPath("/logs/agent")',
          'calls = []',
          'async def run_agent(environment, command, env=None): calls.append({"command": command, "env": env})',
          'agent.exec_as_agent = run_agent',
          'asyncio.run(agent.run("instruction", None, None))',
          'print(json.dumps({"calls": calls, "hostHasLimit": module.TRIAL_TIMEOUT_ENV in os.environ}))'
        ].join('\n'),
        join(REPOSITORY_ROOT, 'apps/cli/src/lib/dev-review-eval')
      ],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 'test-subscription-token' } }
    )
    expect(printed.stderr).toBe('')
    const result = JSON.parse(printed.stdout) as {
      calls: { command: string; env: Record<string, string> }[]
      hostHasLimit: boolean
    }
    expect(result.hostHasLimit).toBe(false)
    const [call] = result.calls as [{ command: string; env: Record<string, string> }]
    expect(call.command).toContain(`--timeout-sec "$${TRIAL_TIMEOUT_ENV}"`)
    expect(call.command).toContain('--stream /logs/agent/vinaya-trial.txt')
    expect(call.env).not.toHaveProperty(TRIAL_TIMEOUT_ENV)
    // The container's shell expands the variable from the task environment into the limit the trial honours;
    // `run` strips every Vinaya variable, so this shell gets the task environment directly.
    const expanded = spawnSync('sh', ['-c', `printf '%s' "$${TRIAL_TIMEOUT_ENV}"`], {
      env: { PATH: process.env.PATH, [TRIAL_TIMEOUT_ENV]: String(TRIAL_TIMEOUT_SEC) },
      encoding: 'utf8',
      timeout: 30_000,
      killSignal: 'SIGKILL'
    })
    expect(expanded.stdout).toBe(String(TRIAL_TIMEOUT_SEC))
  })

  it('refuses a trial whose limit the task does not name, before reading the case', async () => {
    const argv = (limit: string[]) => [
      '--case',
      '/nonexistent/case.json',
      '--tree',
      '/app',
      '--record',
      '/r.json',
      '--usage',
      '/u.json',
      '--backend',
      'standalone',
      '--adapter',
      'claude-code',
      '--model',
      'm',
      ...limit
    ]
    expect(await harborTrialCommand(argv([]))).toBe(2)
    // The run command's expansion of an unset variable is an empty value.
    expect(await harborTrialCommand(argv(['--timeout-sec', '']))).toBe(2)
  })

  it('keeps the hidden-test runner output in the verifier log directory and prints it for test-stdout.txt', async () => {
    const tree = tempDir('harbor-verifier-tree-')
    writeFileSync(join(tree, 'package.json'), '{"name":"verifier-fixture","private":true}\n')
    const tests = tempDir('harbor-verifier-tests-')
    mkdirSync(join(tests, 'hidden'), { recursive: true })
    writeFileSync(
      join(tests, 'hidden', 'marker.test.ts'),
      [
        "import { expect, it } from 'bun:test'",
        "it('prints', () => {",
        "  console.log('runner-stdout-marker')",
        "  console.error('runner-stderr-marker')",
        '  expect(1).toBe(1)',
        '})',
        ''
      ].join('\n')
    )
    run('git', ['init', '--quiet'], { cwd: tree })
    run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'base'], {
      cwd: tree
    })
    const answer = folders().find((f) => f.caseFile.case.kind === 'answer') as ReturnType<typeof folders>[number]
    const spec: GradingSpec = {
      schemaVersion: 1,
      suite: answer.suite,
      case: answer.caseFile.case,
      testFiles: ['marker.test.ts']
    }
    const verifier = tempDir('harbor-verifier-logs-')
    const printed: string[] = []
    await runHiddenTests(
      tree,
      tests,
      spec,
      120_000,
      runnerOutputLog(verifier, (text) => printed.push(text))
    )
    const kept = `${readFileSync(join(verifier, HIDDEN_TEST_STDOUT_FILE), 'utf8')}${readFileSync(join(verifier, HIDDEN_TEST_STDERR_FILE), 'utf8')}`
    expect(kept).toContain('== marker.test.ts')
    expect(kept).toContain('runner-stdout-marker')
    expect(kept).toContain('runner-stderr-marker')
    expect(printed.join('')).toContain('runner-stdout-marker')
    expect(printed.join('')).toContain('runner-stderr-marker')
    // The verifier script joins the grading script's standard error to the standard output Harbor keeps.
    expect(TEST_SCRIPT).toContain('--out /logs/verifier 2>&1')
  }, 120_000)

  it('converts Codex tasks with only the subscription hosts, installing and checking both pinned CLIs', async () => {
    const out = tempDir('harbor-tasks-codex-')
    await convertHarborTasks({ out, adapter: 'codex', print: () => {}, warn: () => {} })
    for (const { suite, caseFile } of folders()) {
      const dir = join(out, suite, caseFile.case.id)
      const toml = Bun.TOML.parse(readFileSync(join(dir, 'task.toml'), 'utf8')) as {
        agent: { allowed_hosts: string[] }
        verifier: { network_mode: string }
      }
      expect(toml.agent.allowed_hosts).toEqual(['api.openai.com', 'chatgpt.com'])
      expect(toml.agent.allowed_hosts).toEqual([...CODEX_ALLOWED_HOSTS])
      expect(toml.verifier.network_mode).toBe('no-network')
      const image = readFileSync(join(dir, 'environment/Dockerfile'), 'utf8')
      expect(image).toContain(`npm install --global ${CLAUDE_CODE_PACKAGE}`)
      expect(image).toContain(`npm install --global --prefix /opt/codex ${GRADING_CODEX_PACKAGE}`)
      expect(image).toContain('ln -s /opt/codex/bin/codex /opt/claude/bin/codex')
      expect(image).toContain(`test "$(claude --version)" = "${CLAUDE_CODE_PACKAGE.split('@').at(-1)} (Claude Code)"`)
      expect(image).toContain(`test "$(codex --version)" = "codex-cli ${GRADING_CODEX_PACKAGE.split('@').at(-1)}"`)
      expect(image).toContain('apt-get install --yes --no-install-recommends bubblewrap')
      expect(image).toContain('command -v bwrap && bwrap --version')
    }
    expect(await harborTasksCommand(['--out', out, '--adapter', 'unsupported'])).toBe(2)
  })

  it('installs in /app with a frozen lockfile, in a change case only, after the sparse checkout and before the remote is removed', () => {
    for (const { dir, caseFile } of folders()) {
      const dockerfile = readFileSync(join(dir, 'environment/Dockerfile'), 'utf8')
      const install = caseFile.case.kind === 'change' ? `PREPARE_INSTALL='${CHANGE_CASE_INSTALL}' ` : ''
      expect(dockerfile).toContain(`\nRUN ${install}sh /harbor/prepare-repository.sh '`)
      expect(dockerfile).toMatch(/sh \/harbor\/prepare-repository\.sh '[^']+' '\/app' '[0-9a-f]{40}'/)
      const script = readFileSync(join(dir, 'environment/prepare-repository.sh'), 'utf8')
      const at = (needle: string) => {
        const index = script.indexOf(needle)
        expect(index).toBeGreaterThan(-1)
        return index
      }
      expect(CHANGE_CASE_INSTALL).toBe('bun install --frozen-lockfile')
      expect(script).toContain('install=${PREPARE_INSTALL:-}')
      expect(at('.git/info/sparse-checkout')).toBeLessThan(at('git checkout --quiet -B task "$base"'))
      expect(at('git checkout --quiet -B task "$base"')).toBeLessThan(at('\n  $install\n'))
      expect(at('\n  $install\n')).toBeLessThan(at('git remote remove origin'))
    }
  })

  it('puts claude in a directory of its own, first on PATH, and leaves none in /usr/local/bin', () => {
    expect(CLAUDE_BIN_DIRECTORY).toBe('/opt/claude/bin')
    for (const { dir } of folders()) {
      const lines = readFileSync(join(dir, 'environment/Dockerfile'), 'utf8').split('\n')
      const link = lines.find((line) => line.startsWith('RUN ') && line.includes(' /opt/claude/bin/claude'))
      expect(link).toContain(
        'ln -s "$(npm root --global)/@anthropic-ai/claude-code/bin/claude.exe" /opt/claude/bin/claude'
      )
      expect(link).toContain('rm /usr/local/bin/claude')
      expect(link?.indexOf('npm install --global')).toBeLessThan(link?.indexOf('rm /usr/local/bin/claude') ?? -1)
      expect(lines.filter((line) => line.startsWith('ENV PATH='))).toEqual(['ENV PATH=/opt/claude/bin:$PATH'])
      // The only line naming claude in /usr/local/bin is the one that removes it.
      expect(lines.filter((line) => line.includes('/usr/local/bin/claude'))).toEqual([link as string])
      expect(lines.some((line) => /ln\b.*\/usr\/local\/bin\b/.test(line))).toBe(false)
    }
  })

  it('installs gh and ends as the non-root tester user, after the clone and the review commit', () => {
    for (const { dir, caseFile } of folders()) {
      const lines = readFileSync(join(dir, 'environment/Dockerfile'), 'utf8').trimEnd().split('\n')
      const index = (find: (line: string) => boolean) => {
        const at = lines.findIndex(find)
        expect(at).toBeGreaterThan(-1)
        return at
      }
      const gh = lines[index((line) => line.includes('apt-get install'))] as string
      expect(gh).toMatch(
        /^RUN apt-get update && apt-get install --yes --no-install-recommends gh && .* && gh --version$/
      )
      expect(lines).toContain('RUN useradd -m -u 1001 tester')
      const users = lines.filter((line) => line.startsWith('USER '))
      expect(users.at(-1)).toBe('USER tester')
      const user = lines.lastIndexOf('USER tester')
      const owned = index((line) => line.startsWith('RUN ') && line.includes('chown -R tester:tester'))
      expect(lines[owned]).toContain('chown -R tester:tester /app /case /logs')
      expect(lines[owned]).toContain('mkdir -p /logs/agent /logs/verifier')
      expect(owned).toBeLessThan(user)
      expect(lines).toContain('ENV HOME=/home/tester')
      expect(index((line) => line.includes('sh /harbor/prepare-repository.sh'))).toBeLessThan(user)
      if (caseFile.case.kind === 'review')
        expect(index((line) => line.includes('sh /harbor/commit-review.sh'))).toBeLessThan(user)
      // Every instruction after the user switch needs no root.
      expect(lines.slice(user + 1).every((line) => /^(ENV|WORKDIR) /.test(line))).toBe(true)
    }
  })

  it('writes each solution file with its git file mode at the reference commit', () => {
    const developer = summary.find((s) => s.suite === suiteName('developer')) as ConvertedSuite
    const executable: string[] = []
    let files = 0
    for (const id of developer.converted) {
      const solution = join(first, developer.suite, id, 'solution/files')
      if (!existsSync(solution)) continue
      for (const path of walk(solution)) {
        files++
        const mode = statSync(join(solution, path)).mode & 0o777
        expect([0o644, 0o755]).toContain(mode)
        if (mode === 0o755) executable.push(`${id} ${path}`)
      }
    }
    expect(files).toBeGreaterThan(executable.length)
    expect(executable.sort()).toEqual([
      'pr-1240 apps/cli/src/checks/bin/check-doc-claims.ts',
      'pr-1277 apps/cli/src/checks/bin/check-retired-vocabulary.ts',
      'pr-990 apps/cli/src/index.ts'
    ])
  })

  it('fetches the base with its full history and no blob up front, and the head unchanged', () => {
    const fetches = PREPARE_REPOSITORY_SCRIPT.split('\n').filter((line) => line.trim().startsWith('git fetch'))
    expect(fetches.map((line) => line.trim())).toEqual([
      'git fetch --quiet --filter=blob:none origin "$base"',
      'git fetch --quiet --depth 1 --filter=blob:none origin "$head"'
    ])
  })

  it('writes every quarantined developer folder, with its quarantine in task.toml', () => {
    const BROKEN_TASKS = ['pr-1268', 'pr-1299']
    const developer = summary.find((s) => s.suite === suiteName('developer')) as ConvertedSuite
    expect(developer.converted.length).toBe(28)
    expect(readdirSync(join(first, developer.suite)).length).toBe(28)
    const record = loadHarborQuarantine()
    const quarantines = record.get(developer.suite) ?? []
    expect(quarantines.map((q) => q.taskId).sort()).toEqual(['pr-1002', 'pr-1077', 'pr-1268', 'pr-1271', 'pr-1299'])
    expect([...record.keys()]).toEqual([developer.suite])
    const withMetadata: string[] = []
    for (const { suite, dir, caseFile } of folders()) {
      const metadata = (
        Bun.TOML.parse(readFileSync(join(dir, 'task.toml'), 'utf8')) as { metadata: Record<string, unknown> }
      ).metadata
      const quarantine = suite === developer.suite ? quarantines.find((q) => q.taskId === caseFile.case.id) : undefined
      if (quarantine === undefined) {
        for (const key of Object.values(QUARANTINE_METADATA)) expect(metadata[key]).toBeUndefined()
        continue
      }
      withMetadata.push(caseFile.case.id)
      // A case no solution written from its inputs can pass is a broken task; the rest fail only on the image.
      expect(quarantine.cause).toBe(BROKEN_TASKS.includes(caseFile.case.id) ? 'broken-task' : 'environment')
      expect(quarantine.reasonVersion).toBe(1)
      expect(metadata).toMatchObject({
        quarantine_cause: quarantine.cause,
        quarantine_reason: quarantine.reason,
        quarantine_reason_version: quarantine.reasonVersion,
        quarantine_adjudication_digest: quarantine.adjudicationDigest
      })
      expect(walk(dir)).toEqual(expect.arrayContaining(REQUIRED_FILES))
    }
    expect(withMetadata.sort()).toEqual(['pr-1002', 'pr-1077', 'pr-1268', 'pr-1271', 'pr-1299'])
  })

  it('refuses a quarantine record with a stale digest or naming a case its suite does not hold, writing no folder', async () => {
    const record = readJson<{ schemaVersion: 1; suites: Record<string, Record<string, unknown>[]> }>(
      HARBOR_QUARANTINE_PATH
    )
    const suite = suiteName('developer')
    const write = (suites: typeof record.suites) => {
      const path = join(tempDir('harbor-tasks-quarantine-'), 'quarantine.json')
      writeFileSync(path, JSON.stringify({ ...record, suites }))
      return path
    }
    const entry = record.suites[suite]?.[0] as Record<string, unknown>
    const stale = write({ [suite]: [{ ...entry, reason: `${entry.reason} Edited.` }] })
    expect(() => loadHarborQuarantine(stale)).toThrow('stale adjudication digest')
    const absent = { taskId: 'pr-1', cause: 'environment', reason: 'No such case.', reasonVersion: 1 } as const
    const unknown = write({ [suite]: [{ ...absent, adjudicationDigest: quarantineAdjudicationDigest(absent) }] })
    const out = tempDir('harbor-tasks-quarantine-out-')
    const quiet = () => {}
    for (const quarantine of [stale, unknown]) {
      await expect(convertHarborTasks({ out, quarantine, print: quiet, warn: quiet })).rejects.toBeInstanceOf(
        HarborTasksRefused
      )
    }
    await expect(convertHarborTasks({ out, quarantine: unknown, print: quiet, warn: quiet })).rejects.toThrow(
      'names pr-1, which developer-capability-neutral.l5 does not hold'
    )
    expect(readdirSync(out)).toEqual([])
  })

  it('refuses a held-out conversion without the pinned approval, opening no held-out file', async () => {
    const opened: string[] = []
    const out = tempDir('harbor-tasks-held-out-')
    const code = await harborTasksCommand(['--held-out-approval', 'wrong', '--out', out], (path) => {
      opened.push(path)
      return readFileSync(path)
    })
    expect(code).toBe(2)
    expect(opened.filter((path) => /held-out/.test(path))).toEqual([])
    expect(readdirSync(out)).toEqual([])
  })

  it('converts the source-citation held-out cases under the pinned approval, listing them by id alone', async () => {
    const out = tempDir('harbor-tasks-citation-held-out-')
    const printed: string[] = []
    const warned: string[] = []
    const suites = await convertHarborTasks({
      out,
      heldOutApprovals: [DERIVED_FILE_DIGESTS.sourceCitation.heldOut],
      print: (line) => printed.push(line),
      warn: (line) => warned.push(line)
    })
    expect(suites.map((s) => [s.suite, s.split, s.converted])).toEqual([
      [suiteName('sourceCitation'), 'held-out', [...HELD_OUT_IDS.sourceCitation]]
    ])
    expect(readdirSync(join(out, suiteName('sourceCitation'))).sort()).toEqual([...HELD_OUT_IDS.sourceCitation].sort())
    expect(warned).toEqual([])
    expect(printed.join('\n')).toContain(`ids: ${HELD_OUT_IDS.sourceCitation.join(', ')}`)
    expect(printed.join('\n')).not.toContain('"taskStatement"')
  })

  it('writes a Vinaya archive holding no case, hidden-test or held-out file', () => {
    const archive = join(tempDir('harbor-tasks-archive-'), 'vinaya.tar')
    writeArchive(archive)
    const listing = run('tar', ['-tf', archive]).stdout.split('\n').filter(Boolean)
    expect(listing).toContain('apps/cli/src/index.ts')
    expect(listing).toContain('apps/cli/src/lib/dev-review-eval/harbor-trial.ts')
    expect(listing).toContain('apps/cli/tests/eval/registry/modules.json')
    expect(listing.filter(isExcludedPath)).toEqual([])
  })

  it('names a Harbor agent file that parses', () => {
    const agent = join(REPOSITORY_ROOT, 'apps/cli/src/lib/dev-review-eval/vinaya_harbor_agent.py')
    const compiled = run('python3', ['-m', 'py_compile', agent], {
      env: { ...process.env, PYTHONPYCACHEPREFIX: tempDir('harbor-agent-pycache-') }
    })
    expect(compiled.stderr).toBe('')
    expect(compiled.status).toBe(0)
  })
})

describe('the case repository built from a local mirror', () => {
  /** A bare mirror of this repository reached through `file://`, serving any object with a filter. */
  let mirror: string
  const built = new Map<string, string>()

  beforeAll(() => {
    mirror = tempDir('harbor-tasks-mirror-')
    git(mirror, ['init', '--quiet', '--bare'])
    const objects = join(
      git(REPOSITORY_ROOT, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(),
      'objects'
    )
    writeFileSync(join(mirror, 'objects', 'info', 'alternates'), `${objects}\n`)
    git(mirror, ['config', 'uploadpack.allowFilter', 'true'])
    git(mirror, ['config', 'uploadpack.allowAnySHA1InWant', 'true'])
  })

  /** The clone script's arguments as the case's Dockerfile passes them, but from the mirror. */
  function cloneArguments(dir: string): string[] {
    const line = readFileSync(join(dir, 'environment/Dockerfile'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('RUN ') && l.includes('sh /harbor/prepare-repository.sh')) as string
    const call = line.slice(line.indexOf('sh /harbor/prepare-repository.sh'))
    const args = [...call.matchAll(/'([^']*)'/g)].map((m) => m[1] as string)
    return [`file://${mirror}`, ...args.slice(2)]
  }

  /** Runs the case's clone script (no install) once per distinct set of arguments, then returns its tree. */
  function cloneOf(dir: string): string {
    const args = cloneArguments(dir)
    const key = args.join(' ')
    const known = built.get(key)
    if (known !== undefined) return known
    const tree = join(tempDir('harbor-tasks-clone-'), 'app')
    const result = run(
      'sh',
      [join(dir, 'environment/prepare-repository.sh'), args[0] as string, tree, ...args.slice(1)],
      {
        env: { ...process.env, PREPARE_INSTALL: '' }
      }
    )
    if (result.status !== 0) throw new Error(`clone script failed: ${result.stderr}`)
    built.set(key, tree)
    return tree
  }

  it('keeps HEAD at the base, leaves every excluded file out of the tree and the object store, and keeps no remote', () => {
    for (const { dir, caseFile } of folders()) {
      const tree = cloneOf(dir)
      const base = caseFile.case.baseRevision
      expect(git(tree, ['rev-parse', 'HEAD']).trim()).toBe(base)
      // The base comes with its history: its parent commit is in the clone.
      expect(Number(git(tree, ['rev-list', '--count', 'HEAD']).trim())).toBeGreaterThan(1)
      expect(git(tree, ['remote']).trim()).toBe('')
      expect(walk(tree).filter((path) => !path.startsWith('.git/') && isExcludedPath(path))).toEqual([])
      const entries = git(REPOSITORY_ROOT, ['ls-tree', '-r', base])
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [meta, path] = line.split('\t') as [string, string]
          return { blob: meta.split(' ')[2] as string, path }
        })
      const kept = new Set(entries.filter((e) => !isExcludedPath(e.path)).map((e) => e.blob))
      for (const entry of entries.filter((e) => isExcludedPath(e.path) && !kept.has(e.blob))) {
        const probe = run('git', ['cat-file', '-e', entry.blob], {
          cwd: tree,
          env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }
        })
        expect(probe.status).not.toBe(0)
      }
    }
  }, 600_000)

  it('commits the change under review as HEAD, the seeded head reproduced to its exact id', () => {
    for (const { dir, caseFile } of folders()) {
      if (caseFile.case.kind !== 'review') continue
      const tree = join(tempDir('harbor-tasks-review-'), 'app')
      run('cp', ['-R', cloneOf(dir), tree])
      const caseCopy = join(tempDir('harbor-tasks-review-case-'), 'case.json')
      copyFileSync(join(dir, 'environment/case.json'), caseCopy)
      const head = caseFile.case.changeUnderReview.head
      const result = run('sh', [
        join(dir, 'environment/commit-review.sh'),
        tree,
        caseCopy,
        head,
        `Seeded change ${caseFile.case.id}`
      ])
      expect(result.stderr).toBe('')
      expect(git(tree, ['rev-parse', 'HEAD']).trim()).toBe(head)
    }
  }, 600_000)

  /** One converted case of each kind, by suite. */
  const ONE_OF_EACH = [
    { suite: 'developer-capability-neutral.l5', kind: 'change' },
    { suite: 'code-reviewer-quality-neutral.l5', kind: 'review' },
    { suite: 'source-delivery-neutral.l5', kind: 'answer' }
  ] as const

  const oneOf = (suite: string, kind: NeutralCase['kind']) => {
    const found = folders().find((f) => f.suite === suite && f.caseFile.case.kind === kind)
    if (found === undefined) throw new Error(`no ${kind} case in ${suite}`)
    return found
  }

  for (const { suite, kind } of ONE_OF_EACH) {
    it(`grades a ${kind} case's reference, split into its agent and measured parts, 1, and each applicable known-bad variant 0`, async () => {
      const { dir } = oneOf(suite, kind)
      const spec = readJson<GradingSpec>(join(dir, 'tests/grading.json'))
      const oracle = readJson<OracleSpec>(join(dir, 'solution/reference.json'))
      const rendered = renderCase(spec.case)
      if (!rendered.ok) throw new Error('the case does not render')
      const reference = referenceRecord(oracle, rendered.input)
      const { agent, measured } = splitRecord(reference)
      const passing = await gradeTrial(spec, agent, measured)
      expect(passing.reason).toBeNull()
      expect(passing.reward).toBe(1)
      let planted = 0
      for (const variant of KNOWN_BAD_VARIANTS) {
        const bad = variant.plant(reference, oracle)
        if (bad === null) continue
        planted++
        const split = splitRecord(bad)
        const grade = await gradeTrial(spec, split.agent, split.measured)
        expect(grade.reward).toBe(0)
        expect(grade.verdicts[variant.graderId]?.verdict).toBe('fail')
      }
      expect(planted).toBeGreaterThan(0)
      // A missing agent record rewards 0 with its reason.
      const missing = await gradeTrial(spec, null, measured)
      expect(missing.reward).toBe(0)
      expect(missing.reason).toContain('no agent record')
      const out = tempDir('harbor-tasks-verifier-')
      writeGrade(out, passing)
      expect(readFileSync(join(out, 'reward.txt'), 'utf8')).toBe('1')
      expect(readJson<{ verdicts: object }>(join(out, 'grades.json')).verdicts).toEqual(passing.verdicts)
    })

    it(`the oracle's agent part for a ${kind} case, bound to a fake commit, rewards 1 with that commit's measured part`, async () => {
      const { dir, caseFile } = oneOf(suite, kind)
      const spec = readJson<GradingSpec>(join(dir, 'tests/grading.json'))
      const oracle = readJson<OracleSpec>(join(dir, 'solution/reference.json'))
      const tree = join(tempDir('harbor-tasks-oracle-'), 'app')
      run('cp', ['-R', cloneOf(dir), tree])
      let measured: ReturnType<typeof splitRecord>['measured'] = { measuredChange: null, hiddenTests: null }
      if (kind === 'change') {
        writeFileSync(join(tree, 'apps/cli/src/lib/oracle-fake.ts'), 'export const fake = true\n')
        git(tree, ['add', '-A'])
        git(tree, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'fake'])
        const change = measureChange(tree, caseFile.case.baseRevision)
        expect(change.changedPaths).toEqual(['apps/cli/src/lib/oracle-fake.ts'])
        const c = caseFile.case as Extract<NeutralCase, { kind: 'change' }>
        measured = {
          measuredChange: change,
          hiddenTests: {
            revision: change.head,
            results: c.hiddenTests.map((t) => ({ path: t.path, name: t.name, result: 'pass' as const }))
          }
        }
      }
      const agent = oracleAgentPart(tree, oracle)
      expect(agent.measuredChange).toBeNull()
      expect(agent.hiddenTests).toBeNull()
      if (kind === 'change') expect(agent.pullRequest?.headSha).toBe(git(tree, ['rev-parse', 'HEAD']).trim())
      const grade = await gradeTrial(spec, agent, measured)
      expect(grade.reason).toBeNull()
      expect(grade.reward).toBe(1)
    })

    it(`the trial entry runs a ${kind} case on a fake process in container mode and records its agent part`, async () => {
      const { dir, caseFile } = oneOf(suite, kind)
      const tree = join(tempDir('harbor-tasks-trial-'), 'app')
      run('cp', ['-R', cloneOf(dir), tree])
      if (kind === 'review') {
        const head = (caseFile.case as Extract<NeutralCase, { kind: 'review' }>).changeUnderReview.head
        run('sh', [
          join(dir, 'environment/commit-review.sh'),
          tree,
          join(dir, 'environment/case.json'),
          head,
          `Seeded change ${caseFile.case.id}`
        ])
      }
      const work = tempDir('harbor-tasks-trial-files-')
      const casePath = join(work, 'case.json')
      copyFileSync(join(dir, 'environment/case.json'), casePath)
      const recordPath = join(work, 'agent', 'vinaya-trial-record.json')
      const usagePath = join(work, 'agent', 'vinaya-usage.json')
      const dispatched: { cwd?: string; containerMode?: boolean }[] = []
      // A Claude answer turn in container mode logs in from the subscription token alone.
      const priorToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-subscription-token'
      const outcome = await runHarborTrial(
        {
          casePath,
          tree,
          recordPath,
          usagePath,
          backend: 'standalone',
          adapter: 'claude-code',
          model: 'claude-test-model',
          timeoutMs: 60_000
        },
        fakeSteps(kind, dispatched)
      ).finally(() => {
        if (priorToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = priorToken
      })
      expect(outcome).toEqual({ ok: true })
      // The case file is gone before the role starts; the record and the usage are written.
      expect(existsSync(casePath)).toBe(false)
      const record = readJson<ContainerTrialRecord>(recordPath)
      expect(readJson<{ inputTokens: number }>(usagePath).inputTokens).toBeGreaterThanOrEqual(0)
      // The record is an agent part naming its backend: the verifier's two facts unset, every other field the split's.
      const rendered = renderCase(caseFile.case)
      if (!rendered.ok) throw new Error('the case does not render')
      const oracle = readJson<OracleSpec>(join(dir, 'solution/reference.json'))
      const split = splitRecord(referenceRecord(oracle, rendered.input)).agent
      expect(record.backend).toBe('standalone')
      expect(Object.keys(record).sort()).toEqual([...Object.keys(split), 'backend'].sort())
      expect(record.measuredChange).toBeNull()
      expect(record.hiddenTests).toBeNull()
      expect(record.input).toEqual(rendered.input)
      expect(record.rendererVersion).toBe(VINAYA_RENDERER_VERSION)
      if (kind !== 'answer') expect(dispatched).toEqual([{ cwd: tree, containerMode: true }])
      const spec = readJson<GradingSpec>(join(dir, 'tests/grading.json'))
      const measured =
        kind === 'change'
          ? { measuredChange: measureChange(tree, caseFile.case.baseRevision), hiddenTests: null }
          : { measuredChange: null, hiddenTests: null }
      const grade = await gradeTrial(spec, record, measured)
      // The verifier accepts the record and grades it; the fake run is not meant to pass.
      expect(grade.reason).toBeNull()
      expect(Object.keys(grade.verdicts).length).toBeGreaterThan(0)
    }, 60_000)
  }

  it('refuses an unsupported backend or adapter before reading the case', async () => {
    const options = {
      casePath: join(tempDir('harbor-tasks-refused-'), 'absent.json'),
      tree: '/app',
      recordPath: '/logs/agent/r.json',
      usagePath: '/logs/agent/u.json',
      backend: 'standalone',
      adapter: 'claude-code',
      model: 'claude-test-model',
      timeoutMs: 1000
    }
    expect(await runHarborTrial({ ...options, backend: 'unsupported' })).toMatchObject({ ok: false, refused: true })
    expect(await runHarborTrial({ ...options, adapter: 'unsupported' })).toMatchObject({ ok: false, refused: true })
    expect(HARBOR_TRIAL_BACKENDS).toEqual(['standalone', 'engine'])
  })

  it('runs a Codex reviewer trial through the same container process contract', async () => {
    const { dir, caseFile } = oneOf('code-reviewer-quality-neutral.l5', 'review')
    const work = tempDir('harbor-codex-trial-')
    const tree = join(work, 'app')
    run('cp', ['-R', cloneOf(dir), tree])
    const casePath = join(work, 'case.json')
    copyFileSync(join(dir, 'environment/case.json'), casePath)
    const dispatched: { cwd?: string; containerMode?: boolean }[] = []
    const steps = fakeSteps('review', dispatched)
    const agents: string[] = []
    const outcome = await runHarborTrial(
      {
        casePath,
        tree,
        recordPath: join(work, 'record.json'),
        usagePath: join(work, 'usage.json'),
        backend: 'standalone',
        adapter: 'codex',
        model: 'codex-test-model',
        timeoutMs: 60_000
      },
      {
        ...steps,
        dispatch: async (role, agent, prompt, opts) => {
          agents.push(agent)
          return steps.dispatch(role, agent, prompt, opts)
        }
      }
    )
    expect(outcome).toEqual({ ok: true })
    expect(agents).toEqual(['codex'])
    expect(dispatched).toEqual([{ cwd: tree, containerMode: true }])
    expect(existsSync(casePath)).toBe(false)
    const rendered = renderCase(caseFile.case)
    if (!rendered.ok) throw new Error('the case does not render')
    expect(readJson<NonNullable<ReturnType<typeof splitRecord>['agent']>>(join(work, 'record.json')).input).toEqual(
      rendered.input
    )
  })

  /** A container trial of one case on `backend` and `adapter`, with stub agents; its record, grade and launches. */
  async function backendTrial(
    suite: string,
    kind: 'change' | 'review',
    backend: StepOneBackend,
    adapter: 'claude-code' | 'codex'
  ) {
    const { dir, caseFile } = oneOf(suite, kind)
    const tree = join(tempDir('harbor-backend-trial-'), 'app')
    run('cp', ['-R', cloneOf(dir), tree])
    if (kind === 'review') {
      const head = (caseFile.case as Extract<NeutralCase, { kind: 'review' }>).changeUnderReview.head
      run('sh', [
        join(dir, 'environment/commit-review.sh'),
        tree,
        join(dir, 'environment/case.json'),
        head,
        `Seeded change ${caseFile.case.id}`
      ])
    }
    const work = tempDir('harbor-backend-trial-files-')
    const casePath = join(work, 'case.json')
    copyFileSync(join(dir, 'environment/case.json'), casePath)
    const recordPath = join(work, 'agent', 'vinaya-trial-record.json')
    const dispatched: { cwd?: string; containerMode?: boolean }[] = []
    const launches: StubLaunch[] = []
    const hosts: string[] = []
    const standalone = fakeSteps(kind, dispatched)
    let world: { context: DevToolContext } | null = null
    const steps: VinayaProcessSteps = {
      ...standalone,
      startToolHost: async (opts) => {
        hosts.push(opts.role)
        world = { context: opts.context }
        return standalone.startToolHost(opts)
      },
      engineSpawn: stubAgent(kind, adapter, () => world, launches)
    }
    // The container's subscription logins: Claude's token, and a Codex home holding a staged login.
    const codexHome = tempDir('harbor-backend-codex-home-')
    writeFileSync(join(codexHome, 'auth.json'), '{"staged":"login"}')
    const prior = { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, codexHome: process.env.CODEX_HOME }
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-subscription-token'
    process.env.CODEX_HOME = codexHome
    const outcome = await runHarborTrial(
      {
        casePath,
        tree,
        recordPath,
        usagePath: join(work, 'agent', 'vinaya-usage.json'),
        backend,
        adapter,
        model: `${adapter}-test-model`,
        timeoutMs: 30_000
      },
      steps
    ).finally(() => {
      if (prior.token === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prior.token
      if (prior.codexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prior.codexHome
    })
    expect(outcome).toEqual({ ok: true })
    const record = readJson<ContainerTrialRecord>(recordPath)
    const spec = readJson<GradingSpec>(join(dir, 'tests/grading.json'))
    const measured =
      kind === 'change'
        ? { measuredChange: measureChange(tree, caseFile.case.baseRevision), hiddenTests: null }
        : { measuredChange: null, hiddenTests: null }
    const grade = await gradeTrial(spec, record, measured)
    return { tree, record, grade, dispatched, launches, hosts }
  }

  const BACKEND_CASES = [
    { suite: 'developer-capability-neutral.l5', kind: 'change' },
    { suite: 'code-reviewer-quality-neutral.l5', kind: 'review' }
  ] as const

  for (const { suite, kind } of BACKEND_CASES) {
    for (const backend of HARBOR_TRIAL_BACKENDS) {
      it(`runs a ${kind} case on the ${backend} backend with stub agents into a record the generic graders accept`, async () => {
        const trial = await backendTrial(suite, kind, backend, 'claude-code')
        expect(trial.record.backend).toBe(backend)
        expect(trial.grade.reason).toBeNull()
        expect(Object.keys(trial.grade.verdicts).length).toBeGreaterThan(0)
        if (backend === 'standalone') {
          expect(trial.dispatched).toEqual([{ cwd: trial.tree, containerMode: true }])
          expect(trial.launches).toEqual([])
          return
        }
        // The Engine ran the role's one step through its own role launcher; the standalone dispatch never ran.
        expect(trial.dispatched).toEqual([])
        expect(trial.launches).toHaveLength(1)
        const [launch] = trial.launches as [StubLaunch]
        expect(launch.command).toBe('claude')
        expect(realpathSync(launch.cwd)).toBe(realpathSync(trial.tree))
        expect(launch.prompt).toContain(kind === 'change' ? 'Closes #' : 'Review the following change')
        const settings = launch.args[launch.args.indexOf('--settings') + 1] as string
        expect(
          settings.endsWith(`generated/${kind === 'change' ? 'developer' : 'code-reviewer'}/role-settings.json`)
        ).toBe(true)
        // The generated MCP settings reach the trial's own tool host through the bridge script, and nothing else.
        const mcp = JSON.parse(launch.settings) as { mcpServers: Record<string, { command: string }> }
        expect(Object.keys(mcp.mcpServers)).toEqual([ENGINE_DEV_TOOLS_SERVER])
        expect(launch.bridge).toContain("'task-tools' 'dev-bridge' '--socket'")
        expect(trial.hosts).toEqual([kind === 'change' ? 'developer' : 'code-reviewer'])
        // No forge credential and no API key reaches the role; Claude logs in from the subscription token.
        expect(Object.keys(launch.env).some((key) => /GH_TOKEN|GITHUB_TOKEN|API_KEY/.test(key))).toBe(false)
        expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('test-subscription-token')
        expect(launch.env.CLAUDE_FORCE_OAUTH).toBe('1')
        // The Engine's name for the dev-tools server reads as the standalone one in the record's trace.
        if (kind === 'change')
          expect(trial.record.trace?.map((call) => call.tool)).toEqual([
            'shell',
            'publish_changes',
            'open_pull_request'
          ])
      }, 120_000)
    }
  }

  it('runs the same change case on the Engine on Claude Code and on Codex, both grading with the same verdicts', async () => {
    const claude = await backendTrial('developer-capability-neutral.l5', 'change', 'engine', 'claude-code')
    const codex = await backendTrial('developer-capability-neutral.l5', 'change', 'engine', 'codex')
    expect(claude.grade.reason).toBeNull()
    expect(codex.grade.reason).toBeNull()
    expect(codex.grade.verdicts).toEqual(claude.grade.verdicts)
    expect(codex.grade.reward).toBe(claude.grade.reward)
    expect(claude.record.backend).toBe('engine')
    expect(codex.record.backend).toBe('engine')
    const [launch] = codex.launches as [StubLaunch]
    expect(launch.command).toBe('codex')
    // Codex launches from its generated home: the required dev-tools server is the trial's bridge, its login a staged copy.
    expect(launch.settings).toContain(`[mcp_servers.${ENGINE_DEV_TOOLS_SERVER}]\nenabled = true\nrequired = true\n`)
    expect(launch.settings).toContain(`command = ${JSON.stringify(launch.mcpCommand)}`)
    expect(launch.bridge).toContain("'task-tools' 'dev-bridge' '--socket'")
    expect(launch.codexLogin).toBe('{"staged":"login"}')
    expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(launch.args).toContain('codex-test-model')
  }, 240_000)

  it('refuses a loop case on both backends with its existing reason', async () => {
    const { dir } = oneOf('developer-capability-neutral.l5', 'change')
    const [loop] = developmentCases('wholeLoop')
    if (loop === undefined || loop.kind !== 'loop') throw new Error('no loop case')
    for (const backend of HARBOR_TRIAL_BACKENDS) {
      const work = tempDir('harbor-loop-refused-')
      const casePath = join(work, 'case.json')
      const caseFile: HarborCaseFile = {
        ...readJson<HarborCaseFile>(join(dir, 'environment/case.json')),
        case: loop
      }
      writeFileSync(casePath, JSON.stringify(caseFile))
      const launches: StubLaunch[] = []
      const dispatched: { cwd?: string; containerMode?: boolean }[] = []
      const trial = runHarborTrial(
        {
          casePath,
          tree: work,
          recordPath: join(work, 'record.json'),
          usagePath: join(work, 'usage.json'),
          backend,
          adapter: 'claude-code',
          model: 'claude-test-model',
          timeoutMs: 60_000
        },
        { ...fakeSteps('change', dispatched), engineSpawn: stubAgent('change', 'claude-code', () => null, launches) }
      )
      // The refusal is the run's failure, and the run still leaves its usage file, with no usage.
      expect(await trial).toMatchObject({ ok: false, reason: expect.stringContaining('step one runs no loop case') })
      expect(readJson<{ inputTokens: number }>(join(work, 'usage.json')).inputTokens).toBe(0)
      expect(dispatched).toEqual([])
      expect(launches).toEqual([])
      expect(existsSync(join(work, 'record.json'))).toBe(false)
    }
  })
})

describe('the bundled grade script', () => {
  it('carries the current renderer version and grades an answer case with no repository beside it', () => {
    const { dir } = folders().find((f) => f.caseFile.case.kind === 'answer') as ReturnType<typeof folders>[number]
    const isolated = tempDir('harbor-tasks-bundle-')
    for (const name of ['tests', 'solution']) run('cp', ['-R', join(dir, name), join(isolated, name)])
    const version = run('bun', [join(isolated, 'tests/grade.js'), 'version'], { cwd: isolated })
    expect(version.stdout.trim()).toBe(VINAYA_RENDERER_VERSION)
    const agent = join(isolated, 'logs/agent')
    const app = join(isolated, 'app')
    mkdirSync(app, { recursive: true })
    const oracle = run(
      'bun',
      [
        join(isolated, 'solution/oracle.js'),
        'oracle',
        '--solution',
        join(isolated, 'solution'),
        '--app',
        app,
        '--agent',
        agent
      ],
      { cwd: isolated }
    )
    expect(oracle.stderr).toBe('')
    const verifier = join(isolated, 'logs/verifier')
    run(
      'bun',
      [
        join(isolated, 'tests/grade.js'),
        'grade',
        '--tests',
        join(isolated, 'tests'),
        '--app',
        app,
        '--agent',
        agent,
        '--out',
        verifier
      ],
      { cwd: isolated }
    )
    expect(readFileSync(join(verifier, 'reward.txt'), 'utf8')).toBe('1')
  }, 60_000)

  it('launches vitest under Node, never under Bun', () => {
    expect(underNode(['/app/node_modules/.bin/vitest', 'run', 'x.test.ts'])).toEqual([
      'node',
      '/app/node_modules/vitest/vitest.mjs',
      'run',
      'x.test.ts'
    ])
    expect(underNode(['bun', 'test', 'x.test.ts'])).toEqual(['bun', 'test', 'x.test.ts'])
  })
})

/** What one stub agent launch received from the Engine: its command line, working directory, environment and prompt. */
interface StubLaunch {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
  prompt: string
  /**
   * Read at launch, before the trial removes its scratch directory: the
   * generated settings naming the dev-tools server (Claude's MCP settings,
   * Codex's `config.toml`), the server command they name and that script's
   * text, and Codex's staged login.
   */
  settings: string
  mcpCommand: string
  bridge: string
  codexLogin: string | null
}

/** The generated settings a launch names its dev-tools server in, and that server's command. */
function mcpSettingsOf(command: string, args: readonly string[], env: Record<string, string | undefined>) {
  if (command === 'claude') {
    const settings = readFileSync(args[args.indexOf('--mcp-config') + 1] as string, 'utf8')
    const mcp = JSON.parse(settings) as { mcpServers: Record<string, { command: string }> }
    return { settings, mcpCommand: mcp.mcpServers[ENGINE_DEV_TOOLS_SERVER]?.command ?? '' }
  }
  const settings = readFileSync(join(env.CODEX_HOME as string, 'config.toml'), 'utf8')
  const section = settings.slice(settings.indexOf(`[mcp_servers.${ENGINE_DEV_TOOLS_SERVER}]`))
  return { settings, mcpCommand: JSON.parse(/\ncommand = (".*")\n/.exec(section)?.[1] ?? '""') as string }
}

/**
 * A stub agent the Engine's executor spawns in place of Claude Code or Codex:
 * it records its launch, reads the prompt from stdin, makes a Developer's
 * change and publication through the trial's tool-host world, and prints the
 * adapter's own structured stream ending in the role's structured output.
 */
function stubAgent(
  kind: 'change' | 'review',
  adapter: 'claude-code' | 'codex',
  world: () => { context: DevToolContext } | null,
  launches: StubLaunch[]
): SpawnFn {
  return (command, args, options) => {
    const stdout = new EventEmitter()
    const lifecycle = new EventEmitter()
    const { settings, mcpCommand } = mcpSettingsOf(command, args, options.env)
    const codexAuth = command === 'codex' ? join(options.env.CODEX_HOME as string, 'auth.json') : null
    const launch: StubLaunch = {
      command,
      args: [...args],
      cwd: options.cwd,
      env: { ...options.env },
      prompt: '',
      settings,
      mcpCommand,
      bridge: readFileSync(mcpCommand, 'utf8'),
      codexLogin: codexAuth !== null && existsSync(codexAuth) ? readFileSync(codexAuth, 'utf8') : null
    }
    launches.push(launch)
    const output =
      kind === 'change' ? { turnResult: { status: 'completed' } } : { reviewResult: { status: 'completed' } }
    const act = async () => {
      const context = world()?.context
      if (kind === 'change' && context !== undefined) {
        writeFileSync(join(options.cwd, 'apps/cli/src/lib/harbor-fake.ts'), 'export const fake = true\n')
        await context.publishChanges('Feat(cli): Add it')
        const issue = /Closes #(\d+)/.exec(launch.prompt)?.[1]
        await context.openPullRequest('t', `Closes #${issue}\n\nThe change.`)
      }
      const tools =
        kind === 'change'
          ? [
              { name: 'Bash', input: { command: 'bun run typecheck' } },
              { name: `mcp__${ENGINE_DEV_TOOLS_SERVER}__publish_changes`, input: { header: 'Feat(cli): Add it' } },
              { name: `mcp__${ENGINE_DEV_TOOLS_SERVER}__open_pull_request`, input: { title: 't' } }
            ]
          : [{ name: 'Bash', input: { command: 'git diff' } }]
      const lines =
        adapter === 'claude-code'
          ? [
              { type: 'system', subtype: 'init', session_id: 'stub-session' },
              {
                type: 'assistant',
                message: {
                  content: tools.map((tool, index) => ({ type: 'tool_use', id: `t${index}`, ...tool }))
                }
              },
              {
                type: 'result',
                subtype: 'success',
                session_id: 'stub-session',
                structured_output: output,
                usage: { input_tokens: 3, output_tokens: 2 }
              }
            ]
          : [
              { type: 'thread.started', thread_id: 'stub-thread' },
              ...tools.map((tool, index) => ({
                type: 'item.completed',
                item: tool.name.startsWith('mcp__')
                  ? {
                      id: `m${index}`,
                      type: 'mcp_tool_call',
                      server: ENGINE_DEV_TOOLS_SERVER,
                      tool: tool.name.split('__')[2],
                      arguments: tool.input
                    }
                  : { id: `c${index}`, type: 'command_execution', command: tool.input.command }
              })),
              { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: JSON.stringify(output) } },
              { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2, cached_input_tokens: 0 } }
            ]
      for (const line of lines) stdout.emit('data', `${JSON.stringify(line)}\n`)
      lifecycle.emit('close', 0)
    }
    return {
      stdin: {
        write: (chunk: string) => {
          launch.prompt += chunk
        },
        end: () => {
          setTimeout(() => void act(), 0)
        }
      },
      stdout: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => stdout.on(event, listener) },
      stderr: { on: () => {} },
      on: (event: string, listener: (...args: unknown[]) => void) => lifecycle.on(event, listener),
      kill: () => {}
    } as unknown as ReturnType<SpawnFn>
  }
}

/** Fake process steps for a container run: the role's transcript, and for a Developer its change and publication. */
function fakeSteps(
  kind: NeutralCase['kind'],
  dispatched: { cwd?: string; containerMode?: boolean }[]
): VinayaProcessSteps {
  let world: { context: DevToolContext } | null = null
  const lines =
    kind === 'change'
      ? [
          { id: 'c1', type: 'command_execution', command: 'bun run typecheck' },
          {
            id: 'm1',
            type: 'mcp_tool_call',
            server: DEV_TOOLS_MCP_SERVER_NAME,
            tool: 'publish_changes',
            arguments: { header: 'Feat(cli): Add it' }
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
  const transcript = lines.map((item) => JSON.stringify({ type: 'item.completed', item }))
  return {
    ...PRODUCTION_VINAYA_PROCESS_STEPS,
    dispatch: async (_role, _agent, prompt, opts) => {
      dispatched.push({ cwd: opts.cwd, containerMode: opts.containerMode })
      if (kind === 'change' && world !== null) {
        writeFileSync(join(opts.cwd as string, 'apps/cli/src/lib/harbor-fake.ts'), 'export const fake = true\n')
        await world.context.publishChanges('Feat(cli): Add it')
        // The world's own issue number, as the change trial's prompt names it.
        const issue = /Closes #(\d+)/.exec(prompt)?.[1]
        await world.context.openPullRequest('t', `Closes #${issue}\n\nThe change.`)
      }
      for (const line of transcript) opts.observeStdoutLine?.(line)
      return {
        exitCode: 0,
        durationMs: 5,
        usage: { input: 3, output: 2 },
        resumeId: 's',
        timedOut: false,
        ...(kind === 'review'
          ? { reviewOutput: { raw: { reviewResult: { status: 'completed' } } } }
          : { turnOutput: { raw: { turnResult: { status: 'completed' } } } })
      } as never
    },
    readOnlyTurn: async () => async () => `${transcript.join('\n')}\n`,
    startToolHost: async (opts) => {
      world = { context: opts.context }
      return { socketPath: opts.socketPath, close: async () => {} }
    }
  }
}
