import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'

const BIN = join(import.meta.dir, '../../src/checks/bin/check-review-gate.ts')

/**
 * The review check owns reviews, and nothing else decides its result.
 *
 * It used to fail for two conditions it does not own: any other check-run
 * on the head being red, and a `[principal]` Test Plan box still unticked.
 * Every merge condition is its own independent check now, so that all green
 * means mergeable — a red sibling is already red under its own name, and the
 * principal Test Plan wait is a check of its own. This spins up a real
 * throwaway repo and a stubbed `gh` carrying both of those conditions, and
 * measures that neither reaches the check: the check-run endpoint is never
 * called at all, and the unticked box is never named in the output.
 */
describe('check-review-gate — reviews only', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('never reads other check-runs, and never names an unticked [principal] Test Plan item', async () => {
    dir = mkdtempSync(join(tmpdir(), 'review-gate-reviews-only-'))
    const g = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    g(['init', '-q', '-b', 'work'])
    g(['config', 'user.email', 't@example.com'])
    g(['config', 'user.name', 'test'])
    writeFileSync(join(dir, 'a.txt'), 'content\n')
    g(['add', '-A'])
    g(['commit', '-qm', 'initial'])
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    g(['remote', 'add', 'origin', dir])
    g(['branch', 'main'])

    // Written by the stub the moment anything asks it for this head's
    // check-runs. Its absence after the run is the assertion.
    const checkRunsProbe = join(dir, 'check-runs-was-fetched.txt')
    const body = ['## Test Plan', '', '- [ ] **[principal]** verify in a signed-in browser', ''].join('\n')
    const ghDir = join(dir, 'fakebin')
    execFileSync('mkdir', ['-p', ghDir])
    const ghPath = join(ghDir, 'gh')
    writeFileSync(
      ghPath,
      `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: 1,
    comments: [],
    labels: [],
    headRefName: 'work',
    headRefOid: ${JSON.stringify(sha)},
    baseRefName: 'main',
    body: ${JSON.stringify(body)}
  }))
  process.exit(0)
}
if (args[0] === 'api' && String(args[1]).includes('/check-runs')) {
  writeFileSync(${JSON.stringify(checkRunsProbe)}, args.join(' '))
  process.stdout.write('{"id":1,"name":"Vinaya CI","status":"completed","conclusion":"failure"}\\n')
  process.exit(0)
}
process.stderr.write('gh stub: unhandled invocation: ' + args.join(' ') + '\\n')
process.exit(1)
`
    )
    chmodSync(ghPath, 0o755)

    const proc = Bun.spawn(['bun', BIN], {
      cwd: dir,
      env: { ...process.env, PATH: `${ghDir}:${process.env.PATH}`, PR_NUMBER: '1' },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const stderr = await new Response(proc.stderr).text()
    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited

    // The red sibling check is never even fetched.
    expect(existsSync(checkRunsProbe)).toBe(false)
    // The unticked `[principal]` box is not this check's to name.
    const output = `${stdout}${stderr}`
    expect(output).not.toContain('[principal]')
    expect(output).not.toContain('Test Plan')
    // It still refuses for the one condition it does own: this fixture's PR
    // carries no verdict at all.
    expect(exitCode).toBe(1)
    expect(output).toContain('code-reviewer verdict is not a clean APPROVE')
  })
})

/**
 * The same rule, bound to the two sources rather than to one run: neither
 * the review check's own adapter nor the pure gate function it calls may
 * reference another check's results or the Test Plan tick logic. Comments
 * are stripped before the scan — both files DESCRIBE what they no longer do,
 * and a test that could not tell prose from code would forbid saying so.
 */
describe('check-review-gate — architecture: the source references neither other checks nor Test Plan ticks', () => {
  /** Line and block comments removed, so only executable text is scanned. */
  function codeOf(relPath: string): string {
    const src = readFileSync(join(import.meta.dir, relPath), 'utf-8')
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  }

  const FORBIDDEN: { pattern: RegExp; owns: string }[] = [
    { pattern: /mechanicalCheck/i, owns: "another check's result" },
    { pattern: /check-runs/i, owns: "another check's result" },
    { pattern: /gh pr checks/i, owns: "another check's result" },
    { pattern: /REVIEW_GATE_CHECK_RUN_NAME/, owns: "another check's result" },
    { pattern: /bucket/i, owns: "another check's result" },
    { pattern: /evaluateTestPlanGate/, owns: 'the Test Plan tick-state' },
    { pattern: /\[principal\]/i, owns: 'the Test Plan tick-state' },
    { pattern: /uncheckedPrincipal/i, owns: 'the Test Plan tick-state' }
  ]

  for (const relPath of [
    '../../src/checks/bin/check-review-gate.ts',
    '../../../../packages/aeg-core/src/review-gate.ts'
  ]) {
    it(`${relPath} carries none of them`, () => {
      const code = codeOf(relPath)
      // Sanity: the stripper left real code behind, so an empty string can
      // never be what makes this pass.
      expect(code).toContain('checkReviewGate')
      const hits = FORBIDDEN.filter((f) => f.pattern.test(code)).map((f) => `${f.pattern.source} (${f.owns})`)
      expect(hits).toEqual([])
    })
  }
})
