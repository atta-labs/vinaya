import { describe, expect, it } from 'bun:test'
import {
  type MilestoneForge,
  adoptMilestone,
  closeMilestone,
  createMilestone,
  deleteMilestone,
  editMilestone,
  milestoneStatus,
  parsePagedArrays
} from './milestone-operations'

const GOAL = 'The goal.\n\nRelease: 1.0.0'

type Call = { args: string[]; input?: string }

/** A forge whose `gh` answers from `answer`; a thrown value is a failed call. Every call is recorded. */
function stubForge(
  answer: (args: string[], input?: string) => string,
  over: Partial<MilestoneForge> = {}
): MilestoneForge & { calls: Call[] } {
  const calls: Call[] = []
  const forge: MilestoneForge = {
    sh: (args, input) => {
      calls.push({ args, input })
      return answer(args, input)
    },
    resolveRepo: async () => ({ owner: 'o', repo: 'r' }),
    fetchTrancheIssues: async () => [],
    findMilestoneFacts: () => ({ milestones: [] }) as never,
    deriveLifecycle: async () => 'complete',
    ...over
  }
  return Object.assign(forge, { calls })
}

const ghFailure = (stderr: string) => Object.assign(new Error(`Command failed: gh\n${stderr}`), { stderr })
const joined = (a: string[]) => a.join(' ')

describe('createMilestone', () => {
  it('returns the created Milestone', async () => {
    const forge = stubForge(() => JSON.stringify({ number: 7, html_url: 'https://x/7' }))
    const out = await createMilestone({ title: 'T', body: GOAL, validateOnly: false }, forge)
    expect(out).toEqual({ ok: true, written: true, number: 7, url: 'https://x/7' })
    expect(forge.calls[0]?.args).toEqual(['gh', 'api', 'repos/o/r/milestones', '--input', '-'])
    expect(JSON.parse(forge.calls[0]?.input ?? '')).toEqual({ title: 'T', description: GOAL })
  })

  it('writes nothing on a validate-only pass', async () => {
    const forge = stubForge(() => '')
    const out = await createMilestone({ title: 'T', body: GOAL, validateOnly: true }, forge)
    expect(out).toEqual({ ok: true, written: false })
    expect(forge.calls).toEqual([])
  })

  it('refuses a malformed body with milestone-shape findings, before any forge call', async () => {
    const forge = stubForge(() => '')
    const out = await createMilestone({ title: 'T', body: 'Release: 1.0.0', validateOnly: false }, forge)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings.every((f) => f.check === 'milestone-shape')).toBe(true)
    expect(forge.calls).toEqual([])
  })

  it('refuses with a forge-fetch finding when the forge write fails', async () => {
    const forge = stubForge(() => {
      throw ghFailure('HTTP 422 duplicate title')
    })
    const out = await createMilestone({ title: 'T', body: GOAL, validateOnly: false }, forge)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.findings[0]?.check).toBe('forge-fetch')
      expect(out.findings[0]?.message).toContain('HTTP 422 duplicate title')
    }
  })

  it('refuses when no repository resolves', async () => {
    const forge = stubForge(() => '', { resolveRepo: async () => null })
    const out = await createMilestone({ title: 'T', body: GOAL, validateOnly: false }, forge)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.check).toBe('forge-fetch')
  })
})

describe('editMilestone', () => {
  it('patches the description and returns the Milestone', async () => {
    const forge = stubForge(() => JSON.stringify({ number: 3, html_url: 'https://x/3' }))
    const out = await editMilestone({ number: '3', body: GOAL, validateOnly: false }, forge)
    expect(out).toEqual({ ok: true, written: true, number: 3, url: 'https://x/3' })
    expect(forge.calls[0]?.args).toEqual(['gh', 'api', '-X', 'PATCH', 'repos/o/r/milestones/3', '--input', '-'])
  })

  it('refuses a malformed body and reports a failed PATCH', async () => {
    const bad = await editMilestone(
      { number: '3', body: 'Release: 1.0.0', validateOnly: false },
      stubForge(() => '')
    )
    expect(bad.ok).toBe(false)
    const failing = stubForge(() => {
      throw ghFailure('HTTP 500')
    })
    const out = await editMilestone({ number: '3', body: GOAL, validateOnly: false }, failing)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.check).toBe('forge-fetch')
  })

  it('writes nothing on a validate-only pass', async () => {
    const forge = stubForge(() => '')
    expect(await editMilestone({ number: '3', body: GOAL, validateOnly: true }, forge)).toEqual({
      ok: true,
      written: false
    })
    expect(forge.calls).toEqual([])
  })
})

