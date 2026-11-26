import { describe, expect, test } from 'bun:test'
import { REGION_PREFIXES } from '@harness/workflow/tools/legacy-markers'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentCommandText,
  DeferredEvidenceError,
  extractAgentCommandLines,
  recordGreenTestRun,
  runAgentCommand,
  type TestRunCache,
  type TestRunCacheRecord,
  testRunCacheKey
} from '@harness/workflow/tools/pr-report/pr-report-engine'
import {
  ADOPTER_TEST_RUNNER,
  nativeRunCommand,
  readyTestCommand
} from '@harness/kernel/gates/ring0-hooks/pre-push/pre-push-test-runner'
import { READY_TESTS_DEFERRED_RECORD, readyCiPlanCommand } from '@harness/workflow/tools/pre-push-ready-policy'
import { writeJsonUnderGit } from '@harness/kernel/gates/ring0-hooks/pre-push/pre-push-failed-tests'
import { checkBareDigits } from '@harness/workflow/tools/body-bare-digits-logic'
import { compareEvidenceBlock } from '@harness/workflow/checks/evidence-fresh-logic'
import { resolveAnchoredRegion, ScanContext } from '@harness/kernel/gates/checks/scan-context'
import { fixtureDir } from '@harness/kernel/conformance/unit/test-temp-fixture'
import { readyGateEvidence, runExplicitCommandsLive } from './flow-v2-live'
import { prReportCommand } from '@harness/workflow/tools/pr-report/bin/pr-report'
import { useRuntimeDir } from '@harness/workflow/tests/round-fakes'
import { explicitTestPlanCommands, readyTestPlanCommand, withReadyTestCommand } from './v2-actions'

// The loop writes the ready push's own test command as the staged body's Test Plan line, so the Evidence write
// (`pr report --push`, whose Test Plan commands go through `runAgentCommand`) reuses the run the ready push cached
// for the same head instead of running the tests again.

const memoryCache = (): TestRunCache => {
  const store = new Map<string, TestRunCacheRecord>()
  return { get: (key) => store.get(key), set: (key, record) => void store.set(key, record) }
}

const BODY = [
  '## Test plan',
  '',
  '<!-- VINAYA:TEST-PLAN:START -->',
  '```',
  'bun test tests/other.test.ts → passes',
  'bun apps/cli/src/index.ts check --all → exit 0',
  '```',
  '<!-- VINAYA:TEST-PLAN:END -->',
  ''
].join('\n')

function worktree(): { dir: string; marker: string } {
  const dir = fixtureDir('ready-evidence-')
  const marker = join(fixtureDir('ready-evidence-marker-'), 'ran')
  // A test file that leaves a marker outside the worktree whenever it really runs.
  writeFileSync(
    join(dir, 'a.test.ts'),
    `import { test } from 'bun:test'\nimport { writeFileSync } from 'node:fs'\ntest('a', () => writeFileSync(${JSON.stringify(marker)}, 'ran'))\n`
  )
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' })
  git('init', '-q', '-b', 'task/1')
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base')
  return { dir, marker }
}

describe('the Evidence write reuses the ready push run', () => {
  test('the Test Plan line becomes the ready push command; other commands stay', () => {
    const body = withReadyTestCommand(BODY, readyTestCommand(['/w/a.test.ts']))
    expect(extractAgentCommandLines(body).map(agentCommandText)).toEqual([
      'bun test --timeout=30000 -- /w/a.test.ts',
      'bun apps/cli/src/index.ts check --all'
    ])
  })

  test('with the Test Plan line equal to the ready push command at the same head, the evidence write runs no tests', async () => {
    const { dir, marker } = worktree()
    const cache = memoryCache()
    const command = readyTestCommand([join(dir, 'a.test.ts')])
    // What the ready push's hook records after its green run at this head.
    expect(await recordGreenTestRun(command, '1 pass', dir, 'pre-push', cache)).toBe(true)
    const body = withReadyTestCommand(BODY, command)
    const testLine = extractAgentCommandLines(body).map(agentCommandText)[0] as string
    const result = await runAgentCommand(testLine, 60000, dir, {}, cache)
    expect(result.reusedFrom).toBeDefined()
    expect(result.output).toBe('1 pass')
    expect(existsSync(marker)).toBe(false)
  })

  test('the body names the selection relative to the worktree, and that line still reuses the hook run per file', async () => {
    const { dir, marker } = worktree()
    const cache = memoryCache()
    const selected = [join(dir, 'a.test.ts')]
    // The hook records its own command, with absolute paths, unchanged.
    expect(await recordGreenTestRun(readyTestCommand(selected), '1 pass', dir, 'pre-push', cache)).toBe(true)
    const line = readyTestPlanCommand(selected, dir)
    expect(line).toBe('bun test --timeout=30000 -- ./a.test.ts')
    const testLine = extractAgentCommandLines(withReadyTestCommand(BODY, line)).map(agentCommandText)[0] as string
    expect(testLine).toBe(line)
    const result = await runAgentCommand(testLine, 60000, dir, {}, cache)
    expect(result.reusedFrom).toBeDefined()
    expect(result.output).toBe('1 pass')
    expect(existsSync(marker)).toBe(false)
  })
})

