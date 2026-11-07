/**
 * No source file outside the path function assembles a run-file path (O3).
 *
 * Twenty-four modules each built their own path under the machine's Vinaya
 * home before `harness/kernel/run-paths.ts` existed, and two of them
 * disagreed about where the same task's control records lived. Moving them
 * onto one function fixes that once; this test is what stops the next one
 * from drifting back, because nothing else would notice — a second
 * convention reads as ordinary working code right up until a confined role's
 * sandbox grant names a directory the driver no longer writes to.
 *
 * Two things are refused, both against the real source tree:
 *
 *   1. Joining a run-file location off the machine's Vinaya home — importing
 *      `GLOBAL_VINAYA_HOME` at all, outside the files allowed below.
 *   2. Naming one of the layout's earlier top-level folders as a path
 *      segment, anywhere.
 *
 * **The telemetry outbox is the one exception**, and is named as such rather
 * than quietly skipped: log events still queue under the Vinaya home
 * (`log-sink.ts`'s `telemetryOutboxRoot`) because where they are delivered
 * is itself changing, and moving that file first would mean moving it twice.
 * When the log tasks move it, delete its entry here — the deletion is the
 * signal that the exception is gone.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const SOURCE_ROOTS = [
  join(REPO_ROOT, 'apps', 'cli', 'src'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/dev-review-policy'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/artifacts/docs'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/archive-task.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/blast-radius-domains.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/brief-render.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/brief-validation.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/consumer-enumeration.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/derive-section7.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/derive-tranche.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/issue-validation.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/milestone-validation.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/objectives.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/parse-registry.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/parse-tranche.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/pr-tier.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/premise-check.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/principals-config.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/protected-paths.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/review-input-manifest.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/review-policy.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/review-status.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/ruling-ordinal.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/state-machine-model.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/task-branch-identity.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/test-plan-section.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/verdict-extraction.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/waiver-label.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/gate-cutovers.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/live-record.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/objectives-cutover-config.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/state-source.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-contract/types.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/pr-report/tokens/parse-ledger.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/pr-report/tokens/parse-token-report.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/pr-report/tokens/report-tokens.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/pr-report/tokens/sum-ledger.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/checks/pr-report-density.ts'),
  join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/task-phase-history.ts'),
  join(REPO_ROOT, 'packages', 'sources', 'src')
]

/** The source that moved out of `apps/cli/src` and `packages/aeg-core/src` into the kernel, so these scans read it where it now lives. */
const MOVED_KERNEL_FILES = [
  'harness/kernel/adapters/agents/agent-line.ts',
  'harness/kernel/adapters/agents/claude-code/loop-narration-claude.ts',
  'harness/kernel/effects/effects.ts',
  'harness/kernel/effects/envelope.ts',
  'harness/kernel/isolation/worker-boundary.ts',
  'harness/kernel/log/client/cli-operation-log.ts',
  'harness/kernel/log/client/log-cache-sqlite.ts',
  'harness/kernel/log/client/log-custom.ts',
  'harness/kernel/log/client/log-schema-digest.ts',
  'harness/kernel/log/client/log-sync-folder-source.ts',
  'harness/kernel/log/client/log-sync-server-source.ts',
  'harness/kernel/log/client/log-sync.ts',
  'harness/kernel/log/client/log-webhook-drain.ts',
  'harness/kernel/log/client/loop-log.ts',
  'harness/kernel/log/client/narration.ts',
  'harness/kernel/log/client/schema-digest.ts',
  'harness/kernel/log/custom.ts',
  'harness/kernel/log/envelope.ts',
  'harness/kernel/log/fixtures/executions.ts',
  'harness/kernel/log/fixtures/fact-sheets.ts',
  'harness/kernel/log/fixtures/generator.ts',
  'harness/kernel/log/log-sink.ts',
  'harness/kernel/log/redact.ts',
  'harness/kernel/log/schema.ts',
  'harness/kernel/log/store.ts',
  'harness/kernel/log/sync/cache-contract.ts',
  'harness/kernel/log/sync/contracts.ts',
  'harness/kernel/log/sync/engine.ts',
  'harness/kernel/log/sync/measured.ts',
  'harness/kernel/log/sync/memory-cache.ts',
  'harness/kernel/log/sync/normalize.ts',
  'harness/kernel/log/sync/row.ts',
  'harness/kernel/run-paths.ts',
  'harness/kernel/source-manifest.ts',
  'harness/kernel/telemetry/questions/catches.ts',
  'harness/kernel/telemetry/questions/checks.ts',
  'harness/kernel/telemetry/questions/common.ts',
  'harness/kernel/telemetry/questions/completion.ts',
  'harness/kernel/telemetry/questions/convergence.ts',
  'harness/kernel/telemetry/questions/determinism.ts',
  'harness/kernel/telemetry/questions/index.ts',
  'harness/kernel/telemetry/questions/judgment.ts',
  'harness/kernel/telemetry/questions/labels.ts',
  'harness/kernel/telemetry/questions/time.ts',
  'harness/kernel/telemetry/questions/usage.ts',
  'harness/kernel/tools/dev-tools-names.ts',
  'harness/kernel/tools/dev-tools-registration.ts',
  'harness/kernel/tools/dev-tools-server.ts',
  'harness/kernel/tools/fetch-documentation.ts',
  'harness/kernel/tools/host/broker.ts',
  'harness/kernel/tools/host/dev-tools-bridge.ts',
  'harness/kernel/tools/host/dev-tools-host.ts',
  'harness/kernel/tools/host/router.ts',
  'harness/kernel/tools/mcp-protocol.ts',
  'harness/kernel/tools/read-source.ts',
  'harness/kernel/tools/role-grants.ts',
  'harness/kernel/tools/source-provider.ts',
  'harness/kernel/tools/tool-catalog.ts'
]

