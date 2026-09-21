/**
 * No source file outside the path function assembles a run-file path (O3).
 *
 * Twenty-four modules each built their own path under the machine's Vinaya
 * home before `apps/cli/src/lib/run-paths.ts` existed, and two of them
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

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')
const SOURCE_ROOTS = [
  join(REPO_ROOT, 'apps', 'cli', 'src'),
  join(REPO_ROOT, 'packages', 'aeg-core', 'src'),
  join(REPO_ROOT, 'packages', 'sources', 'src')
]

/** The one function every run file resolves through, and the only file allowed to build a path under the runtime directory. */
const PATH_FUNCTION = 'apps/cli/src/lib/run-paths.ts'

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
  { file: 'apps/cli/src/lib/log-sink.ts', why: 'THE TELEMETRY EXCEPTION — the outbox the log tasks own and will move' },
  { file: 'apps/cli/src/lib/log-flush.ts', why: 'the telemetry exception: reads and truncates the same outbox' },
  { file: 'apps/cli/src/lib/log-webhook-flush.ts', why: 'the telemetry exception: reads the same outbox' },
  { file: 'apps/cli/src/lib/log-artifact.ts', why: 'the telemetry exception: bundles the same outbox for CI export' },
  {
    file: 'apps/cli/src/lib/task-sweep.ts',
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
    expect(VINAYA_HOME_ALLOWED.some((e) => e.file === 'apps/cli/src/lib/log-sink.ts')).toBe(true)
  })

  it('no file names one of the layout’s earlier top-level folders as a path segment', () => {
    const offenders: string[] = []
    for (const f of files) {
      const rel = relative(REPO_ROOT, f)
      if (rel === PATH_FUNCTION) continue
      const lines = codeLines(readFileSync(f, 'utf8')).filter((line) => !isModuleSpecifier(line))
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