describe('adoptMilestone', () => {
  const milestones = [
    { number: 1, title: 'demo', description: '', state: 'open' },
    { number: 2, title: 'Product', description: '', state: 'open' }
  ]
  const answer =
    (over: { issue?: () => string } = {}) =>
    (args: string[]): string => {
      const line = joined(args)
      if (line.includes('labels?per_page')) return JSON.stringify([{ name: 'vinaya/tranche:demo' }])
      if (line.includes('milestones?state=all')) return JSON.stringify(milestones)
      if (line.includes('issue list'))
        return JSON.stringify([{ number: 11, state: 'CLOSED', milestone: { title: 'demo' } }])
      if (line.includes('issue edit')) return over.issue ? over.issue() : ''
      return '{}'
    }

  it('attaches the Issues, closes the old Milestone and returns what moved', async () => {
    const forge = stubForge(answer())
    const out = await adoptMilestone({ target: 'Product', slugs: ['demo'], validateOnly: false }, forge)
    expect(out).toEqual({
      ok: true,
      written: true,
      target: 'Product',
      adopted: [{ slug: 'demo', issueCount: 1, closedMilestone: 1 }]
    })
    expect(forge.calls.some((c) => joined(c.args) === 'gh issue edit 11 -R o/r --milestone Product')).toBe(true)
  })

  it('writes nothing on a validate-only pass', async () => {
    const forge = stubForge(answer())
    const out = await adoptMilestone({ target: 'Product', slugs: ['demo'], validateOnly: true }, forge)
    expect(out).toEqual({ ok: true, written: false })
    expect(forge.calls.some((c) => joined(c.args).includes('issue edit'))).toBe(false)
  })

  it('refuses an unknown target Milestone with a milestone-adopt finding and writes nothing', async () => {
    const forge = stubForge(answer())
    const out = await adoptMilestone({ target: 'Missing', slugs: ['demo'], validateOnly: false }, forge)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.check).toBe('milestone-adopt')
    expect(forge.calls.some((c) => joined(c.args).includes('issue edit'))).toBe(false)
  })

  it('refuses with a forge-fetch finding when a read fails', async () => {
    const forge = stubForge(() => {
      throw ghFailure('HTTP 401')
    })
    const out = await adoptMilestone({ target: 'Product', slugs: ['demo'], validateOnly: false }, forge)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.check).toBe('forge-fetch')
  })

  it('reports a failed write as a partial write, not a refusal', async () => {
    const forge = stubForge(
      answer({
        issue: () => {
          throw ghFailure('HTTP 502')
        }
      })
    )
    const out = await adoptMilestone({ target: 'Product', slugs: ['demo'], validateOnly: false }, forge)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.findings).toEqual([])
      expect(out.partialWrite).toContain('failed to attach Issue #11')
    }
  })
})

describe('closeMilestone', () => {
  const open = [{ number: 5, title: 'demo', description: '', state: 'open' }]
  const answer =
    (labeled: number[], attached: number[], patch?: () => string) =>
    (args: string[]): string => {
      const line = joined(args)
      if (line.includes('milestones?state=all')) return JSON.stringify(open)
      if (line.includes('--label'))
        return JSON.stringify(labeled.map((number) => ({ number, state: 'CLOSED', milestone: { title: 'demo' } })))
      if (line.includes('--milestone'))
        return JSON.stringify(attached.map((number) => ({ number, state: 'CLOSED', milestone: { title: 'demo' } })))
      if (line.includes('PATCH')) return patch ? patch() : JSON.stringify({ number: 5, html_url: 'https://x/5' })
      return '[]'
    }

  it('closes a fully attached tranche Milestone', async () => {
    const forge = stubForge(answer([1, 2], [1, 2]))
    const out = await closeMilestone({ slug: 'demo', validateOnly: false }, forge)
    expect(out).toEqual({ ok: true, written: true, number: 5, url: 'https://x/5' })
  })

  it('verifies without writing on a validate-only pass', async () => {
    const forge = stubForge(answer([1], [1]))
    const out = await closeMilestone({ slug: 'demo', validateOnly: true }, forge)
    expect(out).toEqual({ ok: true, written: false, number: 5, title: 'demo' })
    expect(forge.calls.some((c) => joined(c.args).includes('PATCH'))).toBe(false)
  })

  it('refuses an unattached labelled Issue and never patches', async () => {
    const forge = stubForge(answer([1, 2], [1]))
    const out = await closeMilestone({ slug: 'demo', validateOnly: false }, forge)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.message).toContain('#2')
    expect(forge.calls.some((c) => joined(c.args).includes('PATCH'))).toBe(false)
  })

  it('refuses when no open Milestone resolves', async () => {
    const forge = stubForge(answer([], []))
    const out = await closeMilestone({ slug: 'other', validateOnly: false }, forge)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.check).toBe('milestone-close')
  })

  it('refuses with a forge-fetch finding when the PATCH fails', async () => {
    const forge = stubForge(
      answer([1], [1], () => {
        throw ghFailure('HTTP 500')
      })
    )
    const out = await closeMilestone({ slug: 'demo', validateOnly: false }, forge)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.check).toBe('forge-fetch')
  })
})

