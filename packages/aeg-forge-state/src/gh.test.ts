import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The page walk itself, exercised end to end.
 *
 * Every other test of a paginated reader mocks `ghApiGetAllPagesAsync` and so
 * proves only what its caller does with a list it was handed. What that leaves
 * unguarded is the walk: the `page=` increment, the short-page stop, the
 * `per_page` the stop condition depends on, and the ceiling. All four fail
 * silently rather than loudly — a truncated list looks exactly like a small
 * one — which is the same shape of defect pagination was introduced to close.
 *
 * `gh` is replaced at the `node:child_process` seam (the package's single
 * forge-access path), so these assert the real request sequence this module
 * issues, not a stubbed return value.
 */

const forge = vi.hoisted(() => ({
  /** Every full `gh` arg vector this module issued, in order. */
  requested: [] as string[][],
  /** Answers one page, given its args vector (so a test can inspect/react to `-q` too); overridden per test. */
  respond: (_page: number, _args: string[]): unknown[] => []
}))

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  const execFile = (() => {
    throw new Error('callback form not used by these tests')
  }) as unknown as ((...args: unknown[]) => void) & Record<symbol, unknown>

  execFile[promisify.custom] = async (_bin: string, args: string[]) => {
    forge.requested.push(args)
    const path = args[1] as string
    const page = Number(new URLSearchParams(path.split('?')[1] ?? '').get('page') ?? '1')
    return { stdout: JSON.stringify(forge.respond(page, args)), stderr: '' }
  }

  return { execFile, execFileSync: () => '[]' }
})

const { ghApiGetAllPagesAsync } = await import('./gh')

const items = (n: number, offset = 0): { id: number }[] => Array.from({ length: n }, (_, i) => ({ id: offset + i }))

/** The `page=` value of each request, in order. */
const requestedPages = (): number[] =>
  forge.requested.map((args) => Number(new URLSearchParams((args[1] as string).split('?')[1] ?? '').get('page')))

/** The `per_page` value of each request, in order. */
const requestedPerPage = (): (string | null)[] =>
  forge.requested.map((args) => new URLSearchParams((args[1] as string).split('?')[1] ?? '').get('per_page'))

beforeEach(() => {
  forge.requested.length = 0
  forge.respond = () => []
})

describe('ghApiGetAllPagesAsync', () => {
  it('walks pages until a short one and concatenates them in order', async () => {
    forge.respond = (page) => (page <= 2 ? items(100, (page - 1) * 100) : items(7, 200))

    const all = await ghApiGetAllPagesAsync<{ id: number }>('repos/o/r/milestones?state=all&per_page=100')

    expect(all).toHaveLength(207)
    expect(all[0]).toEqual({ id: 0 })
    expect(all[206]).toEqual({ id: 206 })
    // Stops on the first short page — no fourth request to confirm the end.
    expect(requestedPages()).toEqual([1, 2, 3])
  })

  it('stops after one request when the first page is already short', async () => {
    forge.respond = () => items(6)

    expect(await ghApiGetAllPagesAsync('repos/o/r/milestones?state=all&per_page=100')).toHaveLength(6)
    expect(requestedPages()).toEqual([1])
  })

  it('forces per_page=100 even when the caller asked for fewer, and keeps every other parameter', async () => {
    // The regression this guards: the stop condition IS the page size, so a
    // caller-supplied `per_page=30` returns a "short" first page and truncates
    // the walk at 30 items — silently, which is the defect pagination exists
    // to prevent.
    forge.respond = (page) => (page === 1 ? items(100) : items(4, 100))

    const all = await ghApiGetAllPagesAsync('repos/o/r/milestones?state=all&per_page=30')

    expect(all).toHaveLength(104)
    expect(requestedPerPage()).toEqual(['100', '100'])
    expect(forge.requested[0]?.[1]).toContain('state=all')
  })

  it('supplies per_page when the caller omitted it — GitHub defaults to 30', async () => {
    forge.respond = () => items(30)

    const all = await ghApiGetAllPagesAsync('repos/o/r/milestones')

    // 30 < 100, so this is one short page and a complete answer — but only
    // because the request asked for 100. Unset, it would be page 1 of many.
    expect(all).toHaveLength(30)
    expect(requestedPerPage()).toEqual(['100'])
    expect(forge.requested[0]).toEqual(['api', 'repos/o/r/milestones?per_page=100&page=1'])
  })

  it('refuses to walk forever when every page comes back full', async () => {
    // An endpoint that ignores `page=` (or a collection larger than anything
    // modelled here) must surface as an error, never as an unbounded loop in a
    // process whose stdout contract is one JSON document.
    forge.respond = () => items(100)

    await expect(ghApiGetAllPagesAsync('repos/o/r/milestones?state=all')).rejects.toThrow(/did not terminate within/)
    expect(forge.requested).toHaveLength(100)
  })

  it('opts.jq appends a `-q <expression>` pair, after the path, on every page requested', async () => {
    forge.respond = (page) => (page === 1 ? items(100) : items(3, 100))

    await ghApiGetAllPagesAsync('repos/o/r/issues?state=all', { jq: '[.[] | {labels: .labels}]' })

    expect(forge.requested).toHaveLength(2)
    for (const args of forge.requested) {
      expect(args.slice(-2)).toEqual(['-q', '[.[] | {labels: .labels}]'])
    }
  })

  it('omits -q entirely when no jq option is given — every existing caller keeps its old arg vector', async () => {
    forge.respond = () => items(6)

    await ghApiGetAllPagesAsync('repos/o/r/milestones?state=all')

    expect(forge.requested[0]).not.toContain('-q')
  })
})