describe('the Evidence the driver composes after a ready push', () => {
  test('bounds a huge ready-push output to its tail and names the selection relative to the worktree', async () => {
    const { dir, marker } = worktree()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: dir })
    const selected = [join(dir, 'a.test.ts')]
    const lastLine = ' 1 pass\n 0 fail'
    const output = `${'x'.repeat(19_000_000 - lastLine.length - 1)}\n${lastLine}`
    expect(output.length).toBe(19_000_000)
    const resultPath = join(dir, '.git', 'ready-result.json')
    writeFileSync(
      resultPath,
      JSON.stringify({
        head,
        gate: {
          passed: true,
          output,
          selection: { version: 1, mode: 'full', head, fullCount: 1, selected },
          failed: [],
          wallMs: 1
        }
      })
    )
    const staged = withReadyTestCommand(
      `## Evidence\n\n<!-- VINAYA:EVIDENCE:START -->\n[generated by the driver at open]\n<!-- VINAYA:EVIDENCE:END -->\n\n${BODY}`,
      readyTestPlanCommand(selected, dir)
    )
    // The driver's receipt for the plan's other command, recorded at this head after the hook.
    const cache = memoryCache()
    expect(await recordGreenTestRun('bun apps/cli/src/index.ts check --all', 'ok', dir, 'pr-report', cache)).toBe(true)
    const composed = await readyGateEvidence({ body: staged, head, resultPath, worktreePath: dir, cache })
    expect(composed.length).toBeLessThan(65_536)
    const testLine = extractAgentCommandLines(composed).map(agentCommandText)[0] as string
    expect(testLine).toBe('bun test --timeout=30000 -- ./a.test.ts')
    // The Group C heading is byte-identical to the Test Plan line, and its fence ends with the output's last line.
    const heading = `#### C1: \`${testLine}\``
    expect(composed).toContain(heading)
    const fence = composed.slice(composed.indexOf(heading)).split('```')[1] as string
    expect(fence).toContain('earlier characters truncated')
    expect(fence.endsWith(`${lastLine}\n`)).toBe(true)
    for (const line of [testLine, heading]) expect(line).not.toContain(dir)
    expect(existsSync(marker)).toBe(false)
  })
})

describe('the Evidence base the driver composes against', () => {
  test('a supplied immutable base is the comparison, even when the remote-tracking ref is stale', async () => {
    const { dir } = worktree()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
    const base = git('rev-parse', 'HEAD')
    writeFileSync(join(dir, 'later.txt'), 'later\n')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'task')
    const head = git('rev-parse', 'HEAD')
    // The stale ref already contains the task: against it the diff is empty.
    git('update-ref', 'refs/remotes/origin/main', head)
    const body =
      '## Evidence\n\n<!-- VINAYA:EVIDENCE:START -->\n[generated by the driver at open]\n<!-- VINAYA:EVIDENCE:END -->\n\n## Test plan\n- run tests\n'
    const resultPath = join(dir, '.git', 'ready-result.json')
    writeFileSync(
      resultPath,
      JSON.stringify({
        head,
        gate: {
          passed: true,
          output: 'no tests selected',
          selection: { version: 1, mode: 'full', head, fullCount: 0, selected: [] },
          failed: [],
          wallMs: 1
        }
      })
    )
    const stale = await readyGateEvidence({ body, head, resultPath, worktreePath: dir })
    expect(stale).not.toContain('later.txt')
    const fresh = await readyGateEvidence({ body, head, resultPath, worktreePath: dir, base })
    expect(fresh).toContain('later.txt')
    expect(fresh).toContain(base)
  })
})

describe('persisted ready-gate evidence', () => {
  test('the block the driver writes into a real-shaped body passes the pull-request body gate', async () => {
    const { dir } = worktree()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: dir })
    const body =
      '## Evidence\n\n<!-- VINAYA:EVIDENCE:START -->\n[generated by the driver at open]\n<!-- VINAYA:EVIDENCE:END -->\n\n## Test plan\n- run tests\n'
    const resultPath = join(dir, '.git', 'ready-result.json')
    writeFileSync(
      resultPath,
      JSON.stringify({
        head,
        gate: {
          passed: true,
          output: 'no tests selected',
          selection: { version: 1, mode: 'full', head, fullCount: 0, selected: [] },
          failed: [],
          wallMs: 1
        }
      })
    )
    const composed = await readyGateEvidence({ body, head, resultPath, worktreePath: dir })
    // The gate refusing this block leaves the placeholder in place, and the evidence check then fails on every such pull request.
    expect(checkBareDigits(composed).violations).toEqual([])
  })

  test.each(['no selected files', 'missing fenced plan'])('%s never executes a body command', async (shape) => {
    const { dir, marker } = worktree()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: dir })
    const body =
      shape === 'missing fenced plan'
        ? '## Test plan\n- run tests\n'
        : `## Test plan\n\n\`\`\`\nbun -e 'require("fs").writeFileSync(${JSON.stringify(marker)}, "reran")' → passes\n\`\`\`\n`
    const resultPath = join(dir, '.git', 'ready-result.json')
    writeFileSync(
      resultPath,
      JSON.stringify({
        head,
        gate: {
          passed: true,
          output: 'no tests selected',
          selection: { version: 1, mode: 'full', head, fullCount: 0, selected: [] },
          failed: [],
          wallMs: 1
        }
      })
    )
    if (shape === 'missing fenced plan') {
      const composed = await readyGateEvidence({ body, head, resultPath, worktreePath: dir })
      expect(composed).toContain(`Head: ${head}`)
      expect(composed).toContain('No local tests ran.')
      expect(composed).toContain('(no [agent] commands in the Test Plan section)')
    } else {
      // No hook run stands for the command and it holds no receipt: the composer refuses rather than running it.
      await expect(
        readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache: memoryCache() })
      ).rejects.toThrow('no green receipt')
    }
    expect(existsSync(marker)).toBe(false)
    writeFileSync(resultPath, JSON.stringify({ head: 'stale', gate: { passed: true } }))
    await expect(readyGateEvidence({ body, head, resultPath, worktreePath: dir })).rejects.toThrow('approved head')
  })
})

