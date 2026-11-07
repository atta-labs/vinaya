/**
 * The doctrine map — the one committed list of every doctrine file the Vinaya
 * process carries. Each row names:
 *
 * - `key` — the file's logical key, the path it had under the doctrine's old
 *   single root folder (`roles/developer.md`, `contracts/developer-reviewer.md`,
 *   `enforcement.md`, `templates/brief-template.md`). Readers that key their
 *   output by that layout (the documentation checks, the doctrine source, the
 *   registry gates) look a key up here instead of joining a folder and a name.
 *   The keys are code keys, not doctrine text.
 * - `source` — where the file lives, relative to the process folder. The same
 *   relative path is used under the installed package's `vinaya-strict/`
 *   folder, so a relative link between doctrine files resolves the same way in
 *   the source tree and in an installed package.
 * - `role` — the role id `vinaya doctrine --role` serves the file for, when it
 *   is a role's doctrine.
 * - `template` — the name `vinaya doctrine --template` serves it under, when
 *   it is a template.
 * - `ships` — whether the bundler copies it into the published package.
 *
 * Every reader of the doctrine — the resolver, the review loop's role-file
 * resolution, the skill emitters' role discovery, the template listing and the
 * bundler — reads this map and nothing else.
 */

export type DoctrineMapEntry = {
  readonly key: string
  readonly source: string
  readonly role?: string
  readonly template?: string
  readonly ships: boolean
}

/** The process folder, relative to the repository root — the doctrine tree the source paths are relative to. */
export const DOCTRINE_TREE = 'harness/processes/vinaya-strict'

/** The folder the bundler copies the shipped files into, inside the command line package, and the last segment of `DOCTRINE_TREE`. */
export const BUNDLED_DOCTRINE_DIR = 'vinaya-strict'

export const DOCTRINE_MAP: readonly DoctrineMapEntry[] = [
  { key: 'aeg-manual-flow.md', source: 'doctrine/manual-flow.md', ships: false },
  { key: 'contracts/architect-planner.md', source: 'doctrine/contracts/architect-planner.md', ships: true },
  {
    key: 'contracts/archivist-tranche-archivist.md',
    source: 'doctrine/contracts/archivist-tranche-archivist.md',
    ships: true
  },
  { key: 'contracts/developer-reviewer.md', source: 'doctrine/contracts/developer-reviewer.md', ships: true },
  { key: 'contracts/planner-developer.md', source: 'doctrine/contracts/planner-developer.md', ships: true },
  { key: 'contracts/planner-operator.md', source: 'doctrine/contracts/planner-operator.md', ships: true },
  { key: 'contracts/principal-operator.md', source: 'doctrine/contracts/principal-operator.md', ships: true },
  { key: 'contracts/reviewer-archivist.md', source: 'doctrine/contracts/reviewer-archivist.md', ships: true },
  { key: 'contracts/security-archivist.md', source: 'doctrine/contracts/security-archivist.md', ships: true },
  {
    key: 'contracts/tranche-archivist-planner.md',
    source: 'doctrine/contracts/tranche-archivist-planner.md',
    ships: true
  },
  { key: 'documentation-coherence.md', source: 'doctrine/documentation-coherence.md', ships: false },
  { key: 'enforcement.md', source: 'doctrine/enforcement.md', ships: true },
  { key: 'glossary.md', source: 'doctrine/glossary.md', ships: true },
  { key: 'milestone-model.md', source: 'doctrine/milestone-model.md', ships: true },
  { key: 'process.md', source: 'doctrine/process.md', ships: true },
  { key: 'reviewer-prompt.md', source: 'thinking/reviewer-prompt.md', ships: false },
  { key: 'roles/architect.md', source: 'thinking/architect/doctrine.md', role: 'architect', ships: true },
  { key: 'roles/archivist.md', source: 'retrospecting/archivist/doctrine.md', role: 'archivist', ships: true },
  { key: 'roles/developer.md', source: 'executing/developer/doctrine.md', role: 'developer', ships: true },
  { key: 'roles/developer/reference.md', source: 'executing/developer/reference.md', ships: true },
  { key: 'roles/operator.md', source: 'executing/operator/doctrine.md', role: 'operator', ships: true },
  { key: 'roles/planner.md', source: 'thinking/planner/doctrine.md', role: 'planner', ships: true },
  { key: 'roles/planner/reference.md', source: 'thinking/planner/reference.md', ships: true },
  { key: 'roles/principal.md', source: 'doctrine/roles/principal.md', role: 'principal', ships: true },
  { key: 'roles/reviewer.md', source: 'executing/code-reviewer/doctrine.md', role: 'reviewer', ships: true },
  { key: 'roles/security.md', source: 'executing/security-reviewer/doctrine.md', role: 'security', ships: true },
  {
    key: 'roles/tranche-archivist.md',
    source: 'retrospecting/tranche-archivist/doctrine.md',
    role: 'tranche-archivist',
    ships: true
  },
  {
    key: 'skills/aeg-context-packets/SKILL.md',
    source: 'doctrine/skills/context-packets/SKILL.md',
    ships: true
  },
  {
    key: 'skills/aeg-context-packets/examples/operator-start.md',
    source: 'doctrine/skills/context-packets/examples/operator-start.md',
    ships: true
  },
  { key: 'skills/aeg-roles/SKILL.md', source: 'doctrine/skills/roles/SKILL.md', ships: true },
  { key: 'skills/aeg/SKILL.md', source: 'doctrine/skills/vinaya/SKILL.md', ships: true },
  { key: 'state-machine.md', source: 'doctrine/state-machine.md', ships: true },
  { key: 'task-model.md', source: 'doctrine/task-model.md', ships: true },
  {
    key: 'templates/brief-template.md',
    source: 'artifacts/templates/brief-template.md',
    template: 'brief',
    ships: true
  },
  {
    key: 'templates/decision-record-template.md',
    source: 'artifacts/templates/decision-record-template.md',
    template: 'decision-record',
    ships: true
  },
  {
    key: 'templates/issue-rationale-template.md',
    source: 'artifacts/templates/issue-rationale-template.md',
    template: 'issue-rationale',
    ships: true
  },
  {
    key: 'templates/pr-report-template.md',
    source: 'artifacts/templates/pr-report-template.md',
    template: 'pr-report',
    ships: true
  },
  { key: 'tranche-model.md', source: 'doctrine/tranche-model.md', ships: true }
]

