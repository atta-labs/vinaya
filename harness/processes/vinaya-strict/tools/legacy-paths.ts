/**
 * The retired directory names, composed from the retired prefix the
 * legacy-spelling module holds.
 *
 * Before the process moved to its own folder, its doctrine, its tranche
 * topology files and a project's own notes lived in directories named after
 * the retired prefix. No repository writes there any more, but the guards
 * that refuse resurrecting those files, and the readers of archived tranche
 * files, still match the old paths. They take them from here, so the retired
 * prefix stays spelled in the legacy-spelling module alone.
 */
import { COMMENT_MARKER_PREFIX } from './legacy-markers'

/** The retired product prefix, as the legacy-spelling module spells it. */
const RETIRED_PREFIX = COMMENT_MARKER_PREFIX.old

/** The retired doctrine root, relative to the repository root. */
export const LEGACY_DOCTRINE_ROOT = `${RETIRED_PREFIX}-root`

/** The retired tranche-file directory, relative to the repository root. */
export const LEGACY_TRANCHES_DIR = `${LEGACY_DOCTRINE_ROOT}/tranches`

/** The retired per-project notes directory name. */
export const LEGACY_PROJECT_DIR = `${RETIRED_PREFIX}-project`

/**
 * The retired static collision-domain file, relative to the repository root.
 * No gate reads it; `vinaya doctor` still names one an adopter's repository
 * carries as deprecated.
 */
export const LEGACY_PACKAGES_FILE = `.${RETIRED_PREFIX}/packages`

/**
 * The bundled-doctrine layout releases published before the doctrine moved
 * into the process folder: its root folder and the front-door skill's path
 * inside it. A probe of an already-published package accepts it beside the
 * current layout.
 */
export const LEGACY_PUBLISHED_DOCTRINE_LAYOUT = {
  root: LEGACY_DOCTRINE_ROOT,
  entry: ['skills', RETIRED_PREFIX, 'SKILL.md']
} as const

/** `text` with every regular-expression metacharacter escaped, for a literal path inside a pattern. */
export function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
