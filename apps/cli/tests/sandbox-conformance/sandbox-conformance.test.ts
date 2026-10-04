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
 * shrinks. A listed command that also fails with no sandbox around it, in the
 * same worktree with the same inputs, is no sandbox denial: the suite fails
 * until the entry is removed or the command is given inputs it can pass on.
 *
 * The command-list checks run on every `bun test`. The sandboxed runs need
 * both runtimes and minutes of wall time, so they run only when
 * `VINAYA_SANDBOX_CONFORMANCE=1` — CI's `sandbox-conformance` job on Linux,
 * and on a Mac, from `apps/cli`:
 *
 *   VINAYA_SANDBOX_CONFORMANCE=1 bun test --timeout=900000 tests/sandbox-conformance/sandbox-conformance.test.ts
 *
 * in a terminal outside any agent's sandbox (a sandbox cannot start another
 * one inside itself). The entries that need a dispatchable task, or the
 * branch's open pull request body, run only when the forge offers one.
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
  sourceBranch
} from './sandbox-launch.js'

type CommandEntry = {
  id: string
  forms: string[]
  run?: string
  notRun?: string
  /** Runs against a tranche task that is dispatchable now (open, dependencies merged, no work on its branch). */
  needsDispatchableTask?: boolean
  /** Runs with the body of the branch's open pull request as `PR_BODY`. */
  needsPrBody?: boolean
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
    id: 'bun-install',
    agent: 'codex',
    platform: 'linux',
    denial:
      'bun install exits 1: "bun is unable to write files to tempdir: EROFS" — its temp directory is outside the writable roots'
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
    const platform = process.platform
    let session: SandboxSession

    beforeAll(() => {
      session = openSandboxSession(agent)
      console.info(`[${agent}] worktree ${session.worktreeDir}, branch '${branch || '(detached)'}', ${platform}`)
    })
    afterAll(() => session?.dispose())

    let dispatchable: Promise<{ tranche: string; n: string } | null> | undefined
    let prBody: Promise<string | null> | undefined

    /** The first open tranche task whose branch holds no work and that `verify-dispatch` calls ready with no sandbox around it. */
    const findDispatchable = async (): Promise<{ tranche: string; n: string } | null> => {
      const listed = await session.runOutside('gh issue list --state open --limit 100 --json title', {})
      if (listed.exitCode !== 0) return null
      const titles = (JSON.parse(listed.output) as { title: string }[]).map((i) => i.title)
      for (const title of titles) {
        const m = title.match(/^\[([^\]]+)\] (\d+) — /)
        if (!m?.[1] || !m[2]) continue
        const probe = await session.runOutside(`bun packages/aeg-core/bin/verify-dispatch.ts ${m[1]} ${m[2]}`, {})
        if (probe.exitCode === 0) return { tranche: m[1], n: m[2] }
      }
      return null
    }

    const findPrBody = async (): Promise<string | null> => {
      if (!branch) return null
      const r = await session.runOutside(`gh pr view ${JSON.stringify(branch)} --json body --jq .body`, {})
      return r.exitCode === 0 && r.output.trim() !== '' ? r.output : null
    }

    for (const entry of ENTRIES) {
      const run = entry.run
      if (run === undefined) continue
      it(
        `${entry.id}: ${run}`,
        async () => {
          const env: Record<string, string> = branch ? { BRANCH: branch } : {}
          let command = run
          if (entry.needsDispatchableTask) {
            dispatchable ??= findDispatchable()
            const target = await dispatchable
            if (!target) {
              console.warn(`[${agent}] ${entry.id}: skipped — no tranche task is dispatchable now`)
              return
            }
            command = run.replaceAll('{tranche}', target.tranche).replaceAll('{n}', target.n)
          }
          if (entry.needsPrBody) {
            prBody ??= findPrBody()
            const body = await prBody
            if (body === null) {
              console.warn(`[${agent}] ${entry.id}: skipped — branch '${branch}' has no open pull request body`)
              return
            }
            env.PR_BODY = body
          }
          const result = await session.run(command, env)
          const listed = knownFailure(entry.id, agent, platform)
          console.info(
            `[${agent}] ${entry.id}: exit ${result.exitCode}${listed ? ' (listed as a known failure)' : ''} — ${command}`
          )
          if (listed && result.exitCode === 0) {
            throw new Error(
              `${entry.id} now exits 0 under ${agent}'s sandbox on ${platform} — remove its KNOWN_FAILURES entry ("${listed.denial}").`
            )
          }
          if (listed) {
            const outside = await session.runOutside(command, env)
            if (outside.exitCode !== 0) {
              throw new Error(
                `${entry.id} is listed as a sandbox denial for ${agent} on ${platform}, but it exits ${outside.exitCode} with no sandbox too — the failure is the command's own, not the boundary's. ` +
                  `Give it inputs it can pass on, or remove the entry. Its unsandboxed output ends:\n${outside.output.slice(-3000)}`
              )
            }
          }
          if (!listed && result.exitCode !== 0) {
            throw new Error(
              `${entry.id} exits ${result.exitCode} under ${agent}'s sandbox on ${platform}, and no KNOWN_FAILURES entry lists it. ` +
                `Its output ends:\n${result.output.slice(-3000)}`
            )
          }
        },
        COMMAND_BUDGET_MS * 2 + 60_000
      )
    }
  })
}