// A deferred head: the hook ran every cheap gate, deferred the selected tests to required CI and recorded that for
// the head; the driver ran the explicit Test Plan commands at the publication boundary and recorded their receipts.
describe('the Evidence of a head whose ready push deferred its tests to required CI', () => {
  const POLICY = { mode: 'ci' as const, workflow: '.github/workflows/ci.yml', check: 'Vinaya CI' }
  const ciLine = readyCiPlanCommand(POLICY)

  function deferredWorktree() {
    const { dir, marker } = worktree()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: dir })
    const resultPath = join(dir, '.git', 'ready-result.json')
    writeFileSync(
      resultPath,
      JSON.stringify({
        head,
        gate: {
          passed: true,
          output: 'deferred',
          selection: null,
          failed: [],
          wallMs: 1,
          localTests: 'deferred',
          requiredCi: { workflow: POLICY.workflow, check: POLICY.check }
        }
      })
    )
    writeJsonUnderGit(dir, READY_TESTS_DEFERRED_RECORD, {
      version: 1,
      kind: 'ready',
      head,
      branch: 'task/1',
      runId: 'run-1',
      workflow: POLICY.workflow,
      check: POLICY.check,
      recordedAt: new Date().toISOString()
    })
    return { dir, marker, head, resultPath }
  }

  // A multi-command plan: the automatic line, a cd-wrapped test, a non-test verification command.
  const explicitTest = (marker: string) =>
    `cd . && bun -e 'require("fs").appendFileSync(${JSON.stringify(marker)}, "x")'`
  const verify = 'bun -e "process.exit(0)"'
  const planBody = (marker: string) =>
    [
      '## Evidence',
      '',
      '<!-- VINAYA:EVIDENCE:START -->',
      '[generated by the driver at open]',
      '<!-- VINAYA:EVIDENCE:END -->',
      '',
      '## Test plan',
      '',
      '```',
      'bun test tests/other.test.ts → passes',
      `${explicitTest(marker)} → exits 0`,
      `${verify} → exits 0`,
      '```',
      ''
    ].join('\n')

  test('the staged plan names the required-CI line first and keeps every explicit command in order', () => {
    const body = withReadyTestCommand(planBody('/m'), ciLine, 'passes in required CI')
    expect(extractAgentCommandLines(body).map(agentCommandText)).toEqual([ciLine, explicitTest('/m'), verify])
    expect(explicitTestPlanCommands(body)).toEqual([explicitTest('/m'), verify])
  })

  test('pending for the selected suite, the driver receipts for the rest: the real freshness and body gates pass, nothing runs', async () => {
    const { dir, marker, head, resultPath } = deferredWorktree()
    const cache = memoryCache()
    const body = withReadyTestCommand(planBody(marker), ciLine, 'passes in required CI')
    // The driver's receipts at the publication boundary: genuine green runs at this head and tree.
    for (const command of explicitTestPlanCommands(body))
      expect(await recordGreenTestRun(command, 'ok', dir, 'pr-report', cache)).toBe(true)
    const composed = await readyGateEvidence({
      body,
      head,
      resultPath,
      worktreePath: dir,
      cache,
      deferral: { readPolicy: () => POLICY }
    })
    expect(composed).toContain('[pending in required CI]')
    expect(composed).not.toMatch(/\[exit /)
    expect(composed.match(/_Reused from /g)?.length).toBe(2)
    expect(existsSync(marker)).toBe(false)
    const region = resolveAnchoredRegion(ScanContext.from(composed, REGION_PREFIXES), 'EVIDENCE')
    if (region === null || region === 'hidden') throw new Error('no evidence region')
    const expected = extractAgentCommandLines(composed).map(agentCommandText)
    expect(expected).toEqual([ciLine, explicitTest(marker), verify])
    expect(compareEvidenceBlock(region, head, '', expected).status).toBe('pass')
    expect(checkBareDigits(composed).violations).toEqual([])
    // The same block with a heading dropped is refused by the same gate: the comparison covers the whole list.
    expect(compareEvidenceBlock(region, head, '', expected.slice(0, 2)).status).toBe('fail')
  })

  test('a command with no receipt refuses before anything executes, and so does a record for another head', async () => {
    const { dir, marker, head, resultPath } = deferredWorktree()
    const body = withReadyTestCommand(planBody(marker), ciLine, 'passes in required CI')
    const deps = { readPolicy: () => POLICY }
    await expect(
      readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache: memoryCache(), deferral: deps })
    ).rejects.toThrow(DeferredEvidenceError)
    expect(existsSync(marker)).toBe(false)
    const cache = memoryCache()
    for (const command of explicitTestPlanCommands(body))
      await recordGreenTestRun(command, 'ok', dir, 'pr-report', cache)
    const stale = { ...deps, readRecord: () => null }
    await expect(
      readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache, deferral: stale })
    ).rejects.toThrow('no deferred-tests record names head')
    await expect(
      readyGateEvidence({
        body,
        head,
        resultPath,
        worktreePath: dir,
        cache,
        deferral: { readPolicy: () => ({ mode: 'local' }) }
      })
    ).rejects.toThrow('no longer names that check')
    await expect(
      readyGateEvidence({
        body,
        head,
        resultPath,
        worktreePath: dir,
        cache,
        deferral: {
          readPolicy: () => {
            throw new Error('offline')
          }
        }
      })
    ).rejects.toThrow('could not be read')
    expect(existsSync(marker)).toBe(false)
  })
})

