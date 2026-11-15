// The safe rule that lets a recorded test go by a changed file it read: every hunk of the file is body-only or an
// inert addition, the test's recorded coverage shows it never entered the changed functions, and its process opened
// the file once, loaded it, with no child opening it. Each condition is shown to keep the test when it alone fails.
// In-memory repositories and synthetic version-2 records; the public entrypoint only.
import { describe, expect, it } from 'bun:test'
import {
  type InventoryDeclarations,
  inventoryViewOf,
  memoryRepository,
  neverEnteredFunctions,
  READ_RECORD_SCHEMA,
  type ReadRecord,
  type RecordedTest,
  type SelectionPlan,
  type SelectionPolicy,
  selectTests
} from '../src/index.js'

const DECLARATIONS: InventoryDeclarations = {
  suites: [{ id: 'all', dir: '.', runner: 'bun', preload: null }],
  edges: [],
  unknowns: [],
  policies: []
}

const LIB = 'src/lib.ts'
const OTHER = 'src/other.ts'
const TEST = 'tests/a.test.ts'
const SECOND = 'tests/b.test.ts'

// Line 5 opens `unused`, 6 and 7 are its own lines, 8 closes it.
const LIB_BASE = [
  'export function used(): number {',
  '  return 1',
  '}',
  '',
  'export function unused(): number {',
  '  const a = 2',
  '  return a',
  '}',
  ''
].join('\n')
const LIB_BODY_CHANGED = LIB_BASE.replace('const a = 2', 'const a = 3')

const OTHER_BASE = ['export function other(): number {', '  return 1', '}', ''].join('\n')

const BASE: Record<string, string> = {
  [LIB]: LIB_BASE,
  [OTHER]: OTHER_BASE,
  [TEST]: '// reads the library\n',
  [SECOND]: '// reads the library\n'
}

/** A version-2 entry for a test that loaded `LIB` once and ran only `used`. */
const goodEntry = (reads: string[] = [TEST, LIB]): RecordedTest => ({
  reads,
  listed: [],
  opens: { [TEST]: 1, [LIB]: 1 },
  childOpens: [],
  coverage: {
    [LIB]: {
      instrumented: [
        [2, 2],
        [6, 7]
      ],
      executed: [[2, 2]]
    }
  }
})

const recordOf = (tests: Record<string, RecordedTest>, schemaVersion: 1 | 2 = 2, platform = 'linux'): ReadRecord => ({
  schema: READ_RECORD_SCHEMA,
  schemaVersion,
  commit: 'base',
  platform,
  tests
})

type Selected = { plan: SelectionPlan; tests: string[] }

function select(
  head: Record<string, string | null>,
  record: ReadRecord,
  options: { policy?: Partial<SelectionPolicy>; platform?: string } = {}
): Selected {
  const headFiles: Record<string, string> = { ...BASE }
  for (const [path, text] of Object.entries(head)) {
    if (text === null) delete headFiles[path]
    else headFiles[path] = text
  }
  const plan = selectTests({
    repo: memoryRepository({ base: BASE, head: headFiles }),
    base: 'base',
    head: 'head',
    inventory: {
      head: inventoryViewOf('head', headFiles, DECLARATIONS),
      base: inventoryViewOf('base', BASE, DECLARATIONS)
    },
    policy: { depth: 'transitive', ...options.policy },
    records: { record, platform: options.platform ?? 'linux' }
  })
  return { plan, tests: plan.required.map((t) => t.test).sort() }
}

const withEntry = (over: Partial<RecordedTest>, reads?: string[]): ReadRecord =>
  recordOf({ [TEST]: { ...goodEntry(reads), ...over } })

