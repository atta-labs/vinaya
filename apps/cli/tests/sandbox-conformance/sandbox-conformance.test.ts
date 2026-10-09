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
 * `VINAYA_SANDBOX_CONFORMANCE=1` — CI's `sandbox-conformance` jobs on Linux
 * and macOS, and on a Mac, from `apps/cli`. On a pull request whose diff
 * touches none of `SUITE_INPUTS` they print one line and skip; on a push,
 * with no event, or when the diff cannot be computed they run in full. Each
 * agent's commands run on `CONCURRENCY` workers, each in a worktree of its
 * own, because commands write:
 *
 *   VINAYA_SANDBOX_CONFORMANCE=1 bun test --timeout=900000 tests/sandbox-conformance/sandbox-conformance.test.ts
 *
 * in a terminal outside any agent's sandbox (a sandbox cannot start another
 * one inside itself). The entries that need a dispatchable task, or the
 * branch's open pull request body, run only when the forge offers one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { devToolsSocketRoot } from '../../src/lib/task-tools/dev-tools-registration.js'
import { listingRevealsSocket, reachDriverSocketUnderOptIn } from '../lib/dispatch/driver-socket-reach.js'
import { commandsTheTextsName, DOCTRINE_SOURCES, isSuiteInput, REPO_ROOT } from './command-sources.js'
import {
  AGENTS,
  type Agent,
  COMMAND_BUDGET_MS,
  conformanceSkipReason,
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
  'gh-issue-view'
]

type Platform = 'darwin' | 'linux'

type KnownFailure = {
  readonly id: string
  readonly agent: Agent
  readonly platform: Platform
  /** The denial the command hits today, as its own output names it. */
  readonly denial: string
  /** When set, the entry applies only while this holds (default: always). */
  readonly appliesWhen?: () => boolean
}

/** A real dispatch has no ambient forge token; a CI job that sets one lets `gh` authenticate without its token store. */
const noAmbientForgeToken = (): boolean => !process.env.GH_TOKEN && !process.env.GITHUB_TOKEN

/**
 * O2/O7: every Bash line runs INSIDE Claude's sandbox because the exclusion
 * list is empty (`claudeRunsCommandUnsandboxed` in `sandbox-launch.ts`). Inside, the gh token
 * store `~/.config/gh/hosts.yml` is a denied credential and no
 * `GITHUB_TOKEN`/`GH_TOKEN` sits in the Developer's own macOS environment, so
 * `gh` cannot authenticate and any forge read fails. (Named for darwin: on a
 * Linux CI runner a `GH_TOKEN` IS in the ambient job environment and flows in,
 * so the same lines authenticate there — see O3/O4 below.)
 */
const GH_HOSTS_DENIED_INSIDE =
  'the gh token store ~/.config/gh/hosts.yml is a denied credential and no GITHUB_TOKEN/GH_TOKEN is in the macOS environment, so gh cannot authenticate and the forge read fails'

/**
 * Today's denials. Remove an entry the moment its command passes — the
 * suite fails until you do.
 *
 * O4: the three bare `gh` read lines (`gh-issue-view`/`gh-pr-view`/
 * `gh-pr-view-reviews`) are BACK as Claude/darwin denials — `gh` is no longer
 * an excluded command, so every `gh` line (bare or chained) now runs INSIDE
 * the sandbox, where on macOS gh cannot authenticate. The Developer reads
 * its PR through the driver-run `read_pull_request` tool instead. On a Linux CI
 * runner the ambient `GH_TOKEN` flows in and the sandbox network allows
 * `api.github.com`, so the same bare reads authenticate and PASS there — they
 * are darwin-only failures, like `check-all`'s own macOS cause. `gh-chained`
 * stays for the same reason it always did (a chained line runs inside).
 * O4: `typecheck` is NOT listed for either agent. `bun run typecheck` runs
 * `turbo`, whose cache-miss write used to land at the MAIN repository root's
 * `.turbo/` — outside the granted worktree/scratch, so the sandbox denied it
 * (`IO error: failed to create directory .../vinaya/.turbo/`). The driver now
 * points turbo's cache-directory override (`TURBO_CACHE_DIR`,
 * `confinedTurboCacheDir`) inside the confined dispatch's OWN granted scratch
 * for both agents, and the harness mirrors it (`sandbox-launch.ts`), so each
 * agent's cold-cache miss writes where the sandbox already allows writes and
 * `typecheck` exits 0 under both — no repository-root grant, no cross-agent
 * warm-cache dependency.
 * O3: `check-all` on claude/darwin and claude/linux stays — the CLI's own
 * forge reads are not staged from outside here. Under the publishing-tools
 * design the controller runs the checks that need the forge, so closing these
 * two moves to the publishing-tools task; each keeps its current-cause denial below.
 */
