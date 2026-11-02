/**
 * How the product builds its Log sinks, and the event headers they write.
 *
 * The census reads every TypeScript file in the repository for a sink built
 * (`createLogSink`) or a default factory installed, and fails on product code
 * that builds a sink anywhere but the process factory
 * (`harness/processes/vinaya-strict/integration/log/log-sink-factory.ts`), on
 * an entry point that does not install it, and on any site not listed below.
 *
 * The event headers are held identical across the change that moved the
 * branch-to-Issue reader into the process.
 *
 * `apps/cli/tests/fixtures/log-headers/recorded-headers.json` holds the
 * `meta` and `subject` of one event for each of four runs: a task in the
 * environment, a backlog branch, a tranche branch, and neither. Each run is a
 * real `bun` process in a real git checkout on that branch, building the sink
 * the product builds, with the forge read answered by a stand-in `gh` on the
 * child's `PATH` — never a live forge call. The only values normalised are
 * the two per-process random identifiers, `meta.event_id` and
 * `meta.process_id`; every other field is pinned by the probe's own inputs.
 *
 * Set `VINAYA_RECORD_LOG_HEADERS=1` to rewrite the recording from the code as
 * it stands instead of comparing with it.
 */
import { describe, expect, it } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { spawnSyncBudgeted } from './process-fixture.js'

const RECORDING = join(import.meta.dir, '..', 'fixtures', 'log-headers', 'recorded-headers.json')
const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const LOG_SINK_FACTORY = join(
  REPOSITORY_ROOT,
  'harness',
  'processes',
  'vinaya-strict',
  'integration',
  'log',
  'log-sink-factory.ts'
)

type Scenario = { name: string; branch: string; env: Record<string, string> }

const SCENARIOS: Scenario[] = [
  { name: 'task-in-environment', branch: 'main', env: { VINAYA_TASK: '404', VINAYA_ROLE: 'developer' } },
  { name: 'backlog-branch', branch: 'task/issue-792', env: {} },
  { name: 'tranche-branch', branch: 'task/log-quality-v1/1', env: {} },
  { name: 'neither', branch: 'main', env: {} }
]

// Stands in for the forge on the child's `PATH`: `gh issue view <n> --json
// number` confirms a backlog Issue, `gh issue list --label vinaya/tranche:…`
// names the tranche task's Issue; anything else fails as an unreachable forge.
const FAKE_GH =
  '#!/bin/sh\n' +
  'case "$1 $2" in\n' +
  '  "issue view") echo \'{"number":792}\' ;;\n' +
  '  "issue list") echo \'[{"number":905,"title":"[log-quality-v1] 1 — A tranche task","labels":[{"name":"vinaya/tranche:log-quality-v1"}]}]\' ;;\n' +
  '  *) echo "gh: not available in this probe" 1>&2; exit 4 ;;\n' +
  'esac\n'

const SINK_OVERRIDES = `{
  outboxRoot: () => outbox,
  resolveLogDestination: () => ({ kind: 'folder', folder: outbox }),
  home: () => outbox,
  hostname: () => 'header-recording-host',
  now: () => new Date('2026-11-01T00:00:00.000Z'),
  resolveRepo: async () => ({ owner: 'atta-labs', repo: 'vinaya' }),
  vinayaVersion: () => '0.0.0-recording',
  stderr: () => {}
}`

// The sink the product builds, with every read but the branch and the forge
// pinned; the branch read is the real one, run in the child's own checkout.
const PROBE = `import { createVinayaLogSink } from ${JSON.stringify(LOG_SINK_FACTORY)}
const outbox = process.argv[2]
const sink = createVinayaLogSink(${SINK_OVERRIDES})
sink.log({
  kind: 'dispatch',
  event: 'dispatched',
  payload: {},
  target_role: 'developer',
  model: 'sonnet',
  effect_id: 'header-recording',
  prompt_hash: 'sha256:abc'
})
await sink.drain()
`

function ndjsonUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) out.push(...ndjsonUnder(abs))
    else if (entry.endsWith('.ndjson')) out.push(abs)
  }
  return out
}

type RecordedHeader = { file: string; meta: Record<string, unknown>; subject: Record<string, unknown> }

