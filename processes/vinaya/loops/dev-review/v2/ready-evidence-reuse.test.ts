import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentCommandText,
  extractAgentCommandLines,
  recordGreenTestRun,
  runAgentCommand,
  type TestRunCache,
  type TestRunCacheRecord
} from '../../../../../apps/cli/src/lib/pr-report-engine'
import { readyTestCommand } from '../../../../../apps/cli/src/lib/pre-push-test-runner'
import { checkBareDigits } from '../../../../../apps/cli/src/checks/body-bare-digits-logic'
import { fixtureDir } from '../../../../../apps/cli/tests/lib/test-temp-fixture'
import { readyGateEvidence } from './flow-v2-live'
import { readyTestPlanCommand, withReadyTestCommand } from './v2-actions'

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
