/**
 * Two files in one package declaring the same symbol name.
 *
 * Not a style rule — a verification hazard. `parse-registry.ts` and
 * `registry-parse.ts` are transpositions of each other, `parse-tranche.ts` is a
 * third neighbour, and all three declare an unexported `stripBackticks`. So
 * "the registry's backtick stripper" names nothing a reader can resolve, and
 * checking a claim about it by grepping returns a confident answer about
 * whichever copy the search landed on. That happened twice in real practice:
 * once in a verification pass that reached the right
 * conclusion for the wrong reason, once in a filed Issue that sent a reader to
 * the wrong file. `parse-registry.ts` was also binary to git at the time (see
 * `no-binary-sources.test.ts`), so `git grep` could not have shown its copy.
 *
 * The lint does not forbid the collision. Plenty are harmless — a `makeTask`
 * helper in two test files collides with nothing anyone reasons about. It
 * reports them so a name that cannot be resolved by eye is known to be one.
 *
 * Deliberately syntactic. Resolving *references* needs the compiler API and is
 * a different, larger job; this only reads declarations, so it is fast, has no
 * dependencies, and cannot silently degrade the way a text search does.
 */
export type SymbolDeclaration = { name: string; file: string; exported: boolean }
export type SymbolCollision = { name: string; files: string[]; anyExported: boolean }

/**
 * A top-level declaration — no leading whitespace, so nested and block-scoped
 * declarations are out of scope by construction.
 *
 * `const enum` is matched before bare `const`, or `export const enum E` would
 * capture the keyword `enum` as the symbol name.
 *
 * KNOWN BLIND SPOTS, stated rather than papered over — a detector that implies
 * coverage it does not have is the failure class it was built to catch:
 *   - a multi-declarator statement (`const a = 1, b = 2`) reports only the
 *     first name;
 *   - column-0 text inside a template literal or a block comment is read as
 *     code, so either can produce a false hit;
 *   - `export { x } from './y'` re-exports are not declarations and are not
 *     reported — correct for this purpose, but it means this does not measure
 *     a module's export surface.
 * Closing these needs a real parse, which is the compiler API and a far larger
 * job than this file.
 */
const DECLARATION =
  /^(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|interface|type|const\s+enum|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm

export function declarationsIn(file: string, source: string): SymbolDeclaration[] {
  const out: SymbolDeclaration[] = []
  DECLARATION.lastIndex = 0
  let m: RegExpExecArray | null = DECLARATION.exec(source)
  while (m !== null) {
    out.push({ name: m[2] as string, file, exported: m[1] !== undefined })
    m = DECLARATION.exec(source)
  }
  return out
}

/**
 * Names declared in more than one file. `files` is sorted so the report is
 * stable across filesystem ordering — a lint that reorders between runs
 * produces diff noise and gets ignored, which is how a lint stops working.
 */
export function findCollisions(decls: SymbolDeclaration[]): SymbolCollision[] {
  const byName = new Map<string, SymbolDeclaration[]>()
  for (const d of decls) {
    const list = byName.get(d.name) ?? []
    list.push(d)
    byName.set(d.name, list)
  }
  const out: SymbolCollision[] = []
  for (const [name, list] of byName) {
    const files = [...new Set(list.map((d) => d.file))].sort()
    if (files.length < 2) continue
    out.push({ name, files, anyExported: list.some((d) => d.exported) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
