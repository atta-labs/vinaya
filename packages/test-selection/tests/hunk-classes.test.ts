// The hunk classifier over fixture pairs: each case is a file's text before and
// after a change, and the class every hunk of it must get.
import { describe, expect, it } from 'bun:test'
import {
  type ChangeStatus,
  classifyHunks,
  type FileHunkClasses,
  type HunkClass,
  loadLibraryTypeScript,
  type TypeScriptApi
} from '../src/index.js'

const ts = loadLibraryTypeScript() as TypeScriptApi

function classify(
  before: string | null,
  after: string | null,
  options: { path?: string; status?: ChangeStatus; ts?: TypeScriptApi | null } = {}
): FileHunkClasses {
  return classifyHunks({
    path: options.path ?? 'src/module.ts',
    status: options.status ?? 'modified',
    before,
    after,
    ts: options.ts === undefined ? ts : options.ts
  })
}

const kinds = (result: FileHunkClasses): string[] => result.hunks.map((hunk) => hunk.kind)

function only<K extends HunkClass['kind']>(result: FileHunkClasses, kind: K): Extract<HunkClass, { kind: K }> {
  expect(result.hunks).toHaveLength(1)
  const hunk = result.hunks[0] as HunkClass
  expect(hunk.kind).toBe(kind)
  return hunk as Extract<HunkClass, { kind: K }>
}

function expectUnclassified(result: FileHunkClasses, reason: string): void {
  expect(result.classified).toBe(false)
  expect(result.reason).toBe(reason as FileHunkClasses['reason'])
  expect(result.hunks.length).toBeGreaterThan(0)
  for (const hunk of result.hunks) expect(hunk.kind).toBe('unclassified')
}

const BASE = [
  "import { join } from 'node:path'",
  '',
  'const LIMIT = 3',
  '',
  'export function total(items: number[]): number {',
  '  let sum = 0',
  '  for (const item of items) sum += item',
  '  return sum',
  '}',
  '',
  'export class Store {',
  '  private items: string[] = []',
  '',
  '  add(item: string): void {',
  '    this.items.push(item)',
  '  }',
  '',
  '  path(root: string): string {',
  '    const parts = this.items.map((item) => {',
  '      return item.trim()',
  '    })',
  '    return join(root, ...parts)',
  '  }',
  '}',
  ''
].join('\n')

const edit = (from: string, to: string): string => {
  expect(BASE.includes(from)).toBe(true)
  return BASE.replace(from, to)
}

describe('body-only hunks', () => {
  it('names the function a change strictly inside its body lies in, with its spans on both sides', () => {
    const result = classify(BASE, edit('  let sum = 0\n', '  let sum = 0\n  if (items.length > LIMIT) sum = 1\n'))
    expect(result.classified).toBe(true)
    const hunk = only(result, 'body-only')
    expect(hunk.function.name).toBe('total')
    expect(hunk.hunk).toEqual({ before: { start: 6, end: 5 }, after: { start: 7, end: 7 } })
    expect(hunk.function.before).toEqual({ span: { start: 5, end: 9 }, body: { start: 5, end: 9 }, nested: [] })
    expect(hunk.function.after).toEqual({ span: { start: 5, end: 10 }, body: { start: 5, end: 10 }, nested: [] })
  })

  it('names a method by its class, and reports the functions nested in it', () => {
    const result = classify(BASE, edit('    return join(root, ...parts)', '    return join(root, ...parts.reverse())'))
    const hunk = only(result, 'body-only')
    expect(hunk.function.name).toBe('Store.path')
    expect(hunk.function.before.nested).toEqual([{ start: 19, end: 21 }])
    expect(hunk.function.after.nested).toEqual([{ start: 19, end: 21 }])
  })

  it('names the innermost function, anonymous ones included', () => {
    const hunk = only(classify(BASE, edit('      return item.trim()', '      return item.trimEnd()')), 'body-only')
    expect(hunk.function.name).toBe('Store.path.<anonymous>')
    expect(hunk.function.before.body).toEqual({ start: 19, end: 21 })
  })

  it('classifies every hunk when each lies in a different function body', () => {
    const after = edit('  let sum = 0', '  let sum = 1').replace(
      '    this.items.push(item)',
      '    this.items.unshift(item)'
    )
    const result = classify(BASE, after)
    expect(result.classified).toBe(true)
    expect(result.hunks.map((h) => (h.kind === 'body-only' ? h.function.name : h.kind))).toEqual(['total', 'Store.add'])
  })

  it('classifies a deletion inside a body', () => {
    const hunk = only(classify(BASE, edit('  let sum = 0\n', '')), 'body-only')
    expect(hunk.hunk.after.end).toBeLessThan(hunk.hunk.after.start)
    expect(hunk.function.name).toBe('total')
  })

  it('reports no hunks and a classified file when the texts are equal', () => {
    expect(classify(BASE, BASE)).toEqual({ path: 'src/module.ts', classified: true, reason: null, hunks: [] })
  })
})