describe('a Milestone number that is not digits', () => {
  it('is refused by edit and status before any forge call', async () => {
    const forge = stubForge(() => '')
    const edit = await editMilestone({ number: '../3', body: GOAL, validateOnly: false }, forge)
    const status = await milestoneStatus({ number: '3/../x' }, forge)
    for (const out of [edit, status]) {
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.findings[0]?.check).toBe('forge-args')
    }
    expect(forge.calls).toEqual([])
  })
})

describe('closeMilestone declared-tranche hold', () => {
  const held = 'Goal.\n\n### Tranche intents\n- demo: Now.\n- later: Not yet.'
  const answer = (args: string[]): string => {
    const line = joined(args)
    if (line.includes('milestones?state=all'))
      return JSON.stringify([{ number: 5, title: 'Product', description: held, state: 'open' }])
    if (line.includes('--label'))
      return JSON.stringify([{ number: 1, state: 'CLOSED', milestone: { title: 'Product' } }])
    if (line.includes('--milestone'))
      return JSON.stringify([{ number: 1, state: 'CLOSED', milestone: { title: 'Product' } }])
    return JSON.stringify({ number: 5, html_url: 'https://x/5' })
  }

  it('refuses while a declared tranche is unfinished, and never patches', async () => {
    const forge = stubForge(answer, { deriveLifecycle: async () => 'active' })
    const out = await closeMilestone({ slug: 'demo', validateOnly: false }, forge)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.findings[0]?.check).toBe('milestone-close')
      expect(out.findings[0]?.message).toContain('must stay open')
    }
    expect(forge.calls.some((c) => joined(c.args).includes('PATCH'))).toBe(false)
  })

  it('refuses with a forge-fetch finding when a declared tranche lifecycle cannot be read', async () => {
    const forge = stubForge(answer, {
      deriveLifecycle: async () => {
        throw ghFailure('HTTP 500')
      }
    })
    const out = await closeMilestone({ slug: 'demo', validateOnly: false }, forge)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.check).toBe('forge-fetch')
  })
})

describe('milestoneStatus', () => {
  const description = 'Goal.\n\n### Tranche intents\n- demo: Do it.'

  it('returns the header and one row per declared tranche', async () => {
    const forge = stubForge(() => JSON.stringify({ number: 4, title: 'Product', description, state: 'open' }), {
      fetchTrancheIssues: async () =>
        [
          { number: 1, title: '[demo] 1 — A task', state: 'CLOSED', stateReason: 'COMPLETED', labels: [], body: '' }
        ] as never
    })
    const out = await milestoneStatus({ number: '4' }, forge)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.milestone).toEqual({ number: 4, title: 'Product', state: 'open' })
      expect(out.tranches).toHaveLength(1)
      expect(out.tranches[0]).toMatchObject({ slug: 'demo', issues: 1, counts: { merged: 1, open: 0, notPlanned: 0 } })
    }
  })

  it('returns no rows when no intents are declared', async () => {
    const forge = stubForge(() => JSON.stringify({ number: 4, title: 'P', description: 'Goal.', state: 'closed' }))
    expect(await milestoneStatus({ number: '4' }, forge)).toEqual({
      ok: true,
      milestone: { number: 4, title: 'P', state: 'closed' },
      tranches: []
    })
  })

  it('refuses a missing Milestone as milestone-status and a failed read as forge-fetch', async () => {
    const missing = await milestoneStatus(
      { number: '4' },
      stubForge(() => {
        throw ghFailure('HTTP 404 Not Found')
      })
    )
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.findings[0]?.check).toBe('milestone-status')
    const down = await milestoneStatus(
      { number: '4' },
      stubForge(() => {
        throw ghFailure('HTTP 500')
      })
    )
    expect(down.ok).toBe(false)
    if (!down.ok) expect(down.findings[0]?.check).toBe('forge-fetch')
  })
})