const KNOWN_FAILURES: readonly KnownFailure[] = [
  {
    id: 'check-all',
    agent: 'claude',
    platform: 'darwin',
    denial: `check --all runs inside the sandbox and ${GH_HOSTS_DENIED_INSIDE} — the CLI's forge reads are not yet staged from outside (O3, Issue #1034)`
  },
  {
    id: 'gh-chained',
    agent: 'claude',
    platform: 'darwin',
    appliesWhen: noAmbientForgeToken,
    denial: `a chained gh line is not a bare excluded command, so Claude Code runs it inside the sandbox, where ${GH_HOSTS_DENIED_INSIDE}`
  },
  {
    id: 'gh-issue-view',
    agent: 'claude',
    platform: 'darwin',
    denial: `O4: gh is no longer an excluded command, so this bare read runs inside the sandbox, where ${GH_HOSTS_DENIED_INSIDE}`
  },
  {
    id: 'gh-pr-view',
    agent: 'claude',
    platform: 'darwin',
    denial: `O4: gh is no longer an excluded command, so this bare read runs inside the sandbox, where ${GH_HOSTS_DENIED_INSIDE}`
  },
  {
    id: 'gh-pr-view-reviews',
    agent: 'claude',
    platform: 'darwin',
    denial: `O4: gh is no longer an excluded command, so this bare read runs inside the sandbox, where ${GH_HOSTS_DENIED_INSIDE}`
  },
  {
    id: 'check-all',
    agent: 'claude',
    platform: 'linux',
    denial:
      'check --all runs inside the sandbox, where the confined secret scanner (atta-labs/secret-scan) cannot run and errors — the dominant denial on a Linux CI runner, whose ambient GH_TOKEN otherwise flows in and lets the forge-reading checks authenticate (unlike macOS, where the denied gh token store additionally blocks them). Removing it is folded into the O3/O4 forge-staging escalation (Issue #1034)'
  }
]

