import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DoctrineContent, DoctrineSource } from '../../../harness/processes/vinaya-strict/tools/doctrine-source.js'
import {
  CONTRACT_ENTRIES,
  type DoctrineMapEntry,
  doctrineSource,
  ROLE_KEY_ENTRIES
} from '../../../harness/processes/vinaya-strict/tools/doctrine/doctrine-map.js'
import { DEFAULT_GOVERNANCE_ROOT } from './file-adapter'

export type DoctrineFileSourceConfig = {
  /** Doctrine root to read from — the folder the doctrine map's source paths are relative to. Defaults to `DEFAULT_GOVERNANCE_ROOT`. */
  root?: string
}

/** Every map row present under `root`, sorted by logical key for deterministic order, returning the logical key as the path plus the raw content. */
function readEntries(root: string, entries: readonly DoctrineMapEntry[]): Array<{ path: string; content: string }> {
  return entries
    .filter((entry) => existsSync(join(root, entry.source)))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((entry) => ({ path: entry.key, content: readFileSync(join(root, entry.source), 'utf-8') }))
}

/**
 * File-backed `DoctrineSource` over a configurable doctrine root. Reads the
 * enforcement page, the role doctrine and the contracts each at the source
 * path the doctrine map names for its logical key, and reports each file by
 * that logical key (`roles/<id>.md`, `contracts/<name>.md`). The default root
 * is `DEFAULT_GOVERNANCE_ROOT`; adapter logic never hardcodes a literal path.
 */
export function createFileDoctrineSource(config: DoctrineFileSourceConfig = {}): DoctrineSource {
  const root = config.root ?? DEFAULT_GOVERNANCE_ROOT
  return {
    async getDoctrine(): Promise<DoctrineContent> {
      const enforcement = readFileSync(join(root, doctrineSource('enforcement.md')), 'utf-8')
      const roles = readEntries(root, ROLE_KEY_ENTRIES)
      const contracts = readEntries(root, CONTRACT_ENTRIES)
      return { enforcement, roles, contracts }
    }
  }
}