// The real driver/report path on a deferred head: the driver records the explicit command's receipt at the
// publication boundary (`runExplicitCommandsLive`, into the repository's own test-run cache), then the real
// `vinaya pr report` command — reading the default branch's policy through the trust anchor, the hook's
// deferred-tests record and that cache by itself — renders the selected suite pending and reuses the receipt, twice,
// running nothing.
describe('`vinaya pr report` on a deferred head reuses the receipts the driver recorded', () => {
  class ReportExit extends Error {
    constructor(public code: number | undefined) {
      super(`process.exit(${code})`)
    }
  }
  const POLICY = { mode: 'ci' as const, workflow: '.github/workflows/ci.yml', check: 'Vinaya CI' }
  const ENV_KEYS = [
    'VINAYA_RUNTIME_DIR',
    'GITHUB_ACTIONS',
    'VINAYA_CI_CONFIG_PROBE_REF',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'PR_BODY',
    'BRANCH'
  ]

  test('pending for the selected suite, the driver receipt for the explicit command, exit zero, nothing re-run', async () => {
    const dir = fixtureDir('deferred-report-')
    const counter = join(fixtureDir('deferred-report-counter-'), 'runs')
    const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
    const originalCwd = process.cwd()
    const originalExit = process.exit
    try {
      const env = { ...process.env }
      for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' })
      git('init', '-q', '-b', 'task/issue-1')
      // The default branch opts in: the trust anchor this report reads is `origin/main`'s committed config.
      writeFileSync(join(dir, 'vinaya.config.json'), JSON.stringify({ prePush: { readyTests: POLICY } }))
      git('add', '.')
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base')
      git('update-ref', 'refs/remotes/origin/main', 'HEAD')
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
      // What the hook records when it deferred this head's selected tests.
      writeJsonUnderGit(dir, READY_TESTS_DEFERRED_RECORD, {
        version: 1,
        kind: 'ready',
        head,
        branch: 'task/issue-1',
        runId: 'run-1',
        workflow: POLICY.workflow,
        check: POLICY.check,
        recordedAt: new Date().toISOString()
      })
      useRuntimeDir(fixtureDir('deferred-report-runtime-'))
      process.env.GITHUB_ACTIONS = 'true'
      process.env.VINAYA_CI_CONFIG_PROBE_REF = 'origin/main'
      delete process.env.GH_TOKEN
      delete process.env.GITHUB_TOKEN
      const explicit = `cd . && printf x >> ${JSON.stringify(counter)}`
      const body = [
        '## Test plan',
        '',
        '```',
        `${readyCiPlanCommand(POLICY)} → passes in required CI`,
        `${explicit} → exits 0`,
        '```',
        ''
      ].join('\n')
      // The driver at the publication boundary: the command really runs once and its receipt is recorded.
      const driven = await runExplicitCommandsLive({
        worktreePath: dir,
        head,
        branch: 'task/issue-1',
        body,
        commands: explicitTestPlanCommands(body),
        deadlineAt: Date.now() + 60_000
      })
      expect(driven.outcome).toBe('passed')
      expect(readFileSync(counter, 'utf8')).toBe('x')
      const bodyPath = join(fixtureDir('deferred-report-body-'), 'body.md')
      const report = async () => {
        writeFileSync(bodyPath, body)
        process.chdir(dir)
        process.exit = ((code?: number) => {
          throw new ReportExit(code)
        }) as never
        let code: number | undefined
        try {
          await prReportCommand(['--write', bodyPath], {
            gateRunner: () => ({ failed: false, outcomes: [{ name: 'g', status: 'pass', errors: [] }] })
          })
        } catch (err) {
          if (!(err instanceof ReportExit)) throw err
          code = err.code
        } finally {
          process.exit = originalExit
          process.chdir(originalCwd)
        }
        return { code, written: readFileSync(bodyPath, 'utf8') }
      }
      for (const _refresh of [1, 2]) {
        const { code, written } = await report()
        expect(code).toBe(0)
        expect(written).toContain('[pending in required CI]')
        expect(written).toContain(`#### C2: \`${explicit}\``)
        expect(written).toContain('_Reused from ')
        expect(written).not.toMatch(/\[exit /)
      }
      // The explicit command ran only the once the driver ran it; nothing ran the selected suite.
      expect(readFileSync(counter, 'utf8')).toBe('x')
    } finally {
      process.exit = originalExit
      process.chdir(originalCwd)
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      useRuntimeDir(null)
    }
  })

  test('a later command that writes git-ignored files leaves every earlier command its receipt', async () => {
    const dir = fixtureDir('deferred-report-ignored-')
    const counter = join(fixtureDir('deferred-report-ignored-counter-'), 'runs')
    const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
    const originalCwd = process.cwd()
    const originalExit = process.exit
    try {
      const env = { ...process.env }
      for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' })
      git('init', '-q', '-b', 'task/issue-1')
      writeFileSync(join(dir, 'vinaya.config.json'), JSON.stringify({ prePush: { readyTests: POLICY } }))
      writeFileSync(join(dir, '.gitignore'), 'cache/\n')
      git('add', '.')
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base')
      git('update-ref', 'refs/remotes/origin/main', 'HEAD')
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
      writeJsonUnderGit(dir, READY_TESTS_DEFERRED_RECORD, {
        version: 1,
        kind: 'ready',
        head,
        branch: 'task/issue-1',
        runId: 'run-1',
        workflow: POLICY.workflow,
        check: POLICY.check,
        recordedAt: new Date().toISOString()
      })
      useRuntimeDir(fixtureDir('deferred-report-ignored-runtime-'))
      process.env.GITHUB_ACTIONS = 'true'
      process.env.VINAYA_CI_CONFIG_PROBE_REF = 'origin/main'
      delete process.env.GH_TOKEN
      delete process.env.GITHUB_TOKEN
      // The first command passes and leaves the tree as it was; the second writes a git-ignored cache file, as a
      // typecheck that fills its build cache does.
      const first = `cd . && printf x >> ${JSON.stringify(counter)}`
      const second = 'mkdir -p cache && printf stamp > cache/stamp'
      const body = [
        '## Test plan',
        '',
        '```',
        `${readyCiPlanCommand(POLICY)} → passes in required CI`,
        `${first} → exits 0`,
        `${second} → exits 0`,
        '```',
        ''
      ].join('\n')
      const driven = await runExplicitCommandsLive({
        worktreePath: dir,
        head,
        branch: 'task/issue-1',
        body,
        commands: explicitTestPlanCommands(body),
        deadlineAt: Date.now() + 60_000
      })
      expect(driven.outcome).toBe('passed')
      const bodyPath = join(fixtureDir('deferred-report-ignored-body-'), 'body.md')
      writeFileSync(bodyPath, body)
      process.chdir(dir)
      process.exit = ((code?: number) => {
        throw new ReportExit(code)
      }) as never
      let code: number | undefined
      try {
        await prReportCommand(['--write', bodyPath], {
          gateRunner: () => ({ failed: false, outcomes: [{ name: 'g', status: 'pass', errors: [] }] })
        })
      } catch (err) {
        if (!(err instanceof ReportExit)) throw err
        code = err.code
      } finally {
        process.exit = originalExit
        process.chdir(originalCwd)
      }
      const written = readFileSync(bodyPath, 'utf8')
      expect(code).toBe(0)
      expect(written).toContain(`#### C2: \`${first}\``)
      expect(written).toContain(`#### C3: \`${second}\``)
      expect(written).not.toMatch(/\[exit /)
      // The first command ran only the once the driver ran it.
      expect(readFileSync(counter, 'utf8')).toBe('x')
    } finally {
      process.exit = originalExit
      process.chdir(originalCwd)
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      useRuntimeDir(null)
    }
  })

  test('the driver’s Evidence refuses a deferred-tests record left by another run', async () => {
    const dir = fixtureDir('deferred-report-run-')
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' })
    git('init', '-q', '-b', 'task/issue-1')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    writeJsonUnderGit(dir, READY_TESTS_DEFERRED_RECORD, {
      version: 1,
      kind: 'ready',
      head,
      branch: 'task/issue-1',
      runId: 'another-run',
      workflow: POLICY.workflow,
      check: POLICY.check,
      recordedAt: new Date().toISOString()
    })
    const resultPath = join(dir, '.git', 'ready-result.json')
    writeFileSync(
      resultPath,
      JSON.stringify({
        head,
        gate: {
          passed: true,
          output: '',
          selection: null,
          failed: [],
          wallMs: 1,
          localTests: 'deferred',
          requiredCi: { ...POLICY, runId: 'run-1' }
        }
      })
    )
    const body = `## Test plan\n\n\`\`\`\n${readyCiPlanCommand(POLICY)} → passes in required CI\n\`\`\`\n`
    await expect(
      readyGateEvidence({
        body,
        head,
        resultPath,
        worktreePath: dir,
        cache: memoryCache(),
        deferral: { readPolicy: () => POLICY }
      })
    ).rejects.toThrow('no deferred-tests record names head')
  })
})

// A passed local ready push: the hook ran the selected suite, the driver then ran every other Test Plan command and
// recorded its receipt; the composer reads both and runs nothing.
describe('the Evidence of a head whose ready push ran its selected tests locally', () => {
  test('one entry per Test Plan command, in order: the real freshness and body gates pass and nothing ran twice', async () => {
    const { dir, marker } = worktree()
    const counter = join(fixtureDir('local-evidence-counter-'), 'runs')
    writeFileSync(
      join(dir, 'b.test.ts'),
      `import { test } from 'bun:test'\nimport { appendFileSync } from 'node:fs'\ntest('b', () => appendFileSync(${JSON.stringify(counter)}, 'x'))\n`
    )
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' })
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'second')
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    git('update-ref', 'refs/remotes/origin/main', head)
    const selected = [join(dir, 'a.test.ts')]
    const resultPath = join(dir, '.git', 'ready-result.json')
    writeFileSync(
      resultPath,
      JSON.stringify({
        head,
        gate: {
          passed: true,
          output: ' 1 pass\n 0 fail',
          selection: { version: 1, mode: 'full', head, fullCount: 1, selected },
          failed: [],
          wallMs: 1
        }
      })
    )
    const explicitTest = 'cd . && bun test --timeout=30000 ./b.test.ts'
    const verify = 'bun -e "process.exit(0)"'
    const body = withReadyTestCommand(
      [
        '## Evidence',
        '',
        '<!-- VINAYA:EVIDENCE:START -->',
        '[generated by the driver at open]',
        '<!-- VINAYA:EVIDENCE:END -->',
        '',
        '## Test plan',
        '',
        '```',
        'bun test tests/other.test.ts → passes',
        `${explicitTest} → 0 fail`,
        `${verify} → exits 0`,
        '```',
        ''
      ].join('\n'),
      readyTestPlanCommand(selected, dir)
    )
    const commands = explicitTestPlanCommands(body)
    expect(commands).toEqual([explicitTest, verify])
    const cache = memoryCache()
    const saved = process.env.VINAYA_RUNTIME_DIR
    useRuntimeDir(fixtureDir('local-evidence-runtime-'))
    try {
      const driven = await runExplicitCommandsLive({
        worktreePath: dir,
        head,
        branch: 'task/1',
        body,
        commands,
        deadlineAt: Date.now() + 120_000,
        cache
      })
      expect(driven).toMatchObject({ outcome: 'passed' })
    } finally {
      if (saved === undefined) delete process.env.VINAYA_RUNTIME_DIR
      else process.env.VINAYA_RUNTIME_DIR = saved
      useRuntimeDir(null)
    }
    expect(readFileSync(counter, 'utf8')).toBe('x')
    const composed = await readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache })
    const region = resolveAnchoredRegion(ScanContext.from(composed, REGION_PREFIXES), 'EVIDENCE')
    if (region === null || region === 'hidden') throw new Error('no evidence region')
    const expected = extractAgentCommandLines(composed).map(agentCommandText)
    expect(expected).toEqual([readyTestPlanCommand(selected, dir), explicitTest, verify])
    expect(compareEvidenceBlock(region, head, '', expected).status).toBe('pass')
    expect(checkBareDigits(composed).violations).toEqual([])
    expect(composed.match(/_Reused from /g)?.length).toBe(3)
    // Nothing ran a second time: the selected suite stayed the hook run, the explicit test ran only for the driver.
    expect(readFileSync(counter, 'utf8')).toBe('x')
    expect(existsSync(marker)).toBe(false)
    // A command with no receipt at this head makes the composer throw rather than run it.
    await expect(
      readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache: memoryCache() })
    ).rejects.toThrow('no green receipt')
    expect(readFileSync(counter, 'utf8')).toBe('x')
  })

  test('on an already open pull request, an earlier push’s file list gives way to this push’s own selection', async () => {
    const { dir, marker } = worktree()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: dir })
    const selected = [join(dir, 'a.test.ts')]
    const resultPath = join(dir, '.git', 'ready-result.json')
    writeFileSync(
      resultPath,
      JSON.stringify({
        head,
        gate: {
          passed: true,
          output: ' 1 pass\n 0 fail',
          selection: { version: 1, mode: 'full', head, fullCount: 2, selected },
          failed: [],
          wallMs: 1
        }
      })
    )
    const verify = 'bun -e "process.exit(0)"'
    const stale = readyTestPlanCommand([join(dir, 'a.test.ts'), join(dir, 'b.test.ts')], dir)
    const body = withReadyTestCommand(['## Test plan', '', '```', `${verify} → exits 0`, '```', ''].join('\n'), stale)
    const cache = memoryCache()
    expect(await recordGreenTestRun(verify, 'ok', dir, 'pr-report', cache)).toBe(true)
    const composed = await readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache })
    const expected = extractAgentCommandLines(composed).map(agentCommandText)
    expect(expected).toEqual([readyTestPlanCommand(selected, dir), verify])
    expect(composed).toContain(`${readyTestPlanCommand(selected, dir)} → every selected test file passes`)
    const region = resolveAnchoredRegion(ScanContext.from(composed, REGION_PREFIXES), 'EVIDENCE')
    if (region === null || region === 'hidden') throw new Error('no evidence region')
    expect(compareEvidenceBlock(region, head, '', expected).status).toBe('pass')
    expect(existsSync(marker)).toBe(false)
  })
})