/** The one function every run file resolves through, and the only file allowed to build a path under the runtime directory. */
const PATH_FUNCTION = 'harness/kernel/run-paths.ts'
const PROCESS_LOOPS_FOLDER = 'processes/vinaya-strict/loops/'

/**
 * Where the machine's Vinaya home may still be reached, and why. Everything
 * here is either the path function itself, the home's own non-run-file
 * contents, or the telemetry exception this task deliberately left in place.
 */
const VINAYA_HOME_ALLOWED: ReadonlyArray<{ file: string; why: string }> = [
  { file: PATH_FUNCTION, why: 'the path function itself — it resolves the default runtime directory under the home' },
  {
    file: 'apps/cli/src/lib/config.ts',
    why: 'defines the home, and the global config and trust-cache files that are not run files'
  },
  {
    file: 'harness/kernel/log/log-sink.ts',
    why: 'THE TELEMETRY EXCEPTION — the outbox the log tasks own and will move'
  },
  { file: 'apps/cli/src/lib/log-flush.ts', why: 'the telemetry exception: reads and truncates the same outbox' },
  { file: 'harness/kernel/log/client/log-webhook-drain.ts', why: 'the telemetry exception: reads the same outbox' },
  { file: 'apps/cli/src/lib/log-artifact.ts', why: 'the telemetry exception: bundles the same outbox for CI export' },
  {
    file: 'harness/processes/vinaya-strict/loops/dev-review/run-control/task-sweep.ts',
    why: "task-files-v1 3, O3 — the earlier-layout sweep reads the home's own seven retired top-level folders (`run-paths.ts`'s `LEGACY_TOP_LEVEL_DIRNAMES`) to list and attribute what a prior layout left there; it names no run-file location of its own"
  }
]

/**
 * Top-level folder names the layout replaced. A source file naming one as a
 * path segment is building a run-file path the old way, whatever else it
 * calls the variable.
 */
const RETIRED_SEGMENTS: ReadonlyArray<{ segment: string; nowAt: string }> = [
  { segment: 'dispatch-output', nowAt: "the task's own `output/`" },
  { segment: 'dispatch-resume', nowAt: "the task's own `sessions/`" },
  { segment: 'dispatch-settings', nowAt: "the task's own `hooks/`" },
  { segment: 'task-start', nowAt: "the unscoped folder's own `control/`" },
  { segment: 'task-resume', nowAt: "the resolving task's own `control/`" },
  { segment: 'control-store', nowAt: "each task's own `control/`" },
  { segment: 'loops', nowAt: "the task's own `output/driver.log`" }
]

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    if (statSync(dir).isFile()) {
      out.push(dir)
      return
    }
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.endsWith('.ts')) continue
      if (entry.endsWith('.test.ts')) continue
      out.push(full)
    }
  }
  for (const root of SOURCE_ROOTS) walk(root)
  for (const file of MOVED_KERNEL_FILES) out.push(join(REPO_ROOT, file))
  return out
}

