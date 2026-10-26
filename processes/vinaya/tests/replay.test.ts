import { fixtureDir } from '../../../apps/cli/tests/lib/test-temp-fixture'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runDirectory } from '../bin/run-engine'
import { blocked, git, PR, replay, requestChanges, TASK, VINAYA_INSTALL } from './replay-world'

// The replay world (`replay-world.ts`) runs one task end to end on the Engine path with recorded agent streams.

const generated = (runtimeDir: string, role: string, file: string) =>
  readFileSync(join(runtimeDir, 'engine-runs', String(TASK), 'generated', role, file), 'utf8')

let codexHome: string | undefined
beforeAll(() => {
  // The operator's Codex login the runner copies into each Codex role's generated home.
  codexHome = process.env.CODEX_HOME
  const home = fixtureDir('replay-codex-home-')
  writeFileSync(join(home, 'auth.json'), '{"tokens":"replay"}')
  process.env.CODEX_HOME = home
})
afterAll(() => {
  if (codexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = codexHome
})

for (const vendor of ['claude', 'codex'] as const)
  describe(`replay on ${vendor}`, () => {
    test('green path: the task completes and publishes round 1, with every live fix in place', async () => {
      const run = await replay({ vendor })
      expect(run.trace.outcome).toBe('completed')
      expect(run.result.exitCode).toBe(0)
      expect(run.spawns.map((s) => s.step)).toEqual(['develop', 'code-review', 'security-review'])
      // Each Developer launch begins a turn: its head and its launch record are written before the agent starts.
      expect(run.developerTurnsBegun).toBe(1)
      // The turn's launch record is closed with the Developer's own vendor session, so a later run can resume it.
      expect(run.developerTurnsCompleted).toHaveLength(1)
      expect(typeof run.developerTurnsCompleted[0]).toBe('string')
      // The tool bridges start the CLI of the Vinaya install, never one under the task's repository.
      const bridges = readdirSync(runDirectory(run.runtimeDir, TASK)).filter((f) => f.endsWith('.sh'))
      expect(bridges.length).toBeGreaterThan(0)
      for (const bridge of bridges) {
        const text = readFileSync(join(runDirectory(run.runtimeDir, TASK), bridge), 'utf8')
        expect(text).toContain(join(VINAYA_INSTALL, 'apps', 'cli', 'src', 'index.ts'))
        expect(text).not.toContain(join(run.root, 'apps', 'cli'))
      }
      // The forge calls the runner makes, in order.
      expect(run.forgeCalls).toEqual([`readiness task/issue-${TASK}`, `worktree task/issue-${TASK}`, 'publish round 1'])
      expect(run.published).toEqual([
        { round: 1, prNumber: PR, expectedHead: git(run.worktree, 'rev-parse', 'HEAD'), heldFound: true }
      ])
      // The checks run the repository's CLI entry (never this process's argv[1]), in the worktree, with the PR env.
      expect(run.cliCalls).toEqual([
        { args: ['check', '--all'], cwd: run.worktree, pr: String(PR), branch: `task/issue-${TASK}` }
      ])
      // Grant placeholders are resolved in the generated settings.
      const developerSettings =
        vendor === 'claude'
          ? generated(run.runtimeDir, 'developer', 'role-settings.json')
          : generated(run.runtimeDir, 'developer', 'config.toml')
      expect(developerSettings).not.toContain('${')
      expect(developerSettings).toContain(run.worktree)
      // The agent environment carries the Keychain login names.
      for (const name of ['USER', 'LOGNAME'])
        if (process.env[name] !== undefined) expect(run.spawns[0]?.env[name]).toBe(process.env[name])
      // The vendor prints the event stream the executor frames, and its result is read from it.
      if (vendor === 'codex') {
        expect(run.spawns[0]?.args).toContain('--json')
        const auth = join(run.runtimeDir, 'engine-runs', String(TASK), 'generated', 'developer', 'auth.json')
        expect(statSync(auth).mode & 0o777).toBe(0o600)
      } else expect(run.spawns[0]?.args).toEqual(expect.arrayContaining(['--output-format', 'stream-json']))
      // The Developer's first prompt is the loop's round-1 prompt, with the kept work named.
      const first = run.spawns[0]?.prompt ?? ''
      expect(first).toContain('DEVELOPER DOCTRINE (replay)')
      expect(first).toContain('Kept work:')
      expect(first).toContain('notes.md')
      // Nothing the run wrote lands in the repository: only the task worktree was added.
      expect(readdirSync(run.root).sort()).toEqual([...run.before, '.worktrees'].sort())
      // The Log events the run emitted, in order (each name once, first occurrence).
      const names = [...new Set(run.events.map((e) => e.event ?? e.kind ?? ''))]
      expect(names).toEqual(
        expect.arrayContaining(['loop_started', 'round_started', 'gate_result_read', 'verdicts_read'])
      )
      expect(names.indexOf('gate_result_read')).toBeLessThan(names.indexOf('verdicts_read'))
    })

    test('a red gate loops back to develop, which continues its own session', async () => {
      const run = await replay({ vendor, gates: [1, 0] })
      expect(run.trace.outcome).toBe('completed')
      const develops = run.spawns.filter((s) => s.step === 'develop')
      expect(develops).toHaveLength(2)
      const session = vendor === 'claude' ? 'claude-replay-session-develop' : 'codex-replay-thread-develop'
      expect(develops[1]?.args.slice(0, 3)).toEqual(
        vendor === 'claude' ? ['-p', '--resume', session] : ['exec', 'resume', session]
      )
      expect(develops[1]?.prompt).toContain('The checks (`vinaya check --all`) are red on the last head.')
      expect(develops[1]?.prompt).toContain('✗ closes-n: fail')
      expect(run.cliCalls).toHaveLength(2)
      expect(run.published.map((p) => p.round)).toEqual([1])
    })

    test('a revise round: findings reach round 2, the round advances once, and the held verdicts are found at publish', async () => {
      const run = await replay({ vendor, codeReview: { 1: requestChanges(vendor) } })
      expect(run.trace.outcome).toBe('completed')
      const develops = run.spawns.filter((s) => s.step === 'develop')
      expect(develops).toHaveLength(2)
      const second = develops[1]?.prompt ?? ''
      expect(second).toContain('Round 2 review findings:')
      expect(second).toContain('The paragraph still names the old gate.')
      expect(second).toContain(`Resuming task Issue #${TASK}.`)
      expect(second).toContain('Finding ids in this handoff')
      // Publication reads round 2's held verdicts: the round advanced on revise and not again on publish.
      expect(run.published).toEqual([expect.objectContaining({ round: 2, heldFound: true })])
    })

    test('a blocked reviewer pauses the run for a human, and nothing is published', async () => {
      const run = await replay({ vendor, codeReview: { 1: blocked(vendor) } })
      expect(run.trace.outcome).toBe('paused')
      expect(run.trace.pauseReason).toBe('escalation')
      expect(run.handoff.calls).toEqual([
        'escalation:escalation',
        'pause-state:escalation',
        expect.stringMatching(/^comment:pr:escalation$/)
      ])
      expect(run.published).toEqual([])
    })

    test('the reviewers can read on this vendor and cannot write', async () => {
      const run = await replay({ vendor })
      for (const role of ['code-reviewer', 'security-reviewer']) {
        if (vendor === 'codex') {
          const toml = generated(run.runtimeDir, role, 'config.toml')
          expect(toml).toContain('shell_tool = true')
          expect(toml).toContain('sandbox_mode = "read-only"')
        } else {
          const settings = JSON.parse(generated(run.runtimeDir, role, 'role-settings.json'))
          expect(settings.permissions.allow).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob']))
          expect(settings.sandbox.filesystem.allowWrite).toEqual([])
        }
      }
    })
  })