describe('the Evidence of a head whose native local run passed and that still owes required CI', () => {
  const CONTEXT = 'c'.repeat(64)
  const OTHER = 'd'.repeat(64)
  const IDENTITIES = ['a.test.ts@default']

  // `identities` is what this push ran; `planIdentities` is what the live body's Test Plan line names — an earlier
  // push's selection when the pull request was already open; `extra` are explicit Test Plan lines after it.
  function nativeHead(
    identities: readonly string[] = IDENTITIES,
    planIdentities: readonly string[] = identities,
    extra: readonly string[] = []
  ) {
    const { dir, marker } = worktree()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: dir })
    const command = nativeRunCommand(CONTEXT, identities)
    const resultPath = join(dir, '.git', 'ready-result.json')
    writeFileSync(
      resultPath,
      JSON.stringify({
        head,
        gate: {
          passed: true,
          output: ' 1 pass\n 0 fail',
          selection: {
            version: 1,
            mode: 'full',
            head,
            fullCount: 1,
            selected: [join(dir, 'a.test.ts')],
            native: { version: 1, context: CONTEXT, identities, groups: [], command }
          },
          failed: [],
          wallMs: 1,
          // A locally tested head that owes the required check: no `localTests`, so its tests were not deferred.
          requiredCi: { workflow: '.github/workflows/ci.yml', check: 'Vinaya CI' }
        }
      })
    )
    const body = withReadyTestCommand(
      [
        '## Evidence',
        '',
        '<!-- VINAYA:EVIDENCE:START -->',
        '[generated by the driver at open]',
        '<!-- VINAYA:EVIDENCE:END -->',
        '',
        '## Test plan',
        '',
        '```',
        'bun test tests/other.test.ts → passes',
        ...extra,
        '```',
        ''
      ].join('\n'),
      nativeRunCommand(CONTEXT, planIdentities),
      'every selected test passes under its own native runner'
    )
    return { dir, marker, head, command, resultPath, body }
  }

  test('the plan and the Evidence name the aggregate native command and compose its receipt; nothing runs', async () => {
    const { dir, marker, head, command, resultPath, body } = nativeHead()
    expect(explicitTestPlanCommands(body)).toEqual([])
    const cache = memoryCache()
    expect(await recordGreenTestRun(command, ' 1 pass\n 0 fail', dir, 'pre-push', cache, { context: CONTEXT })).toBe(
      true
    )
    const composed = await readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache })
    const region = resolveAnchoredRegion(ScanContext.from(composed, REGION_PREFIXES), 'EVIDENCE')
    if (region === null || region === 'hidden') throw new Error('no evidence region')
    const expected = extractAgentCommandLines(composed).map(agentCommandText)
    expect(expected).toEqual([command])
    expect(compareEvidenceBlock(region, head, '', expected).status).toBe('pass')
    expect(checkBareDigits(composed).violations).toEqual([])
    expect(composed).not.toContain('pending in required CI')
    expect(composed).not.toContain('required-ci')
    expect(composed.match(/_Reused from /g)?.length).toBe(1)
    expect(existsSync(marker)).toBe(false)
  })

  test('on an already open pull request, the Test Plan line becomes this push’s own command, matching Group C; other lines keep their order', async () => {
    // The live body still names the first push's 14-identity selection; this push ran and recorded only 10 of them.
    const all = Array.from({ length: 14 }, (_, i) => `t${i}.test.ts@default`)
    const ran = all.slice(0, 10)
    const verify = 'bun -e "process.exit(0)"'
    const { dir, marker, head, command, resultPath, body } = nativeHead(ran, all, [`${verify} → exits 0`])
    const stale = nativeRunCommand(CONTEXT, all)
    expect(extractAgentCommandLines(body).map(agentCommandText)).toEqual([stale, verify])
    const cache = memoryCache()
    expect(await recordGreenTestRun(command, ' 10 pass\n 0 fail', dir, 'pre-push', cache, { context: CONTEXT })).toBe(
      true
    )
    expect(await recordGreenTestRun(verify, 'ok', dir, 'pr-report', cache)).toBe(true)
    const composed = await readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache })
    const expected = extractAgentCommandLines(composed).map(agentCommandText)
    expect(expected).toEqual([command, verify])
    expect(composed).not.toContain(stale)
    const region = resolveAnchoredRegion(ScanContext.from(composed, REGION_PREFIXES), 'EVIDENCE')
    if (region === null || region === 'hidden') throw new Error('no evidence region')
    expect(compareEvidenceBlock(region, head, '', expected).status).toBe('pass')
    // The stale line against the same Evidence is what evidence-fresh refused before: the comparison stays exact.
    expect(compareEvidenceBlock(region, head, '', [stale, verify]).status).not.toBe('pass')
    expect(checkBareDigits(composed).violations).toEqual([])
    expect(existsSync(marker)).toBe(false)
  })

  test('a missing receipt, an unqualified legacy receipt, or one under another context refuses; nothing runs', async () => {
    const { dir, marker, head, command, resultPath, body } = nativeHead()
    await expect(
      readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache: memoryCache() })
    ).rejects.toThrow('no receipt')
    // A receipt written before contexts were recorded names no context: it never stands for the native command.
    const legacy = memoryCache()
    const key = (await testRunCacheKey(command, dir)) as string
    legacy.set(key, {
      output: ' 1 pass',
      exitCode: 0,
      timedOut: false,
      overflowed: false,
      recordedAt: '2026-10-01T00:00:00.000Z',
      source: 'pre-push'
    })
    await expect(readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache: legacy })).rejects.toThrow(
      'no receipt'
    )
    // A run recorded under another context cannot be filed for this command at all.
    const other = memoryCache()
    expect(await recordGreenTestRun(command, ' 1 pass', dir, 'pre-push', other, { context: OTHER })).toBe(false)
    await expect(readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache: other })).rejects.toThrow(
      'no receipt'
    )
    expect(existsSync(marker)).toBe(false)
  })
})

