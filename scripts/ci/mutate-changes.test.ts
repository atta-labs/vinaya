import { afterAll, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  applyInsertions,
  changedLines,
  type MutationReport,
  mutateChanges,
  mutateSource,
  parseArgs,
  parseErrorOf
} from './mutate-changes.ts'

const scratch = mkdtempSync(join(tmpdir(), 'mutate-changes-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Mutates `after` against `before` as `file`, and asserts the result parses whenever there is one. */
function mutate(file: string, before: string, after: string) {
  const result = mutateSource(file, after, changedLines(before, after))
  if (result.text !== null) expect(parseErrorOf(file, result.text)).toBeNull()
  return result
}

let moduleCount = 0
/** Loads mutated text as a module, so a test can call what it exports. */
async function load(text: string): Promise<Record<string, unknown>> {
  const path = join(scratch, `module-${moduleCount++}.ts`)
  writeFileSync(path, text)
  return (await import(path)) as Record<string, unknown>
}

describe('changedLines', () => {
  it('lists every line of every hunk and each pure deletion by the line before it', () => {
    const before = 'a\nb\nc\nd\ne\n'
    const after = 'a\nB\nC\nD\ne\nf\n'
    expect(changedLines(before, after)).toEqual({ lines: [2, 3, 4, 6], deletions: [] })
    expect(changedLines('a\nb\nc\n', 'a\nc\n')).toEqual({ lines: [], deletions: [1] })
  })
})

describe('mutateSource', () => {
  it('body-only change: the function holding the line throws, naming file, line and function; others run', async () => {
    const before = [
      'export function add(a: number, b: number): number {',
      '  return a + b',
      '}',
      'export function sub(a: number, b: number): number {',
      '  return a - b',
      '}',
      ''
    ].join('\n')
    const after = before.replace('return a + b', 'return b + a')
    const result = mutate('src/body.ts', before, after)
    expect(result.functions).toEqual([{ name: 'add', line: 2, functionLine: 1 }])
    expect(result.unplaceable).toEqual([])
    expect(result.text?.split('\n')[0]).toBe(
      'export function add(a: number, b: number): number { throw new Error("mutate-changes: src/body.ts:2 add");'
    )
    const mod = await load(result.text as string)
    expect(() => (mod.add as (a: number, b: number) => number)(1, 2)).toThrow('mutate-changes: src/body.ts:2 add')
    expect((mod.sub as (a: number, b: number) => number)(3, 1)).toBe(2)
  })

  it('several changed lines in one hunk: every line is covered, each function mutated once', async () => {
    const before = [
      'export function first(): number {',
      '  const x = 1',
      '  return x',
      '}',
      'export function second(): number {',
      '  return 2',
      '}',
      'export function third(): number {',
      '  return 3',
      '}',
      ''
    ].join('\n')
    // One hunk over lines 2–6: two lines of `first`, its closing brace, `second`'s header and body.
    const after = [
      'export function first(): number {',
      '  const x = 10',
      '  return x + 0',
      '} ',
      'export function second(): number  {',
      '  return 20',
      '}',
      'export function third(): number {',
      '  return 3',
      '}',
      ''
    ].join('\n')
    expect(changedLines(before, after).lines).toEqual([2, 3, 4, 5, 6])
    const result = mutate('multi.ts', before, after)
    expect(result.functions).toEqual([
      { name: 'first', line: 2, functionLine: 1 },
      { name: 'second', line: 5, functionLine: 5 }
    ])
    expect(result.text?.match(/mutate-changes:/g)).toHaveLength(2)
    const mod = await load(result.text as string)
    expect(() => (mod.first as () => number)()).toThrow('mutate-changes: multi.ts:2 first')
    expect(() => (mod.second as () => number)()).toThrow('mutate-changes: multi.ts:5 second')
    expect((mod.third as () => number)()).toBe(3)
  })

  it('nested arrows: outer and inner expression bodies are wrapped outer-first and never cancel', async () => {
    const before = ['export const make = (a: number) =>', '  (b: number) =>', '    a + b', ''].join('\n')
    const after = ['export const make = (a: number, _c = 0) =>', '  (b: number) =>', '    a - b', ''].join('\n')
    const result = mutate('nested.ts', before, after)
    expect(result.functions).toEqual([
      { name: 'make', line: 1, functionLine: 1 },
      { name: '<anonymous>', line: 3, functionLine: 2 }
    ])
    expect(result.text).toBe(
      [
        'export const make = (a: number, _c = 0) =>',
        '  { throw new Error("mutate-changes: nested.ts:1 make"); return ((b: number) =>',
        '    { throw new Error("mutate-changes: nested.ts:3 <anonymous>"); return (a - b) }) }',
        ''
      ].join('\n')
    )
    const mod = await load(result.text as string)
    expect(() => (mod.make as (a: number) => unknown)(1)).toThrow('nested.ts:1 make')
  })

  it('nested arrows: a change inside the inner function only mutates the inner one, keeping what the outer returns', async () => {
    const before = [
      'export const outer = (a: number) => {',
      '  const inner = (b: number) => ({ sum: a + b })',
      '  return inner',
      '}',
      ''
    ].join('\n')
    const after = before.replace('({ sum: a + b })', '({ sum: b + a })')
    const result = mutate('inner.ts', before, after)
    // The whole line is the outer function's: the change could be to `inner`'s binding, so `outer` throws.
    expect(result.functions.map((f) => f.name)).toEqual(['outer'])

    const split = ['export const outer = (a: number) => {', '  const inner = (b: number) =>', '    ({ sum: a + b })']
    const beforeSplit = [...split, '  return inner', '}', ''].join('\n')
    const afterSplit = beforeSplit.replace('({ sum: a + b })', '({ sum: b + a })')
    const inner = mutate('inner.ts', beforeSplit, afterSplit)
    expect(inner.functions).toEqual([{ name: 'inner', line: 3, functionLine: 2 }])
    expect(inner.text).toContain('{ throw new Error("mutate-changes: inner.ts:3 inner"); return (({ sum: b + a })) }')
    const mod = await load(inner.text as string)
    const made = (mod.outer as (a: number) => (b: number) => unknown)(1)
    expect(typeof made).toBe('function')
    expect(() => made(2)).toThrow('inner.ts:3 inner')
  })

  it('class members: a method, a constructor after super(), an accessor; overloads and abstract members unplaceable', async () => {
    const before = [
      'class Base {',
      '  constructor(public readonly n: number) {}',
      '}',
      'export class Counter extends Base {',
      '  private count = 0',
      '  constructor(n: number) {',
      '    super(n)',
      '    this.count = n',
      '  }',
      '  increment(by: number): number {',
      '    this.count += by',
      '    return this.count',
      '  }',
      '  get value(): number {',
      '    return this.count',
      '  }',
      '  scale(by: number): number',
      '  scale(by: string): number',
      '  scale(by: number | string): number {',
      '    return this.count * Number(by)',
      '  }',
      '}',
      'export abstract class Shape {',
      '  abstract area(): number',
      '}',
      ''
    ].join('\n')
    const after = before
      .replace('    this.count = n', '    this.count = n * 1')
      .replace('    this.count += by', '    this.count = this.count + by')
      .replace('    return this.count\n  }\n  scale', '    return this.count + 0\n  }\n  scale')
      .replace('  scale(by: string): number', '  scale(by: string | bigint): number')
      .replace('  abstract area(): number', '  abstract area(): number | null')
      .replace('  private count = 0', '  private count = 0 + 0')
    const result = mutate('counter.ts', before, after)
    expect(result.functions).toEqual([
      { name: 'Counter.constructor', line: 8, functionLine: 6 },
      { name: 'Counter.increment', line: 11, functionLine: 10 },
      { name: 'Counter.get value', line: 15, functionLine: 14 }
    ])
    expect(result.unplaceable).toEqual([5, 18, 24])
    const lines = (result.text as string).split('\n')
    // After `super(n)`, which has no semicolon of its own, the throw starts a statement of its own.
    expect(lines[6]).toBe('    super(n); throw new Error("mutate-changes: counter.ts:8 Counter.constructor");')
    expect(lines[9]).toBe(
      '  increment(by: number): number { throw new Error("mutate-changes: counter.ts:11 Counter.increment");'
    )
    const mod = await load(result.text as string)
    expect(() => new (mod.Counter as new (n: number) => unknown)(1)).toThrow('counter.ts:8 Counter.constructor')
  })

  it('a change outside any function is unplaceable and mutates nothing', () => {
    const before = ['export const limit = 10', 'export class Box {', '  size = limit * 2', '}', ''].join('\n')
    const after = ['export const limit = 11', 'export class Box {', '  size = limit * 3', '}', ''].join('\n')
    const result = mutate('outside.ts', before, after)
    expect(result).toEqual({ text: null, functions: [], unplaceable: [1, 3], parseError: null })
  })

  it('a pure deletion mutates the function that held it; one at the top of the file is unplaceable', () => {
    const before = ['// header', 'export function f(): number {', '  const x = 1', '  return 2', '}', ''].join('\n')
    const after = ['export function f(): number {', '  return 2', '}', ''].join('\n')
    expect(changedLines(before, after)).toEqual({ lines: [], deletions: [0, 1] })
    const result = mutate('deleted.ts', before, after)
    expect(result.functions).toEqual([{ name: 'f', line: 1, functionLine: 1 }])
    expect(result.unplaceable).toEqual([0])
  })

  it('a mutation that would not parse is reported and the file left unmutated', () => {
    const before = ['export function broken(): number {', '  return 1', '}', ''].join('\n')
    const after = ['export function broken(): number {', '  return 1 +', '}', ''].join('\n')
    const result = mutateSource('broken.ts', after, changedLines(before, after))
    expect(result.text).toBeNull()
    expect(result.functions.map((f) => f.name)).toEqual(['broken'])
    expect(result.parseError).toContain('3: Expression expected')
  })

  it('a .tsx file is mutated like a .ts file', () => {
    const before = ['export const View = () => <div>a</div>', ''].join('\n')
    const after = ['export const View = () => <div>b</div>', ''].join('\n')
    const result = mutate('view.tsx', before, after)
    expect(result.text).toBe(
      'export const View = () => { throw new Error("mutate-changes: view.tsx:1 View"); return (<div>b</div>) }\n'
    )
  })
})

describe('applyInsertions', () => {
  it('applies edits computed against the original text from the end; at one point closings nest inside', () => {
    const insertions = [
      { position: 0, text: '[', closing: false, depth: 0 },
      { position: 0, text: '(', closing: false, depth: 1 },
      { position: 3, text: ')', closing: true, depth: 1 },
      { position: 3, text: ']', closing: true, depth: 0 },
      { position: 1, text: '-', closing: false, depth: 2 }
    ]
    expect(applyInsertions('abc', insertions)).toBe('[(a-bc)]')
    expect(applyInsertions('abc', [...insertions].reverse())).toBe('[(a-bc)]')
  })
})

describe('mutate-changes command', () => {
  const repo = join(scratch, 'repo')
  const run = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), text)
  }
  const commit = (message: string) => {
    run(['add', '-A'])
    run(['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', message])
    return run(['rev-parse', 'HEAD'])
  }

  it('mutates changed TypeScript files in the worktree and reports mutated, unplaceable and skipped files', () => {
    mkdirSync(repo, { recursive: true })
    run(['init', '-q'])
    write('src/a.ts', 'export function a(): number {\n  return 1\n}\nexport const k = 1\n')
    write('src/gone.ts', 'export const gone = 1\n')
    write('README.md', 'docs\n')
    const base = commit('base')
    write('src/a.ts', 'export function a(): number {\n  return 2\n}\nexport const k = 2\n')
    write('src/new.tsx', 'export const N = () => <b>n</b>\n')
    rmSync(join(repo, 'src/gone.ts'))
    write('README.md', 'more docs\n')
    const head = commit('head')

    const cli = spawnSync(
      'bun',
      [join(import.meta.dir, 'mutate-changes.ts'), '--base', base, '--head', head, '--worktree', repo],
      { encoding: 'utf8' }
    )
    expect(cli.stderr).toBe('')
    expect(cli.status).toBe(0)
    const report = JSON.parse(cli.stdout) as MutationReport
    expect(report).toEqual({
      base,
      head,
      mutated: [
        { file: 'src/a.ts', functions: [{ name: 'a', line: 2, functionLine: 1 }] },
        { file: 'src/new.tsx', functions: [{ name: 'N', line: 1, functionLine: 1 }] }
      ],
      unplaceable: [{ file: 'src/a.ts', lines: [4] }],
      unparsed: [],
      skipped: [
        { file: 'README.md', reason: 'not TypeScript' },
        { file: 'src/gone.ts', reason: 'deleted' }
      ]
    })
    const mutatedA = readFileSync(join(repo, 'src/a.ts'), 'utf8')
    expect(mutatedA).toContain('throw new Error("mutate-changes: src/a.ts:2 a");')
    expect(parseErrorOf('src/a.ts', mutatedA)).toBeNull()
    expect(parseErrorOf('src/new.tsx', readFileSync(join(repo, 'src/new.tsx'), 'utf8'))).toBeNull()

    // The worktree now differs from the head: a second run refuses and writes nothing.
    expect(() => mutateChanges({ base, head, worktree: repo })).toThrow('differs from')
    expect(readFileSync(join(repo, 'src/a.ts'), 'utf8')).toBe(mutatedA)
  })

  it('a documentation-only change reads as no mutation', () => {
    const base = run(['rev-parse', 'HEAD'])
    run(['checkout', '-q', '--', '.'])
    write('README.md', 'only docs\n')
    const head = commit('docs')
    expect(mutateChanges({ base, head, worktree: repo })).toEqual({
      base,
      head,
      mutated: [],
      unplaceable: [],
      unparsed: [],
      skipped: [{ file: 'README.md', reason: 'not TypeScript' }]
    })
  })

  it('refuses an incomplete or unknown command line', () => {
    expect(parseArgs(['--base', 'a', '--head', 'b', '--worktree', 'w'])).toEqual({
      base: 'a',
      head: 'b',
      worktree: 'w'
    })
    expect(parseArgs(['--base', 'a', '--head', 'b'])).toBeNull()
    expect(parseArgs(['--base', 'a', '--head', 'b', '--worktree', 'w', '--other', 'x'])).toBeNull()
  })
})