/**
 * `tranchesAttachedToMilestone`'s own fixture, driven for real: `./gh` is
 * NOT mocked in this file (only `node:child_process` is), so this exercises
 * the actual paginated walk and the actual `-q` filter together, not a
 * caller's assumption about what `ghApiGetAllPagesAsync` does with them.
 * Every other `tranchesAttachedToMilestone` test (`fetch-milestone.test.ts`)
 * mocks `ghApiGetAllPagesAsync` itself, which proves the caller's own logic
 * but nothing about the filter actually reaching `gh` or the walk actually
 * paging — the gap a round-2 review found.
 */
describe('tranchesAttachedToMilestone — the real paginated, filtered fetch, end to end', () => {
  const OVER_ONE_MEGABYTE = 'x'.repeat(1024 * 1024 + 1)

  /** One full-shaped Issue (`body` included) per number in `[start, start + count)`, all carrying `slug`'s tranche label. */
  function issuePage(start: number, count: number, slug: string) {
    return Array.from({ length: count }, (_, i) => ({
      number: start + i,
      body: OVER_ONE_MEGABYTE,
      labels: [{ name: `vinaya/tranche:${slug}` }]
    }))
  }

  it('an 80+ Issue Milestone, full bodies over one megabyte each, delivered across three pages, resolves to the union of their tranche slugs — and the filter is what actually keeps the parsed payload small, not a mock standing in for it', async () => {
    const byPage: Record<number, ReturnType<typeof issuePage>> = {
      1: issuePage(1, 100, 'tranche-a'),
      2: issuePage(101, 100, 'tranche-b'),
      3: issuePage(201, 25, 'tranche-c')
    }

    // Stands in for `gh`'s own server-side `-q` evaluation: full bodies
    // survive UNLESS the exact filter this module sends is present, so a
    // regression that drops the filter (or sends the wrong expression)
    // shows up as megabyte-scale JSON here, not a silent pass.
    forge.respond = (page, args) => {
      const full = byPage[page] ?? []
      const jqIdx = args.indexOf('-q')
      if (jqIdx !== -1 && args[jqIdx + 1] === '[.[] | {labels: .labels}]') {
        return full.map((issue) => ({ labels: issue.labels }))
      }
      return full
    }

    const { tranchesAttachedToMilestone } = await import('./fetch-milestone')
    const slugs = await tranchesAttachedToMilestone('o', 'r', 15)

    expect(slugs.sort()).toEqual(['tranche-a', 'tranche-b', 'tranche-c'])
    expect(requestedPages()).toEqual([1, 2, 3])
    // Every one of the three requests carried the labels-only filter — none
    // slipped through unfiltered, which is what would have let a full,
    // over-one-megabyte body back into this process.
    for (const args of forge.requested) {
      expect(args.slice(-2)).toEqual(['-q', '[.[] | {labels: .labels}]'])
    }
  })
})
