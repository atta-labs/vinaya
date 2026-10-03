/**
 * The sandbox conformance suite — the proof of both agents' boundaries
 * (`apps/cli/specs/isolation.md`, "The conformance suite").
 *
 * Every command the Developer doctrine and the rendered brief tell a
 * Developer to run is an entry in `commands.json`; each runnable entry runs
 * inside Claude Code's sandbox and inside Codex's, configured as the driver
 * configures a confined Developer dispatch (`sandbox-launch.ts`). A command
 * either exits 0 under both, or is listed in `KNOWN_FAILURES` below with its
 * agent, its platform and the denial it hits today. A listed command that
 * now exits 0 fails the suite until its entry is removed, so the list only
 * shrinks.
 *
 * The command-list checks run on every `bun test`. The sandboxed runs need
 * both runtimes and minutes of wall time, so they run only when
 * `VINAYA_SANDBOX_CONFORMANCE=1` — CI's `sandbox-conformance` job on Linux,
 * and on a Mac, from `apps/cli`:
 *
 *   VINAYA_SANDBOX_CONFORMANCE=1 bun test --timeout=900000 tests/sandbox-conformance/sandbox-conformance.test.ts
 *
 * in a terminal outside any agent's sandbox (a sandbox cannot start another
 * one inside itself). On a task branch every entry runs; elsewhere the
 * entries that need a task's identity are skipped.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { commandsTheTextsName } from './command-sources.js'
import {
  AGENTS,
  type Agent,
  COMMAND_BUDGET_MS,
  openSandboxSession,
  type SandboxSession,
  sourceBranch,
  taskIdentity
} from './sandbox-launch.js'

type CommandEntry = {
  id: string
  forms: string[]
  run?: string
  notRun?: string
  needsTaskBranch?: boolean
}

const ENTRIES: CommandEntry[] = (
  JSON.parse(readFileSync(join(import.meta.dir, 'commands.json'), 'utf8')) as { commands: CommandEntry[] }
).commands

/** The commands the suite must always run, whatever else the texts name. */
const ALWAYS_RUN_IDS = [
  'git-status',
  'git-diff',
  'bun-install',
  'bun-test-one-file',
  'doctrine-developer',
  'check-dispatch-readiness',
  'gh-issue-view'
]

type Platform = 'darwin' | 'linux'

type KnownFailure = {
  readonly id: string
  readonly agent: Agent
  readonly platform: Platform
  /** The denial the command hits today, as its own output names it. */
  readonly denial: string
}

const GH_CONFIG_DENIED =
  'gh exits before reaching the forge: "failed to read configuration: open ~/.config/gh/config.yml: operation not permitted" — the real home is denied read'
const BUN_HIDDEN_LINUX =
  'bun is not found: the runner installs it under ~/.bun, and the denied home is mounted empty, so the binary is gone inside the sandbox'

/**
 * Today's denials. Remove an entry the moment its command passes — the
 * suite fails until you do.
 */
const KNOWN_FAILURES: readonly KnownFailure[] = [
  {
    id: 'typecheck',
    agent: 'claude',
    platform: 'darwin',
    denial:
      'turbo exits 1: "Encountered an I/O error while attempting to read ~/Library/Application Support/com.vercel.cli/auth.json" — the real home is denied read'
  },
  {
    id: 'typecheck',
    agent: 'codex',
    platform: 'linux',
    denial:
      'turbo exits 1: "failed to create directory `<main checkout>/.turbo/cache` … Read-only file system" — turbo keeps a linked worktree\'s cache in the main checkout, outside the writable roots'
  },
  {
    id: 'bun-install',
    agent: 'codex',
    platform: 'linux',
    denial:
      'bun install exits 1: "bun is unable to write files to tempdir: EROFS" — its temp directory is outside the writable roots'
  },
  {
    id: 'verify-dispatch',
    agent: 'codex',
    platform: 'linux',
    denial:
      'verify-dispatch exits 1 on "leftover-detection: stop — 2 commit(s) already ahead of origin/main on this task branch", then "verify-dispatch: NOT READY"'
  },
  {
    id: 'check-all',
    agent: 'codex',
    platform: 'linux',
    denial:
      'check --all exits 1 on "closes-n: PR body does not contain `Closes #1026`" (no PR body reaches the sandbox); the log outbox also hits "EROFS: read-only file system, mkdir ~/.vinaya"'
  },
  { id: 'check-dispatch-readiness', agent: 'claude', platform: 'darwin', denial: GH_CONFIG_DENIED },
  { id: 'verify-dispatch', agent: 'claude', platform: 'darwin', denial: GH_CONFIG_DENIED },
  { id: 'check-all', agent: 'claude', platform: 'darwin', denial: GH_CONFIG_DENIED },
  { id: 'gh-issue-view', agent: 'claude', platform: 'darwin', denial: GH_CONFIG_DENIED },
  { id: 'gh-pr-view', agent: 'claude', platform: 'darwin', denial: GH_CONFIG_DENIED },
  { id: 'gh-pr-view-reviews', agent: 'claude', platform: 'darwin', denial: GH_CONFIG_DENIED },
  ...[
    'bun-install',
    'bun-test-one-file',
    'typecheck',
    'format-and-lint',
    'doctrine-developer',
    'doctrine-pr-report',
    'check-dispatch-readiness',
    'verify-dispatch',
    'check-all'
  ].map((id): KnownFailure => ({ id, agent: 'claude', platform: 'linux', denial: BUN_HIDDEN_LINUX }))
]