// A repository whose pre-push hook runs its declared test runner: the ready push ran local tests and left no
// selection note, so the runner itself is the Test Plan's test line and the Group C heading of the hook's run.
describe('the Evidence of a head whose ready push ran the repository’s declared test runner', () => {
  const setup = async () => {
    const { dir, marker } = worktree()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: dir })
    const resultPath = join(dir, '.git', 'ready-result.json')
    writeFileSync(
      resultPath,
      JSON.stringify({
        head,
        gate: { passed: true, output: ' 3 pass\n 0 fail', selection: null, failed: [], wallMs: 1 }
      })
    )
    const verify = 'bun -e "process.exit(0)"'
    const body = [
      '## Evidence',
      '',
      '<!-- VINAYA:EVIDENCE:START -->',
      '[generated by the driver at open]',
      '<!-- VINAYA:EVIDENCE:END -->',
      '',
      '## Test plan',
      '',
      '```',
      'bun test tests/cart.test.ts → passes',
      `${verify} → exits 0`,
      '```',
      ''
    ].join('\n')
    const cache = memoryCache()
    expect(await recordGreenTestRun(verify, 'ok', dir, 'pr-report', cache)).toBe(true)
    return { dir, marker, head, resultPath, verify, body, cache }
  }

  test('the Test Plan and Group C both name the runner first and the other commands after it: evidence-fresh passes, nothing runs', async () => {
    const { dir, marker, head, resultPath, verify, body, cache } = await setup()
    const composed = await readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache })
    const expected = extractAgentCommandLines(composed).map(agentCommandText)
    expect(expected).toEqual([ADOPTER_TEST_RUNNER, verify])
    expect(composed).toContain(`${ADOPTER_TEST_RUNNER} → every test passes`)
    expect(composed).not.toContain('tests/cart.test.ts')
    const region = resolveAnchoredRegion(ScanContext.from(composed, REGION_PREFIXES), 'EVIDENCE')
    if (region === null || region === 'hidden') throw new Error('no evidence region')
    // The Group C section is present, so the heading comparison really runs.
    expect(region.maskedRegion).toMatch(/^### Group C — Test Plan commands/m)
    const headings = [...region.region.matchAll(/^####\s+C\d+:\s+`(.*)`\s*$/gm)].map((match) => match[1])
    expect(headings).toEqual([ADOPTER_TEST_RUNNER, verify])
    expect(compareEvidenceBlock(region, head, '', expected).status).toBe('pass')
    // The Developer's replaced line no longer matches: the heading names the runner the hook ran.
    expect(compareEvidenceBlock(region, head, '', ['bun test tests/cart.test.ts', verify]).status).toBe('fail')
    expect(region.region).toContain(' 3 pass')
    expect(checkBareDigits(composed).violations).toEqual([])
    expect(existsSync(marker)).toBe(false)
  })

  test('the same record fed twice leaves exactly one runner line in the Test Plan', async () => {
    const { dir, head, resultPath, verify, body, cache } = await setup()
    const once = await readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache })
    const twice = await readyGateEvidence({ body: once, head, resultPath, worktreePath: dir, cache })
    const commands = extractAgentCommandLines(twice).map(agentCommandText)
    expect(commands).toEqual([ADOPTER_TEST_RUNNER, verify])
    expect(commands.filter((command) => command === ADOPTER_TEST_RUNNER)).toHaveLength(1)
    expect(explicitTestPlanCommands(twice)).toEqual([verify])
    const region = resolveAnchoredRegion(ScanContext.from(twice, REGION_PREFIXES), 'EVIDENCE')
    if (region === null || region === 'hidden') throw new Error('no evidence region')
    expect(compareEvidenceBlock(region, head, '', commands).status).toBe('pass')
  })

  test('a non-test command with no receipt refuses rather than running', async () => {
    const { dir, marker, head, resultPath, body } = await setup()
    await expect(
      readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache: memoryCache() })
    ).rejects.toThrow('no green receipt')
    expect(existsSync(marker)).toBe(false)
  })
})