describe('signature and enclosing chain', () => {
  it('leaves a parameter change unclassified', () => {
    expectUnclassified(
      classify(BASE, edit('total(items: number[])', 'total(items: readonly number[])')),
      'outside-function-bodies'
    )
  })

  it('leaves a change on the closing brace line unclassified', () => {
    const before = 'function f() {\n  return 1\n}\n'
    expectUnclassified(classify(before, 'function f() {\n  return 1\n} // done\n'), 'outside-function-bodies')
  })

  it('leaves a body change unclassified when a multi-line signature also changed', () => {
    const before = 'function f(\n  a: number\n) {\n  return a\n}\n'
    const after = 'function f(\n  a: number = 2\n) {\n  return a + 1\n}\n'
    expect(classify(before, after).classified).toBe(false)
  })

  it('leaves a body change unclassified when an enclosing declaration changed', () => {
    const before = 'class A {\n  m() {\n    return 1\n  }\n}\n'
    const after = 'class A extends Object {\n  m() {\n    return 2\n  }\n}\n'
    expectUnclassified(classify(before, after), 'outside-function-bodies')
  })

  it('compares the signature and chain even where the lines around the hunk are unchanged', () => {
    // The opening brace moves to a new function: the body's lines map, the function does not.
    const before = 'function f() {\n  const x = 1\n  return x\n}\n'
    const after = 'function f() {\n  const x = 1\n  }\n  function g() {\n  return x\n}\n'
    expect(classify(before, after).classified).toBe(false)
  })

  it('leaves a change to a decorator unclassified', () => {
    const before = 'class A {\n  @log\n  m() {\n    return 1\n  }\n}\n'
    const after = 'class A {\n  @trace\n  m() {\n    return 2\n  }\n}\n'
    expect(classify(before, after).classified).toBe(false)
  })

  it("leaves a body change unclassified when its own function's signature changed inside an outer body", () => {
    const before = [
      'function outer() {',
      '  function inner(',
      '    a: number',
      '  ) {',
      '    const b = a',
      '    return b',
      '  }',
      '  return inner(1)',
      '}',
      ''
    ].join('\n')
    const after = before.replace('    a: number', '    a: number = 2').replace('    const b = a', '    const b = a + 1')
    const result = classify(before, after)
    expect(result.classified).toBe(false)
    expect(result.reason).toBe('signature-or-enclosing-changed')
    expect(result.hunks.map((h) => (h.kind === 'unclassified' ? h.reason : h.kind))).toEqual([
      'other-hunk-unclassified',
      'signature-or-enclosing-changed'
    ])
  })

  it('leaves a body change unclassified when an enclosing function inside an outer body changed its signature', () => {
    const before = [
      'function outer() {',
      '  function middle(',
      '    a: number',
      '  ) {',
      '    return () => {',
      '      const b = a',
      '      return b',
      '    }',
      '  }',
      '  return middle(1)',
      '}',
      ''
    ].join('\n')
    const after = before
      .replace('    a: number', '    a: string')
      .replace('      const b = a', '      const b = a.length')
    const result = classify(before, after)
    expect(result.reason).toBe('signature-or-enclosing-changed')
    expect(result.hunks.map((h) => (h.kind === 'unclassified' ? h.reason : h.kind))).toEqual([
      'other-hunk-unclassified',
      'signature-or-enclosing-changed'
    ])
  })
})