function knownFailure(id: string, agent: Agent, platform: string): KnownFailure | undefined {
  return KNOWN_FAILURES.find(
    (f) => f.id === id && f.agent === agent && f.platform === platform && (f.appliesWhen?.() ?? true)
  )
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

/** The suite's helper modules under `apps/cli/tests/` are followed, `src/` and package modules are not. */
function suiteImports(): { modules: Set<string>; packages: Set<string> } {
  const modules = new Set<string>()
  const packages = new Set<string>()
  const queue = ['command-sources.ts', 'sandbox-conformance.test.ts', 'sandbox-launch.ts'].map((f) =>
    join(import.meta.dir, f)
  )
  for (const file of queue) {
    const source = readFileSync(file, 'utf8')
    for (const m of source.matchAll(/^(?:import|export)\b[^'"]*?from\s+'([^']+)'/gms)) {
      const specifier = m[1] ?? ''
      if (specifier.startsWith('@attalabs/')) packages.add(specifier)
      if (!specifier.startsWith('.')) continue
      const ts = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'))
      const rel = relative(REPO_ROOT, ts)
      modules.add(rel)
      if (rel.startsWith('apps/cli/tests/') && !queue.includes(ts) && existsSync(ts)) queue.push(ts)
    }
  }
  return { modules, packages }
}

describe('sandbox conformance — the inputs the skip decision watches', () => {
  it('covers every text the command list is read from and the command data file', () => {
    const missing = [...DOCTRINE_SOURCES, 'apps/cli/tests/sandbox-conformance/commands.json'].filter(
      (p) => !isSuiteInput(p)
    )
    expect(missing).toEqual([])
  })

  it('covers every module the suite imports, directly or through its test helpers', () => {
    const { modules, packages } = suiteImports()
    expect(modules.size).toBeGreaterThan(3)
    expect([...modules].filter((m) => !isSuiteInput(m))).toEqual([])
    expect(packages.has('@attalabs/aeg-core')).toBe(true)
    const uncovered = [...packages].filter(
      (p) => !isSuiteInput(`packages/${p.slice('@attalabs/'.length)}/src/index.ts`)
    )
    expect(uncovered).toEqual([])
  })

  it('covers the lockfile, the repository config and the CI workflow file', () => {
    expect(['bun.lock', 'vinaya.config.json', '.github/workflows/ci.yml'].filter((p) => !isSuiteInput(p))).toEqual([])
    expect(isSuiteInput('README.md')).toBe(false)
  })
})

describe('sandbox conformance — when the live runs are skipped', () => {
  const pr = { GITHUB_EVENT_NAME: 'pull_request' }
  it('skips a pull request that changes none of the inputs', () => {
    expect(conformanceSkipReason(pr, () => ['README.md', 'apps/cli/src/lib/other.ts'])).toContain('no file the suite')
  })
  it('runs a pull request that changes an input', () => {
    expect(conformanceSkipReason(pr, () => ['README.md', 'bun.lock'])).toBeNull()
  })
  it('runs on a push, and with no event', () => {
    expect(conformanceSkipReason({ GITHUB_EVENT_NAME: 'push' }, () => ['README.md'])).toBeNull()
    expect(conformanceSkipReason({}, () => ['README.md'])).toBeNull()
  })
  it('runs when the diff cannot be computed', () => {
    expect(
      conformanceSkipReason(pr, () => {
        throw new Error('no merge base')
      })
    ).toBeNull()
  })
})

/** Commands of one agent's sandbox that run at once, each worker in a worktree of its own. */
const CONCURRENCY = 3

/** What a Developer's first command does in a fresh worktree. */
const INSTALL = 'bun install --frozen-lockfile --silent'

const WANTED = process.env.VINAYA_SANDBOX_CONFORMANCE === '1'
const SKIP_REASON = WANTED ? conformanceSkipReason() : null
const LIVE = WANTED && SKIP_REASON === null
if (SKIP_REASON !== null) console.info(`sandbox conformance: skipped — ${SKIP_REASON}`)

describe.skipIf(!LIVE || process.platform !== 'linux')('driver socket boundary without Unix-socket seccomp', () => {
  // The host opt-in (`VINAYA_LINUX_SANDBOX_ALLOW_UNIX_SOCKETS=1`) turns the
  // Unix-socket filter off; the driver-tool socket directory must still be
  // unlistable and its sockets unreachable from inside the sandbox.
  it('hides a sibling socket created after Claude Bash starts, with the Unix-socket opt-in set', async () => {
    const reach = await reachDriverSocketUnderOptIn()
    expect(reach.settings.sandbox.network.allowAllUnixSockets).toBe(true)
    expect(reach.settings.sandbox.filesystem.denyRead).toContain(devToolsSocketRoot())
    expect(reach.status, reach.stderr).toBe(0)
    expect(listingRevealsSocket(reach.stdout, reach.socketPath)).toBe(false)
    expect(reach.stdout).toMatch(/DENIED:(EACCES|EPERM|ENOENT)/)
    expect(reach.connectionsAfter).toBe(reach.connectionsBefore)
  }, 60_000)
})

for (const agent of AGENTS) {
  describe.skipIf(!LIVE)(`sandbox conformance — ${agent}'s sandbox`, () => {
    const branch = sourceBranch()
    const platform = process.platform
    const runnable = ENTRIES.filter((e) => e.run !== undefined)
    const sessions: SandboxSession[] = []
    /** Each entry's failure, or `null` once it passed; settled in the background by the workers. */
    const outcomes = new Map<string, Promise<Error | null>>()
    let allDone: Promise<unknown> = Promise.resolve()

    let dispatchable: Promise<{ tranche: string; n: string } | null> | undefined
    let prBody: Promise<string | null> | undefined

    /** The first open tranche task whose branch holds no work and that `verify-dispatch` calls ready with no sandbox around it. */
    const findDispatchable = async (session: SandboxSession): Promise<{ tranche: string; n: string } | null> => {
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

    const findPrBody = async (session: SandboxSession): Promise<string | null> => {
      if (!branch) return null
      const r = await session.runOutside(`gh pr view ${JSON.stringify(branch)} --json body --jq .body`, {})
      return r.exitCode === 0 && r.output.trim() !== '' ? r.output : null
    }

    /** Runs one entry in `session` and throws what the entry's test must fail with. */
    const execute = async (entry: CommandEntry, session: SandboxSession): Promise<void> => {
      const run = entry.run ?? ''
      const env: Record<string, string> = branch ? { BRANCH: branch } : {}
      let command = run
      if (entry.needsDispatchableTask) {
        dispatchable ??= findDispatchable(session)
        const target = await dispatchable
        if (!target) {
          console.warn(`[${agent}] ${entry.id}: skipped — no tranche task is dispatchable now`)
          return
        }
        command = run.replaceAll('{tranche}', target.tranche).replaceAll('{n}', target.n)
      }
      if (entry.needsPrBody) {
        prBody ??= findPrBody(session)
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
    }

    beforeAll(() => {
      const workers = Math.min(CONCURRENCY, runnable.length)
      for (let i = 0; i < workers; i++) sessions.push(openSandboxSession(agent))
      const first = sessions[0]
      console.info(
        `[${agent}] ${workers} workers, first worktree ${first?.worktreeDir}, branch '${branch || '(detached)'}', ${platform}`
      )
      const settle = new Map<string, (error: Error | null) => void>()
      for (const entry of runnable) outcomes.set(entry.id, new Promise((done) => settle.set(entry.id, done)))
      const queue = [...runnable]
      // Commands write (installs, caches), so a worker never shares its worktree; each installs once before its first command, as the serial run's first command did.
      allDone = Promise.all(
        sessions.map(async (session) => {
          await session.run(INSTALL, {}).catch(() => undefined)
          for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
            const done = settle.get(entry.id)
            try {
              await execute(entry, session)
              done?.(null)
            } catch (error) {
              done?.(error instanceof Error ? error : new Error(String(error)))
            }
          }
        })
      )
    })
    afterAll(async () => {
      await allDone.catch(() => undefined)
      for (const session of sessions) session.dispose()
    })

    for (const entry of runnable) {
      it(
        `${entry.id}: ${entry.run}`,
        async () => {
          const failure = await outcomes.get(entry.id)
          if (failure) throw failure
        },
        COMMAND_BUDGET_MS * 2 + 60_000
      )
    }
  })
}