describe('the safe rule over a body-only change', () => {
  it('leaves a test out when every condition holds, and names it and the reason in the plan', () => {
    const { plan, tests } = select({ [LIB]: LIB_BODY_CHANGED }, recordOf({ [TEST]: goodEntry() }))
    expect(tests).toEqual([])
    expect(plan.records.leftOut).toEqual([
      {
        test: TEST,
        files: [
          {
            path: LIB,
            rule: 'unentered-bodies',
            detail: `the change to ${LIB} only changes the bodies of unused, and the recorded run opened it once and never entered what changed`
          }
        ]
      }
    ])
  })

  it('keeps the test when the test ran a line of the changed function', () => {
    const entry: RecordedTest = {
      ...goodEntry(),
      coverage: {
        [LIB]: {
          instrumented: [
            [2, 2],
            [6, 7]
          ],
          executed: [
            [2, 2],
            [7, 7]
          ]
        }
      }
    }
    expect(select({ [LIB]: LIB_BODY_CHANGED }, recordOf({ [TEST]: entry })).tests).toEqual([TEST])
  })

  it('keeps the test when the closing line of the changed function ran', () => {
    const entry: RecordedTest = {
      ...goodEntry(),
      coverage: {
        [LIB]: {
          instrumented: [
            [2, 2],
            [6, 8]
          ],
          executed: [
            [2, 2],
            [8, 8]
          ]
        }
      }
    }
    expect(select({ [LIB]: LIB_BODY_CHANGED }, recordOf({ [TEST]: entry })).tests).toEqual([TEST])
  })

  it('keeps the test when no line of the changed function body was instrumented', () => {
    const entry: RecordedTest = { ...goodEntry(), coverage: { [LIB]: { instrumented: [[2, 2]], executed: [[2, 2]] } } }
    expect(select({ [LIB]: LIB_BODY_CHANGED }, recordOf({ [TEST]: entry })).tests).toEqual([TEST])
  })

  it('keeps the test when its own process opened the file twice', () => {
    expect(select({ [LIB]: LIB_BODY_CHANGED }, withEntry({ opens: { [TEST]: 1, [LIB]: 2 } })).tests).toEqual([TEST])
  })

  it('keeps the test when the record holds no open count for the file, or none at all', () => {
    expect(select({ [LIB]: LIB_BODY_CHANGED }, withEntry({ opens: { [TEST]: 1 } })).tests).toEqual([TEST])
    expect(select({ [LIB]: LIB_BODY_CHANGED }, withEntry({ opens: undefined })).tests).toEqual([TEST])
  })

  it('keeps the test when its coverage does not hold the file, or it has no coverage', () => {
    expect(select({ [LIB]: LIB_BODY_CHANGED }, withEntry({ coverage: {} })).tests).toEqual([TEST])
    expect(select({ [LIB]: LIB_BODY_CHANGED }, withEntry({ coverage: undefined })).tests).toEqual([TEST])
  })

  it('keeps the test when a child process opened the file, or the record says nothing of children', () => {
    expect(select({ [LIB]: LIB_BODY_CHANGED }, withEntry({ childOpens: [LIB] })).tests).toEqual([TEST])
    expect(select({ [LIB]: LIB_BODY_CHANGED }, withEntry({ childOpens: undefined })).tests).toEqual([TEST])
  })

  it('keeps the test when the record was taken on another platform than the caller runs', () => {
    const record = recordOf({ [TEST]: goodEntry() })
    expect(select({ [LIB]: LIB_BODY_CHANGED }, record, { platform: 'darwin' }).tests).toEqual([TEST])
  })

  it('keeps the test when the changed function has no line of its own', () => {
    const oneLine = 'export function unused(): number { return 2 }\n'
    const base = { ...BASE, [LIB]: oneLine }
    const plan = selectTests({
      repo: memoryRepository({ base, head: { ...base, [LIB]: oneLine.replace('2', '3') } }),
      base: 'base',
      head: 'head',
      inventory: {
        head: inventoryViewOf('head', { ...base, [LIB]: oneLine.replace('2', '3') }, DECLARATIONS),
        base: inventoryViewOf('base', base, DECLARATIONS)
      },
      policy: { depth: 'transitive' },
      records: {
        record: recordOf({
          [TEST]: {
            ...goodEntry(),
            coverage: { [LIB]: { instrumented: [[1, 1]], executed: [] } }
          }
        }),
        platform: 'linux'
      }
    })
    expect(plan.required.map((t) => t.test)).toEqual([TEST])
  })

  it('excludes the lines of a nested function from the changed function’s own lines', () => {
    const base = [
      'export function outer(): number {',
      '  const inner = () => {',
      '    return 1',
      '  }',
      '  const x = 2',
      '  return x',
      '}',
      ''
    ].join('\n')
    const run = (executed: [number, number][]) => {
      const baseFiles = { ...BASE, [LIB]: base }
      const headFiles = { ...baseFiles, [LIB]: base.replace('const x = 2', 'const x = 3') }
      return selectTests({
        repo: memoryRepository({ base: baseFiles, head: headFiles }),
        base: 'base',
        head: 'head',
        inventory: {
          head: inventoryViewOf('head', headFiles, DECLARATIONS),
          base: inventoryViewOf('base', baseFiles, DECLARATIONS)
        },
        policy: { depth: 'transitive' },
        records: {
          record: recordOf({
            [TEST]: {
              ...goodEntry(),
              coverage: {
                [LIB]: {
                  instrumented: [
                    [3, 3],
                    [5, 6]
                  ],
                  executed
                }
              }
            }
          }),
          platform: 'linux'
        }
      }).required.map((t) => t.test)
    }
    // The nested function's own line ran, the outer function's did not: the outer function was never entered.
    expect(run([[3, 3]])).toEqual([])
    expect(run([[5, 5]])).toEqual([TEST])
  })
})