describe('deleteMilestone', () => {
  const empty = { number: 9, open_issues: 0, closed_issues: 0 }
  const forgeFor = (milestone: unknown, list: () => string, del?: () => string) =>
    stubForge((args) => {
      const line = joined(args)
      if (line.includes('-X DELETE')) return del ? del() : ''
      if (line.includes('--paginate')) return list()
      return JSON.stringify(milestone)
    })

  it('deletes an existing Milestone with nothing attached, listing every state through REST', async () => {
    const forge = forgeFor(empty, () => '[]')
    expect(await deleteMilestone({ number: '9' }, forge)).toEqual({ ok: true, deleted: true, number: 9 })
    expect(forge.calls.map((c) => joined(c.args))).toEqual([
      'gh api repos/o/r/milestones/9',
      'gh api --paginate repos/o/r/issues?milestone=9&state=all&per_page=100',
      'gh api -X DELETE repos/o/r/milestones/9'
    ])
  })

  it('refuses a Milestone that does not exist and never deletes', async () => {
    const forge = stubForge(() => {
      throw ghFailure('HTTP 404 Not Found')
    })
    const out = await deleteMilestone({ number: '9' }, forge)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.findings[0]?.check).toBe('milestone-delete')
      expect(out.findings[0]?.message).toContain('does not exist')
    }
    expect(forge.calls.some((c) => joined(c.args).includes('DELETE'))).toBe(false)
  })

  it('refuses a Milestone with an attached closed Issue, naming it, and never deletes', async () => {
    const forge = forgeFor({ number: 9, open_issues: 0, closed_issues: 1 }, () =>
      JSON.stringify([{ number: 42, state: 'closed', title: 'Old work' }])
    )
    const out = await deleteMilestone({ number: '9' }, forge)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.message).toContain('#42 (issue, closed) Old work')
    expect(forge.calls.some((c) => joined(c.args).includes('DELETE'))).toBe(false)
  })

  it('names an attached merged pull request, and every item across pages', async () => {
    const forge = forgeFor(
      { number: 9, open_issues: 0, closed_issues: 2 },
      () =>
        `${JSON.stringify([{ number: 1, state: 'closed', title: 'a' }])}${JSON.stringify([{ number: 2, state: 'closed', title: 'b', pull_request: {} }])}`
    )
    const out = await deleteMilestone({ number: '9' }, forge)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.findings[0]?.message).toContain('#1 (issue, closed) a')
      expect(out.findings[0]?.message).toContain('#2 (pull request, closed) b')
    }
  })

  it('refuses on any doubt: a failed listing, an unreadable listing, or counts the listing missed', async () => {
    const failing = forgeFor(empty, () => {
      throw ghFailure('HTTP 403')
    })
    const failed = await deleteMilestone({ number: '9' }, failing)
    expect(failed.ok).toBe(false)
    expect(failing.calls.some((c) => joined(c.args).includes('DELETE'))).toBe(false)

    const garbled = forgeFor(empty, () => '{"message":"rate limited"}')
    const unread = await deleteMilestone({ number: '9' }, garbled)
    expect(unread.ok).toBe(false)
    expect(garbled.calls.some((c) => joined(c.args).includes('DELETE'))).toBe(false)

    const undercounted = forgeFor({ number: 9, open_issues: 1, closed_issues: 0 }, () => '[]')
    const short = await deleteMilestone({ number: '9' }, undercounted)
    expect(short.ok).toBe(false)
    expect(undercounted.calls.some((c) => joined(c.args).includes('DELETE'))).toBe(false)
  })

  it('refuses with a forge-fetch finding when the delete itself fails', async () => {
    const forge = forgeFor(
      empty,
      () => '[]',
      () => {
        throw ghFailure('HTTP 500')
      }
    )
    const out = await deleteMilestone({ number: '9' }, forge)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.findings[0]?.check).toBe('forge-fetch')
  })

  it('refuses a number that is not digits', async () => {
    const forge = forgeFor(empty, () => '[]')
    const out = await deleteMilestone({ number: '../9' }, forge)
    expect(out.ok).toBe(false)
    expect(forge.calls).toEqual([])
  })
})

describe('parsePagedArrays', () => {
  it('reads one merged array, several page arrays, and brackets inside strings', () => {
    expect(parsePagedArrays('[1,2]')).toEqual([1, 2])
    expect(parsePagedArrays('[1][2,3]\n[4]')).toEqual([1, 2, 3, 4])
    expect(parsePagedArrays('[{"t":"a ] [ b \\" ]"}]')).toEqual([{ t: 'a ] [ b " ]' }])
    expect(parsePagedArrays('')).toEqual([])
  })

  it('returns null for anything that is not a run of arrays', () => {
    expect(parsePagedArrays('{"a":1}')).toBeNull()
    expect(parsePagedArrays('[1')).toBeNull()
    expect(parsePagedArrays('[1] junk')).toBeNull()
  })
})
