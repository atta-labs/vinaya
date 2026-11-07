import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DOCTRINE_CONTENT_LAYOUT,
  type DoctrineContent,
  type DoctrineContentFile,
  type DoctrineSource
} from '../../../harness/processes/vinaya-strict/tools/doctrine-source.js'
import { DEFAULT_GOVERNANCE_ROOT } from './file-adapter'

export type DoctrineFileSourceConfig = {
  /** Doctrine root to read from — the folder the doctrine map's source paths are relative to. Defaults to `DEFAULT_GOVERNANCE_ROOT`. */
  root?: string
}

/** Every listed file present under `root`, in the layout's logical-key order, returning the logical key as the path plus the raw content. */
function readFiles(root: string, files: readonly DoctrineContentFile[]): Array<{ path: string; content: string }> {
  return files
    .filter((file) => existsSync(join(root, file.source)))
    .map((file) => ({ path: file.key, content: readFileSync(join(root, file.source), 'utf-8') }))
}

/**
 * File-backed `DoctrineSource` over a configurable doctrine root. Reads the
 * enforcement page, the role doctrine and the contracts each at the source
 * path the doctrine map names for its logical key (`DOCTRINE_CONTENT_LAYOUT`),
 * and reports each file by that logical key (`roles/<id>.md`,
 * `contracts/<name>.md`). The default root is `DEFAULT_GOVERNANCE_ROOT`;
 * adapter logic never hardcodes a literal path.
 */
export function createFileDoctrineSource(config: DoctrineFileSourceConfig = {}): DoctrineSource {
  const root = config.root ?? DEFAULT_GOVERNANCE_ROOT
  return {
    async getDoctrine(): Promise<DoctrineContent> {
      const enforcement = readFileSync(join(root, DOCTRINE_CONTENT_LAYOUT.enforcement), 'utf-8')
      const roles = readFiles(root, DOCTRINE_CONTENT_LAYOUT.roles)
      const contracts = readFiles(root, DOCTRINE_CONTENT_LAYOUT.contracts)
      return { enforcement, roles, contracts }
    }
  }
}
