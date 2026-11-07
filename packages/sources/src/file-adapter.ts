import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTranche } from '../../../harness/processes/vinaya-strict/tools/task-contract/parse-tranche'
import { DOCTRINE_TREE } from '../../../harness/processes/vinaya-strict/tools/doctrine/doctrine-map'
import type { StateSource } from './contract'

/** Default governance root when no config value is supplied — the doctrine
 * map's doctrine tree, `harness/processes/vinaya-strict`, which the doctrine
 * file adapter reads. Never read directly by adapter logic below — always
 * through `config.root`, so a relocation of this repo's governance data is a
 * config flip, not a rewrite. */
export const DEFAULT_GOVERNANCE_ROOT = DOCTRINE_TREE

/** The retired tranche-file state an unconfigured file source still reads. */
const LEGACY_TRANCHES_DIR = 'aeg-root/tranches'

export type FileSourceConfig = {
  /** Governance root to read from. Unset, tranches are read from the retired tranche-file state. */
  root?: string
}

/**
 * Transitional StateSource design — wraps the existing `parseTranche`
 * reader over a configurable governance root. Deliberate throwaway: deleted
 * by the future migration tranche once every consumer is forge-backed.
 * Tries the active-tranche path first (`<root>/tranches/<slug>.md`),
 * then the completed path (`<root>/tranches/completed/<slug>.md`) — this
 * repo's own governance root currently holds no active `.md` files (they
 * moved to forge-only reads), so the completed path is the live case today.
 */
export function createFileSource(config: FileSourceConfig = {}): StateSource {
  const tranchesDir = config.root === undefined ? LEGACY_TRANCHES_DIR : join(config.root, 'tranches')
  return {
    async getTranche(slug: string) {
      const activePath = join(tranchesDir, `${slug}.md`)
      const completedPath = join(tranchesDir, 'completed', `${slug}.md`)
      const path = existsSync(activePath) ? activePath : completedPath
      if (!existsSync(path)) {
        throw new Error(`No tranche file found for slug "${slug}" under ${tranchesDir}`)
      }
      return parseTranche(readFileSync(path, 'utf-8'))
    }
  }
}