describe('inert additions', () => {
  it('classifies added inert declarations and lists their names', () => {
    const added = [
      '',
      '/** A helper. */',
      'function helper(value: number): number {',
      '  return value * 2',
      '}',
      'type Pair = [number, number]',
      'interface Shape {',
      '  size: number',
      '}',
      'class Box {',
      '  value = 1',
      '  get double() {',
      '    return this.value * 2',
      '  }',
      '}',
      'const NAME = "box"',
      'const COUNT = -1, ENABLED = true, NOTHING = null',
      'const double = (n: number) => n * 2',
      'const triple = function (n: number) {',
      '  return n * 3',
      '}'
    ].join('\n')
    const result = classify(BASE, edit('const LIMIT = 3\n', `const LIMIT = 3\n${added}\n`))
    expect(result.classified).toBe(true)
    const hunk = only(result, 'inert-addition')
    expect(hunk.names).toEqual([
      'helper',
      'Pair',
      'Shape',
      'Box',
      'NAME',
      'COUNT',
      'ENABLED',
      'NOTHING',
      'double',
      'triple'
    ])
    expect(hunk.importSpecifiers).toEqual([])
  })

  it('classifies an added type-only import and lists its specifier', () => {
    const result = classify(
      BASE,
      edit(
        "import { join } from 'node:path'\n",
        "import { join } from 'node:path'\nimport type { Stats } from 'node:fs'\n"
      )
    )
    const hunk = only(result, 'inert-addition')
    expect(hunk.names).toEqual(['Stats'])
    expect(hunk.importSpecifiers).toEqual(['node:fs'])
  })

  it('classifies an addition beside a body-only change', () => {
    const after = edit('const LIMIT = 3\n', 'const LIMIT = 3\nconst STEP = 2\n').replace(
      '  let sum = 0',
      '  let sum = STEP'
    )
    const result = classify(BASE, after)
    expect(result.classified).toBe(true)
    expect(kinds(result)).toEqual(['inert-addition', 'body-only'])
  })

  const notInert: [string, string, string][] = [
    ['an exported function', 'export function added() {}', 'exported'],
    ['an exported type', 'export type Added = string', 'exported'],
    ['a runtime relative import', "import { other } from './other.js'", 'runtime-import'],
    ['a side-effect import', "import './setup.js'", 'runtime-import'],
    ['an import with inline type specifiers only', "import { type Other } from './other.js'", 'runtime-import'],
    ['a class with a heritage clause', 'class Added extends Map {}', 'not-inert'],
    ['a class with a computed key', "class Added {\n  ['key']() {}\n}", 'not-inert'],
    ['a class with a static member', 'class Added {\n  static count = 0\n}', 'not-inert'],
    ['a class with a static block', 'class Added {\n  static {\n  }\n}', 'not-inert'],
    ['a class with a decorated member', 'class Added {\n  @log\n  m() {}\n}', 'not-inert'],
    ['a template-literal const', 'const ADDED = `x`', 'not-inert'],
    ['a template-literal const with a substitution', ['const ADDED = `x$', '{1}`'].join(''), 'not-inert'],
    ['an object-literal const', 'const ADDED = { a: 1 }', 'not-inert'],
    ['a call const', 'const ADDED = compute()', 'not-inert'],
    ['a let', 'let added = 1', 'not-inert'],
    ['a destructuring const', 'const { length } = "abc"', 'not-inert'],
    ['an enum', 'enum Added {\n  A\n}', 'not-inert'],
    ['a statement', 'console.log(1)', 'not-inert'],
    ['a declare const', 'declare const ADDED: number', 'not-inert'],
    ['a shadowing name', 'const structuredClone = 42', 'name-collision'],
    ['a redeclared name', 'function LIMIT() {}', 'load-error'],
    ['a name the old text referenced', 'type item = string', 'name-collision'],
    ['an import binding shadowing a used name', "import type { join as sum } from 'node:path'", 'name-collision']
  ]
  for (const [label, line, reason] of notInert) {
    it(`leaves ${label} unclassified`, () => {
      const before = `${BASE}function clone<T>(value: T): T {\n  return structuredClone(value)\n}\n`
      const after = before.replace('const LIMIT = 3\n', `const LIMIT = 3\n${line}\n`)
      expectUnclassified(classify(before, after), reason)
    })
  }

  it('leaves an added name the old text declared in an inner scope unclassified', () => {
    const before = 'function f() {\n  const local = 1\n  return local\n}\n'
    expectUnclassified(classify(before, `${before}function local() {}\n`), 'name-collision')
  })

  it('classifies blank lines added or removed between top-level statements, binding no names', () => {
    const before = 'const a = 1\n\nconst b = 2\n'
    const added = only(classify(before, 'const a = 1\n\n\nconst b = 2\n'), 'inert-addition')
    expect(added.names).toEqual([])
    const removed = classify(before, 'const a = 1\nconst b = 2\n')
    expect(removed.classified).toBe(true)
    expect(kinds(removed)).toEqual(['inert-addition'])
  })

  it('leaves a blank line inside a top-level template literal or comment unclassified', () => {
    const template = 'const a = `x\n\ny`\n'
    expectUnclassified(classify(template, 'const a = `x\n\n\ny`\n'), 'outside-function-bodies')
    expectUnclassified(classify(template, 'const a = `x\ny`\n'), 'outside-function-bodies')
    const comment = '/*\n * a\n\n */\nconst a = 1\n'
    expectUnclassified(classify(comment, '/*\n * a\n */\nconst a = 1\n'), 'outside-function-bodies')
  })

  it('leaves an added statement unclassified when it changes how the next line parses', () => {
    const before = 'const a = b\n\nfunction g() {}\n'
    expect(classify(before, 'const a = b\nfunction h() {}\n(g)\n\nfunction g() {}\n').classified).toBe(false)
  })

  it('leaves an addition that replaced a non-blank line unclassified', () => {
    expectUnclassified(classify(BASE, edit('const LIMIT = 3\n', 'function helper() {}\n')), 'outside-function-bodies')
  })
})