describe('the safe rule over the file side', () => {
  const entry = recordOf({ [TEST]: goodEntry() })

  it('leaves a test out for an inert addition alone, and says so', () => {
    const head = `${LIB_BASE}function helper(): number {\n  return 9\n}\n`
    const { plan, tests } = select({ [LIB]: head }, entry)
    expect(tests).toEqual([])
    expect(plan.records.leftOut[0]?.files[0]).toMatchObject({
      path: LIB,
      rule: 'unentered-bodies',
      detail: expect.stringContaining('only adds declarations that do nothing when the module loads')
    })
  })

  it('keeps the test when a hunk is outside a function body', () => {
    expect(select({ [LIB]: `${LIB_BODY_CHANGED}export const added = 1\n` }, entry).tests).toEqual([TEST])
  })

  it('keeps the test when one hunk is classified and another is not', () => {
    const head = LIB_BODY_CHANGED.replace('export function used(): number', 'export function used(a = 1): number')
    expect(select({ [LIB]: head }, entry).tests).toEqual([TEST])
  })

  it('keeps the test when the changed text no longer parses', () => {
    expect(select({ [LIB]: LIB_BODY_CHANGED.replace('return a', 'return a +') }, entry).tests).toEqual([TEST])
  })

  it('keeps the test when the file is not a .ts file', () => {
    const base = { ...BASE, 'src/lib.js': LIB_BASE }
    const headFiles = { ...base, 'src/lib.js': LIB_BODY_CHANGED }
    const plan = selectTests({
      repo: memoryRepository({ base, head: headFiles }),
      base: 'base',
      head: 'head',
      inventory: {
        head: inventoryViewOf('head', headFiles, DECLARATIONS),
        base: inventoryViewOf('base', base, DECLARATIONS)
      },
      policy: { depth: 'transitive' },
      records: {
        record: recordOf({
          [TEST]: {
            ...goodEntry([TEST, 'src/lib.js']),
            opens: { [TEST]: 1, 'src/lib.js': 1 },
            coverage: { 'src/lib.js': goodEntry().coverage?.[LIB] as never }
          }
        }),
        platform: 'linux'
      }
    })
    expect(plan.required.map((t) => t.test)).toEqual([TEST])
  })

  it('keeps the test when the changed file is itself a test file', () => {
    const readsSecond = recordOf({ [TEST]: { ...goodEntry([TEST, SECOND]), opens: { [TEST]: 1, [SECOND]: 1 } } })
    expect(select({ [SECOND]: '// reads the library, differently\n' }, readsSecond).tests).toEqual([TEST, SECOND])
  })

  it('keeps the test when the file is deleted, and when it is added', () => {
    expect(select({ [LIB]: null }, entry).tests).toEqual([TEST])
    expect(
      select({ 'src/new.ts': 'export const n = 1\n' }, recordOf({ [TEST]: { ...goodEntry(), listed: ['src'] } })).tests
    ).toEqual([TEST])
  })

  it('keeps the test when it read a second changed file the rule cannot clear', () => {
    const both = recordOf({
      [TEST]: {
        ...goodEntry([TEST, LIB, OTHER]),
        opens: { [TEST]: 1, [LIB]: 1, [OTHER]: 1 },
        coverage: { ...goodEntry().coverage, [OTHER]: { instrumented: [[2, 2]], executed: [[2, 2]] } }
      }
    })
    expect(select({ [LIB]: LIB_BODY_CHANGED }, both).tests).toEqual([])
    expect(
      select({ [LIB]: LIB_BODY_CHANGED, [OTHER]: OTHER_BASE.replace('return 1', 'return 2') }, both).tests
    ).toEqual([TEST])
  })

  it('keeps the test when the changed path is read only through a folder', () => {
    const folder = recordOf({ [TEST]: { ...goodEntry([TEST, 'src/']), opens: { [TEST]: 1 } } })
    expect(select({ [LIB]: LIB_BODY_CHANGED }, folder).tests).toEqual([TEST])
  })
})

