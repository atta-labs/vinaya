/**
 * A prototype of a planned split, applied to a staging copy of the repository
 * and never to the workspace: `globToRegex` leaves
 * `packages/aeg-core/src/doc-owners.ts` for its own module under the kernel's
 * gates folder, outside the package, and `doc-owners.ts` imports it back and
 * re-exports it, as a package entry may do in the workspace. The assemble step
 * then has to ship that module inside the aeg-core tarball at the module path
 * {@link SPLIT_MODULE} records.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import type { InternalModule } from '../assemble-pack.ts'

export const DOC_OWNERS = 'packages/aeg-core/src/doc-owners.ts'
/** Where the split module lives in the staging copy, outside the package. */
export const SPLIT_SOURCE = 'harness/kernel/gates/glob-to-regex.ts'
/** The specifier `doc-owners.ts` imports the split module by. */
export const SPLIT_SPECIFIER = '../../../harness/kernel/gates/glob-to-regex'

/** The allowlist entry the split needs: the module path it ships at inside the tarball. */
export const SPLIT_MODULE: InternalModule = {
  path: 'src/glob-to-regex.ts',
  source: SPLIT_SOURCE,
  reason: 'the doc-owners glob translation, split out of doc-owners.ts and shipped inside the package'
}

/** Applies the split under `stagingRoot`, a copy of the repository; returns the rewritten `doc-owners.ts` text. */
export function applySplitPrototype(stagingRoot: string): string {
  const path = join(stagingRoot, DOC_OWNERS)
  const text = readFileSync(path, 'utf8')
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const fn = file.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'globToRegex'
  )
  if (!fn) throw new Error(`split prototype: ${DOC_OWNERS} declares no globToRegex`)
  // The function with its leading doc comment.
  const start = fn.getFullStart() + (text.slice(fn.getFullStart(), fn.getStart(file)).match(/^\s*/)?.[0].length ?? 0)
  const moved = text.slice(start, fn.getEnd())

  const module = join(stagingRoot, SPLIT_SOURCE)
  mkdirSync(dirname(module), { recursive: true })
  writeFileSync(module, `${moved}\n`)

  const lastImport = [...file.statements].reverse().find((s) => ts.isImportDeclaration(s))
  const at = lastImport ? lastImport.getEnd() : 0
  const withImport = `${text.slice(0, at)}\nimport { globToRegex } from '${SPLIT_SPECIFIER}'${text.slice(at, start)}`
  const rewritten = `${withImport}export { globToRegex }${text.slice(fn.getEnd())}`
  writeFileSync(path, rewritten)
  return rewritten
}
