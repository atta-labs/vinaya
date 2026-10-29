import { describe, expect, test } from 'bun:test'
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
  type TestRunCacheRecord
} from '../../../../../apps/cli/src/lib/pr-report-engine'
import { readyTestCommand } from '../../../../../apps/cli/src/lib/pre-push-test-runner'
import { READY_TESTS_DEFERRED_RECORD, readyCiPlanCommand } from '../../../../../apps/cli/src/lib/pre-push-ready-policy'
import { writeJsonUnderGit } from '../../../../../apps/cli/src/lib/pre-push-failed-tests'
import { checkBareDigits } from '../../../../../apps/cli/src/checks/body-bare-digits-logic'
import { compareEvidenceBlock } from '../../../../../apps/cli/src/checks/evidence-fresh-logic'
import { resolveAnchoredRegion, ScanContext } from '../../../../../apps/cli/src/checks/scan-context'
import { fixtureDir } from '../../../../../apps/cli/tests/lib/test-temp-fixture'
import { readyGateEvidence, runExplicitCommandsLive } from './flow-v2-live'
import { prReportCommand } from '../../../../../apps/cli/src/commands/pr-report'
import { useRuntimeDir } from '../../../tests/round-fakes'
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
  '<!-- AEG:TEST-PLAN:START -->',
  '```',
  'bun test tests/other.test.ts → passes',
  'bun apps/cli/src/index.ts check --all → exit 0',
  '```',
  '<!-- AEG:TEST-PLAN:END -->',
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
      `## Evidence\n\n<!-- AEG:EVIDENCE:START -->\n[generated by the driver at open]\n<!-- AEG:EVIDENCE:END -->\n\n${BODY}`,
      readyTestPlanCommand(selected, dir)
    )
    const composed = await readyGateEvidence({ body: staged, head, resultPath, worktreePath: dir })
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

describe('persisted ready-gate evidence', () => {
  test('the block the driver writes into a real-shaped body passes the pull-request body gate', async () => {
    const { dir } = worktree()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: dir })
    const body =
      '## Evidence\n\n<!-- AEG:EVIDENCE:START -->\n[generated by the driver at open]\n<!-- AEG:EVIDENCE:END -->\n\n## Test plan\n- run tests\n'
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
    const composed = await readyGateEvidence({ body, head, resultPath, worktreePath: dir })
    expect(composed).toContain(`Head: ${head}`)
    expect(composed).toContain('No local tests ran.')
    expect(composed).toContain('persisted ready-gate result')
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
      '<!-- AEG:EVIDENCE:START -->',
      '[generated by the driver at open]',
      '<!-- AEG:EVIDENCE:END -->',
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
    const region = resolveAnchoredRegion(ScanContext.from(composed), 'EVIDENCE')
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
