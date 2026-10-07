import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { GateRow } from '@attalabs/aeg-core'
import { extractImportRecords, resolveRelativeImport, walkFiles } from './test-selector.js'

/**
 * The inputs of the registry gates' seventh rule — anything able to block a
 * change or write to the forge reaches a log producer — gathered with the import
 * resolution the test selector already has, so no second source search exists.
 * A producer is a CLI source file that imports the sink's `log` or `logSync`;
 * reaching one is confined to the CLI package's own sources.
 */

const CLI_SOURCE_DIR = 'apps/cli/src'
const LOG_SINK_PATH = 'apps/cli/src/lib/log-sink.ts'
const LOG_SINK_PRODUCER_NAMES: readonly string[] = ['log', 'logSync']

const NOT_REACHED_BY_IMPORT_CHECK_BIN =
  'a check bin: it runs only as a child of `vinaya check`, whose runner records one gate event per attempt, so no import of the sink is needed'
const NOT_REACHED_STANDALONE_SCRIPT =
  'a standalone script outside the CLI package: the import resolution cannot follow it and no CLI source imports it; invoked directly, it records nothing of its own'
/**
 * Files G7 lets reach no producer, each with the reason. A file that does reach
 * one, or is no longer a GitHub-writing or blocking-gate file, or has no reason
 * here, is itself a finding.
 */
export const G7_EXEMPTIONS: Readonly<Record<string, string>> = {
  'apps/cli/src/checks/bin/check-review-gate.ts': NOT_REACHED_BY_IMPORT_CHECK_BIN,
  'apps/cli/src/checks/bin/check-main-branch-refusal.ts': NOT_REACHED_BY_IMPORT_CHECK_BIN,
  'apps/cli/src/checks/bin/check-token-collection-wired.ts': NOT_REACHED_BY_IMPORT_CHECK_BIN,
  'apps/cli/src/checks/resolver.ts':
    'the pure step that decides which checks `vinaya check` runs; the runner it feeds records each run and the invocation records its own operation at exit',
  'packages/aeg-core/bin/open-pr.ts': NOT_REACHED_STANDALONE_SCRIPT,
  'packages/aeg-core/bin/open-issue.ts': NOT_REACHED_STANDALONE_SCRIPT,
  'packages/aeg-core/bin/verify-dispatch.ts': NOT_REACHED_STANDALONE_SCRIPT,
  'packages/aeg-core/bin/verify-task.ts': NOT_REACHED_STANDALONE_SCRIPT,
  'packages/aeg-core/bin/check-branch-topology.ts': NOT_REACHED_STANDALONE_SCRIPT,
  'packages/aeg-core/bin/check-push-target.ts': NOT_REACHED_STANDALONE_SCRIPT,
  'packages/aeg-core/bin/check-first-push-dispatch.ts': NOT_REACHED_STANDALONE_SCRIPT,
  'packages/aeg-core/bin/assign-task-issue.ts': NOT_REACHED_STANDALONE_SCRIPT,
  'packages/aeg-core/src/brief-validation.ts':
    'a pure library outside the CLI package: it makes no call of its own, and the import resolution does not follow a workspace package'
}

/** The Ring-0 rows' TypeScript implementation files that exist: the blocking gates. */
export function blockingGateFiles(ring0Rows: readonly GateRow[], existsFn: (path: string) => boolean): string[] {
  return [...new Set(ring0Rows.map((r) => r.implementation).filter((p) => p.endsWith('.ts') && existsFn(p)))]
}

/** The CLI package's import graph (repo-relative paths) and the files that import the sink's logging functions. */
export function gatherLogProducerGraph(root: string): { producers: Set<string>; imports: Map<string, string[]> } {
  const files = walkFiles(join(root, CLI_SOURCE_DIR)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  const known = new Set(files)
  const sink = join(root, LOG_SINK_PATH)
  const producers = new Set<string>([LOG_SINK_PATH])
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
