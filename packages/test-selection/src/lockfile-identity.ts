/**
 * The dependency identity of a parsed `bun.lock`: the whole lockfile with only
 * its path text replaced, so moving a workspace folder or a local tarball's
 * path leaves it equal while any change to what gets installed does not.
 *
 * The identity is built by subtraction, never from a list of kept fields:
 * every top-level key and every field of every workspace and package entry
 * stays, and only path text is swapped for a marker that keeps its protocol
 * (`file:<path>`, `link:<path>`, `workspace:<path>`, or `<path>` for a bare
 * relative path) — so a switch between a tarball and a `link:` still shows,
 * and two tarballs at the same path still differ by their integrity.
 *
 * `workspaces` is re-keyed by each entry's `name` instead of its folder. The
 * `packages` map keeps its keys (dependency paths of package names, never
 * folders); each entry is classified by its tuple shape, its meta object
 * found by type, and only its leading `name@spec` can change:
 *
 * - `[name@spec]` — a workspace or linked entry: a path spec is replaced;
 * - `[name@version, registry, meta, integrity]` — a registry entry: kept whole;
 * - `[name@spec, meta, integrity]` — a local tarball, git or github entry: a
 *   path spec (a protocol-free one too, as a tarball's is) is replaced, a git
 *   or github spec and its commit id are kept, the meta and integrity kept;
 * - any other shape is kept whole.
 *
 * Pure: the caller parses the text (the lockfile is JSON with trailing
 * commas) and a malformed or ambiguous lockfile throws, so a reader of it
 * keeps the conservative answer.
 */

const PATH = '<path>'
const PATH_PROTOCOLS = ['workspace:', 'file:', 'link:']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A relative or absolute file-system path: `./x`, `../x`, `/x`, `~/x`, `.` or `..`. */
function isRelativePath(spec: string): boolean {
  return /^(?:\.{1,2}|~)?\//.test(spec) || spec === '.' || spec === '..'
}

/**
 * A dependency spec with its path text replaced. `bare` reads a spec with no
 * protocol as a path, as a local tarball entry's resolution is written.
 */
function pathFreeSpec(spec: string, bare = false): string {
  const protocol = PATH_PROTOCOLS.find((p) => spec.startsWith(p))
  if (protocol) return `${protocol}${PATH}`
  if (isRelativePath(spec)) return PATH
  if (bare && !spec.includes(':')) return PATH
  return spec
}

/** Every string leaf of a value with its path text replaced. */
function pathFreeLeaves(value: unknown): unknown {
  if (typeof value === 'string') return pathFreeSpec(value)
  if (Array.isArray(value)) return value.map(pathFreeLeaves)
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pathFreeLeaves(v)]))
  return value
}

/** A manifest-shaped object with every dependency map's specs path-free; every other field kept. */
function pathFreeManifest(entry: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entry).map(([key, value]) => [
      key,
      key.endsWith('ependencies') && isRecord(value) ? pathFreeLeaves(value) : value
    ])
  )
}

/** `name@spec` with the spec's path text replaced; the name, scoped or not, is kept. */
function pathFreeResolution(resolution: string, bare: boolean): string {
  const at = resolution.indexOf('@', 1)
  if (at < 0) return resolution
  return `${resolution.slice(0, at + 1)}${pathFreeSpec(resolution.slice(at + 1), bare)}`
}

function packageIdentity(entry: unknown): unknown {
  if (!Array.isArray(entry) || typeof entry[0] !== 'string') return entry
  const metaAt = entry.findIndex(isRecord)
  const out: unknown[] = [...entry]
  if (entry.length === 1) out[0] = pathFreeResolution(entry[0], false)
  // `[name@spec, meta, integrity]`: a local tarball, git or github entry.
  else if (metaAt === 1) out[0] = pathFreeResolution(entry[0], true)
  return out
}

function workspacesIdentity(workspaces: unknown): unknown {
  if (!isRecord(workspaces)) return workspaces
  const out: Record<string, unknown> = {}
  for (const [folder, entry] of Object.entries(workspaces)) {
    const key = isRecord(entry) && typeof entry.name === 'string' ? entry.name : folder
    if (key in out) throw new Error(`bun.lock names two workspaces ${JSON.stringify(key)}`)
    out[key] = isRecord(entry) ? pathFreeManifest(entry) : entry
  }
  return out
}

/** The dependency identity of a parsed `bun.lock`; throws on a value that is not a lockfile object. */
export function bunLockIdentity(parsed: unknown): unknown {
  if (!isRecord(parsed)) throw new Error('bun.lock is not an object')
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'workspaces') out[key] = workspacesIdentity(value)
    else if (key === 'packages')
      out[key] = isRecord(value)
        ? Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, packageIdentity(entry)]))
        : value
    else if (key === 'overrides' || key === 'catalog' || key === 'catalogs') out[key] = pathFreeLeaves(value)
    else out[key] = value
  }
  return out
}

/** The installed package a lockfile `packages` key names: its last package name, scoped or not (`a/@s/b` is `@s/b`). */
export function lockKeyPackageName(key: string): string {
  const segments = key.split('/')
  let name = ''
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as string
    if (segment.startsWith('@') && i + 1 < segments.length) {
      name = `${segment}/${segments[i + 1]}`
      i++
    } else name = segment
  }
  return name
}

/**
 * The names of the installed packages whose entry differs between two lockfile identities (`bunLockIdentity`'s
 * result), added and removed ones included; `null` when either side is not an identity with a `packages` object, or
 * when anything beyond `packages` and `workspaces` (an override or catalog) differs, so the caller treats every package
 * as changed. A workspace's declared ranges alone install nothing new: only `packages` says what is installed.
 */
export function changedLockPackages(
  before: unknown,
  after: unknown,
  same: (a: unknown, b: unknown) => boolean
): string[] | null {
  if (!isRecord(before) || !isRecord(after) || !isRecord(before.packages) || !isRecord(after.packages)) return null
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (key !== 'packages' && key !== 'workspaces' && !same(before[key], after[key])) return null
  const names = new Set<string>()
  const a = before.packages
  const b = after.packages
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (!(key in a) || !(key in b) || !same(a[key], b[key])) names.add(lockKeyPackageName(key))
  return [...names].sort()
}