function headerFor(scenario: Scenario): RecordedHeader {
  const scratch = mkdtempSync(join(tmpdir(), 'vinaya-header-recording-'))
  try {
    const repoDir = join(scratch, 'repo')
    const binDir = join(scratch, 'bin')
    const outbox = join(scratch, 'outbox')
    mkdirSync(repoDir)
    mkdirSync(binDir)
    const git = (...args: string[]): void => {
      const r = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
    }
    git('init', '--quiet', '--initial-branch=main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    writeFileSync(join(repoDir, 'a.txt'), 'a')
    git('add', 'a.txt')
    git('commit', '--quiet', '-m', 'init')
    if (scenario.branch !== 'main') git('checkout', '--quiet', '-b', scenario.branch)
    writeFileSync(join(binDir, 'gh'), FAKE_GH, { mode: 0o755 })
    const probe = join(scratch, 'probe.ts')
    writeFileSync(probe, PROBE)
    // A minimal, fully stated environment: nothing the test process carries
    // (a CI host's `GITHUB_*`, a dispatched session's `VINAYA_*`) reaches the
    // header.
    const run = spawnSyncBudgeted(
      'bun',
      [probe, outbox],
      {
        cwd: repoDir,
        encoding: 'utf8',
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          HOME: scratch,
          VINAYA_RUN_ID: 'header-recording-run',
          ...scenario.env
        }
      },
      60_000,
      `header recording probe (${scenario.name})`
    )
    if (run.status !== 0) throw new Error(`probe ${scenario.name} failed: ${run.stderr}`)
    const files = ndjsonUnder(outbox)
    expect(files).toHaveLength(1)
    const file = files[0] as string
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const event = JSON.parse(lines[0] as string) as { meta: Record<string, unknown>; subject: Record<string, unknown> }
    return {
      file: file.slice(outbox.length + 1),
      meta: { ...event.meta, event_id: '<random>', process_id: '<random>' },
      subject: event.subject
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// ── Every sink construction site and every factory installation ─────────────

const CENSUSED_CALLS = ['createLogSink', 'installDefaultLogSinkFactory', 'installVinayaLogSinkFactory'] as const
type CensusedCall = (typeof CENSUSED_CALLS)[number]
const EMBEDDED_CALL = new RegExp(`\\b(${CENSUSED_CALLS.join('|')})\\s*\\(`, 'g')

/** The process module that builds every sink the product uses. */
const FACTORY_MODULE = 'harness/processes/vinaya-strict/integration/log/log-sink-factory.ts'

/** The entry points that install the process factory before any command or run starts. */
const ENTRY_POINTS = ['apps/cli/src/index.ts', 'harness/processes/vinaya-strict/bin/run-engine.ts']

/**
 * Every site in the repository, as `<file> <call> <code|embedded>` with its
 * count: `code` is a call the compiler sees, `embedded` one inside a string or
 * template a test writes out as a child process's own program (or hands to an
 * analyzer as a sample). A new site fails here until it is listed, with why.
 */
const SITES: Record<string, number> = {
  // The factory itself: a sink with the process's reader or with a caller's own, and the default-sink installation.
  [`${FACTORY_MODULE} createLogSink code`]: 2,
  [`${FACTORY_MODULE} installDefaultLogSinkFactory code`]: 1,
  // The entry points.
  'apps/cli/src/index.ts installVinayaLogSinkFactory code': 1,
  'harness/processes/vinaya-strict/bin/run-engine.ts installVinayaLogSinkFactory code': 1,
  // The test processes' composition root.
  'apps/cli/tests/lib/test-env-preload.ts installVinayaLogSinkFactory code': 1,
  // Child processes a test starts with the bare default sink, installing the process factory as an entry point does.
  'apps/cli/tests/lib/log-destination.test.ts installVinayaLogSinkFactory embedded': 1,
  'apps/cli/tests/lib/log-sink-no-sync-spawn.test.ts installVinayaLogSinkFactory embedded': 1,
  'apps/cli/tests/lib/log-sink.test.ts installVinayaLogSinkFactory embedded': 1,
  'harness/processes/vinaya-strict/tests/integration/log/log-sink-factory.test.ts installVinayaLogSinkFactory embedded': 1,
  'harness/processes/vinaya-strict/tests/lib/task-tools/cancel.test.ts installVinayaLogSinkFactory embedded': 2,
  'apps/cli/tests/fixtures/checks/run-and-hang.ts installVinayaLogSinkFactory code': 1,
  // Kernel contract tests: each builds the Log client's own sink with a branch reader it gives itself.
  'apps/cli/tests/checks/runner.test.ts createLogSink code': 1,
  'apps/cli/tests/commands/log-emit.test.ts createLogSink code': 1,
  'apps/cli/tests/lib/log-custom.test.ts createLogSink code': 1,
  'apps/cli/tests/lib/log-destination.test.ts createLogSink code': 4,
  'apps/cli/tests/lib/log-destination.test.ts createLogSink embedded': 1,
  'apps/cli/tests/lib/log-sink.test.ts createLogSink code': 50,
  'apps/cli/tests/lib/log-sink.test.ts createLogSink embedded': 2,
  'apps/cli/tests/lib/log-sync-folder-source.test.ts createLogSink code': 2,
  // Samples the destination-isolation analyzer reads as text; nothing runs them.
  'apps/cli/tests/log-destination-isolation.test.ts createLogSink embedded': 2
}

const CENSUS_FILE = 'apps/cli/tests/lib/log-sink-factory.test.ts'

const isTestPath = (path: string): boolean => path.includes('/tests/') || /\.test\.tsx?$/.test(path)

function censusedSites(): Record<string, number> {
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.tsx', '*.mts'],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }
  )
    .split('\0')
    // This file names every call as text; it is the census, not a site.
    .filter(
      (f) => f !== '' && f !== CENSUS_FILE && !f.includes('node_modules/') && existsSync(join(REPOSITORY_ROOT, f))
    )
  const sites: Record<string, number> = {}
  const count = (key: string): void => {
    sites[key] = (sites[key] ?? 0) + 1
  }
  for (const file of files) {
    const text = readFileSync(join(REPOSITORY_ROOT, file), 'utf8')
    if (!CENSUSED_CALLS.some((name) => text.includes(name))) continue
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : ''
        if ((CENSUSED_CALLS as readonly string[]).includes(callee)) count(`${file} ${callee as CensusedCall} code`)
      }
      const literal =
        ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
          ? node.text
          : ts.isTemplateExpression(node)
            ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('\n')
            : null
      if (literal !== null) for (const match of literal.matchAll(EMBEDDED_CALL)) count(`${file} ${match[1]} embedded`)
      if (!ts.isTemplateExpression(node)) ts.forEachChild(node, visit)
      else for (const span of node.templateSpans) visit(span.expression)
    }
    visit(source)
  }
  return sites
}

