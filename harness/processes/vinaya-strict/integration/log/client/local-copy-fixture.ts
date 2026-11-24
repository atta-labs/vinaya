import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type StoredEvent,
  type StoredSpan,
  storedEvents,
  storedSpans
} from '../../../../../kernel/gates/checks/runner/local-copy-probe.js'

const REPOSITORY = 'atta-labs/vinaya'

/**
 * Points the process's own run handle at a fresh runtime directory for one test, so what the harness writes through
 * it can be read back from the local copy. `restore` puts the environment back and removes the directory.
 */
export function isolatedLocalCopy(): {
  runtimeDir: string
  /** The file names of the local copy, in every repository folder. */
  copyFiles: () => string[]
  /** Every event the local copy holds, by name and attributes. */
  events: () => StoredEvent[]
  /** Every span the local copy holds, by name and attributes. */
  spans: () => StoredSpan[]
  /** Every earlier-format file the directory holds (`*.ndjson`): none is written for what the Log now records. */
  earlierFormatFiles: () => string[]
  restore: () => void
} {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'vinaya-local-copy-'))
  const saved = { dir: process.env.VINAYA_RUNTIME_DIR, repo: process.env.VINAYA_REPO, task: process.env.VINAYA_TASK }
  process.env.VINAYA_RUNTIME_DIR = runtimeDir
  process.env.VINAYA_REPO = REPOSITORY
  delete process.env.VINAYA_TASK
  const logs = join(runtimeDir, 'logs')
  const restoreVar = (name: 'VINAYA_RUNTIME_DIR' | 'VINAYA_REPO' | 'VINAYA_TASK', value: string | undefined): void => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  // A recorder another test in the same process bound to a repository files its records under that repository's
  // folder, so every repository folder the directory holds is read.
  const repositoryFolders = (): string[] =>
    existsSync(logs)
      ? readdirSync(logs, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(logs, entry.name))
      : []
  return {
    runtimeDir,
    copyFiles: () => repositoryFolders().flatMap((folder) => readdirSync(folder).filter((f) => f.endsWith('.jsonl'))),
    events: () => repositoryFolders().flatMap((folder) => storedEvents(folder)),
    spans: () => repositoryFolders().flatMap((folder) => storedSpans(folder)),
    earlierFormatFiles: () =>
      existsSync(logs)
        ? readdirSync(logs, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ndjson'))
        : [],
    restore: () => {
      restoreVar('VINAYA_RUNTIME_DIR', saved.dir)
      restoreVar('VINAYA_REPO', saved.repo)
      restoreVar('VINAYA_TASK', saved.task)
      rmSync(runtimeDir, { recursive: true, force: true })
    }
  }
}
