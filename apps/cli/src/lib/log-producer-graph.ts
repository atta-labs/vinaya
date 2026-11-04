import { existsSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { GateRow } from '@attalabs/aeg-core'
import { extractImportRecords, resolveRelativeImport, walkFiles } from './test-selector.js'

/**
 * The inputs of the registry gates' seventh rule — anything able to block a
 * change or write to the forge reaches a log producer — gathered with the import
 * resolution the test selector already has, so no second source search exists.
 * A producer is a CLI, process-folder or kernel source file that imports the
 * sink's `log` or `logSync`; reaching one is confined to those sources, leaving out any file
 * under a `tests` folder there and every `.test.ts` file.
 */

const CLI_SOURCE_DIR = 'apps/cli/src'
const PROCESSES_DIR = 'harness/processes'
const KERNEL_DIR = 'harness/kernel'
const LOG_SINK_PATHS = ['apps/cli/src/lib/log-sink.ts', 'harness/kernel/log/log-sink.ts'] as const
const LOG_SINK_PRODUCER_NAMES: readonly string[] = ['log', 'logSync']

const G7_EXEMPTIONS_PATH = '.vinaya/g7-exemptions.json'

/**
 * The files G7 lets reach no producer, each with its reason, read from
 * `.vinaya/g7-exemptions.json` in the repository being checked (keys are
 * repository-relative paths, values are reasons). A file that does reach a
 * producer, or is no longer a GitHub-writing or blocking-gate file, or has no
 * reason there, is itself a finding. A missing file means no exemptions; an
 * unreadable shape throws an error naming the file.
 */
export function readG7Exemptions(root: string): Record<string, string> {
  const path = join(root, G7_EXEMPTIONS_PATH)
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `${G7_EXEMPTIONS_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${G7_EXEMPTIONS_PATH} must be one JSON object mapping each exempted path to its reason`)
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error(`${G7_EXEMPTIONS_PATH}: the reason for "${key}" must be a string`)
    out[key] = value
  }
  return out
}

/** The Ring-0 rows' TypeScript implementation files that exist: the blocking gates. */
export function blockingGateFiles(ring0Rows: readonly GateRow[], existsFn: (path: string) => boolean): string[] {
  return [...new Set(ring0Rows.map((r) => r.implementation).filter((p) => p.endsWith('.ts') && existsFn(p)))]
}

/** The import graph (repo-relative paths) of the CLI, process folders and kernel's non-test sources, and the files that import the sink's logging functions. */
export function gatherLogProducerGraph(root: string): { producers: Set<string>; imports: Map<string, string[]> } {
  const files = [
    ...walkFiles(join(root, CLI_SOURCE_DIR)),
    ...[PROCESSES_DIR, KERNEL_DIR].flatMap((dir) =>
      walkFiles(join(root, dir)).filter((f) => !relative(root, f).split(sep).includes('tests'))
    )
  ].filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  const known = new Set(files)
  const sinkPath = LOG_SINK_PATHS.find((path) => existsSync(join(root, path))) ?? LOG_SINK_PATHS[0]
  const sink = join(root, sinkPath)
  const producers = new Set<string>([sinkPath])
  const imports = new Map<string, string[]>()
  for (const file of files) {
    const deps: string[] = []
    for (const record of extractImportRecords(readFileSync(file, 'utf8'))) {
      const target = resolveRelativeImport(file, record.specifier, known)
      if (target === null) continue
      deps.push(relative(root, target))
      if (target === sink && record.kind === 'named' && record.names.some((n) => LOG_SINK_PRODUCER_NAMES.includes(n))) {
        producers.add(relative(root, file))
      }
    }
    imports.set(relative(root, file), deps)
  }
  return { producers, imports }
}