describe('unclassified changes', () => {
  it('leaves a comment changed outside every function body unclassified', () => {
    const before = '// Totals.\nexport function total() {\n  return 1\n}\n'
    expectUnclassified(classify(before, before.replace('// Totals.', '// Sums.')), 'outside-function-bodies')
  })

  it('leaves a comment added outside every function body unclassified', () => {
    const before = 'export function total() {\n  return 1\n}\n'
    expectUnclassified(classify(before, `// Totals.\n${before}`), 'outside-function-bodies')
  })

  it('leaves a changed top-level initializer unclassified', () => {
    expectUnclassified(classify(BASE, edit('const LIMIT = 3', 'const LIMIT = 4')), 'outside-function-bodies')
  })

  it('leaves a changed class field unclassified', () => {
    expectUnclassified(
      classify(BASE, edit('private items: string[] = []', 'private items: string[] = ["a"]')),
      'outside-function-bodies'
    )
  })

  it('makes every hunk of a file unclassified when one is', () => {
    const after = edit('const LIMIT = 3', 'const LIMIT = 4').replace('  let sum = 0', '  let sum = 1')
    const result = classify(BASE, after)
    expect(result.classified).toBe(false)
    expect(result.hunks.map((h) => (h.kind === 'unclassified' ? h.reason : h.kind))).toEqual([
      'outside-function-bodies',
      'other-hunk-unclassified'
    ])
  })

  const files: [string, Parameters<typeof classify>, string][] = [
    ['a new file', [null, BASE, { status: 'added' }], 'not-modified'],
    ['a deleted file', [BASE, null, { status: 'deleted' }], 'not-modified'],
    ['a renamed file', [BASE, edit('  let sum = 0', '  let sum = 1'), { status: 'renamed' }], 'not-modified'],
    ['a .tsx file', [BASE, edit('  let sum = 0', '  let sum = 1'), { path: 'src/view.tsx' }], 'not-ts'],
    ['a .js file', [BASE, edit('  let sum = 0', '  let sum = 1'), { path: 'src/module.js' }], 'not-ts'],
    ['a declaration file', [BASE, edit('  let sum = 0', '  let sum = 1'), { path: 'src/module.d.ts' }], 'not-ts'],
    ['a test file', [BASE, edit('  let sum = 0', '  let sum = 1'), { path: 'tests/module.test.ts' }], 'test-file'],
    ['a spec file', [BASE, edit('  let sum = 0', '  let sum = 1'), { path: 'tests/module.spec.ts' }], 'test-file'],
    [
      'a file without TypeScript',
      [BASE, edit('  let sum = 0', '  let sum = 1'), { ts: null }],
      'typescript-unavailable'
    ],
    ['a file that does not parse after the change', [BASE, edit('  let sum = 0', '  let sum = (0'), {}], 'unparseable'],
    ['a file that did not parse before the change', [edit('  let sum = 0', '  let sum = (0'), BASE, {}], 'unparseable'],
    ['an await outside an async function', [BASE, edit('  let sum = 0', '  let sum = await 0'), {}], 'load-error'],
    ['a duplicate let', [BASE, edit('  let sum = 0', '  let sum = 0\n  let sum = 1'), {}], 'load-error'],
    ['a name used before its declaration at load', ['const a = 1\n', 'const a = b\nconst b = 1\n'], 'load-error']
  ]
  for (const [label, args, reason] of files) {
    it(`leaves ${label} unclassified`, () => expectUnclassified(classify(...args), reason))
  }
})