describe('every Log sink is built through the process factory', () => {
  const sites = censusedSites()

  it('no product code builds a sink, or installs a default factory, anywhere but the process factory', () => {
    const bypassing = Object.keys(sites).filter((site) => {
      const [file, call] = site.split(' ') as [string, CensusedCall]
      if (isTestPath(file)) return false
      if (call === 'installVinayaLogSinkFactory') return false
      return file !== FACTORY_MODULE
    })
    expect(bypassing).toEqual([])
  })

  it('each entry point, and only an entry point, installs the process factory', () => {
    const installing = Object.keys(sites)
      .filter((site) => site.endsWith(' installVinayaLogSinkFactory code'))
      .map((site) => site.split(' ')[0] as string)
      .filter((file) => !isTestPath(file))
      .sort()
    expect(installing).toEqual([...ENTRY_POINTS].sort())
    // Every process runner the process ships as a program is one of them.
    const binDir = join(REPOSITORY_ROOT, 'harness', 'processes', 'vinaya-strict', 'bin')
    const runners = readdirSync(binDir)
      .filter((name) => name.endsWith('.ts') && readFileSync(join(binDir, name), 'utf8').includes('import.meta.main'))
      .map((name) => `harness/processes/vinaya-strict/bin/${name}`)
    for (const runner of runners) expect(ENTRY_POINTS).toContain(runner)
  })

  it('the entry point installs the factory before it runs any command', () => {
    const entry = readFileSync(join(REPOSITORY_ROOT, 'apps', 'cli', 'src', 'index.ts'), 'utf8')
    const installedAt = entry.indexOf('\ninstallVinayaLogSinkFactory()')
    expect(installedAt).toBeGreaterThan(-1)
    for (const first of ['\nensureGhOnPath()', '\nmaybeDeferToAuthorRepoSource()', '\nrecordCliOperationAtExit(']) {
      expect(entry.indexOf(first)).toBeGreaterThan(installedAt)
    }
  })

  it('lists every construction site and installation in the repository', () => {
    expect(sites).toEqual(SITES)
  })
})

describe('the Log sink writes the recorded event headers', () => {
  it('for a task in the environment, a backlog branch, a tranche branch and neither', () => {
    const headers: Record<string, RecordedHeader> = {}
    for (const scenario of SCENARIOS) headers[scenario.name] = headerFor(scenario)
    if (process.env.VINAYA_RECORD_LOG_HEADERS === '1') {
      mkdirSync(join(RECORDING, '..'), { recursive: true })
      writeFileSync(RECORDING, `${JSON.stringify(headers, null, 2)}\n`)
    }
    expect(headers).toEqual(JSON.parse(readFileSync(RECORDING, 'utf8')))
  }, 240_000)
})