describe('the Evidence of a head whose ready push ran no local tests', () => {
  // The repository declares no test runner: the hook ran every gate, printed its marker and ran no test.
  const setup = () => {
    const { dir, marker } = worktree()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: dir })
    const resultPath = join(dir, '.git', 'ready-result.json')
    writeFileSync(
      resultPath,
      JSON.stringify({
        head,
        gate: {
          passed: true,
          output: 'vinaya pre-push: no local tests (no test runner declared at .vinaya/test-runner)\n',
          selection: null,
          failed: [],
          wallMs: 1,
          localTests: 'none'
        }
      })
    )
    const planBody = (lines: string[]) =>
      [
        '## Evidence',
        '',
        '<!-- VINAYA:EVIDENCE:START -->',
        '[generated by the driver at open]',
        '<!-- VINAYA:EVIDENCE:END -->',
        '',
        '## Test plan',
        '',
        '```',
        ...lines,
        '```',
        ''
      ].join('\n')
    return { dir, marker, head, resultPath, planBody }
  }

  test('an adopter’s Test Plan command with a green receipt is Group C’s heading, and evidence-fresh passes', async () => {
    const { dir, marker, head, resultPath, planBody } = setup()
    const vitest = 'npx vitest run src/App.test.tsx'
    const body = planBody([`${vitest} → the Keet Lite heading is found by role and name`])
    // The explicit command the driver now runs at a no-local-tests ready push.
    expect(explicitTestPlanCommands(body)).toEqual([vitest])
    const cache = memoryCache()
    expect(await recordGreenTestRun(vitest, ' Test Files  1 passed', dir, 'pr-report', cache)).toBe(true)
    const composed = await readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache })
    // The expected list is the body's own Test Plan, exactly as evidence-fresh derives it; the body is unchanged.
    const expected = extractAgentCommandLines(composed).map(agentCommandText)
    expect(expected).toEqual([vitest])
    const region = resolveAnchoredRegion(ScanContext.from(composed, REGION_PREFIXES), 'EVIDENCE')
    if (region === null || region === 'hidden') throw new Error('no evidence region')
    expect(region.maskedRegion).toMatch(/^### Group C — Test Plan commands/m)
    const headings = [...region.region.matchAll(/^####\s+C\d+:\s+`(.*)`\s*$/gm)].map((match) => match[1])
    expect(headings).toEqual([vitest])
    expect(compareEvidenceBlock(region, head, '', expected).status).toBe('pass')
    expect(checkBareDigits(composed).violations).toEqual([])
    expect(existsSync(marker)).toBe(false)
  })

  test('a test-run-shaped Test Plan line is its own Group C heading from its receipt, in the Test Plan’s order', async () => {
    const { dir, marker, head, resultPath, planBody } = setup()
    const test = 'bun test ./a.test.ts'
    const verify = 'bun -e "process.exit(0)"'
    const body = planBody([`${test} → the heading is found by role and name`, `${verify} → exits 0`])
    const cache = memoryCache()
    expect(await recordGreenTestRun(test, ' 1 pass', dir, 'pr-report', cache)).toBe(true)
    expect(await recordGreenTestRun(verify, 'ok', dir, 'pr-report', cache)).toBe(true)
    const composed = await readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache })
    const expected = extractAgentCommandLines(composed).map(agentCommandText)
    expect(expected).toEqual([test, verify])
    const region = resolveAnchoredRegion(ScanContext.from(composed, REGION_PREFIXES), 'EVIDENCE')
    if (region === null || region === 'hidden') throw new Error('no evidence region')
    const headings = [...region.region.matchAll(/^####\s+C\d+:\s+`(.*)`\s*$/gm)].map((match) => match[1])
    expect(headings).toEqual([test, verify])
    expect(compareEvidenceBlock(region, head, '', expected).status).toBe('pass')
    expect(checkBareDigits(composed).violations).toEqual([])
    expect(existsSync(marker)).toBe(false)
    // With no receipt for the test-run line, the composer refuses rather than standing a hook run in for it.
    const partial = memoryCache()
    expect(await recordGreenTestRun(verify, 'ok', dir, 'pr-report', partial)).toBe(true)
    await expect(readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache: partial })).rejects.toThrow(
      'no green receipt'
    )
    expect(existsSync(marker)).toBe(false)
  })

  test('a Test Plan with no command: Group C has no heading and Group B carries the hook’s no-local-tests line', async () => {
    const { dir, head, resultPath } = setup()
    const body = [
      '## Evidence',
      '',
      '<!-- VINAYA:EVIDENCE:START -->',
      '[generated by the driver at open]',
      '<!-- VINAYA:EVIDENCE:END -->',
      '',
      '## Test plan',
      '- checked by hand',
      ''
    ].join('\n')
    const composed = await readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache: memoryCache() })
    const expected = extractAgentCommandLines(composed).map(agentCommandText)
    expect(expected).toEqual([])
    const region = resolveAnchoredRegion(ScanContext.from(composed, REGION_PREFIXES), 'EVIDENCE')
    if (region === null || region === 'hidden') throw new Error('no evidence region')
    expect(region.maskedRegion).toMatch(/^### Group C — Test Plan commands/m)
    expect([...region.region.matchAll(/^####\s+C\d+:/gm)]).toHaveLength(0)
    expect(compareEvidenceBlock(region, head, '', expected).status).toBe('pass')
    expect(region.region).toContain(
      'note: No local tests ran. vinaya pre-push: no local tests (no test runner declared at .vinaya/test-runner)'
    )
    expect(checkBareDigits(composed).violations).toEqual([])
  })

  test('the driver’s own run of the explicit commands is the receipt Group C composes; nothing runs twice', async () => {
    const { dir, head, resultPath, planBody } = setup()
    const counter = join(fixtureDir('none-evidence-counter-'), 'runs')
    const verify = `bun -e 'require("fs").appendFileSync(${JSON.stringify(counter)}, "x")'`
    const body = planBody([`${verify} → exits 0`])
    const cache = memoryCache()
    const saved = process.env.VINAYA_RUNTIME_DIR
    useRuntimeDir(fixtureDir('none-evidence-runtime-'))
    try {
      const driven = await runExplicitCommandsLive({
        worktreePath: dir,
        head,
        branch: 'task/1',
        body,
        commands: explicitTestPlanCommands(body),
        deadlineAt: Date.now() + 120_000,
        cache
      })
      expect(driven).toMatchObject({ outcome: 'passed' })
    } finally {
      if (saved === undefined) delete process.env.VINAYA_RUNTIME_DIR
      else process.env.VINAYA_RUNTIME_DIR = saved
      useRuntimeDir(null)
    }
    expect(readFileSync(counter, 'utf8')).toBe('x')
    const composed = await readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache })
    const region = resolveAnchoredRegion(ScanContext.from(composed, REGION_PREFIXES), 'EVIDENCE')
    if (region === null || region === 'hidden') throw new Error('no evidence region')
    expect(compareEvidenceBlock(region, head, '', [verify]).status).toBe('pass')
    expect(readFileSync(counter, 'utf8')).toBe('x')
    // Without that receipt the composer refuses rather than running the command.
    await expect(
      readyGateEvidence({ body, head, resultPath, worktreePath: dir, cache: memoryCache() })
    ).rejects.toThrow('no green receipt')
    expect(readFileSync(counter, 'utf8')).toBe('x')
  })
})