function knownFailure(id: string, agent: Agent, platform: string): KnownFailure | undefined {
  return KNOWN_FAILURES.find((f) => f.id === id && f.agent === agent && f.platform === platform)
}

describe('sandbox conformance — the command list', () => {
  const named = commandsTheTextsName()
  const forms = new Map(ENTRIES.flatMap((e) => e.forms.map((form) => [form, e.id] as const)))

  it('every command the doctrine and the rendered brief name has an entry in commands.json', () => {
    const missing = [...named].filter(([command]) => !forms.has(command)).map(([c, source]) => `${c}  (${source})`)
    expect(missing).toEqual([])
  })

  it('every form in commands.json is still named by the doctrine or the rendered brief', () => {
    const stale = [...forms.keys()].filter((form) => !named.has(form))
    expect(stale).toEqual([])
  })

  it('every entry has a unique id and either runs or says why no Developer runs it in its sandbox', () => {
    const ids = ENTRIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    const malformed = ENTRIES.filter((e) => (e.run === undefined) === (e.notRun === undefined)).map((e) => e.id)
    expect(malformed).toEqual([])
  })

  it('the always-run commands are run entries', () => {
    const notRun = ALWAYS_RUN_IDS.filter((id) => ENTRIES.find((e) => e.id === id)?.run === undefined)
    expect(notRun).toEqual([])
  })
})

describe('sandbox conformance — the known-failures list', () => {
  it('every known failure names a run entry, an agent, a platform and a denial, once', () => {
    const runIds = new Set(ENTRIES.filter((e) => e.run !== undefined).map((e) => e.id))
    const bad = KNOWN_FAILURES.filter(
      (f) => !runIds.has(f.id) || !AGENTS.includes(f.agent) || f.denial.trim() === ''
    ).map((f) => f.id)
    expect(bad).toEqual([])
    const keys = KNOWN_FAILURES.map((f) => `${f.id}/${f.agent}/${f.platform}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

const LIVE = process.env.VINAYA_SANDBOX_CONFORMANCE === '1'

for (const agent of AGENTS) {
  describe.skipIf(!LIVE)(`sandbox conformance — ${agent}'s sandbox`, () => {
    const branch = sourceBranch()
    const identity = taskIdentity(branch)
    const platform = process.platform
    let session: SandboxSession

    beforeAll(() => {
      session = openSandboxSession(agent)
      console.info(`[${agent}] worktree ${session.worktreeDir}, branch '${branch || '(detached)'}', ${platform}`)
    })
    afterAll(() => session?.dispose())

    for (const entry of ENTRIES) {
      const run = entry.run
      if (run === undefined) continue
      const runnable = !entry.needsTaskBranch || identity !== null
      it.skipIf(!runnable)(
        `${entry.id}: ${run}`,
        async () => {
          const command = identity ? run.replaceAll('{tranche}', identity.tranche).replaceAll('{n}', identity.n) : run
          const result = await session.run(command, branch ? { BRANCH: branch } : {})
          const listed = knownFailure(entry.id, agent, platform)
          console.info(
            `[${agent}] ${entry.id}: exit ${result.exitCode}${listed ? ' (listed as a known failure)' : ''} — ${command}`
          )
          if (listed && result.exitCode === 0) {
            throw new Error(
              `${entry.id} now exits 0 under ${agent}'s sandbox on ${platform} — remove its KNOWN_FAILURES entry ("${listed.denial}").`
            )
          }
          if (!listed && result.exitCode !== 0) {
            throw new Error(
              `${entry.id} exits ${result.exitCode} under ${agent}'s sandbox on ${platform}, and no KNOWN_FAILURES entry lists it. ` +
                `Its output ends:\n${result.output.slice(-3000)}`
            )
          }
        },
        COMMAND_BUDGET_MS + 60_000
      )
    }
  })
}