/** The doctrine's front door: the logical key of the operating-model skill every session loads first. */
export const FRONT_DOOR_KEY = 'skills/aeg/SKILL.md'

const BY_KEY: ReadonlyMap<string, DoctrineMapEntry> = new Map(DOCTRINE_MAP.map((entry) => [entry.key, entry]))

/** The map row for a logical key, or `undefined` when the key names no doctrine file. */
export function doctrineEntry(key: string): DoctrineMapEntry | undefined {
  return BY_KEY.get(key)
}

/** The process-relative source path of a logical key; throws for a key the map does not carry, which is a programming error. */
export function doctrineSource(key: string): string {
  const entry = BY_KEY.get(key)
  if (entry === undefined) throw new Error(`doctrine map: no file for logical key "${key}"`)
  return entry.source
}

/** The process-relative path of the front door. */
export const FRONT_DOOR_SOURCE = doctrineSource(FRONT_DOOR_KEY)

/** Every source path, repository-relative (`harness/processes/vinaya-strict/<source>`). */
export const DOCTRINE_REPO_PATHS: readonly string[] = DOCTRINE_MAP.map((entry) => `${DOCTRINE_TREE}/${entry.source}`)

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A regular-expression source matching exactly one of the map's
 * repository-relative source paths — for the patterns that recognize a
 * doctrine path inside other text, so they recognize the doctrine and nothing
 * else under `harness/`.
 */
export const DOCTRINE_PATH_PATTERN_SOURCE = `(?:${DOCTRINE_REPO_PATHS.map(escapeRegExp).join('|')})`

/** The repository-relative path of one logical key's file. */
export function doctrineRepoPath(key: string): string {
  return `${DOCTRINE_TREE}/${doctrineSource(key)}`
}

/** The logical key for a process-relative source path, or `undefined` when the path is not a doctrine file. */
export function keyForSource(source: string): string | undefined {
  return DOCTRINE_MAP.find((entry) => entry.source === source)?.key
}

/** The logical key for a repository-relative path, or `undefined` when the path is not a doctrine file. */
export function keyForRepoPath(path: string): string | undefined {
  const prefix = `${DOCTRINE_TREE}/`
  return path.startsWith(prefix) ? keyForSource(path.slice(prefix.length)) : undefined
}

/** Whether a repository-relative path is one of the map's source paths. */
export function isDoctrineRepoPath(path: string): boolean {
  return keyForRepoPath(path) !== undefined
}

/** The role doctrine rows — one per role id, the ones `--role` serves. */
export const ROLE_ENTRIES: readonly DoctrineMapEntry[] = DOCTRINE_MAP.filter((entry) => entry.role !== undefined)

/** The template rows, sorted by template name. */
export const TEMPLATE_ENTRIES: readonly DoctrineMapEntry[] = DOCTRINE_MAP.filter(
  (entry) => entry.template !== undefined
).sort((a, b) => (a.template ?? '').localeCompare(b.template ?? ''))

/** The map row of a role id, or `undefined` when no role doctrine carries that id. */
export function roleEntry(role: string): DoctrineMapEntry | undefined {
  return ROLE_ENTRIES.find((entry) => entry.role === role)
}

/** The rows of the contracts, keyed `contracts/<name>.md`. */
export const CONTRACT_ENTRIES: readonly DoctrineMapEntry[] = DOCTRINE_MAP.filter((entry) =>
  /^contracts\/[^/]+\.md$/.test(entry.key)
)

/** The role-doctrine rows keyed `roles/<id>.md` — the files the old layout listed directly under its `roles/` folder. */
export const ROLE_KEY_ENTRIES: readonly DoctrineMapEntry[] = DOCTRINE_MAP.filter((entry) =>
  /^roles\/[^/]+\.md$/.test(entry.key)
)
