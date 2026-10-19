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
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  gradeTrial,
  type GradingSpec,
  measureChange,
  type OracleSpec,
  oracleAgentPart,
  splitRecord,
  underNode,
  writeGrade
} from '../../src/lib/dev-review-eval/harbor-grade'
import {
  AGENT_ALLOWED_HOSTS,
  CHANGE_CASE_INSTALL,
  type ConvertedSuite,
  convertHarborTasks,
  HARBOR_SUITE_KEYS,
  HARBOR_VERSION,
  harborTasksCommand,
  isExcludedPath,
  REPOSITORY_ROOT,
  suiteName,
  writeArchive
} from '../../src/lib/dev-review-eval/harbor-tasks'
import { type HarborCaseFile, runHarborTrial } from '../../src/lib/dev-review-eval/harbor-trial'
import type { NeutralCase } from '../../src/lib/dev-review-eval/neutral-case'
import { PRODUCTION_VINAYA_PROCESS_STEPS, type VinayaProcessSteps } from '../../src/lib/dev-review-eval/step-one'
import { renderCase, VINAYA_RENDERER_VERSION } from '../../src/lib/dev-review-eval/vinaya-renderer'
import { stripVinayaEnv } from '../lib/process-fixture'
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
  const dir = mkdtempSync(join(tmpdir(), prefix))
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

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
})

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
          timeoutMs: 1000
        },
        fakeSteps(kind, dispatched)
      ).finally(() => {
        if (priorToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = priorToken
      })
      expect(outcome).toEqual({ ok: true })
      // The case file is gone before the role starts; the record and the usage are written.
      expect(existsSync(casePath)).toBe(false)
      const record = readJson<ReturnType<typeof splitRecord>['agent']>(recordPath)
      expect(readJson<{ inputTokens: number }>(usagePath).inputTokens).toBeGreaterThanOrEqual(0)
      // The record is an agent part: the verifier's two facts unset, every other field the split's.
      const rendered = renderCase(caseFile.case)
      if (!rendered.ok) throw new Error('the case does not render')
      const oracle = readJson<OracleSpec>(join(dir, 'solution/reference.json'))
      const split = splitRecord(referenceRecord(oracle, rendered.input)).agent
      expect(Object.keys(record).sort()).toEqual(Object.keys(split).sort())
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

  it('refuses a backend other than standalone and an adapter other than Claude Code before reading the case', async () => {
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
    expect(await runHarborTrial({ ...options, backend: 'engine' })).toMatchObject({ ok: false, refused: true })
    expect(await runHarborTrial({ ...options, adapter: 'codex' })).toMatchObject({ ok: false, refused: true })
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
    dispatch: async (_role, _agent, _prompt, opts) => {
      dispatched.push({ cwd: opts.cwd, containerMode: opts.containerMode })
      if (kind === 'change' && world !== null) {
        writeFileSync(join(opts.cwd as string, 'apps/cli/src/lib/harbor-fake.ts'), 'export const fake = true\n')
        await world.context.publishChanges('Feat(cli): Add it')
        await world.context.openPullRequest('t', 'Closes #1\n\nThe change.')
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