describe('the file-level lists and the record version', () => {
  const entry = recordOf({ [TEST]: goodEntry() })

  it('keeps a test on the real-sandbox list, or on the outside-call list', () => {
    const body = { [LIB]: LIB_BODY_CHANGED }
    expect(select(body, entry, { policy: { fileLevel: { realSandbox: [TEST] } } }).tests).toEqual([TEST])
    expect(select(body, entry, { policy: { fileLevel: { outsideCall: [TEST] } } }).tests).toEqual([TEST])
  })

  it('keeps every test that read a listed helper, and no other', () => {
    const helper = 'src/helper.ts'
    const base = { ...BASE, [helper]: 'export const h = 1\n' }
    const record = recordOf({
      [TEST]: { ...goodEntry([TEST, LIB, helper]), opens: { [TEST]: 1, [LIB]: 1, [helper]: 1 } },
      [SECOND]: { ...goodEntry([SECOND, LIB]), opens: { [SECOND]: 1, [LIB]: 1 } }
    })
    const headFiles = { ...base, [LIB]: LIB_BODY_CHANGED }
    const run = (realSandbox: string[]) =>
      selectTests({
        repo: memoryRepository({ base, head: headFiles }),
        base: 'base',
        head: 'head',
        inventory: {
          head: inventoryViewOf('head', headFiles, DECLARATIONS),
          base: inventoryViewOf('base', base, DECLARATIONS)
        },
        policy: { depth: 'transitive', fileLevel: { realSandbox } },
        records: { record, platform: 'linux' }
      }).required.map((t) => t.test)
    expect(run([helper])).toEqual([TEST])
    expect(run([])).toEqual([])
  })

  it('changes the plan’s identity when a list changes', () => {
    const body = { [LIB]: LIB_BODY_CHANGED }
    const none = select(body, entry).plan
    const listed = select(body, entry, { policy: { fileLevel: { outsideCall: ['other.test.ts'] } } }).plan
    expect(listed.identity).not.toBe(none.identity)
    expect(listed.context.policy).not.toBe(none.context.policy)
  })

  it('does not name a test as left out when an obligation still plans it', () => {
    const obligations = [{ id: 'always', kind: 'policy' as const, reason: 'always runs', tests: [TEST] }]
    const { plan } = select({ [LIB]: LIB_BODY_CHANGED }, entry, { policy: { obligations } })
    expect(plan.obligations.map((o) => o.test)).toEqual([TEST])
    expect(plan.records.leftOut).toEqual([])
  })

  it('selects a version-1 record exactly as before: the test is kept', () => {
    const v1 = recordOf({ [TEST]: { reads: [TEST, LIB], listed: [] } }, 1)
    const { plan, tests } = select({ [LIB]: LIB_BODY_CHANGED }, v1)
    expect(tests).toEqual([TEST])
    expect(plan.records.leftOut).toEqual([])
  })
})

describe('the safe rule composes with the name narrowing', () => {
  const IMPORTS_USED = "import { used } from '../src/lib.ts'\nused()\n"
  const files = { [TEST]: IMPORTS_USED, [SECOND]: '// reads the library\n' }

  it('leaves out, with its own reason, a test the changed exported names never reach', () => {
    const base = { ...BASE, ...files }
    const headFiles = { ...base, [LIB]: LIB_BODY_CHANGED }
    const plan = selectTests({
      repo: memoryRepository({ base, head: headFiles }),
      base: 'base',
      head: 'head',
      inventory: {
        head: inventoryViewOf('head', headFiles, DECLARATIONS),
        base: inventoryViewOf('base', base, DECLARATIONS)
      },
      policy: { depth: 'transitive' },
      records: {
        record: recordOf({
          // The test the names narrow reads the file twice, so only the names can let it go.
          [TEST]: { ...goodEntry(), opens: { [TEST]: 1, [LIB]: 2 } },
          [SECOND]: { ...goodEntry([SECOND, LIB]), opens: { [SECOND]: 1, [LIB]: 1 } }
        }),
        platform: 'linux'
      }
    })
    expect(plan.required).toEqual([])
    expect(plan.records.leftOut.map((l) => [l.test, l.files.map((f) => f.rule)])).toEqual([
      [TEST, ['unreached-names']],
      [SECOND, ['unentered-bodies']]
    ])
  })
})

describe('neverEnteredFunctions', () => {
  const fn = { inner: [6, 7], closing: 8 }

  it('answers false for any fact the entry lacks and true when all hold', () => {
    expect(neverEnteredFunctions(goodEntry(), LIB, [fn])).toBe(true)
    expect(neverEnteredFunctions(goodEntry(), LIB, [])).toBe(true)
    expect(neverEnteredFunctions({ reads: [LIB], listed: [] }, LIB, [fn])).toBe(false)
    expect(neverEnteredFunctions(goodEntry(), 'src/unknown.ts', [fn])).toBe(false)
  })

  it('answers false when any one of several changed functions was entered', () => {
    expect(neverEnteredFunctions(goodEntry(), LIB, [fn, { inner: [2], closing: 3 }])).toBe(false)
  })
})
