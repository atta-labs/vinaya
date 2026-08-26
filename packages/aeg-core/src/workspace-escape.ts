/**
 * Workspace-escape detection (task 17, Issue #78). Neither the module
 * dependency graph nor a literal-path grep sees a filesystem reference built
 * at runtime from a relative string — measured 2026-08-16 during attalabs'
 * adoption of the published CLI: deleting the vendored CLI workspace looked
 * safe by both instruments (nothing depended on it; no source file
 * referenced it by name) and broke a sibling workspace's test suite anyway,
 * via `readFileSync(fileURLToPath(new URL('../../cli/src/index.ts',
 * import.meta.url)))` — not a dependency edge, not an import, and a
 * relative specifier with no literal `apps/vinaya/cli` substring for the
 * grep to hit.
 *
 * This covers the three idioms Issue #78 names: `readFileSync`/`readFile`
 * with a literal relative-path first argument, and `new URL('…',
 * import.meta.url)`. It does NOT follow `import`/`require` module
 * specifiers — the dependency graph already owns those, and duplicating it
 * here would be noise, not signal.
 *
 * Deliberately static-string-only: a literal containing `${…}` (a template
 * with interpolation) is a dynamically computed path and stays out of
 * scope, same as any non-literal argument — resolving those needs data-flow
 * analysis, a different and much larger job than this file (Issue #78's own
 * stated boundary).
 *
 * Zero I/O: every input (file paths + contents, `knownPaths`) is read by the
 * adapter and passed in, same discipline as `doctrine-portability.ts` and
 * `reader-resolvable-prose.ts`.
 */

export type WorkspaceEscapeSourceFile = { path: string; content: string }

export type WorkspaceEscapeReason = 'escapes-workspace-package' | 'path-not-found'

export type WorkspaceEscapeFinding = {
  file: string
  line: number
  reference: string
  resolved: string
  reason: WorkspaceEscapeReason
}

/** `apps/*`/`packages/*` — this repo's own `package.json` `workspaces` globs. A caller with a different layout passes its own. */
const DEFAULT_WORKSPACE_DIRS: readonly string[] = ['apps', 'packages']

/**
 * `readFileSync('./x')`/`readFile('../x')` — literal first argument,
 * required to start `./` or `../` (the only shape found anywhere in this
 * repo's own corpus; a bare non-relative literal like `'utf8'` is always
 * the SECOND argument to these calls, never the first, so requiring the
 * relative prefix costs no real coverage while ruling out an accidental
 * match on an unrelated literal).
 */
const READ_CALL = /\b(?:readFileSync|readFile)\s*\(\s*(['"`])((?:\.\.?\/)[^'"`]*)\1/g

/** `new URL('…', import.meta.url)` — the second argument must be the literal expression, not a variable holding it. */
const NEW_URL_IMPORT_META_URL = /\bnew\s+URL\s*\(\s*(['"`])([^'"`]*)\1\s*,\s*import\.meta\.url\s*\)/g

function lineAt(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++
  }
  return line
}

/**
 * Repo-relative POSIX join + `.`/`..` normalization. No `node:path` — every
 * input here is already POSIX (repo-relative, forward-slash), so there is
 * no platform-separator handling to delegate, and this package's other pure
 * scanners (`doctrine-portability.ts`, `reader-resolvable-prose.ts`) carry
 * no filesystem-module dependency either.
 */
function resolveRelative(fromDir: string, ref: string): string {
  const stack = fromDir === '' ? [] : fromDir.split('/')
  for (const segment of ref.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') stack.pop()
    else stack.push(segment)
  }
  return stack.join('/')
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? '' : path.slice(0, idx)
}

/** The workspace package a repo-relative path belongs to — its first two segments when it sits under one of `workspaceDirs` (`apps/<name>`, `packages/<name>`); `null` for a repo-root file, `aeg-root/**`, or anything that normalizes above the repo root entirely. */
function workspacePackageOf(path: string, workspaceDirs: readonly string[]): string | null {
  const [first, second] = path.split('/')
  if (first === undefined || second === undefined || !workspaceDirs.includes(first)) return null
  return `${first}/${second}`
}

type ExtractedReference = { line: number; reference: string; resolved: string }

/**
 * Both idioms scanned by raw pattern, not a parser — same syntactic
 * discipline as `symbol-collisions.ts`'s declaration scan. KNOWN BLIND SPOT,
 * stated rather than papered over: a match inside a string or a comment
 * reads as code, same limitation that file documents for its own regex.
 * Not measured as a real risk here — a repo-wide scan of this codebase
 * found zero such decoys (every real hit was a genuine call site).
 */
function extractReferences(path: string, content: string): ExtractedReference[] {
  const dir = dirOf(path)
  const out: ExtractedReference[] = []
  for (const pattern of [READ_CALL, NEW_URL_IMPORT_META_URL]) {
    pattern.lastIndex = 0
    let m: RegExpExecArray | null = pattern.exec(content)
    while (m !== null) {
      const literal = m[2] as string
      if (!literal.includes('${')) {
        out.push({ line: lineAt(content, m.index), reference: literal, resolved: resolveRelative(dir, literal) })
      }
      m = pattern.exec(content)
    }
  }
  return out
}

/**
 * Static filesystem references that either resolve outside the citing
 * file's own workspace package, or to a repo path that does not exist at
 * all. `knownPaths` is every repo-relative path that exists on disk,
 * collected by the adapter — this module never touches the filesystem.
 * `workspaceDirs` defaults to this repo's own `apps`/`packages` layout; a
 * file outside every workspace dir is skipped entirely (there is no "own
 * package" for it to escape).
 */
export function findWorkspaceEscapes(
  files: readonly WorkspaceEscapeSourceFile[],
  knownPaths: ReadonlySet<string>,
  workspaceDirs: readonly string[] = DEFAULT_WORKSPACE_DIRS
): WorkspaceEscapeFinding[] {
  const findings: WorkspaceEscapeFinding[] = []
  for (const file of files) {
    const own = workspacePackageOf(file.path, workspaceDirs)
    if (own === null) continue
    for (const ref of extractReferences(file.path, file.content)) {
      const target = workspacePackageOf(ref.resolved, workspaceDirs)
      const escapes = target !== own
      const missing = !knownPaths.has(ref.resolved)
      if (escapes || missing) {
        findings.push({
          file: file.path,
          line: ref.line,
          reference: ref.reference,
          resolved: ref.resolved,
          reason: escapes ? 'escapes-workspace-package' : 'path-not-found'
        })
      }
    }
  }
  return findings
}