/** Comment lines are prose about the old layout — history worth keeping, never a path this process builds. */
function codeLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
}

/**
 * A module specifier is not a filesystem path. `packages/aeg-core/src/index.ts`
 * legitimately re-exports `'./control-store'` — the control store's own
 * source directory, which keeps its name; what moved is where its RECORDS
 * are written, and that is decided by the root its caller passes.
 */
function isModuleSpecifier(line: string): boolean {
  // Also matches the closing line of a multi-line re-export, `} from './x'`,
  // where the `export` keyword is many lines above.
  return /(?:^|\})\s*(?:import|export)?\s*from\s*['"]/.test(line) || /^(?:import|export)\s+['"]/.test(line)
}

describe('run-file paths are assembled in exactly one place (O3)', () => {
  const files = sourceFiles()

  it('finds a real source tree to scan — a silently empty walk would pass every assertion below', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((f) => relative(REPO_ROOT, f) === PATH_FUNCTION)).toBe(true)
  })

  it('no file outside the named exceptions reaches the machine Vinaya home', () => {
    const allowed = new Set(VINAYA_HOME_ALLOWED.map((e) => e.file))
    const offenders = files
      .map((f) => ({ rel: relative(REPO_ROOT, f), text: readFileSync(f, 'utf8') }))
      .filter(({ rel }) => !allowed.has(rel))
      .filter(({ text }) => codeLines(text).some((line) => line.includes('GLOBAL_VINAYA_HOME')))
      .map(({ rel }) => rel)

    expect(
      offenders,
      `these files build a path off the machine Vinaya home. Every file a task's run writes resolves through ${PATH_FUNCTION}'s runPath instead; if this is genuinely NOT a run file, add it to VINAYA_HOME_ALLOWED with a reason.`
    ).toEqual([])
  })

  it('names the telemetry outbox as the exception, rather than skipping it silently', () => {
    const telemetry = VINAYA_HOME_ALLOWED.filter((e) => e.why.includes('telemetry'))
    expect(telemetry.length).toBeGreaterThan(0)
    // The one this task deliberately did not move. When the log tasks move
    // it, this entry goes away and this assertion goes with it.
    expect(VINAYA_HOME_ALLOWED.some((e) => e.file === 'harness/kernel/log/log-sink.ts')).toBe(true)
  })

  it('no file names one of the layout’s earlier top-level folders as a path segment', () => {
    const offenders: string[] = []
    for (const f of files) {
      const rel = relative(REPO_ROOT, f)
      if (rel === PATH_FUNCTION) continue
      // The process's own source folder `harness/processes/vinaya-strict/loops/` is a repository folder, never a run-file
      // location, so a path that names it (a wrapped import of the moved driver, a scanner root) is not the retired folder.
      const lines = codeLines(readFileSync(f, 'utf8'))
        .filter((line) => !isModuleSpecifier(line))
        .map((line) => line.replaceAll(PROCESS_LOOPS_FOLDER, ''))
      for (const { segment, nowAt } of RETIRED_SEGMENTS) {
        // As a quoted path segment — `'dispatch-resume'`, `"loops"`,
        // `/loops/` inside a template — never a mention in an identifier
        // (`dev-review-loop.ts`'s own module name) or in prose.
        const quoted = new RegExp(`['"\`/]${segment}['"\`/]`)
        if (lines.some((line) => quoted.test(line))) offenders.push(`${rel}: '${segment}' → now ${nowAt}`)
      }
    }
    expect(
      offenders,
      `these files name a retired top-level folder. Resolve the location through ${PATH_FUNCTION}'s runPath instead.`
    ).toEqual([])
  })
})
